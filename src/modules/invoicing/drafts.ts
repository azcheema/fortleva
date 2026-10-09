import { record } from "@/audit/record";
import { assertInScope, scopeWhere, type MemberActor } from "@/authz/authorize";
import { deny } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { hasAccess, requireAccess } from "@/entitlements/resolver";
import { fail } from "@/lib/domain-error";
import { CURRENCIES, readPreferences } from "@/preferences/service";

import { guarded } from "./db-errors";
import {
  formatFixed,
  invoiceTotals,
  LINE_AMOUNT_MAX,
  lineAmount,
  parseFixed,
  QUANTITY_MAX,
  readFixed,
  UNIT_PRICE_MAX,
  type InvoiceTotals,
} from "./money";
import { readDefaultPaymentTerms } from "./seller";
import { normalizePaymentTerms, textOrNull } from "./seller-fields";
import { defaultRateFor, isVatProfile, rateAllowed, suggestVatProfile, VAT_RATES, type VatProfile } from "./vat";

/**
 * INVOICE DRAFTS (Phase 4 slice 107; founder decision C75 (f), step 1).
 *
 * A draft belongs to ONE client, chosen when it is made and never changed
 * (the database holds it); it has no number, reads its client's billing
 * details live, and is edited freely until it is issued (slice 108). Every
 * verb is `requireAccess` → `assertInScope({ clientId })` — DIRECT client
 * assignment, as every client-level record: money is the client relationship,
 * and a member assigned only to one of the client's projects does not reach
 * its invoices — then the invoice locked `FOR UPDATE` and its status re-read
 * (a draft, or `INVOICE_NOT_DRAFT`), then the write, then the audit row, in
 * one transaction (AGENTS.md). Locking the invoice FIRST is the lock order the
 * migration's header asks of every writer: the line guard takes the invoice
 * after the line, and a writer that took a line before its invoice could
 * deadlock against one that did not.
 *
 * AUDIT, without a carve-out: `invoice.created`, `invoice.draft_edited` (the
 * fields, or the line operation and the line's id) and `invoice.draft_deleted`.
 *
 * MONEY is `money.ts`'s exact arithmetic; a draft's totals are computed on
 * read from its lines and are never stored (they are written, and checked by
 * the database, when it is issued).
 */

export type InvoicingCtx = { readonly tenantId: string; readonly actor: MemberActor };

const memberPrincipal = (ctx: InvoicingCtx) => ({ type: "member", id: ctx.actor.memberId }) as const;

/** At most this many lines on one invoice. */
export const LINE_LIMIT = 200;
/** At most this many invoices on the list; one past it is read to know there were more. */
export const INVOICE_LIST_LIMIT = 200;

export const LINE_TEXT_MAX = { description: 2000, unit: 20 } as const;
export const DETAIL_TEXT_MAX = { buyerReference: 100, ourReference: 100, note: 1000 } as const;

export type InvoiceStatus = "DRAFT" | "ISSUED" | "SENT" | "PAID" | "CREDITED";

export type InvoiceListRow = {
  readonly id: string;
  readonly status: InvoiceStatus;
  readonly displayNumber: string | null;
  readonly client: { readonly id: string; readonly name: string };
  readonly project: { readonly key: string; readonly name: string } | null;
  readonly currency: string;
  /** In hundredths; a draft's from its lines, an issued invoice's as stored. */
  readonly total: bigint;
  readonly createdAt: Date;
  readonly issueDate: Date | null;
};

export type InvoiceLineView = {
  readonly id: string;
  readonly position: number;
  readonly description: string;
  /** Thousandths. */
  readonly quantity: bigint;
  readonly unit: string | null;
  /** Hundredths. */
  readonly unitPrice: bigint;
  /** Hundredths of a percent. */
  readonly vatRate: bigint;
  /** Hundredths. */
  readonly amount: bigint;
};

export type BillTo = {
  readonly id: string;
  readonly name: string;
  readonly orgNr: string | null;
  readonly vatNumber: string | null;
  readonly vatProfile: VatProfile | null;
  readonly countryCode: string | null;
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  readonly postalCode: string | null;
  readonly city: string | null;
  readonly billingEmail: string | null;
  readonly archived: boolean;
};

export type InvoiceDetail = {
  readonly id: string;
  readonly status: InvoiceStatus;
  readonly displayNumber: string | null;
  readonly client: BillTo;
  readonly project: { readonly id: string; readonly key: string; readonly name: string } | null;
  readonly vatProfile: VatProfile;
  readonly currency: string;
  readonly paymentTermsDays: number;
  readonly periodStart: Date | null;
  readonly periodEnd: Date | null;
  readonly buyerReference: string | null;
  readonly ourReference: string | null;
  readonly note: string | null;
  readonly createdAt: Date;
  readonly lines: readonly InvoiceLineView[];
  readonly totals: InvoiceTotals;
  /** The client's live projects — the draft's project select — plus the draft's own if it was archived since (the current value is always offered). */
  readonly projects: readonly { readonly id: string; readonly key: string; readonly name: string; readonly archived?: boolean }[];
  readonly can: { readonly edit: boolean; readonly delete: boolean };
};

const lineSelect = {
  id: true,
  position: true,
  description: true,
  quantity: true,
  unit: true,
  unitPriceExVat: true,
  vatRatePct: true,
  amountExVat: true,
} as const;

type StoredLine = {
  id: string;
  position: number;
  description: string;
  quantity: { toFixed(dp: number): string };
  unit: string | null;
  unitPriceExVat: { toFixed(dp: number): string };
  vatRatePct: { toFixed(dp: number): string };
  amountExVat: { toFixed(dp: number): string };
};

const lineView = (l: StoredLine): InvoiceLineView => ({
  id: l.id,
  position: l.position,
  description: l.description,
  quantity: readFixed(l.quantity, 3),
  unit: l.unit,
  unitPrice: readFixed(l.unitPriceExVat, 2),
  vatRate: readFixed(l.vatRatePct, 2),
  amount: readFixed(l.amountExVat, 2),
});

/** `invoice:view` — the list, newest first, within the member's client scope. */
export async function listInvoices(
  ctx: InvoicingCtx,
  filter: { readonly clientId?: string | null } = {},
): Promise<{ readonly rows: readonly InvoiceListRow[]; readonly more: boolean }> {
  return withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "invoice:view");
    const scope = await scopeWhere(tx, ctx.actor, { clientField: "clientId" });
    const invoices = await tx.invoice.findMany({
      // AND, never a spread: the scope's own term IS a `clientId` key for a
      // scoped member, and spreading the filter after it REPLACED the scope
      // — `?client=<any id>` listed any client's invoices (the security
      // review's high).
      where: { AND: [scope, filter.clientId ? { clientId: filter.clientId } : {}] },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: INVOICE_LIST_LIMIT + 1,
      select: {
        id: true,
        status: true,
        displayNumber: true,
        currency: true,
        total: true,
        createdAt: true,
        issueDate: true,
        client: { select: { id: true, name: true } },
        project: { select: { key: true, name: true } },
      },
    });
    const more = invoices.length > INVOICE_LIST_LIMIT;
    invoices.splice(INVOICE_LIST_LIMIT);
    // A draft's total from its lines, summed per rate in the database (VAT
    // is per rate on the rate's sum, so the per-rate net is all it needs) —
    // never every line of 200 drafts read into memory.
    const draftIds = invoices.filter((i) => i.status === "DRAFT").map((i) => i.id);
    const sums =
      draftIds.length === 0
        ? []
        : await tx.invoiceLine.groupBy({
            by: ["invoiceId", "vatRatePct"],
            where: { invoiceId: { in: draftIds } },
            _sum: { amountExVat: true },
          });
    const linesOf = new Map<string, { amount: bigint; rate: bigint }[]>();
    for (const s of sums) {
      if (!s._sum.amountExVat) continue;
      const list = linesOf.get(s.invoiceId) ?? [];
      list.push({ amount: readFixed(s._sum.amountExVat, 2), rate: readFixed(s.vatRatePct, 2) });
      linesOf.set(s.invoiceId, list);
    }
    return {
      more,
      rows: invoices.map((i) => ({
        id: i.id,
        status: i.status,
        displayNumber: i.displayNumber,
        client: i.client,
        project: i.project,
        currency: i.currency,
        total: i.status === "DRAFT" || i.total === null ? invoiceTotals(linesOf.get(i.id) ?? []).total : readFixed(i.total, 2),
        createdAt: i.createdAt,
        issueDate: i.issueDate,
      })),
    };
  });
}

/** The clients a member may make a draft for: in scope, not archived — with their live projects. */
export async function listInvoiceableClients(
  ctx: InvoicingCtx,
): Promise<readonly { readonly id: string; readonly name: string; readonly projects: readonly { id: string; key: string; name: string }[] }[]> {
  return withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "invoice:create");
    const scope = await scopeWhere(tx, ctx.actor, { clientField: "id" });
    const clients = await tx.client.findMany({
      where: { ...scope, status: "ACTIVE" },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: 500,
      select: {
        id: true,
        name: true,
        projects: {
          where: { status: { not: "ARCHIVED" } },
          orderBy: [{ key: "asc" }],
          select: { id: true, key: true, name: true },
        },
      },
    });
    return clients;
  });
}

/** Lock the invoice and re-read it; a draft or a typed refusal. Scope is checked by the caller. */
async function lockDraft(
  tx: TenantDb,
  invoiceId: string,
): Promise<{ clientId: string; vatProfile: VatProfile }> {
  const rows = await tx.$queryRaw<{ client_id: string; status: string; vat_profile: string }[]>`
    SELECT client_id, status::text AS status, vat_profile::text AS vat_profile
    FROM invoice WHERE id = ${invoiceId} FOR UPDATE`;
  const row = rows[0];
  if (!row) return deny("NOT_FOUND");
  if (row.status !== "DRAFT") return fail("INVOICE_NOT_DRAFT");
  if (!isVatProfile(row.vat_profile)) throw new Error("lockDraft: an unknown VAT treatment");
  return { clientId: row.client_id, vatProfile: row.vat_profile };
}

/**
 * `invoice:edit` (or `create`, `delete`) on a draft: the gates, the lock, the
 * scope — in that order, so a member outside the client learns nothing about
 * the invoice's state (NOT_FOUND either way).
 */
async function openDraft(
  tx: TenantDb,
  ctx: InvoicingCtx,
  invoiceId: string,
  code: "invoice:edit" | "invoice:delete",
): Promise<{ clientId: string; vatProfile: VatProfile }> {
  await requireAccess(tx, ctx.tenantId, ctx.actor, code);
  const scoped = await tx.invoice.findFirst({ where: { id: invoiceId }, select: { clientId: true } });
  if (!scoped) return deny("NOT_FOUND");
  await assertInScope(tx, ctx.actor, { clientId: scoped.clientId });
  return lockDraft(tx, invoiceId);
}

/** `invoice:view` — one invoice, with its client's billing details read live. */
export async function getInvoice(ctx: InvoicingCtx, invoiceId: string): Promise<InvoiceDetail> {
  return withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "invoice:view");
    const invoice = await tx.invoice.findFirst({
      where: { id: invoiceId },
      select: {
        id: true,
        status: true,
        displayNumber: true,
        clientId: true,
        vatProfile: true,
        currency: true,
        paymentTermsDays: true,
        periodStart: true,
        periodEnd: true,
        buyerReference: true,
        ourReference: true,
        note: true,
        createdAt: true,
        project: { select: { id: true, key: true, name: true } },
      },
    });
    if (!invoice) return deny("NOT_FOUND");
    await assertInScope(tx, ctx.actor, { clientId: invoice.clientId });
    const client = await tx.client.findFirst({
      where: { id: invoice.clientId },
      select: {
        id: true,
        name: true,
        orgNr: true,
        vatNumber: true,
        vatProfile: true,
        countryCode: true,
        addressLine1: true,
        addressLine2: true,
        postalCode: true,
        city: true,
        billingEmail: true,
        status: true,
        projects: {
          where: { status: { not: "ARCHIVED" } },
          orderBy: [{ key: "asc" }],
          select: { id: true, key: true, name: true },
        },
      },
    });
    if (!client) return deny("NOT_FOUND");
    const lines = (
      await tx.invoiceLine.findMany({
        where: { invoiceId },
        orderBy: [{ position: "asc" }, { id: "asc" }],
        select: lineSelect,
      })
    ).map(lineView);
    // In turn, never a batch (AGENTS.md: a per-code check is never a leg).
    const draft = invoice.status === "DRAFT";
    const canEdit = draft && (await hasAccess(tx, ctx.tenantId, ctx.actor, "invoice:edit"));
    const canDelete = draft && (await hasAccess(tx, ctx.tenantId, ctx.actor, "invoice:delete"));
    const { projects: live, status, ...billTo } = client;
    // The draft's own project stays offered after it was archived, or the
    // select would show its raw id at rest and "No project" open (the code
    // review's low; `src/lib/inline-edit.ts`'s current-value rule).
    const own = invoice.project;
    const projects = own && !live.some((p) => p.id === own.id) ? [...live, { ...own, archived: true }] : live;
    return {
      id: invoice.id,
      status: invoice.status,
      displayNumber: invoice.displayNumber,
      client: { ...billTo, archived: status === "ARCHIVED" },
      project: invoice.project,
      vatProfile: invoice.vatProfile,
      currency: invoice.currency,
      paymentTermsDays: invoice.paymentTermsDays,
      periodStart: invoice.periodStart,
      periodEnd: invoice.periodEnd,
      buyerReference: invoice.buyerReference,
      ourReference: invoice.ourReference,
      note: invoice.note,
      createdAt: invoice.createdAt,
      lines,
      totals: invoiceTotals(lines.map((l) => ({ amount: l.amount, rate: l.vatRate }))),
      projects,
      can: { edit: canEdit, delete: canDelete },
    };
  });
}

/** A project of the client, live — or a typed refusal. */
async function assertProjectOfClient(tx: TenantDb, clientId: string, projectId: string): Promise<void> {
  const project = await tx.project.findFirst({
    where: { id: projectId, clientId },
    select: { status: true },
  });
  if (!project) return fail("CLIENT_MISMATCH");
  if (project.status === "ARCHIVED") return fail("ARCHIVED");
}

/**
 * `invoice:create` — a new draft for a client in scope, optionally on one of
 * its live projects. It starts from what this client was last invoiced in
 * (currency, payment terms) or the workspace's defaults; its VAT treatment from
 * the client record, or suggested from its country and VAT number; "our
 * reference" is the member who made it.
 */
export async function createDraft(
  ctx: InvoicingCtx,
  input: { readonly clientId: string; readonly projectId?: string | null },
): Promise<string> {
  return guarded(() =>
    withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "invoice:create");
      await assertInScope(tx, ctx.actor, { clientId: input.clientId });
      const client = await tx.client.findFirst({
        where: { id: input.clientId },
        select: { id: true, status: true, vatProfile: true, countryCode: true, vatNumber: true },
      });
      if (!client) return deny("NOT_FOUND");
      if (client.status === "ARCHIVED") return fail("ARCHIVED");
      if (input.projectId) await assertProjectOfClient(tx, client.id, input.projectId);
      const last = await tx.invoice.findFirst({
        where: { clientId: client.id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { currency: true, paymentTermsDays: true },
      });
      const prefs = await readPreferences(tx, ctx.tenantId);
      const paymentTermsDays = last?.paymentTermsDays ?? (await readDefaultPaymentTerms(tx, ctx.tenantId));
      const me = await tx.member.findFirst({ where: { id: ctx.actor.memberId }, select: { user: { select: { name: true } } } });
      const ourReference = me?.user.name?.trim().slice(0, DETAIL_TEXT_MAX.ourReference) || null;
      const created = await tx.invoice.create({
        data: {
          tenantId: ctx.tenantId,
          clientId: client.id,
          projectId: input.projectId ?? null,
          vatProfile: suggestVatProfile(client),
          currency: last?.currency ?? prefs.currencyDefault,
          paymentTermsDays,
          ourReference,
          createdByMemberId: ctx.actor.memberId,
        },
        select: { id: true },
      });
      await record(tx, {
        action: "invoice.created",
        targetType: "Invoice",
        targetId: created.id,
        metadata: { clientId: client.id, projectId: input.projectId ?? null },
      });
      return created.id;
    }),
  );
}

/** A date input's value — UTC midnight, the form's convention — or null. Years outside 2000–2199 are typos. */
function normalizeDay(raw: unknown): Date | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const d = raw instanceof Date ? raw : typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T00:00:00Z`) : null;
  if (!d || Number.isNaN(d.getTime())) return fail("INVALID_INPUT", "date");
  const year = d.getUTCFullYear();
  if (year < 2000 || year > 2199) return fail("INVALID_INPUT", "date");
  const day = new Date(d.getTime());
  day.setUTCHours(0, 0, 0, 0);
  return day;
}

export type DraftDetailsPatch = {
  readonly projectId?: string | null;
  readonly currency?: unknown;
  readonly paymentTermsDays?: unknown;
  readonly periodStart?: unknown;
  readonly periodEnd?: unknown;
  readonly buyerReference?: unknown;
  readonly ourReference?: unknown;
  readonly note?: unknown;
};

/** `invoice:edit` — the draft's details; only the fields present are written. Returns what changed. */
export async function updateDraftDetails(ctx: InvoicingCtx, invoiceId: string, patch: DraftDetailsPatch): Promise<string[]> {
  const data: Record<string, unknown> = {};
  if ("currency" in patch) {
    const c = typeof patch.currency === "string" ? patch.currency.trim().toUpperCase() : "";
    if (!(CURRENCIES as readonly string[]).includes(c)) return fail("INVALID_INPUT", "currency");
    data.currency = c;
  }
  if ("paymentTermsDays" in patch) {
    const terms = normalizePaymentTerms(patch.paymentTermsDays);
    if (terms === null) return fail("INVALID_INPUT", "payment terms");
    data.paymentTermsDays = terms;
  }
  if ("periodStart" in patch) data.periodStart = normalizeDay(patch.periodStart);
  if ("periodEnd" in patch) data.periodEnd = normalizeDay(patch.periodEnd);
  if ("buyerReference" in patch) data.buyerReference = textOrNull(patch.buyerReference, DETAIL_TEXT_MAX.buyerReference);
  if ("ourReference" in patch) data.ourReference = textOrNull(patch.ourReference, DETAIL_TEXT_MAX.ourReference);
  if ("note" in patch) data.note = textOrNull(patch.note, DETAIL_TEXT_MAX.note);
  if ("projectId" in patch) data.projectId = patch.projectId || null;

  return guarded(() =>
    withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
      const { clientId } = await openDraft(tx, ctx, invoiceId, "invoice:edit");
      if (typeof data.projectId === "string") await assertProjectOfClient(tx, clientId, data.projectId);
      const current = await tx.invoice.findFirst({
        where: { id: invoiceId },
        select: {
          projectId: true,
          currency: true,
          paymentTermsDays: true,
          periodStart: true,
          periodEnd: true,
          buyerReference: true,
          ourReference: true,
          note: true,
        },
      });
      if (!current) return deny("NOT_FOUND");
      const same = (a: unknown, b: unknown) =>
        a instanceof Date || b instanceof Date ? (a as Date | null)?.getTime() === (b as Date | null)?.getTime() : a === b;
      const changed = Object.keys(data).filter((k) => !same(data[k], current[k as keyof typeof current]));
      if (changed.length === 0) return [];
      const start = (changed.includes("periodStart") ? data.periodStart : current.periodStart) as Date | null;
      const end = (changed.includes("periodEnd") ? data.periodEnd : current.periodEnd) as Date | null;
      if (start && end && start.getTime() > end.getTime()) return fail("INVALID_INPUT", "period");
      await tx.invoice.update({
        where: { id: invoiceId },
        data: Object.fromEntries(changed.map((k) => [k, data[k]])),
        select: { id: true },
      });
      await record(tx, {
        action: "invoice.draft_edited",
        targetType: "Invoice",
        targetId: invoiceId,
        metadata: { fields: changed },
      });
      return changed;
    }),
  );
}

/**
 * `invoice:edit` — the draft's VAT treatment. Every line whose rate the new
 * treatment does not have takes its default (Swedish VAT → 25 %, the others
 * → 0 %); a line already at an allowed rate keeps it. The page asks first
 * when a line at 12 or 6 % would lose its rate (the design review's low).
 * Returns how many lines changed rate.
 */
export async function setDraftVatProfile(ctx: InvoicingCtx, invoiceId: string, raw: unknown): Promise<number> {
  if (!isVatProfile(raw)) return fail("INVALID_INPUT", "vat profile");
  const profile = raw;
  return guarded(() =>
    withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
      const current = await openDraft(tx, ctx, invoiceId, "invoice:edit");
      if (current.vatProfile === profile) return 0;
      // The invoice first, then its lines: the line guard checks each new
      // rate against the treatment the invoice now has.
      await tx.invoice.update({ where: { id: invoiceId }, data: { vatProfile: profile }, select: { id: true } });
      const allowed = VAT_RATES[profile].map((r) => formatFixed(r, 2));
      const moved = await tx.invoiceLine.updateMany({
        where: { invoiceId, vatRatePct: { notIn: allowed } },
        data: { vatRatePct: formatFixed(defaultRateFor(profile), 2) },
      });
      await record(tx, {
        action: "invoice.draft_edited",
        targetType: "Invoice",
        targetId: invoiceId,
        metadata: { fields: ["vatProfile"], vatProfile: profile, linesChanged: moved.count },
      });
      return moved.count;
    }),
  );
}

export type LineInput = {
  readonly description?: unknown;
  readonly quantity?: unknown;
  readonly unit?: unknown;
  readonly unitPrice?: unknown;
  /** A whole or decimal percent ("25", "12", "6", "0"). */
  readonly vatRate?: unknown;
};

/**
 * How the member types decimals: with `decimalComma` (their language is
 * Swedish) "1,333" is 1.333, the text the lines table shows; without it an
 * ambiguous "1,000" is refused (`parseFixed`).
 */
export type LineParse = { readonly decimalComma?: boolean };

const parseQuantity = (raw: unknown, decimalComma = false): bigint => {
  const q = parseFixed(raw, 3, "quantity", { decimalComma });
  if (q === null || q <= 0n || q > QUANTITY_MAX) return fail("INVALID_INPUT", "quantity");
  return q;
};

const parseUnitPrice = (raw: unknown, decimalComma = false): bigint => {
  const p = parseFixed(raw, 2, "unit price", { decimalComma });
  if (p === null) return fail("INVALID_INPUT", "unit price");
  if (p > UNIT_PRICE_MAX || p < -UNIT_PRICE_MAX) return fail("INVOICE_AMOUNT_TOO_LARGE");
  return p;
};

const parseRate = (raw: unknown, profile: VatProfile): bigint => {
  const r = parseFixed(raw, 2, "vat rate");
  if (r === null) return fail("INVALID_INPUT", "vat rate");
  if (!rateAllowed(profile, r)) return fail("INVOICE_RATE_NOT_ALLOWED");
  return r;
};

const parseDescription = (raw: unknown): string => {
  const d = textOrNull(raw, LINE_TEXT_MAX.description);
  if (d === null) return fail("INVOICE_LINE_DESCRIPTION_REQUIRED");
  return d;
};

/** The line's amount, refused past what one line may hold. */
const amountOf = (quantity: bigint, unitPrice: bigint): bigint => {
  const amount = lineAmount(quantity, unitPrice);
  if (amount > LINE_AMOUNT_MAX || amount < -LINE_AMOUNT_MAX) return fail("INVOICE_AMOUNT_TOO_LARGE");
  return amount;
};

/**
 * `invoice:edit` — add a line at the end. Only the description is needed
 * (title-only creation, UI rule 2): one of whatever it is, at no price, at
 * the treatment's default rate, until the member edits it.
 */
export async function addLine(ctx: InvoicingCtx, invoiceId: string, input: LineInput, parse: LineParse = {}): Promise<string> {
  return guarded(() =>
    withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
      const { clientId, vatProfile } = await openDraft(tx, ctx, invoiceId, "invoice:edit");
      const description = parseDescription(input.description);
      const quantity = input.quantity === undefined ? 1000n : parseQuantity(input.quantity, parse.decimalComma);
      const unitPrice = input.unitPrice === undefined ? 0n : parseUnitPrice(input.unitPrice, parse.decimalComma);
      const vatRate = input.vatRate === undefined ? defaultRateFor(vatProfile) : parseRate(input.vatRate, vatProfile);
      const unit = textOrNull(input.unit, LINE_TEXT_MAX.unit);
      const amount = amountOf(quantity, unitPrice);
      const stats = await tx.invoiceLine.aggregate({
        where: { invoiceId },
        _count: { _all: true },
        _max: { position: true },
      });
      if (stats._count._all >= LINE_LIMIT) return fail("INVOICE_LINE_LIMIT");
      const created = await tx.invoiceLine.create({
        data: {
          tenantId: ctx.tenantId,
          clientId,
          invoiceId,
          position: (stats._max.position ?? 0) + 1,
          description,
          quantity: formatFixed(quantity, 3),
          unit,
          unitPriceExVat: formatFixed(unitPrice, 2),
          vatRatePct: formatFixed(vatRate, 2),
          amountExVat: formatFixed(amount, 2),
        },
        select: { id: true },
      });
      await record(tx, {
        action: "invoice.draft_edited",
        targetType: "Invoice",
        targetId: invoiceId,
        metadata: { op: "line_added", lineId: created.id },
      });
      return created.id;
    }),
  );
}

/** `invoice:edit` — change one line; only the fields present. Returns what changed. */
export async function updateLine(
  ctx: InvoicingCtx,
  invoiceId: string,
  lineId: string,
  patch: LineInput,
  parse: LineParse = {},
): Promise<string[]> {
  return guarded(() =>
    withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
      const { vatProfile } = await openDraft(tx, ctx, invoiceId, "invoice:edit");
      const stored = await tx.invoiceLine.findFirst({ where: { id: lineId, invoiceId }, select: lineSelect });
      if (!stored) return deny("NOT_FOUND");
      const line = lineView(stored);
      const next = {
        description: "description" in patch ? parseDescription(patch.description) : line.description,
        quantity: "quantity" in patch ? parseQuantity(patch.quantity, parse.decimalComma) : line.quantity,
        unit: "unit" in patch ? textOrNull(patch.unit, LINE_TEXT_MAX.unit) : line.unit,
        unitPrice: "unitPrice" in patch ? parseUnitPrice(patch.unitPrice, parse.decimalComma) : line.unitPrice,
        vatRate: "vatRate" in patch ? parseRate(patch.vatRate, vatProfile) : line.vatRate,
      };
      const changed = (["description", "quantity", "unit", "unitPrice", "vatRate"] as const).filter((k) => next[k] !== line[k]);
      if (changed.length === 0) return [];
      const amount = amountOf(next.quantity, next.unitPrice);
      await tx.invoiceLine.update({
        where: { id: lineId },
        data: {
          description: next.description,
          quantity: formatFixed(next.quantity, 3),
          unit: next.unit,
          unitPriceExVat: formatFixed(next.unitPrice, 2),
          vatRatePct: formatFixed(next.vatRate, 2),
          amountExVat: formatFixed(amount, 2),
        },
        select: { id: true },
      });
      await record(tx, {
        action: "invoice.draft_edited",
        targetType: "Invoice",
        targetId: invoiceId,
        metadata: { op: "line_edited", lineId, fields: changed },
      });
      return changed;
    }),
  );
}

/** `invoice:edit` — remove one line. */
export async function removeLine(ctx: InvoicingCtx, invoiceId: string, lineId: string): Promise<void> {
  await guarded(() =>
    withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
      await openDraft(tx, ctx, invoiceId, "invoice:edit");
      const gone = await tx.invoiceLine.deleteMany({ where: { id: lineId, invoiceId } });
      if (gone.count === 0) return deny("NOT_FOUND");
      await record(tx, {
        action: "invoice.draft_edited",
        targetType: "Invoice",
        targetId: invoiceId,
        metadata: { op: "line_removed", lineId },
      });
    }),
  );
}

/**
 * `invoice:edit` — move a line one place up or down. The two positions swap
 * through the transient slot 0 (the unique on position is checked per row,
 * so a direct swap would collide). A line already first or last stays put.
 */
export async function moveLine(ctx: InvoicingCtx, invoiceId: string, lineId: string, direction: "up" | "down"): Promise<boolean> {
  return guarded(() =>
    withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
      await openDraft(tx, ctx, invoiceId, "invoice:edit");
      const line = await tx.invoiceLine.findFirst({ where: { id: lineId, invoiceId }, select: { id: true, position: true } });
      if (!line) return deny("NOT_FOUND");
      const neighbour = await tx.invoiceLine.findFirst({
        where: { invoiceId, position: direction === "up" ? { lt: line.position } : { gt: line.position } },
        orderBy: { position: direction === "up" ? "desc" : "asc" },
        select: { id: true, position: true },
      });
      if (!neighbour) return false;
      await tx.invoiceLine.update({ where: { id: line.id }, data: { position: 0 }, select: { id: true } });
      await tx.invoiceLine.update({ where: { id: neighbour.id }, data: { position: line.position }, select: { id: true } });
      await tx.invoiceLine.update({ where: { id: line.id }, data: { position: neighbour.position }, select: { id: true } });
      await record(tx, {
        action: "invoice.draft_edited",
        targetType: "Invoice",
        targetId: invoiceId,
        metadata: { op: "line_moved", lineId, direction },
      });
      return true;
    }),
  );
}

/** `invoice:delete` — delete a draft and its lines. An issued invoice is never deleted. */
export async function deleteDraft(ctx: InvoicingCtx, invoiceId: string): Promise<void> {
  await guarded(() =>
    withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
      const { clientId } = await openDraft(tx, ctx, invoiceId, "invoice:delete");
      await tx.invoice.delete({ where: { id: invoiceId }, select: { id: true } });
      await record(tx, {
        action: "invoice.draft_deleted",
        targetType: "Invoice",
        targetId: invoiceId,
        metadata: { clientId },
      });
    }),
  );
}

import { record } from "@/audit/record";
import { assertInScope, scopeWhere, type MemberActor } from "@/authz/authorize";
import { deny } from "@/authz/errors";
import { payLinkUrl } from "@/config";
import { withTenant, type TenantDb } from "@/db";
import { hasAccess, requireAccess } from "@/entitlements/resolver";
import { fail } from "@/lib/domain-error";
import { todayIn } from "@/lib/due-date";
import { CURRENCIES, readPreferences } from "@/preferences/service";

import { readCreditedNets, readCreditNotes, readInvoiceNets, type CreditNoteSummary } from "./credit-state";
import { guarded } from "./db-errors";
import { hoursPagePrint, type HoursPagePrint } from "./hours-page";
import { readInvoiceHours, readLiveHoursPage, releaseDraftHours, type InvoiceHours } from "./hours-record";
import { readIssueCheck, readIssueFingerprint, type IssueCheckSeen } from "./issue";
import { creditCovers, type RateNets } from "./issue-check";
import { readBuyerSnapshot, readIssuedInvoice, SnapshotUnreadable, type IssuedInvoice } from "./issued";
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
import { invoiceLocaleFor, isInvoiceLocale, isoDay, type BuyerPrint, type InvoiceLocale } from "./print";
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

export type InvoiceKind = "INVOICE" | "CREDIT_NOTE";

export type InvoiceListRow = {
  readonly id: string;
  readonly kind: InvoiceKind;
  readonly status: InvoiceStatus;
  readonly displayNumber: string | null;
  readonly client: { readonly id: string; readonly name: string };
  readonly project: { readonly key: string; readonly name: string } | null;
  readonly currency: string;
  /** In hundredths; a draft's from its lines, an issued invoice's as stored — a credit note's POSITIVE (print it with `signed`). */
  readonly total: bigint;
  readonly createdAt: Date;
  readonly issueDate: Date | null;
  /** Slice 109: an unpaid INVOICE past its due date in the workspace's zone — derived, never a status. */
  readonly overdue: boolean;
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

/** What an issued invoice has been credited (slice 108b) — its page's "Credit notes" card. */
export type CreditSummary = {
  readonly notes: readonly CreditNoteSummary[];
  /** Per VAT rate: the invoice's net and what its issued credit notes have credited. */
  readonly original: RateNets;
  readonly credited: RateNets;
  /** Some credited, not all of it — derived, never a status. */
  readonly partly: boolean;
};

export type InvoiceDetail = {
  readonly id: string;
  readonly kind: InvoiceKind;
  readonly status: InvoiceStatus;
  readonly displayNumber: string | null;
  /** A credit note's invoice, and why it credits it. */
  readonly credits: { readonly id: string; readonly displayNumber: string | null; readonly issueDate: string | null } | null;
  readonly creditReason: string | null;
  /** An issued INVOICE: its credit notes and what is left (slice 108b). */
  readonly creditSummary: CreditSummary | null;
  /** A credit note's DRAFT: what is left of its invoice to credit, per rate (its issued credit notes taken off). */
  readonly creditLeft: RateNets | null;
  /** A credit note's DRAFT: the buyer as its invoice named them — what it will print (null if unreadable). */
  readonly creditsBuyer: BuyerPrint | null;
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
  /** The draft's own language choice, or null — the client's (C76 (e)). */
  readonly locale: InvoiceLocale | null;
  /** The language the client's invoices take when the draft makes no choice. */
  readonly clientLocale: InvoiceLocale;
  /** A draft: what issuing it still needs and would give (slice 108). */
  readonly issueCheck: IssueCheckSeen | null;
  /** Issued: the frozen record, as printed. */
  readonly issued: IssuedInvoice | null;
  /** Slice 109 (C79 (c)): the Pay now link — a draft's to edit, fixed at issue. */
  readonly payLinkUrl: string | null;
  /** Slice 109: the FIRST send (emailed or marked) — what opens the client's portal to it. */
  readonly sentAt: Date | null;
  /** Every send, newest first. */
  readonly deliveries: readonly InvoiceDeliveryView[];
  /** Marked paid by hand (C79 (d)): the day the money arrived, and the agency's note. */
  readonly paidOn: Date | null;
  readonly paymentNote: string | null;
  /** An unpaid INVOICE past its due date in the workspace's zone. */
  readonly overdue: boolean;
  /** Issued: today in the workspace's zone, `YYYY-MM-DD` — Mark as paid's first day and its latest. */
  readonly today: string | null;
  /** The client's billing email is on the blocked list (bounced, or reported) — the send dialog says so. */
  readonly billingEmailBlocked: boolean;
  /** An issued credit note not yet sent whose invoice WAS sent: the client has the invoice, not its correction. */
  readonly creditUnsent: boolean;
  /** Issued: by whom (null when the member is gone) and when — what the owners' Pay now notice points at. */
  readonly issuedBy: { readonly name: string | null; readonly at: Date } | null;
  /** Slice 110: the tracked hours its lines billed, and where each is now — null when none. */
  readonly hours: InvoiceHours | null;
  /** Slice 110b (C80 (d)): the time breakdown is ticked — a draft field, fixed at issue. */
  readonly includeHours: boolean;
  /**
   * The time breakdown as the client's PDF prints it: a ticked DRAFT's, from
   * the database's own function now (what issuing it would freeze); an issued
   * invoice's, as frozen. Null when not ticked or there are no hours.
   */
  readonly hoursPage: HoursPagePrint | null;
  readonly can: {
    readonly edit: boolean;
    readonly delete: boolean;
    readonly issue: boolean;
    /** Credit… on an issued invoice (slice 108b). */
    readonly credit: boolean;
    /** …with a corrected copy: `invoice:create` too. */
    readonly copy: boolean;
    /** Slice 109: Send… / Send again… (`invoice:send`). */
    readonly send: boolean;
    /** Mark as sent — until it has been sent. */
    readonly markSent: boolean;
    /** Mark as paid… (`invoice:record_payment`) — an unpaid INVOICE. */
    readonly markPaid: boolean;
    /** Mark as unpaid (C79 (h)) — a PAID invoice. */
    readonly markUnpaid: boolean;
    /** Slice 110: Add hours… — an INVOICE draft, `invoice:edit` + `invoice:generate_from_time`. */
    readonly addHours: boolean;
    /**
     * Return hours to "not invoiced" by hand (C80 (f)) — an issued invoice with
     * an issued credit note, not credited in full, still holding hours;
     * `invoice:generate_from_time` + `invoice:credit`.
     */
    readonly returnHours: boolean;
  };
};

/** One send of an invoice (slice 109): emailed to whom, or marked — when, by whom. */
export type InvoiceDeliveryView = {
  readonly id: string;
  readonly method: "EMAIL" | "MARKED";
  readonly recipients: readonly string[];
  readonly at: Date;
  /** The member's name, or null when they are gone. */
  readonly by: string | null;
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
        kind: true,
        status: true,
        displayNumber: true,
        currency: true,
        total: true,
        createdAt: true,
        issueDate: true,
        dueDate: true,
        client: { select: { id: true, name: true } },
        project: { select: { key: true, name: true } },
      },
    });
    const today = todayIn((await readPreferences(tx, ctx.tenantId)).timezone, new Date());
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
        kind: i.kind,
        status: i.status,
        displayNumber: i.displayNumber,
        client: i.client,
        project: i.project,
        currency: i.currency,
        total: i.status === "DRAFT" || i.total === null ? invoiceTotals(linesOf.get(i.id) ?? []).total : readFixed(i.total, 2),
        createdAt: i.createdAt,
        issueDate: i.issueDate,
        overdue:
          i.kind === "INVOICE" && (i.status === "ISSUED" || i.status === "SENT") && i.dueDate !== null && isoDay(i.dueDate) < today,
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

export type LockedDraft = { clientId: string; vatProfile: VatProfile; kind: InvoiceKind; creditsInvoiceId: string | null };

/** Lock the invoice and re-read it; a draft or a typed refusal. Scope is checked by the caller. */
async function lockDraft(tx: TenantDb, invoiceId: string): Promise<LockedDraft> {
  const rows = await tx.$queryRaw<{ client_id: string; status: string; vat_profile: string; kind: string; credits_invoice_id: string | null }[]>`
    SELECT client_id, status::text AS status, vat_profile::text AS vat_profile, kind::text AS kind, credits_invoice_id
    FROM invoice WHERE id = ${invoiceId} FOR UPDATE`;
  const row = rows[0];
  if (!row) return deny("NOT_FOUND");
  if (row.status !== "DRAFT") return fail("INVOICE_NOT_DRAFT");
  if (!isVatProfile(row.vat_profile)) throw new Error("lockDraft: an unknown VAT treatment");
  return {
    clientId: row.client_id,
    vatProfile: row.vat_profile,
    kind: row.kind === "CREDIT_NOTE" ? "CREDIT_NOTE" : "INVOICE",
    creditsInvoiceId: row.credits_invoice_id,
  };
}

/**
 * The VAT rates a CREDIT NOTE's lines may take: its invoice's, highest first
 * (the code review's low — a new line defaulted to 25 % on a 12 %-only
 * invoice and blocked the issue with a rate nothing could credit). Null for
 * an invoice, whose rates are its treatment's.
 */
async function creditRatesOf(tx: TenantDb, locked: LockedDraft): Promise<bigint[] | null> {
  if (locked.kind !== "CREDIT_NOTE" || !locked.creditsInvoiceId) return null;
  const rows = await tx.invoiceLine.findMany({
    where: { invoiceId: locked.creditsInvoiceId },
    distinct: ["vatRatePct"],
    select: { vatRatePct: true },
  });
  return rows.map((r) => readFixed(r.vatRatePct, 2)).sort((a, b) => (a === b ? 0 : a > b ? -1 : 1));
}

/**
 * `invoice:edit` (or `create`, `delete`) on a draft: the gates, the lock, the
 * scope — in that order, so a member outside the client learns nothing about
 * the invoice's state (NOT_FOUND either way). A CREDIT NOTE's draft also
 * takes `invoice:credit` (slice 108b; A4) — here, keyed on the kind the lock
 * read, so no verb can forget it (the design review's low).
 */
export async function openDraft(
  tx: TenantDb,
  ctx: InvoicingCtx,
  invoiceId: string,
  code: "invoice:edit" | "invoice:delete",
): Promise<LockedDraft> {
  await requireAccess(tx, ctx.tenantId, ctx.actor, code);
  const scoped = await tx.invoice.findFirst({ where: { id: invoiceId }, select: { clientId: true } });
  if (!scoped) return deny("NOT_FOUND");
  await assertInScope(tx, ctx.actor, { clientId: scoped.clientId });
  const locked = await lockDraft(tx, invoiceId);
  if (locked.kind === "CREDIT_NOTE") await requireAccess(tx, ctx.tenantId, ctx.actor, "invoice:credit");
  return locked;
}

/** "Our reference" on a new draft: the member who made it, by name. */
export async function ourReferenceOf(tx: TenantDb, memberId: string): Promise<string | null> {
  const me = await tx.member.findFirst({ where: { id: memberId }, select: { user: { select: { name: true } } } });
  return me?.user.name?.trim().slice(0, DETAIL_TEXT_MAX.ourReference) || null;
}

/** `invoice:view` — one invoice, with its client's billing details read live. */
export async function getInvoice(ctx: InvoicingCtx, invoiceId: string): Promise<InvoiceDetail> {
  return withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "invoice:view");
    // The scope from a minimal read; then, for a draft this member may issue,
    // the fingerprint of what the page is about to show — read BEFORE any of
    // it, so an edit landing between the two reads is refused at issue rather
    // than issued unseen (the fix-pass re-check's low: each statement is its
    // own snapshot under READ COMMITTED).
    const scoped = await tx.invoice.findFirst({ where: { id: invoiceId }, select: { clientId: true, status: true, kind: true } });
    if (!scoped) return deny("NOT_FOUND");
    await assertInScope(tx, ctx.actor, { clientId: scoped.clientId });
    // In turn, never a batch (AGENTS.md: a per-code check is never a leg).
    // A credit note's draft is only for a member who may credit (slice 108b;
    // the design review's low: every `can` below follows it).
    const isCreditNote = scoped.kind === "CREDIT_NOTE";
    const mayCredit = await hasAccess(tx, ctx.tenantId, ctx.actor, "invoice:credit");
    const mayIssueAny = await hasAccess(tx, ctx.tenantId, ctx.actor, "invoice:issue");
    const mayIssue = scoped.status === "DRAFT" && mayIssueAny && (!isCreditNote || mayCredit);
    const seen = mayIssue ? await readIssueFingerprint(tx, invoiceId) : null;
    const invoice = await tx.invoice.findFirst({
      where: { id: invoiceId },
      select: {
        id: true,
        kind: true,
        creditsInvoiceId: true,
        creditReason: true,
        status: true,
        displayNumber: true,
        total: true,
        clientId: true,
        vatProfile: true,
        currency: true,
        paymentTermsDays: true,
        periodStart: true,
        periodEnd: true,
        buyerReference: true,
        ourReference: true,
        note: true,
        locale: true,
        createdAt: true,
        payLinkUrl: true,
        sentAt: true,
        paidOn: true,
        includeHours: true,
        // The agency's note on the payment — its own class-A row (slice 109's
        // pre-apply review): `invoice` is a client's to read once sent.
        paymentNote: { select: { note: true } },
        dueDate: true,
        project: { select: { id: true, key: true, name: true } },
      },
    });
    if (!invoice || invoice.clientId !== scoped.clientId) return deny("NOT_FOUND");
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
        invoiceLocale: true,
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
    const kindAllows = !isCreditNote || mayCredit;
    const canEdit = draft && kindAllows && (await hasAccess(tx, ctx.tenantId, ctx.actor, "invoice:edit"));
    const canDelete = draft && kindAllows && (await hasAccess(tx, ctx.tenantId, ctx.actor, "invoice:delete"));
    const canIssue = draft && mayIssue;
    // A draft: what issuing needs (only for someone who may issue it); an
    // issued invoice: its frozen record, the bank details read tolerantly
    // (an unreadable one says so on the page; the PDF reads strictly).
    const issueCheck = canIssue && seen ? await readIssueCheck(tx, ctx.tenantId, invoiceId, new Date(), seen) : null;
    const issued = draft ? null : await readIssuedInvoice(tx, ctx.tenantId, invoiceId, { strict: false });
    // Slice 108b. A credit note: the invoice it credits (and, while a draft,
    // what is left of it per rate). An issued invoice: its credit notes.
    let credits: InvoiceDetail["credits"] = null;
    let creditLeft: RateNets | null = null;
    let creditsBuyer: BuyerPrint | null = null;
    let creditSummary: CreditSummary | null = null;
    let creditUnsent = false;
    if (isCreditNote && invoice.creditsInvoiceId) {
      const original = await tx.invoice.findFirst({
        where: { id: invoice.creditsInvoiceId },
        select: { id: true, displayNumber: true, issueDate: true, buyerSnapshot: true, sentAt: true },
      });
      if (original) credits = { id: original.id, displayNumber: original.displayNumber, issueDate: original.issueDate ? isoDay(original.issueDate) : null };
      // Slice 109 (the design review's M1): the client has the invoice but not
      // this correction of it — the page says so, beside Send….
      creditUnsent = !draft && invoice.sentAt === null && original?.sentAt != null;
      // Who a credit note's draft bills: the parties as its invoice named
      // them (the guard copies that snapshot at issue), never the live client.
      if (draft && original) {
        try {
          creditsBuyer = readBuyerSnapshot(original.buyerSnapshot);
        } catch (e) {
          if (!(e instanceof SnapshotUnreadable)) throw e;
        }
      }
      if (draft && original) {
        const own = await readInvoiceNets(tx, original.id);
        const done = await readCreditedNets(tx, original.id);
        // Highest rate first, as the totals list them.
        creditLeft = new Map(
          [...own].sort(([a], [b]) => (a === b ? 0 : a > b ? -1 : 1)).map(([rate, net]) => [rate, net - (done.get(rate) ?? 0n)]),
        );
      }
    } else if (!draft) {
      const notes = await readCreditNotes(tx, invoice.id);
      const own = await readInvoiceNets(tx, invoice.id);
      const done = await readCreditedNets(tx, invoice.id);
      creditSummary = { notes, original: own, credited: done, partly: done.size > 0 && !creditCovers(own, done) };
    }
    const creditable = invoice.status === "ISSUED" || invoice.status === "SENT" || invoice.status === "PAID";
    // Something to credit: an invoice of nothing never can be (a credit
    // note's total is above zero — the code review's low).
    const positive = invoice.total !== null && readFixed(invoice.total, 2) > 0n;
    const canCredit =
      !isCreditNote && creditable && positive && mayCredit && mayIssueAny && creditSummary !== null && !creditCovers(creditSummary.original, creditSummary.credited);
    // The corrected copy is a new draft: `invoice:create` (the code review's low).
    const canCopy = canCredit && (await hasAccess(tx, ctx.tenantId, ctx.actor, "invoice:create"));

    // Slice 109 (C79): sending and payments. In turn, never a batch.
    const mayRecordPayment = !draft && (await hasAccess(tx, ctx.tenantId, ctx.actor, "invoice:record_payment"));
    const canSend = !draft && (await hasAccess(tx, ctx.tenantId, ctx.actor, "invoice:send"));
    const issuer = issued
      ? await tx.member.findFirst({ where: { id: issued.issuedByMemberId }, select: { user: { select: { name: true } } } })
      : null;
    const issuedBy = issued ? { name: issuer?.user.name?.trim() || null, at: issued.issuedAt } : null;
    const unpaid = !isCreditNote && (invoice.status === "ISSUED" || invoice.status === "SENT");
    const prefs = !draft ? await readPreferences(tx, ctx.tenantId) : null;
    const today = prefs !== null ? todayIn(prefs.timezone, new Date()) : null;
    const overdue = unpaid && today !== null && invoice.dueDate !== null && isoDay(invoice.dueDate) < today;
    const deliveries: InvoiceDeliveryView[] = [];
    if (!draft) {
      const rows = await tx.invoiceDelivery.findMany({
        where: { invoiceId: invoice.id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 50,
        select: { id: true, method: true, recipients: true, createdAt: true, sentByMemberId: true },
      });
      const names = new Map(
        (
          await tx.member.findMany({
            where: { id: { in: [...new Set(rows.map((r) => r.sentByMemberId))] } },
            select: { id: true, user: { select: { name: true } } },
          })
        ).map((m) => [m.id, m.user.name?.trim() || null]),
      );
      for (const r of rows) {
        deliveries.push({ id: r.id, method: r.method, recipients: r.recipients, at: r.createdAt, by: names.get(r.sentByMemberId) ?? null });
      }
    }
    // The client's billing email on the blocked list (C71 (d) — never why).
    const billingEmailBlocked =
      canSend && client.billingEmail !== null
        ? (await tx.emailSuppression.count({ where: { email: client.billingEmail.toLowerCase() } })) > 0
        : false;

    // Slice 110: the hours its lines billed (the record, and each one's mark
    // now — never its edits, C80 (e)). In turn, never a batch.
    const hours = await readInvoiceHours(tx, ctx.tenantId, invoice.id);
    const mayGenerate = await hasAccess(tx, ctx.tenantId, ctx.actor, "invoice:generate_from_time");
    const canAddHours = canEdit && !isCreditNote && mayGenerate;
    const partlyCredited = !isCreditNote && creditSummary !== null && creditSummary.notes.some((n) => n.status !== "DRAFT");
    const canReturnHours =
      hours !== null && hours.here > 0 && partlyCredited && invoice.status !== "CREDITED" && mayGenerate && mayCredit;
    // Slice 110b: the time breakdown — a ticked draft's from the database's
    // function (the guard's own), an issued invoice's as frozen.
    const live =
      draft && invoice.includeHours && !isCreditNote
        ? await readLiveHoursPage(tx, ctx.tenantId, invoice.id, new Set(lines.map((l) => l.id)))
        : null;
    const hoursPage = issued ? issued.print.hoursPage : live ? hoursPagePrint(live, lines) : null;

    const { projects: liveProjects, status, invoiceLocale, ...billTo } = client;
    // The draft's own project stays offered after it was archived, or the
    // select would show its raw id at rest and "No project" open (the code
    // review's low; `src/lib/inline-edit.ts`'s current-value rule).
    const own = invoice.project;
    const projects = own && !liveProjects.some((p) => p.id === own.id) ? [...liveProjects, { ...own, archived: true }] : liveProjects;
    return {
      id: invoice.id,
      kind: invoice.kind,
      status: invoice.status,
      displayNumber: invoice.displayNumber,
      credits,
      creditReason: invoice.creditReason,
      creditSummary,
      creditLeft,
      creditsBuyer,
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
      locale: isInvoiceLocale(invoice.locale) ? invoice.locale : null,
      clientLocale: invoiceLocaleFor({ invoiceLocale, countryCode: billTo.countryCode }),
      issueCheck,
      issued,
      payLinkUrl: invoice.payLinkUrl,
      sentAt: invoice.sentAt,
      deliveries,
      paidOn: invoice.paidOn,
      paymentNote: invoice.paymentNote?.note ?? null,
      overdue,
      today,
      billingEmailBlocked,
      creditUnsent,
      issuedBy,
      hours,
      includeHours: invoice.includeHours,
      hoursPage,
      can: {
        edit: canEdit,
        delete: canDelete,
        issue: canIssue,
        credit: canCredit,
        copy: canCopy,
        send: canSend,
        markSent: canSend && invoice.sentAt === null,
        markPaid: mayRecordPayment && unpaid,
        markUnpaid: mayRecordPayment && !isCreditNote && invoice.status === "PAID",
        addHours: canAddHours,
        returnHours: canReturnHours,
      },
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
      return writeDraft(tx, ctx, input);
    }),
  );
}

/**
 * The draft itself, inside the caller's transaction, after its gates
 * (`invoice:create`, the client in scope): the client live and not archived,
 * the project one of its live ones. `currency` — slice 110's "Create invoice"
 * from hours priced in it — overrides the client's last; nothing else differs.
 */
export async function writeDraft(
  tx: TenantDb,
  ctx: InvoicingCtx,
  input: { readonly clientId: string; readonly projectId?: string | null; readonly currency?: string | null },
): Promise<string> {
  const client = await tx.client.findFirst({
    where: { id: input.clientId },
    select: { id: true, status: true, vatProfile: true, countryCode: true, vatNumber: true },
  });
  if (!client) return deny("NOT_FOUND");
  if (client.status === "ARCHIVED") return fail("ARCHIVED");
  if (input.projectId) await assertProjectOfClient(tx, client.id, input.projectId);
  // The client's last INVOICE — never a credit note, whose terms are
  // always none (the design review's medium: a part credit made the next
  // invoice due on its date).
  const last = await tx.invoice.findFirst({
    where: { clientId: client.id, kind: "INVOICE" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { currency: true, paymentTermsDays: true },
  });
  const prefs = await readPreferences(tx, ctx.tenantId);
  const paymentTermsDays = last?.paymentTermsDays ?? (await readDefaultPaymentTerms(tx, ctx.tenantId));
  const ourReference = await ourReferenceOf(tx, ctx.actor.memberId);
  const created = await tx.invoice.create({
    data: {
      tenantId: ctx.tenantId,
      clientId: client.id,
      projectId: input.projectId ?? null,
      vatProfile: suggestVatProfile(client),
      currency: input.currency ?? last?.currency ?? prefs.currencyDefault,
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
  /** "sv" | "en", or ""/null — the client's (C76 (e)). */
  readonly locale?: unknown;
  /** A credit note's reason (C77 (b)) — required, so never cleared. */
  readonly creditReason?: unknown;
  /** Slice 109 (C79 (c), (f)): the Pay now link — an invoice's; "" or null clears it. */
  readonly payLinkUrl?: unknown;
  /** Slice 110b (C80 (d)): the time breakdown page on the PDF — an invoice's; a boolean. */
  readonly includeHours?: unknown;
};

/** What a credit note's draft may change: its reason and the words around it. Its terms are its invoice's (the guard holds them). */
const CREDIT_NOTE_FIELDS: ReadonlySet<string> = new Set(["creditReason", "buyerReference", "ourReference", "note"]);

/** A credit note's reason, at most this long (the column's CHECK). */
export const CREDIT_REASON_MAX = 500;

/** `invoice:edit` — the draft's details; only the fields present are written. Returns what changed. */
export async function updateDraftDetails(ctx: InvoicingCtx, invoiceId: string, patch: DraftDetailsPatch): Promise<string[]> {
  const data: Record<string, unknown> = {};
  if ("creditReason" in patch) {
    const reason = textOrNull(patch.creditReason, CREDIT_REASON_MAX);
    if (reason === null) return fail("INVOICE_CREDIT_REASON_REQUIRED");
    data.creditReason = reason;
  }
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
  if ("locale" in patch) {
    const l = patch.locale === null || patch.locale === "" ? null : patch.locale;
    if (l !== null && !isInvoiceLocale(l)) return fail("INVALID_INPUT", "invoice language");
    data.locale = l;
  }
  if ("includeHours" in patch) {
    if (typeof patch.includeHours !== "boolean") return fail("INVALID_INPUT", "time breakdown");
    data.includeHours = patch.includeHours;
  }
  if ("payLinkUrl" in patch) {
    // Stripe's or PayPal's own payment pages, exactly (C79 (f); `src/config`'s
    // fence, the database's CHECK behind it); stored as the parsed link.
    const raw = patch.payLinkUrl === null ? "" : typeof patch.payLinkUrl === "string" ? patch.payLinkUrl.trim() : undefined;
    if (raw === undefined) return fail("INVALID_INPUT", "pay link");
    if (raw === "") data.payLinkUrl = null;
    else {
      const url = payLinkUrl(raw);
      if (!url) return fail("INVOICE_PAY_LINK_REFUSED");
      data.payLinkUrl = url.href;
    }
  }

  return guarded(() =>
    withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
      const { clientId, kind } = await openDraft(tx, ctx, invoiceId, "invoice:edit");
      // A credit note keeps its invoice's terms; an invoice has no reason.
      for (const field of Object.keys(data)) {
        if (kind === "CREDIT_NOTE" ? !CREDIT_NOTE_FIELDS.has(field) : field === "creditReason") return fail("INVALID_INPUT", field);
      }
      if (typeof data.projectId === "string") await assertProjectOfClient(tx, clientId, data.projectId);
      const current = await tx.invoice.findFirst({
        where: { id: invoiceId },
        select: {
          creditReason: true,
          projectId: true,
          currency: true,
          paymentTermsDays: true,
          periodStart: true,
          periodEnd: true,
          buyerReference: true,
          ourReference: true,
          note: true,
          locale: true,
          payLinkUrl: true,
          includeHours: true,
        },
      });
      if (!current) return deny("NOT_FOUND");
      const same = (a: unknown, b: unknown) =>
        a instanceof Date || b instanceof Date ? (a as Date | null)?.getTime() === (b as Date | null)?.getTime() : a === b;
      const changed = Object.keys(data).filter((k) => !same(data[k], current[k as keyof typeof current]));
      if (changed.length === 0) return [];
      // Slice 110 (the design review's M3): tracked hours are priced in the
      // draft's currency — it keeps it while it holds them (the database's
      // `invoice_billed_hours_guard` says the same).
      if (changed.includes("currency") && (await tx.invoiceLineTimeEntry.count({ where: { invoiceId } })) > 0) {
        return fail("INVOICE_HAS_HOURS");
      }
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
        // The Pay now link itself when it changes (the slice-109 design
        // review's high): where a client's money would go is the one field
        // whose old and new values the trail must show.
        metadata: {
          fields: changed,
          ...(changed.includes("payLinkUrl") ? { payLink: data.payLinkUrl ?? null } : {}),
          // Slice 110b: which way the time breakdown went — whether task titles
          // and daily hours go to the client (the security review's nit).
          ...(changed.includes("includeHours") ? { includeHours: data.includeHours === true } : {}),
        },
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
      // A credit note's treatment is its invoice's (the guard holds it).
      if (current.kind === "CREDIT_NOTE") return fail("INVALID_INPUT", "vat profile");
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

/** A credit note's line keeps to its invoice's rates (`creditRatesOf`); an invoice's, to its treatment's (`parseRate`). */
const creditRate = (rate: bigint, rates: readonly bigint[] | null): bigint => {
  if (rates !== null && !rates.includes(rate)) return fail("INVOICE_RATE_NOT_ALLOWED");
  return rate;
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
      const locked = await openDraft(tx, ctx, invoiceId, "invoice:edit");
      const { clientId, vatProfile } = locked;
      const rates = await creditRatesOf(tx, locked);
      const description = parseDescription(input.description);
      const quantity = input.quantity === undefined ? 1000n : parseQuantity(input.quantity, parse.decimalComma);
      const unitPrice = input.unitPrice === undefined ? 0n : parseUnitPrice(input.unitPrice, parse.decimalComma);
      const vatRate =
        input.vatRate === undefined ? (rates?.[0] ?? defaultRateFor(vatProfile)) : creditRate(parseRate(input.vatRate, vatProfile), rates);
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
      const locked = await openDraft(tx, ctx, invoiceId, "invoice:edit");
      const { vatProfile } = locked;
      const rates = "vatRate" in patch ? await creditRatesOf(tx, locked) : null;
      const stored = await tx.invoiceLine.findFirst({ where: { id: lineId, invoiceId }, select: lineSelect });
      if (!stored) return deny("NOT_FOUND");
      const line = lineView(stored);
      const next = {
        description: "description" in patch ? parseDescription(patch.description) : line.description,
        quantity: "quantity" in patch ? parseQuantity(patch.quantity, parse.decimalComma) : line.quantity,
        unit: "unit" in patch ? textOrNull(patch.unit, LINE_TEXT_MAX.unit) : line.unit,
        unitPrice: "unitPrice" in patch ? parseUnitPrice(patch.unitPrice, parse.decimalComma) : line.unitPrice,
        vatRate: "vatRate" in patch ? creditRate(parseRate(patch.vatRate, vatProfile), rates) : line.vatRate,
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

/**
 * `invoice:edit` — remove one line. A line made from tracked hours (slice
 * 110) puts them back on the ready list first — their marks cleared, locked by
 * id after the draft (the lock order); their record goes with the line.
 * Returns how many hours went back.
 */
export async function removeLine(ctx: InvoicingCtx, invoiceId: string, lineId: string): Promise<number> {
  return guarded(() =>
    withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
      await openDraft(tx, ctx, invoiceId, "invoice:edit");
      const line = await tx.invoiceLine.findFirst({ where: { id: lineId, invoiceId }, select: { id: true } });
      if (!line) return deny("NOT_FOUND");
      const hoursReturned = await releaseDraftHours(tx, ctx.tenantId, { lineId });
      const gone = await tx.invoiceLine.deleteMany({ where: { id: lineId, invoiceId } });
      if (gone.count === 0) return deny("NOT_FOUND");
      await record(tx, {
        action: "invoice.draft_edited",
        targetType: "Invoice",
        targetId: invoiceId,
        metadata: { op: "line_removed", lineId, ...(hoursReturned > 0 ? { hoursReturned } : {}) },
      });
      return hoursReturned;
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

/**
 * `invoice:delete` — delete a draft and its lines. An issued invoice is never
 * deleted. Its tracked hours (slice 110) go back on the ready list first.
 */
export async function deleteDraft(ctx: InvoicingCtx, invoiceId: string): Promise<void> {
  await guarded(() =>
    withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
      const { clientId } = await openDraft(tx, ctx, invoiceId, "invoice:delete");
      const hoursReturned = await releaseDraftHours(tx, ctx.tenantId, { invoiceId });
      await tx.invoice.delete({ where: { id: invoiceId }, select: { id: true } });
      await record(tx, {
        action: "invoice.draft_deleted",
        targetType: "Invoice",
        targetId: invoiceId,
        metadata: { clientId, ...(hoursReturned > 0 ? { hoursReturned } : {}) },
      });
    }),
  );
}

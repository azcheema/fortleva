import { record } from "@/audit/record";
import { assertInScope, scopeWhere } from "@/authz/authorize";
import { deny } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { hasAccess, requireAccess } from "@/entitlements/resolver";
import { dateColumn, isoDateOf } from "@/lib/duration";
import { fail, isDeadlock, isLockTimeout } from "@/lib/domain-error";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";

import { guarded } from "./db-errors";
import { LINE_LIMIT, openDraft, writeDraft, type InvoicingCtx } from "./drafts";
import {
  billedSeconds,
  hoursLines,
  hoursQuantity,
  isLineGrouping,
  roundingRuleOf,
  type HourForLine,
  type LineGrouping,
  type LineTexts,
} from "./hours-lines";
import { sharedTasks } from "./hours-record";
import { ISSUE_LOCK_WAIT_MS, ISSUE_TX_TIMEOUT_MS } from "./issue";
import { formatFixed, lineAmount, LINE_AMOUNT_MAX, readFixed, type Minor } from "./money";
import { invoiceLocaleFor, isInvoiceLocale, type InvoiceLocale } from "./print";
import { defaultRateFor, type VatProfile } from "./vat";

/**
 * TRACKED HOURS ONTO INVOICES (Phase 4 slice 110; founder decisions C75 (a),
 * (b) and C80). The design and its review:
 * docs/research/2026-10-10-slice-110-hours-onto-invoices-design.md (§9).
 *
 * THE READY-TO-INVOICE LIST (C80 (a)) is every client's billable hours that
 * no invoice, and neither other mark, has taken: finished, of some length,
 * on a project, not deleted. Its value is what one line per project and rate
 * would bill — each entry rounded by its project's rule (C80 (c)), summed,
 * converted once (`hours-lines.ts`; the database's twin
 * `time_billed_seconds()` in the overview's aggregate).
 *
 * PUTTING HOURS ON A DRAFT — "Create invoice" from a client's hours, or "Add
 * hours…" on an open draft: the draft locked first (or made here), then the
 * hours FOR UPDATE by id and re-checked (any taken, changed or marked
 * meanwhile → HOURS_CHANGED, nothing written), then the lines the chosen
 * grouping makes (C80 (b)), each hour's RECORD on its line, and the MARKS —
 * in that order, which the database holds (migration 20261010180000). A
 * line whose billed time rounds to nothing is not written: its hours stay on
 * the list (the design review's M4).
 *
 * THE OTHER TWO MARKS (C80 (g)): "Billed elsewhere" and "Won't invoice" —
 * `time:write_off`, undoable. Their only history is the audit trail, so the
 * hours' ids are in it.
 *
 * Every verb: `requireAccess` → the client in DIRECT scope (every invoicing
 * verb's) → the write → the audit row, in one transaction (AGENTS.md).
 * Billed hours are never locked (C75 (a)): nothing here touches
 * `locked_reason`.
 */

const memberPrincipal = (ctx: InvoicingCtx) => ({ type: "member", id: ctx.actor.memberId }) as const;

/** At most this many hours on a client's page, and in one action. */
export const HOURS_PAGE_MAX = 1000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The ids an action was given: well-formed, distinct, at least one, at most `HOURS_PAGE_MAX`. */
function parseEntryIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return fail("INVALID_INPUT", "hours");
  const ids = [...new Set(raw.filter((x): x is string => typeof x === "string" && UUID.test(x)))];
  if (ids.length !== raw.length || ids.length === 0) return fail("INVALID_INPUT", "hours");
  if (ids.length > HOURS_PAGE_MAX) return fail("HOURS_TOO_MANY");
  return ids;
}

/** The words a line is written with, in the INVOICE's language (C80 (b)). */
export function lineTextsFor(locale: InvoiceLocale): LineTexts {
  const messages = locale === "sv" ? sv : en;
  return { otherWork: messages.invoices.hours.lineOtherWork };
}

/**
 * The bounded transaction every hours write runs in — the issue's lock wait
 * (a statement parked on a lock ignores the transaction's budget). A wait past
 * it, or a deadlock with another writer of the same hours, is "look again".
 */
async function inHoursTransaction<T>(ctx: InvoicingCtx, fn: (tx: TenantDb) => Promise<T>): Promise<T> {
  try {
    return await guarded(() =>
      withTenant(ctx.tenantId, memberPrincipal(ctx), fn, { lockTimeoutMs: ISSUE_LOCK_WAIT_MS, timeoutMs: ISSUE_TX_TIMEOUT_MS }),
    );
  } catch (e) {
    if (isLockTimeout(e) || isDeadlock(e)) return fail("HOURS_CHANGED");
    throw e;
  }
}

/** The gates of every read and write of the ready list: seeing invoices, and putting hours on them. */
async function openHours(tx: TenantDb, ctx: InvoicingCtx, clientId: string): Promise<void> {
  await requireAccess(tx, ctx.tenantId, ctx.actor, "invoice:view");
  await requireAccess(tx, ctx.tenantId, ctx.actor, "invoice:generate_from_time");
  await assertInScope(tx, ctx.actor, { clientId });
}

/** The hours the ready list holds — the database's `time_entry_ready` predicate. */
const readyWhere = (clientId: string) =>
  ({
    clientId,
    projectId: { not: null },
    billable: true,
    deletedAt: null,
    stoppedAt: { not: null },
    durationSeconds: { gt: 0 },
    invoiceLineId: null,
    billedExternallyAt: null,
    writtenOffAt: null,
  }) as const;

// ── The ready-to-invoice list ─────────────────────────────────────────

export type ReadyClient = {
  readonly clientId: string;
  readonly name: string;
  readonly archived: boolean;
  /** Per currency: billed seconds and what one line per project and rate would bill (hundredths). */
  readonly byCurrency: readonly { readonly currency: string; readonly seconds: number; readonly amount: Minor }[];
  /** Billed seconds of hours with no rate — no price until the member types one. */
  readonly noRateSeconds: number;
  /** The earliest day waiting, `YYYY-MM-DD`. */
  readonly oldest: string;
  readonly count: number;
};

/**
 * `invoice:view` + `invoice:generate_from_time` — every client in the member's
 * DIRECT client scope with hours waiting, the most valuable first. One
 * aggregate per (client, project, rate, currency) in the database, each
 * entry rounded by its project's rule there (`time_billed_seconds()`).
 */
export async function listReadyToInvoice(ctx: InvoicingCtx): Promise<readonly ReadyClient[]> {
  return withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "invoice:view");
    await requireAccess(tx, ctx.tenantId, ctx.actor, "invoice:generate_from_time");
    const scope = await scopeWhere(tx, ctx.actor, { clientField: "id" });
    const clients = await tx.client.findMany({ where: scope, select: { id: true, name: true, status: true } });
    if (clients.length === 0) return [];
    const groups = await tx.$queryRaw<
      { client_id: string; rate: string | null; currency: string | null; billed: bigint; n: number; oldest: Date }[]
    >`
      SELECT e.client_id, e.bill_rate::text AS rate, e.currency,
             sum(time_billed_seconds(e.duration_seconds, p.invoice_rounding_step, p.invoice_rounding_mode, p.invoice_rounding_minimum))::bigint AS billed,
             count(*)::int AS n, min(e.local_date) AS oldest
        FROM time_entry e
        JOIN project p ON p.tenant_id = e.tenant_id AND p.id = e.project_id
       WHERE e.tenant_id = ${ctx.tenantId}
         AND e.client_id = ANY(${clients.map((c) => c.id)}::text[])
         AND e.invoice_line_id IS NULL AND e.billed_externally_at IS NULL AND e.written_off_at IS NULL
         AND e.billable AND e.deleted_at IS NULL AND e.duration_seconds > 0 AND e.stopped_at IS NOT NULL
       GROUP BY e.client_id, e.project_id, e.bill_rate, e.currency`;
    const byClient = new Map<string, { byCurrency: Map<string, { seconds: number; amount: Minor }>; noRate: number; oldest: Date; count: number }>();
    for (const g of groups) {
      const acc = byClient.get(g.client_id) ?? { byCurrency: new Map(), noRate: 0, oldest: g.oldest, count: 0 };
      const seconds = Number(g.billed);
      acc.count += g.n;
      if (g.oldest < acc.oldest) acc.oldest = g.oldest;
      if (g.rate === null || g.currency === null) acc.noRate += seconds;
      else {
        // One line per (project, rate): its quantity converted once, × the rate.
        const amount = lineAmount(hoursQuantity(seconds), readFixed(g.rate, 2));
        const c = acc.byCurrency.get(g.currency) ?? { seconds: 0, amount: 0n };
        c.seconds += seconds;
        c.amount += amount;
        acc.byCurrency.set(g.currency, c);
      }
      byClient.set(g.client_id, acc);
    }
    const out: ReadyClient[] = [];
    for (const c of clients) {
      const acc = byClient.get(c.id);
      if (!acc) continue;
      out.push({
        clientId: c.id,
        name: c.name,
        archived: c.status === "ARCHIVED",
        byCurrency: [...acc.byCurrency.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([currency, v]) => ({ currency, ...v })),
        noRateSeconds: acc.noRate,
        oldest: isoDateOf(acc.oldest),
        count: acc.count,
      });
    }
    const top = (r: ReadyClient) => r.byCurrency.reduce((s, c) => (c.amount > s ? c.amount : s), 0n);
    return out.sort((a, b) => (top(a) === top(b) ? a.name.localeCompare(b.name) : top(a) > top(b) ? -1 : 1));
  });
}

// ── A client's hours ──────────────────────────────────────────────────

const hourSelect = {
  id: true,
  clientId: true,
  projectId: true,
  workItemId: true,
  serviceId: true,
  localDate: true,
  durationSeconds: true,
  billRate: true,
  currency: true,
  description: true,
  needsReview: true,
  billable: true,
  deletedAt: true,
  stoppedAt: true,
  invoiceLineId: true,
  billedExternallyAt: true,
  writtenOffAt: true,
  project: {
    select: { id: true, key: true, name: true, invoiceRoundingStep: true, invoiceRoundingMode: true, invoiceRoundingMinimum: true },
  },
  workItem: {
    select: { id: true, number: true, title: true, visibility: true, deletedAt: true, parentId: true, rootId: true, project: { select: { key: true } } },
  },
  service: { select: { id: true, name: true, visibility: true } },
  member: { select: { id: true, user: { select: { name: true } } } },
} as const;

/** One hour as the client's page shows it and the line builder takes it. */
export type ReadyHour = {
  readonly id: string;
  /** `YYYY-MM-DD`. */
  readonly date: string;
  readonly project: { readonly id: string; readonly key: string; readonly name: string };
  /** The task's id — what a line per task groups by. */
  readonly taskId: string | null;
  /** The task, for the team — "KEY-12" and its title, whoever may see it. */
  readonly task: { readonly ref: string; readonly title: string } | null;
  /** What a LINE may call it: the title when the client may see the task (`namedTaskShared`), else null. */
  readonly sharedTaskTitle: string | null;
  readonly agreement: { readonly id: string; readonly name: string } | null;
  /** The agreement's name when the client may see it, else null. */
  readonly visibleAgreementName: string | null;
  readonly member: { readonly id: string; readonly name: string };
  /** The entry's own note — the team's, never a line's. */
  readonly note: string | null;
  readonly rawSeconds: number;
  readonly billedSeconds: number;
  /** Hundredths; null for an hour with no rate. */
  readonly rate: Minor | null;
  readonly currency: string | null;
  /** Auto-stopped and not yet confirmed: starts unselected (the design review's low). */
  readonly needsReview: boolean;
};

type HourRow = {
  id: string;
  clientId: string | null;
  projectId: string | null;
  workItemId: string | null;
  localDate: Date;
  durationSeconds: number | null;
  billRate: { toFixed(dp: number): string } | null;
  currency: string | null;
  description: string | null;
  needsReview: boolean;
  billable: boolean;
  deletedAt: Date | null;
  stoppedAt: Date | null;
  invoiceLineId: string | null;
  billedExternallyAt: Date | null;
  writtenOffAt: Date | null;
  project: { id: string; key: string; name: string; invoiceRoundingStep: number | null; invoiceRoundingMode: string | null; invoiceRoundingMinimum: number | null } | null;
  workItem: { id: string; number: number; title: string; visibility: string; deletedAt: Date | null; parentId: string | null; rootId: string | null; project: { key: string } } | null;
  service: { id: string; name: string; visibility: string } | null;
  member: { id: string; user: { name: string | null } };
};

/** Rows as hours: each billed by its project's rule, every name a line may print decided client-safe here. */
async function toReadyHours(tx: TenantDb, tenantId: string, rows: readonly HourRow[]): Promise<ReadyHour[]> {
  const items = [...new Map(rows.flatMap((r) => (r.workItem ? [[r.workItem.id, r.workItem] as const] : []))).values()];
  const shared = await sharedTasks(tx, tenantId, items);
  return rows.map((r) => {
    if (!r.project) throw new Error("toReadyHours: an hour without a project");
    const raw = r.durationSeconds ?? 0;
    const wi = r.workItem;
    return {
      id: r.id,
      date: isoDateOf(r.localDate),
      project: { id: r.project.id, key: r.project.key, name: r.project.name },
      taskId: wi?.id ?? null,
      task: wi ? { ref: `${wi.project.key}-${wi.number}`, title: wi.title } : null,
      sharedTaskTitle: wi && shared.has(wi.id) ? wi.title : null,
      agreement: r.service ? { id: r.service.id, name: r.service.name } : null,
      visibleAgreementName: r.service && r.service.visibility === "CLIENT_VISIBLE" ? r.service.name : null,
      member: { id: r.member.id, name: r.member.user.name?.trim() || "—" },
      note: r.description,
      rawSeconds: raw,
      billedSeconds: billedSeconds(raw, roundingRuleOf(r.project)),
      rate: r.billRate === null ? null : readFixed(r.billRate, 2),
      currency: r.currency,
      needsReview: r.needsReview,
    };
  });
}

/** An hour as the line builder takes it. */
export const forLine = (h: ReadyHour): HourForLine => ({
  id: h.id,
  projectId: h.project.id,
  projectName: h.project.name,
  workItemId: h.taskId,
  sharedTaskTitle: h.sharedTaskTitle,
  serviceId: h.agreement?.id ?? null,
  visibleAgreementName: h.visibleAgreementName,
  memberId: h.member.id,
  memberName: h.member.name,
  rate: h.rate,
  billedSeconds: h.billedSeconds,
});

export type MarkedHour = ReadyHour & { readonly mark: "BILLED_ELSEWHERE" | "WONT_INVOICE"; readonly markedAt: Date };

export type ClientHours = {
  readonly client: { readonly id: string; readonly name: string; readonly archived: boolean };
  readonly hours: readonly ReadyHour[];
  /** More hours match than the page shows (`HOURS_PAGE_MAX`): narrow the period. */
  readonly more: boolean;
  readonly marked: readonly MarkedHour[];
  readonly markedMore: boolean;
  /** The client's projects, for the filter. */
  readonly projects: readonly { readonly id: string; readonly key: string; readonly name: string }[];
  /** The project the page is filtered to (chosen, or a draft's own), or null for all. */
  readonly projectId: string | null;
  /** Currencies among its waiting hours (the filter when there are several). */
  readonly currencies: readonly string[];
  /** The currency the page keeps to — the draft's, the one asked for, or the first of several; null when the hours have one (or none). */
  readonly currency: string | null;
  /** The language the lines are written in — the draft's, else the client's. */
  readonly locale: InvoiceLocale;
  readonly texts: LineTexts;
  /** `?draft=`: the open draft these hours would join. */
  readonly draft: { readonly id: string; readonly currency: string; readonly projectId: string | null } | null;
  readonly can: {
    /** Create invoice — `invoice:create` and `invoice:edit`, the client not archived. */
    readonly create: boolean;
    /** Add to the draft — `invoice:edit`. */
    readonly add: boolean;
    /** Billed elsewhere / Won't invoice, and undo — `time:write_off`. */
    readonly mark: boolean;
  };
};

export type ClientHoursFilter = {
  /** `YYYY-MM-DD`, inclusive. */
  readonly from?: string | null;
  readonly to?: string | null;
  /** null: all projects; undefined (never chosen): all — or, with a draft, the draft's own. */
  readonly projectId?: string | null;
  readonly currency?: string | null;
  readonly draftId?: string | null;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `invoice:view` + `invoice:generate_from_time`, the client in DIRECT scope — its waiting and its marked hours. */
export async function readClientHours(ctx: InvoicingCtx, clientId: string, filter: ClientHoursFilter = {}): Promise<ClientHours> {
  return withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    await openHours(tx, ctx, clientId);
    const client = await tx.client.findFirst({
      where: { id: clientId },
      select: {
        id: true,
        name: true,
        status: true,
        invoiceLocale: true,
        countryCode: true,
        projects: { orderBy: [{ key: "asc" }], select: { id: true, key: true, name: true } },
      },
    });
    if (!client) return deny("NOT_FOUND");
    // The draft these hours would join: an open INVOICE of THIS client only.
    const draftRow = filter.draftId
      ? await tx.invoice.findFirst({
          where: { id: filter.draftId, clientId, status: "DRAFT", kind: "INVOICE" },
          select: { id: true, currency: true, projectId: true, locale: true },
        })
      : null;
    // A grouped read in the database — never every waiting hour pulled into
    // memory to find a handful of currencies (the security review's low).
    const currencies = (
      await tx.timeEntry.groupBy({
        by: ["currency"],
        where: { AND: [readyWhere(clientId), { currency: { not: null } }] },
      })
    )
      .map((r) => r.currency!)
      .sort();
    // One invoice, one currency: the draft's; else the one asked for; else —
    // when the client's hours are priced in several — the first, so the page
    // never offers a selection that would be refused (HOURS_MIXED_CURRENCY).
    const currency =
      draftRow?.currency ??
      (filter.currency && currencies.includes(filter.currency) ? filter.currency : currencies.length > 1 ? currencies[0]! : null);
    // A project chosen; or, never chosen (undefined) on a draft's Add hours,
    // the draft's own project (the design's §3.2) — always one of the client's.
    const wanted = filter.projectId === undefined ? (draftRow?.projectId ?? null) : filter.projectId;
    const projectId = wanted && client.projects.some((p) => p.id === wanted) ? wanted : null;
    const from = filter.from && DAY.test(filter.from) ? dateColumn(filter.from) : null;
    const to = filter.to && DAY.test(filter.to) ? dateColumn(filter.to) : null;
    const period = from || to ? { localDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {};
    // The hours with no rate join any currency's invoice (at no price).
    const currencyTerm = currency ? { OR: [{ currency }, { currency: null }] } : {};
    const rows = await tx.timeEntry.findMany({
      where: { AND: [readyWhere(clientId), period, projectId ? { projectId } : {}, currencyTerm] },
      orderBy: [{ localDate: "asc" }, { startedAt: "asc" }, { id: "asc" }],
      take: HOURS_PAGE_MAX + 1,
      select: hourSelect,
    });
    const more = rows.length > HOURS_PAGE_MAX;
    rows.splice(HOURS_PAGE_MAX);
    const hours = await toReadyHours(tx, ctx.tenantId, rows);
    const markedRows = await tx.timeEntry.findMany({
      where: {
        AND: [
          { clientId, deletedAt: null },
          { OR: [{ billedExternallyAt: { not: null } }, { writtenOffAt: { not: null } }] },
          period,
          projectId ? { projectId } : {},
        ],
      },
      orderBy: [{ localDate: "desc" }, { id: "asc" }],
      take: HOURS_PAGE_MAX + 1,
      select: hourSelect,
    });
    const markedMore = markedRows.length > HOURS_PAGE_MAX;
    markedRows.splice(HOURS_PAGE_MAX);
    const markedHours = await toReadyHours(tx, ctx.tenantId, markedRows);
    const marked: MarkedHour[] = markedHours.map((h, i) => {
      const r = markedRows[i]!;
      return r.billedExternallyAt !== null
        ? { ...h, mark: "BILLED_ELSEWHERE", markedAt: r.billedExternallyAt }
        : { ...h, mark: "WONT_INVOICE", markedAt: r.writtenOffAt! };
    });
    const locale = draftRow && isInvoiceLocale(draftRow.locale) ? draftRow.locale : invoiceLocaleFor(client);
    // In turn, never a batch (AGENTS.md: a per-code check is never a leg).
    // Create invoice writes lines too: `invoice:edit` as well (the verb's own gates).
    const mayCreate =
      client.status !== "ARCHIVED" &&
      (await hasAccess(tx, ctx.tenantId, ctx.actor, "invoice:create")) &&
      (await hasAccess(tx, ctx.tenantId, ctx.actor, "invoice:edit"));
    const mayAdd = draftRow !== null && (await hasAccess(tx, ctx.tenantId, ctx.actor, "invoice:edit"));
    const mayMark = await hasAccess(tx, ctx.tenantId, ctx.actor, "time:write_off");
    return {
      client: { id: client.id, name: client.name, archived: client.status === "ARCHIVED" },
      hours,
      more,
      marked,
      markedMore,
      projects: client.projects,
      projectId,
      currencies,
      currency,
      locale,
      texts: lineTextsFor(locale),
      draft: draftRow ? { id: draftRow.id, currency: draftRow.currency, projectId: draftRow.projectId } : null,
      can: { create: mayCreate, add: mayAdd, mark: mayMark },
    };
  });
}

// ── Putting hours on a draft ──────────────────────────────────────────

type DraftTarget = {
  readonly id: string;
  readonly clientId: string;
  readonly currency: string;
  readonly vatProfile: VatProfile;
  readonly locale: InvoiceLocale;
  readonly hasPeriod: boolean;
};

/** Lock `ids` FOR UPDATE, by id — every one, or HOURS_CHANGED (one was removed meanwhile). */
async function lockHours(tx: TenantDb, tenantId: string, ids: readonly string[]): Promise<void> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM time_entry WHERE tenant_id = ${tenantId} AND id = ANY(${ids}::text[]) ORDER BY id FOR UPDATE`;
  if (locked.length !== ids.length) fail("HOURS_CHANGED");
}

/** Still waiting, of this client, in this currency (or with no rate) — the ready list's rule, re-read under the lock. */
const stillReady = (r: HourRow, clientId: string, currency: string | null): boolean =>
  r.clientId === clientId &&
  r.projectId !== null &&
  r.billable &&
  r.deletedAt === null &&
  r.stoppedAt !== null &&
  (r.durationSeconds ?? 0) > 0 &&
  r.invoiceLineId === null &&
  r.billedExternallyAt === null &&
  r.writtenOffAt === null &&
  (currency === null || r.currency === null || r.currency === currency);

export type HoursAdded = {
  readonly lineIds: readonly string[];
  /** Hours put on the draft. */
  readonly hours: number;
  /** Hours left on the list because their line would bill nothing. */
  readonly leftOut: number;
};

/**
 * The lines, records and marks — inside the caller's transaction, after its
 * gates and with the draft held (or made here). The hours are locked by id and
 * re-checked; the lines are what `hoursLines` makes of them; each hour's record
 * is written with its line, then its mark.
 */
async function putHoursOnDraft(
  tx: TenantDb,
  ctx: InvoicingCtx,
  draft: DraftTarget,
  ids: readonly string[],
  grouping: LineGrouping,
  op: "created" | "added",
): Promise<HoursAdded> {
  await lockHours(tx, ctx.tenantId, ids);
  const rows = await tx.timeEntry.findMany({ where: { tenantId: ctx.tenantId, id: { in: [...ids] } }, select: hourSelect });
  if (rows.length !== ids.length || rows.some((r) => !stillReady(r, draft.clientId, draft.currency))) fail("HOURS_CHANGED");
  const hours = await toReadyHours(tx, ctx.tenantId, rows);
  const byId = new Map(hours.map((h) => [h.id, h]));
  const lines = hoursLines(hours.map(forLine), grouping, lineTextsFor(draft.locale));
  // A line of nothing is refused by the database (`invoice_line_quantity_positive`)
  // and bills nothing: its hours stay on the list (the design review's M4).
  const billing = lines.filter((l) => l.quantity > 0n);
  const leftOut = lines.filter((l) => l.quantity === 0n).reduce((n, l) => n + l.entryIds.length, 0);
  if (billing.length === 0) return fail("HOURS_NOTHING_TO_BILL");
  const stats = await tx.invoiceLine.aggregate({ where: { invoiceId: draft.id }, _count: { _all: true }, _max: { position: true } });
  if (stats._count._all + billing.length > LINE_LIMIT) return fail("INVOICE_LINE_LIMIT");
  if (billing.some((l) => l.amount > LINE_AMOUNT_MAX)) return fail("INVOICE_AMOUNT_TOO_LARGE");
  const vatRate = formatFixed(defaultRateFor(draft.vatProfile), 2);
  let position = stats._max.position ?? 0;
  const lineIds: string[] = [];
  const billedDays: string[] = [];
  // In sequence: one transaction, one connection (AGENTS.md's trap).
  for (const line of billing) {
    position += 1;
    const created = await tx.invoiceLine.create({
      data: {
        tenantId: ctx.tenantId,
        clientId: draft.clientId,
        invoiceId: draft.id,
        position,
        description: line.description,
        quantity: formatFixed(line.quantity, 3),
        unit: "h",
        unitPriceExVat: formatFixed(line.unitPrice, 2),
        vatRatePct: vatRate,
        amountExVat: formatFixed(line.amount, 2),
      },
      select: { id: true },
    });
    await tx.invoiceLineTimeEntry.createMany({
      data: line.entryIds.map((entryId) => {
        const h = byId.get(entryId)!;
        billedDays.push(h.date);
        return {
          tenantId: ctx.tenantId,
          clientId: draft.clientId,
          invoiceId: draft.id,
          invoiceLineId: created.id,
          timeEntryId: entryId,
          projectId: h.project.id,
          workItemId: h.taskId,
          localDate: dateColumn(h.date),
          rawSeconds: h.rawSeconds,
          billedSeconds: h.billedSeconds,
          billRate: h.rate === null ? null : formatFixed(h.rate, 2),
        };
      }),
    });
    await tx.timeEntry.updateMany({ where: { tenantId: ctx.tenantId, id: { in: [...line.entryIds] } }, data: { invoiceLineId: created.id } });
    lineIds.push(created.id);
  }
  // A draft without a work period takes the hours' first and last day — the
  // day of supply, and the day of the VAT-in-SEK rate (C78 (a)).
  if (!draft.hasPeriod && billedDays.length > 0) {
    billedDays.sort();
    await tx.invoice.update({
      where: { id: draft.id },
      data: { periodStart: dateColumn(billedDays[0]!), periodEnd: dateColumn(billedDays[billedDays.length - 1]!) },
      select: { id: true },
    });
  }
  const rounding: Record<string, string> = {};
  for (const r of rows) {
    const rule = r.project ? roundingRuleOf(r.project) : null;
    if (rule && r.projectId) rounding[r.projectId] = `${rule.stepMinutes}:${rule.mode}:${rule.minimumMinutes ?? 0}`;
  }
  await record(tx, {
    action: "invoice.hours_added",
    targetType: "Invoice",
    targetId: draft.id,
    metadata: { op, grouping, lineIds, hours: billedDays.length, leftOut, rounding },
  });
  return { lineIds, hours: billedDays.length, leftOut };
}

/** The draft's own facts a put needs, read under its lock. */
async function readDraftTarget(tx: TenantDb, invoiceId: string): Promise<DraftTarget> {
  const inv = await tx.invoice.findFirst({
    where: { id: invoiceId },
    select: {
      id: true,
      clientId: true,
      currency: true,
      vatProfile: true,
      locale: true,
      periodStart: true,
      periodEnd: true,
      client: { select: { invoiceLocale: true, countryCode: true } },
    },
  });
  if (!inv) return deny("NOT_FOUND");
  return {
    id: inv.id,
    clientId: inv.clientId,
    currency: inv.currency,
    vatProfile: inv.vatProfile,
    locale: isInvoiceLocale(inv.locale) ? inv.locale : invoiceLocaleFor(inv.client),
    hasPeriod: inv.periodStart !== null || inv.periodEnd !== null,
  };
}

/**
 * `invoice:view` + `invoice:create` + `invoice:generate_from_time` — "Create
 * invoice" from a client's hours (C80 (a)): ONE transaction — the draft
 * (`createDraft`'s rules; its currency the hours', its project their one
 * project or none), then the lines, records and marks. Returns its id.
 */
export async function createInvoiceFromHours(
  ctx: InvoicingCtx,
  input: { readonly clientId: string; readonly entryIds: unknown; readonly grouping: unknown },
): Promise<{ readonly invoiceId: string } & HoursAdded> {
  const ids = parseEntryIds(input.entryIds);
  if (!isLineGrouping(input.grouping)) return fail("INVALID_INPUT", "grouping");
  const grouping = input.grouping;
  return inHoursTransaction(ctx, async (tx) => {
    await openHours(tx, ctx, input.clientId);
    await requireAccess(tx, ctx.tenantId, ctx.actor, "invoice:create");
    // It writes lines too: the code every other line writer takes (the
    // security review's nit — a custom role with create and not edit).
    await requireAccess(tx, ctx.tenantId, ctx.actor, "invoice:edit");
    // The currency and project the draft takes, from the hours as they are
    // (re-checked under their lock by the put).
    const chosen = await tx.timeEntry.findMany({
      where: { tenantId: ctx.tenantId, id: { in: ids }, clientId: input.clientId },
      select: { currency: true, projectId: true, project: { select: { status: true } } },
    });
    if (chosen.length !== ids.length) return fail("HOURS_CHANGED");
    const currencies = [...new Set(chosen.map((c) => c.currency).filter((c): c is string => c !== null))];
    if (currencies.length > 1) return fail("HOURS_MIXED_CURRENCY");
    const projects = [...new Set(chosen.map((c) => c.projectId))];
    const project = projects.length === 1 && chosen[0]!.project?.status !== "ARCHIVED" ? projects[0] : null;
    const invoiceId = await writeDraft(tx, ctx, { clientId: input.clientId, projectId: project ?? null, currency: currencies[0] ?? null });
    const draft = await readDraftTarget(tx, invoiceId);
    const added = await putHoursOnDraft(tx, ctx, draft, ids, grouping, "created");
    return { invoiceId, ...added };
  });
}

/**
 * `invoice:edit` + `invoice:generate_from_time` — "Add hours…" on an open
 * INVOICE draft (C80 (a)): the draft locked first (`openDraft`), then the put.
 */
export async function addHoursToDraft(
  ctx: InvoicingCtx,
  invoiceId: string,
  input: { readonly entryIds: unknown; readonly grouping: unknown },
): Promise<HoursAdded> {
  const ids = parseEntryIds(input.entryIds);
  if (!isLineGrouping(input.grouping)) return fail("INVALID_INPUT", "grouping");
  const grouping = input.grouping;
  return inHoursTransaction(ctx, async (tx) => {
    const locked = await openDraft(tx, ctx, invoiceId, "invoice:edit");
    // A credit note credits lines, never hours.
    if (locked.kind !== "INVOICE") return fail("INVOICE_NOT_DRAFT");
    await requireAccess(tx, ctx.tenantId, ctx.actor, "invoice:view");
    await requireAccess(tx, ctx.tenantId, ctx.actor, "invoice:generate_from_time");
    const draft = await readDraftTarget(tx, invoiceId);
    return putHoursOnDraft(tx, ctx, draft, ids, grouping, "added");
  });
}

// ── Billed elsewhere / Won't invoice (C80 (g)) ────────────────────────

export type HourMark = "BILLED_ELSEWHERE" | "WONT_INVOICE";
export const isHourMark = (s: unknown): s is HourMark => s === "BILLED_ELSEWHERE" || s === "WONT_INVOICE";

/**
 * `time:write_off`, the client in DIRECT scope — the chosen waiting hours
 * marked "Billed elsewhere" or "Won't invoice": off the ready list, still in
 * every report. Audited with their ids — the marks' only history.
 */
export async function markHours(
  ctx: InvoicingCtx,
  input: { readonly clientId: string; readonly entryIds: unknown; readonly mark: unknown },
): Promise<number> {
  const ids = parseEntryIds(input.entryIds);
  if (!isHourMark(input.mark)) return fail("INVALID_INPUT", "mark");
  const mark = input.mark;
  return inHoursTransaction(ctx, async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "time:write_off");
    await assertInScope(tx, ctx.actor, { clientId: input.clientId });
    await lockHours(tx, ctx.tenantId, ids);
    const rows = await tx.timeEntry.findMany({ where: { tenantId: ctx.tenantId, id: { in: ids } }, select: hourSelect });
    if (rows.length !== ids.length || rows.some((r) => !stillReady(r, input.clientId, null))) return fail("HOURS_CHANGED");
    const now = new Date();
    const marked = await tx.timeEntry.updateMany({
      where: { tenantId: ctx.tenantId, id: { in: ids } },
      data: mark === "BILLED_ELSEWHERE" ? { billedExternallyAt: now } : { writtenOffAt: now },
    });
    await record(tx, {
      action: mark === "BILLED_ELSEWHERE" ? "time_entry.marked_billed_elsewhere" : "time_entry.marked_written_off",
      targetType: "Client",
      targetId: input.clientId,
      metadata: { count: marked.count, entryIds: ids },
    });
    return marked.count;
  });
}

/** `time:write_off`, the client in DIRECT scope — the chosen hours' marks undone: back on the ready list. */
export async function clearHourMarks(ctx: InvoicingCtx, input: { readonly clientId: string; readonly entryIds: unknown }): Promise<number> {
  const ids = parseEntryIds(input.entryIds);
  return inHoursTransaction(ctx, async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "time:write_off");
    await assertInScope(tx, ctx.actor, { clientId: input.clientId });
    await lockHours(tx, ctx.tenantId, ids);
    const rows = await tx.timeEntry.findMany({
      where: { tenantId: ctx.tenantId, id: { in: ids } },
      select: { id: true, clientId: true, billedExternallyAt: true, writtenOffAt: true },
    });
    if (
      rows.length !== ids.length ||
      rows.some((r) => r.clientId !== input.clientId || (r.billedExternallyAt === null && r.writtenOffAt === null))
    ) {
      return fail("HOURS_CHANGED");
    }
    const cleared = await tx.timeEntry.updateMany({
      where: { tenantId: ctx.tenantId, id: { in: ids } },
      data: { billedExternallyAt: null, writtenOffAt: null },
    });
    await record(tx, {
      action: "time_entry.billing_mark_cleared",
      targetType: "Client",
      targetId: input.clientId,
      metadata: {
        count: cleared.count,
        billedElsewhere: rows.filter((r) => r.billedExternallyAt !== null).length,
        wontInvoice: rows.filter((r) => r.writtenOffAt !== null).length,
        entryIds: ids,
      },
    });
    return cleared.count;
  });
}

// ── Returned by hand (C80 (f)) ────────────────────────────────────────

/**
 * `invoice:view` + `invoice:generate_from_time` + `invoice:credit`, the
 * client in DIRECT scope — after a PART credit, particular hours of an issued
 * invoice back to "not invoiced" (C80 (f)): only on an invoice with an issued
 * credit note and not credited in full (which freed them all), only hours
 * still marked on it. Its record of them stays. Returns how many.
 */
export async function returnHours(ctx: InvoicingCtx, invoiceId: string, input: { readonly entryIds: unknown }): Promise<number> {
  const ids = parseEntryIds(input.entryIds);
  return inHoursTransaction(ctx, async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "invoice:view");
    await requireAccess(tx, ctx.tenantId, ctx.actor, "invoice:generate_from_time");
    await requireAccess(tx, ctx.tenantId, ctx.actor, "invoice:credit");
    const scoped = await tx.invoice.findFirst({ where: { id: invoiceId }, select: { clientId: true } });
    if (!scoped) return deny("NOT_FOUND");
    await assertInScope(tx, ctx.actor, { clientId: scoped.clientId });
    // The invoice FIRST (the lock order), then the hours.
    const locked = await tx.$queryRaw<{ kind: string; status: string }[]>`
      SELECT kind::text AS kind, status::text AS status FROM invoice WHERE id = ${invoiceId} FOR UPDATE`;
    const inv = locked[0];
    if (!inv) return deny("NOT_FOUND");
    if (inv.kind !== "INVOICE" || !(inv.status === "ISSUED" || inv.status === "SENT" || inv.status === "PAID")) {
      return fail("INVOICE_HOURS_KEPT");
    }
    const credited = await tx.invoice.count({ where: { kind: "CREDIT_NOTE", creditsInvoiceId: invoiceId, status: { not: "DRAFT" } } });
    if (credited === 0) return fail("INVOICE_HOURS_KEPT");
    await lockHours(tx, ctx.tenantId, ids);
    const rows = await tx.timeEntry.findMany({
      where: { tenantId: ctx.tenantId, id: { in: ids } },
      select: { id: true, invoiceLine: { select: { invoiceId: true } } },
    });
    if (rows.length !== ids.length || rows.some((r) => r.invoiceLine?.invoiceId !== invoiceId)) return fail("HOURS_CHANGED");
    const freed = await tx.timeEntry.updateMany({ where: { tenantId: ctx.tenantId, id: { in: ids } }, data: { invoiceLineId: null } });
    await record(tx, {
      action: "invoice.hours_returned",
      targetType: "Invoice",
      targetId: invoiceId,
      metadata: { count: freed.count, entryIds: ids },
    });
    return freed.count;
  });
}

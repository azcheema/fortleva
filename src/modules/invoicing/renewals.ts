import { record } from "@/audit/record";
import { resolveScope, type MemberActor } from "@/authz/authorize";
import { withTenant, type TenantDb } from "@/db";
import { accessibleCodes, moduleOpenUnderSystem } from "@/entitlements/resolver";
import { dateColumn, localDateString } from "@/lib/duration";
import { emit } from "@/notify/emit";
import { reasonsFor, type NotificationReason } from "@/notify/reasons";
import { readPreferences } from "@/preferences/service";
import { anchorOf, type RenewalInterval } from "@/services/renewal-dates";

import { LINE_LIMIT, LINE_TEXT_MAX } from "./drafts";
import { formatFixed, lineAmount, readFixed } from "./money";
import { DRAFT_LEAD_DAYS, renewalLineText, renewalsToDraft, type RenewalDraftOf } from "./renewal-plan";
import { readDefaultPaymentTerms } from "./seller";
import { defaultRateFor, isVatProfile, suggestVatProfile } from "./vat";

/**
 * RENEWALS THAT DRAFT AN INVOICE (Phase 4 slice 113b; founder decision C88;
 * the design: docs/research/2026-10-12-slice-113-renewal-invoices-design.md
 * §3 as amended by §9). Run per tenant by `src/jobs/agreement-renewals.ts`
 * BEFORE the renewal dates move on, under THIS tenant's SYSTEM principal, RLS
 * live — the database's ONE system path for invoices (`invoice_guard`,
 * `invoice_line_guard`, migration 20261018090000), opened only by
 * `app.renewal_drafting`, which this file and no other sets
 * (`renewal-census.test.ts`).
 *
 * WHAT: for every RUNNING recurring agreement of an ACTIVE client with a
 * price, a currency of its own and "Invoice each renewal" on (C88 (e)), every
 * renewal `renewal-plan.ts` says is owed — the COMING period from 14 days
 * before it (C88 (a), (b)); never a period already started unless drafted
 * without a gap, and then every such period up to the window (a job that was
 * down drafts each day once); only what is left; to its end date (C88 (f),
 * (h)) — ONE line each on its client's renewal draft in that currency, or a
 * new one (C88 (c)). Nothing reaches a client: a member who may issue
 * invoices issues it, as themselves.
 *
 * Only while the INVOICING module is open to the tenant (the design review's
 * #4). The renewal dates' move is held PER AGREEMENT while one of its started
 * periods is still owed (`agreementHoldsDate`) — so a group that fails, the
 * time budget or the cap delays only its own agreements, never a workspace
 * (the code and security reviews of 113b).
 *
 * THE PLAN pages through the candidates and keeps only the agreements truly
 * owed now (`renewalsToDraft`), so agreements already drafted, ended or out of
 * the window never fill the cap (the reviews' wedge). One whose currency is
 * not set (it would be billed in whatever the workspace's default became) or
 * whose name is too long for a line is skipped, and said in the log by id.
 *
 * ONE TRANSACTION PER CLIENT AND CURRENCY — at most `GROUP_SIZE` agreements
 * each, a lock wait bounded — under an advisory lock on the client (two runs
 * never make two drafts for one client): each agreement LOCKED and every fact
 * re-derived from the locked row — one that no longer fits is skipped, never
 * the group; per renewal its `invoiced_through` written FIRST (the line guard
 * holds the line to that row as written in this transaction), then the line;
 * the draft found UNLOCKED, locked by id and re-checked (an issue may have
 * taken it meanwhile), never a draft at the line limit or one a person gave a
 * project; the draft's period widened, never narrowed; `invoice.created` (a
 * new draft) and one `invoice.renewal_drafted` per line, as SYSTEM; ONE inbox
 * notice per draft touched (`invoice.renewal_drafted`, COALESCED — no mail,
 * no push: C88 (d)), deduplicated while unread.
 *
 * WHO IS TOLD (C88 (d)): every ACTIVE member who, checked as THEMSELVES,
 * holds `invoice:view` and `invoice:issue` on all four gates and reaches the
 * client DIRECTLY — the invoice page's own rule, so its link always opens.
 * Nobody → the draft is still made (it waits on Invoices).
 *
 * Lock order: the agreement, then the invoice (the issue path takes the
 * invoice, then the client FOR SHARE; nothing here locks the client).
 * Reads in SEQUENCE on each transaction (AGENTS.md's `Promise.all` trap).
 */

const SYSTEM = { type: "system" } as const;

/** The codes a receiver needs — the invoice page's (`getInvoice`) and the act the notice asks for. */
const RECEIVER_CODES = ["invoice:view", "invoice:issue"] as const;

/** The most agreements one run drafts per tenant; the rest are drafted next run (their dates held). */
export const DRAFT_CAP = 500;
/** The most candidate rows one run reads per tenant, in pages of `PLAN_PAGE`. */
export const PLAN_READ_CAP = 5_000;
const PLAN_PAGE = 500;
/** The most agreements in one transaction: a client with hundreds stays inside the transaction budget. */
export const GROUP_SIZE = 20;
/**
 * The most LINES one transaction adds — after an outage one agreement can owe
 * 24 (the re-check's low): `invoiced_through` is committed with each, so a
 * group cut here goes on from where it stopped on the next run.
 */
export const MAX_LINES_PER_GROUP = 40;
/** How long a statement may wait for a lock before the group gives up (it is drafted next run). */
const LOCK_WAIT_MS = 5_000;

export type RenewalDraftRun = {
  /** Lines added (renewals drafted). */
  readonly drafted: number;
  /** Drafts touched. */
  readonly invoices: number;
  /** Groups that failed (logged; their agreements' dates held). */
  readonly failed: number;
  /** The invoicing module is closed to the tenant: nothing looked at. */
  readonly closed: boolean;
};

const isInterval = (v: string | null): v is RenewalInterval => v === "MONTHLY" || v === "QUARTERLY" || v === "YEARLY";
const utcDay = (d: Date): string => d.toISOString().slice(0, 10);
const shiftDays = (day: string, days: number): string => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

type Due = { readonly id: string; readonly clientId: string; readonly currency: string };

type PlanRow = {
  id: string;
  clientId: string;
  currency: string | null;
  name: string;
  billingInterval: string | null;
  priceExVat: { toFixed(dp: number): string } | null;
  renewsAt: Date | null;
  renewalDay: number | null;
  endsAt: Date | null;
  invoicedThrough: Date | null;
};

/** The renewals owed for a row as it reads now, or none — the plan's filter and the group's re-check. */
function owed(row: Omit<PlanRow, "id" | "clientId" | "currency">, today: string): RenewalDraftOf[] {
  if (!isInterval(row.billingInterval) || row.priceExVat === null || row.renewsAt === null) return [];
  const renewsOn = utcDay(row.renewsAt);
  const anchorDay = anchorOf(renewsOn, row.renewalDay);
  if (anchorDay === null) return [];
  return renewalsToDraft({
    renewsOn,
    interval: row.billingInterval,
    anchorDay,
    endsOn: row.endsAt === null ? null : utcDay(row.endsAt),
    invoicedThrough: row.invoicedThrough === null ? null : utcDay(row.invoicedThrough),
    today,
    price: readFixed(row.priceExVat, 2),
  });
}

/** Draft every renewal owed in this tenant. */
export async function draftRenewalInvoices(
  tenantId: string,
  now: Date = new Date(),
  opts: { readonly deadline?: number } = {},
): Promise<RenewalDraftRun> {
  if (typeof tenantId !== "string" || tenantId.length === 0) throw new TypeError("invoicing: tenantId must be a non-empty string");
  const deadline = opts.deadline ?? Number.POSITIVE_INFINITY;

  const open = await withTenant(tenantId, SYSTEM, async (tx) => {
    if (!(await moduleOpenUnderSystem(tx, tenantId, "invoicing"))) return null;
    return localDateString(now, (await readPreferences(tx, tenantId)).timezone);
  });
  if (open === null) return { drafted: 0, invoices: 0, failed: 0, closed: true };
  const today = open;

  // THE PLAN: candidates by the cheap facts, paged by id; kept only when owed now.
  const due: Due[] = [];
  let after: string | null = null;
  let more = false;
  for (let read = 0; ; ) {
    if (read >= PLAN_READ_CAP || due.length >= DRAFT_CAP) {
      more = true;
      break;
    }
    const cursor: string | null = after;
    const page: PlanRow[] = await withTenant(tenantId, SYSTEM, (tx) =>
      tx.service.findMany({
        where: {
          tenantId,
          status: "ACTIVE",
          kind: "RECURRING",
          billingInterval: { not: null },
          invoiceRenewals: true,
          priceExVat: { gt: 0 },
          renewsAt: { not: null, lt: dateColumn(shiftDays(today, DRAFT_LEAD_DAYS + 1)) },
          client: { status: "ACTIVE" },
          ...(cursor === null ? {} : { id: { gt: cursor } }),
        },
        orderBy: { id: "asc" },
        take: PLAN_PAGE,
        select: {
          id: true,
          clientId: true,
          currency: true,
          name: true,
          billingInterval: true,
          priceExVat: true,
          renewsAt: true,
          renewalDay: true,
          endsAt: true,
          invoicedThrough: true,
        },
      }),
    );
    for (const row of page) {
      const drafts = owed(row, today);
      if (drafts.length === 0) continue;
      if (row.currency === null) {
        console.error(`renewal-invoices: tenant ${tenantId} agreement ${row.id} has no currency of its own: not drafted`);
        continue;
      }
      if (drafts.some((d) => renewalLineText(row.name, d.start, d.end, LINE_TEXT_MAX.description) === null)) {
        console.error(`renewal-invoices: tenant ${tenantId} agreement ${row.id} has a name too long for a line: not drafted`);
        continue;
      }
      if (due.length < DRAFT_CAP) due.push({ id: row.id, clientId: row.clientId, currency: row.currency });
      else more = true;
    }
    read += page.length;
    if (page.length < PLAN_PAGE) break;
    after = page[page.length - 1]!.id;
  }
  if (more) {
    // Said, never silent (the re-check's nit): the rest are drafted on later
    // runs, and their dates are held while a started period is owed.
    console.error(`renewal-invoices: tenant ${tenantId} cut at ${due.length} agreement(s) owed: the rest wait for a later run`);
  }

  // Per client and currency, at most GROUP_SIZE agreements to a transaction.
  const byKey = new Map<string, Due[]>();
  for (const d of due) {
    const key = `${d.clientId}|${d.currency}`;
    byKey.set(key, [...(byKey.get(key) ?? []), d]);
  }
  const groups: Due[][] = [];
  for (const list of byKey.values()) for (let i = 0; i < list.length; i += GROUP_SIZE) groups.push(list.slice(i, i + GROUP_SIZE));

  const receiversOf = receiverResolver(tenantId);
  const out = { drafted: 0, invoices: 0, failed: 0, closed: false };
  for (const group of groups) {
    if (Date.now() >= deadline) {
      console.error(`renewal-invoices: tenant ${tenantId} out of time: ${groups.length - groups.indexOf(group)} group(s) wait for the next run`);
      break;
    }
    const { clientId, currency } = group[0]!;
    try {
      const receivers = await receiversOf(clientId);
      const r = await draftGroup(tenantId, clientId, currency, today, group, receivers);
      out.drafted += r.drafted;
      out.invoices += r.invoices;
    } catch (e) {
      out.failed += 1;
      const code = typeof e === "object" && e !== null && "code" in e ? ` (${String((e as { code: unknown }).code)})` : "";
      console.error(`renewal-invoices: tenant ${tenantId} client ${clientId} failed: ${e instanceof Error ? e.name : typeof e}${code}`);
    }
  }
  return out;
}

/** Who is told about a client's renewal draft — see the file's comment. One resolution per member per run. */
function receiverResolver(tenantId: string): (clientId: string) => Promise<Map<string, NotificationReason>> {
  type Who = { readonly issues: boolean; readonly all: boolean; readonly direct: readonly string[] };
  let members: string[] | null = null;
  const memo = new Map<string, Who>();
  return async (clientId) => {
    if (members === null) {
      members = await withTenant(tenantId, SYSTEM, async (tx) =>
        (await tx.member.findMany({ where: { tenantId, status: "ACTIVE" }, select: { id: true }, orderBy: { id: "asc" } })).map((m) => m.id),
      );
    }
    const assigned: string[] = [];
    const issuers: string[] = [];
    // In turn: each resolution is a transaction of its own (AGENTS.md's trap).
    for (const memberId of members) {
      let who = memo.get(memberId);
      if (!who) {
        const actor: MemberActor = { memberId };
        who = await withTenant(tenantId, SYSTEM, async (tx) => {
          const codes = await accessibleCodes(tx, tenantId, actor, RECEIVER_CODES);
          const scope = await resolveScope(tx, actor);
          return { issues: RECEIVER_CODES.every((c) => codes.has(c)), all: scope.all, direct: scope.all ? [] : scope.directClientIds };
        });
        memo.set(memberId, who);
      }
      if (!who.issues) continue;
      // DIRECT reach only (the invoice page's rule): tenant-wide, or assigned to
      // the client itself — a member reaching it through a project is not told.
      if (who.all) issuers.push(memberId);
      else if (who.direct.includes(clientId)) assigned.push(memberId);
    }
    // The client's own people say so; a tenant-wide member hears it as someone who can issue.
    return reasonsFor([
      ["CLIENT_MEMBER", assigned],
      ["INVOICE_ACCESS", issuers],
    ]);
  };
}

type Locked = {
  client_id: string;
  status: string;
  kind: string;
  billing_interval: string | null;
  invoice_renewals: boolean;
  price_ex_vat: { toFixed(dp: number): string } | null;
  currency: string | null;
  renews_at: Date | null;
  renewal_day: number | null;
  ends_at: Date | null;
  invoiced_through: Date | null;
  name: string;
};

async function draftGroup(
  tenantId: string,
  clientId: string,
  currency: string,
  today: string,
  group: readonly Due[],
  receivers: ReadonlyMap<string, NotificationReason>,
): Promise<{ drafted: number; invoices: number }> {
  return withTenant(
    tenantId,
    SYSTEM,
    async (tx) => {
      // The renewal job's right, for this transaction only (the guards' `drafting`).
      await tx.$executeRaw`SELECT set_config('app.renewal_drafting', 'on', true)`;
      // Two runs never make two drafts for one client.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`renewal-invoice:${tenantId}:${clientId}`}, 0))`;

      const client = await tx.client.findFirst({
        where: { tenantId, id: clientId },
        select: { status: true, vatProfile: true, countryCode: true, vatNumber: true },
      });
      if (!client || client.status !== "ACTIVE") return { drafted: 0, invoices: 0 };

      const touched = new Map<string, { created: boolean; lines: number }>();
      let drafted = 0;
      // The draft this group adds to, once chosen — locked for the transaction,
      // never re-read per line (the re-check's low).
      let current: { id: string; vatProfile: Parameters<typeof defaultRateFor>[0]; lines: number } | null = null;
      agreements: for (const due of group) {
        const rows = await tx.$queryRaw<Locked[]>`
          SELECT client_id, status::text AS status, kind::text AS kind, billing_interval::text AS billing_interval,
                 invoice_renewals, price_ex_vat, currency, renews_at, renewal_day, ends_at, invoiced_through, name
            FROM service
           WHERE tenant_id = ${tenantId} AND id = ${due.id}
             FOR UPDATE`;
        const s = rows[0];
        // Every fact re-derived from the locked row; one that no longer fits waits.
        if (
          !s ||
          s.client_id !== clientId ||
          s.status !== "ACTIVE" ||
          s.kind !== "RECURRING" ||
          !s.invoice_renewals ||
          s.currency !== currency
        ) {
          continue;
        }
        const drafts = owed(
          {
            name: s.name,
            billingInterval: s.billing_interval,
            priceExVat: s.price_ex_vat,
            renewsAt: s.renews_at,
            renewalDay: s.renewal_day,
            endsAt: s.ends_at,
            invoicedThrough: s.invoiced_through,
          },
          today,
        );
        for (const draft of drafts) {
          if (drafted >= MAX_LINES_PER_GROUP) break agreements; // the rest go on next run
          // The line's exact text (the database holds it).
          const text = renewalLineText(s.name, draft.start, draft.end, LINE_TEXT_MAX.description);
          if (text === null) break;
          // FIRST the record of what is drafted — the line guard holds the line to
          // this row as written in this transaction.
          await tx.service.update({ where: { id: due.id }, data: { invoicedThrough: dateColumn(draft.end) }, select: { id: true } });
          if (draft.amount <= 0n) {
            // A share that rounds to nothing: recorded as drafted, no line (the guard
            // would refuse a zero price, and the group with it).
            await record(tx, {
              action: "invoice.renewal_drafted",
              targetType: "Service",
              targetId: due.id,
              metadata: { clientId, serviceId: due.id, periodStart: draft.start, periodEnd: draft.end, lineId: null, prorated: draft.prorated },
            });
            continue;
          }

          if (current === null || current.lines >= LINE_LIMIT) current = await openRenewalDraft(tx, tenantId, clientId, currency, client, draft, touched);
          const invoice = current;
          const position = ((await tx.invoiceLine.aggregate({ where: { invoiceId: invoice.id }, _max: { position: true } }))._max.position ?? 0) + 1;
          const quantity = 1000n; // one period
          const line = await tx.invoiceLine.create({
            data: {
              tenantId,
              clientId,
              invoiceId: invoice.id,
              position,
              description: text,
              quantity: formatFixed(quantity, 3),
              unit: null,
              unitPriceExVat: formatFixed(draft.amount, 2),
              vatRatePct: formatFixed(defaultRateFor(invoice.vatProfile), 2),
              amountExVat: formatFixed(lineAmount(quantity, draft.amount), 2),
              serviceId: due.id,
              servicePeriodStart: dateColumn(draft.start),
              servicePeriodEnd: dateColumn(draft.end),
            },
            select: { id: true },
          });
          // The draft's period covers every renewal on it — widened, never narrowed.
          await tx.$executeRaw`
            UPDATE invoice
               SET period_start = least(coalesce(period_start, ${dateColumn(draft.start)}::date), ${dateColumn(draft.start)}::date),
                   period_end = greatest(coalesce(period_end, ${dateColumn(draft.end)}::date), ${dateColumn(draft.end)}::date),
                   updated_at = statement_timestamp()
             WHERE tenant_id = ${tenantId} AND id = ${invoice.id}
               AND (period_start IS DISTINCT FROM least(coalesce(period_start, ${dateColumn(draft.start)}::date), ${dateColumn(draft.start)}::date)
                 OR period_end IS DISTINCT FROM greatest(coalesce(period_end, ${dateColumn(draft.end)}::date), ${dateColumn(draft.end)}::date))`;
          await record(tx, {
            action: "invoice.renewal_drafted",
            targetType: "Invoice",
            targetId: invoice.id,
            metadata: { clientId, serviceId: due.id, periodStart: draft.start, periodEnd: draft.end, lineId: line.id, prorated: draft.prorated },
          });
          touched.get(invoice.id)!.lines += 1;
          invoice.lines += 1;
          drafted += 1;
        }
      }

      for (const [invoiceId, t] of touched) {
        if (t.lines === 0 || receivers.size === 0) continue;
        await emit(tx, tenantId, {
          kind: "invoice.renewal_drafted",
          entity: { type: "Invoice", id: invoiceId },
          clientId,
          receivers,
          // IDS ONLY, and a count (emit's rule).
          params: { clientId, invoiceId, count: String(t.lines) },
          dedupeKey: `invoice.renewal_drafted:${invoiceId}`,
        });
      }
      return { drafted, invoices: [...touched.values()].filter((t) => t.lines > 0).length };
    },
    { lockTimeoutMs: LOCK_WAIT_MS },
  );
}

/**
 * The client's renewal draft in this currency to add to — the oldest one
 * still a DRAFT, made by the job, with no project a person gave it and room
 * for a line — LOCKED by id and re-checked; or a new one (C88 (c)).
 */
async function openRenewalDraft(
  tx: TenantDb,
  tenantId: string,
  clientId: string,
  currency: string,
  client: Parameters<typeof suggestVatProfile>[0],
  draft: { readonly start: string; readonly end: string },
  touched: Map<string, { created: boolean; lines: number }>,
): Promise<{ id: string; vatProfile: Parameters<typeof defaultRateFor>[0]; lines: number }> {
  const tried: string[] = [];
  for (;;) {
    const candidate = await tx.invoice.findFirst({
      where: { tenantId, clientId, origin: "RENEWAL", kind: "INVOICE", status: "DRAFT", currency, projectId: null, id: { notIn: tried } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    if (!candidate) break;
    tried.push(candidate.id);
    const locked = await tx.$queryRaw<{ status: string; origin: string; currency: string; project_id: string | null; vat_profile: string }[]>`
      SELECT status::text AS status, origin::text AS origin, currency, project_id, vat_profile::text AS vat_profile
        FROM invoice WHERE tenant_id = ${tenantId} AND id = ${candidate.id} FOR UPDATE`;
    const row = locked[0];
    if (!row || row.status !== "DRAFT" || row.origin !== "RENEWAL" || row.currency !== currency || row.project_id !== null) continue;
    if (!isVatProfile(row.vat_profile)) continue;
    const lines = await tx.invoiceLine.count({ where: { invoiceId: candidate.id } });
    if (lines >= LINE_LIMIT) continue;
    if (!touched.has(candidate.id)) touched.set(candidate.id, { created: false, lines: 0 });
    return { id: candidate.id, vatProfile: row.vat_profile, lines };
  }

  // A new renewal draft: the client's VAT treatment and terms, as a member's
  // draft derives them (`writeDraft`), with nothing a person would type.
  const last = await tx.invoice.findFirst({
    where: { clientId, kind: "INVOICE" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { paymentTermsDays: true },
  });
  const paymentTermsDays = last?.paymentTermsDays ?? (await readDefaultPaymentTerms(tx, tenantId));
  const vatProfile = suggestVatProfile(client);
  const created = await tx.invoice.create({
    data: {
      tenantId,
      clientId,
      origin: "RENEWAL",
      createdByMemberId: null,
      vatProfile,
      currency,
      paymentTermsDays,
      periodStart: dateColumn(draft.start),
      periodEnd: dateColumn(draft.end),
    },
    select: { id: true },
  });
  await record(tx, {
    action: "invoice.created",
    targetType: "Invoice",
    targetId: created.id,
    metadata: { clientId, projectId: null, origin: "RENEWAL" },
  });
  touched.set(created.id, { created: true, lines: 0 });
  return { id: created.id, vatProfile, lines: 0 };
}

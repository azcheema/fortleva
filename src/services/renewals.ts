import { record } from "@/audit/record";
import { withTenant } from "@/db";
import { dateColumn, localDateString } from "@/lib/duration";
import { readPreferences } from "@/preferences/service";

import { anchorOf, nextRenewal, type RenewalInterval } from "./renewal-dates";

/**
 * AN AGREEMENT'S RENEWAL DATE MOVES ON BY ITSELF (Phase 4 slice 113;
 * founder decision C88, stated with its second round). Until now nothing
 * moved `renews_at`, so a monthly agreement left Renewals after its first
 * date and never came back; and slice 113b drafts each renewal's invoice
 * from this date. Run per tenant on every `POST /api/jobs/run` (idempotent:
 * a date already moved is not due) by `src/jobs/agreement-renewals.ts`,
 * which found the tenant under the audited platform seam; everything here
 * runs under THIS tenant's SYSTEM principal, RLS live.
 *
 * WHAT MOVES: a RUNNING (`ACTIVE`) RECURRING agreement with an interval
 * whose renewal day has PASSED in the tenant's own zone — the day AFTER it
 * is reached, so Renewals still says "renews today" on the day. It moves to
 * the first renewal after today in whole intervals, on its anchor day
 * (`renewal-dates.ts`: the 31st renews on 28 February and on 31 March again),
 * and the anchor is kept in `renewal_day`. Whether or not it invoices: a
 * renewal date is a fact about the agreement.
 *
 * WHAT STAYS: a paused or ended agreement (a paused one is moved on when it
 * runs again — nothing is billed for the time it did not, slice 113b); a
 * one-time one; and one whose END comes before the next renewal — its date
 * stays where it was and Renewals shows its end instead (C55).
 *
 * ONE TRANSACTION PER AGREEMENT: the row locked and re-read (a person may
 * have changed the date, paused it or ended it since the plan), the move,
 * and `service.renewed` — `{ clientId, from, to, steps }`, days only — as
 * SYSTEM. No notification: a renewal is not news (C55).
 *
 * Reads in SEQUENCE on each transaction (AGENTS.md's `Promise.all` trap).
 */

const SYSTEM = { type: "system" } as const;

/** One page of the plan; the plan pages on by id until it is done, reaches `MOVE_CAP` or runs out of time. */
export const MOVE_BATCH = 250;
/**
 * The most agreements one run looks at per tenant; the rest are looked at by
 * the next run. Each is a transaction of its own, so this bounds what one
 * workspace can take of a run (slice 113's security review: thousands of
 * agreements dated back to 2000 would otherwise hold the jobs route for its
 * whole life, and the backstops after it would never run).
 */
export const MOVE_CAP = 1_000;

const isInterval = (v: string | null): v is RenewalInterval => v === "MONTHLY" || v === "QUARTERLY" || v === "YEARLY";

const utcDay = (d: Date): string => d.toISOString().slice(0, 10);

export type RenewalMoveRun = { readonly moved: number; readonly failed: number; readonly held: number };

/**
 * An agreement as its date's move reads it — the LOCKED row, in plain values —
 * for a hold to judge (slice 113b: the invoicing module's `agreementHoldsDate`
 * keeps a date where it is while a started period is still owed a draft; this
 * module knows nothing of invoices).
 */
export type MoveFacts = {
  readonly renewsOn: string;
  readonly interval: RenewalInterval;
  readonly anchorDay: number;
  readonly endsOn: string | null;
  readonly invoicedThrough: string | null;
  readonly invoiceRenewals: boolean;
  /** The price as stored ("1200.00"), or null. */
  readonly price: string | null;
  readonly currency: string | null;
  readonly clientActive: boolean;
  readonly name: string;
};

/** True: leave this agreement's date where it is this run. */
export type MoveHold = (facts: MoveFacts, today: string) => boolean;

/**
 * Move on every passed renewal date of this tenant's running agreements.
 *
 * THE PLAN PAGES THROUGH EVERY DUE ROW (the design review's low): a row the
 * move can never touch — one beyond the step bound — stays "due" for good,
 * and a first-500-by-id plan would let the oldest of them fill every run.
 * One whose END has passed is not even planned (it ends before any next
 * renewal). And ONE AGREEMENT'S FAILURE DOES NOT STOP THE REST: it is
 * counted and logged by id and error name only, and the next one moves.
 * The job passes a `deadline` (its time budget); what is left moves next run.
 * And a `hold` (slice 113b): an agreement it holds keeps its date this run.
 */
export async function moveRenewalDatesOn(
  tenantId: string,
  now: Date = new Date(),
  opts: { readonly deadline?: number; readonly hold?: MoveHold } = {},
): Promise<RenewalMoveRun> {
  if (typeof tenantId !== "string" || tenantId.length === 0) throw new TypeError("services: tenantId must be a non-empty string");
  const today = await withTenant(tenantId, SYSTEM, async (tx) => localDateString(now, (await readPreferences(tx, tenantId)).timezone));
  const out = { moved: 0, failed: 0, held: 0 };
  let after: string | null = null;
  const deadline = opts.deadline ?? Number.POSITIVE_INFINITY;
  for (let seen = 0; seen < MOVE_CAP && Date.now() < deadline; ) {
    const cursor: string | null = after;
    // A date before today's UTC midnight has a UTC day before today.
    const page: { id: string }[] = await withTenant(tenantId, SYSTEM, (tx) =>
      tx.service.findMany({
        where: {
          tenantId,
          status: "ACTIVE",
          kind: "RECURRING",
          billingInterval: { not: null },
          renewsAt: { lt: dateColumn(today) },
          OR: [{ endsAt: null }, { endsAt: { gte: dateColumn(today) } }],
          ...(cursor === null ? {} : { id: { gt: cursor } }),
        },
        orderBy: { id: "asc" },
        take: MOVE_BATCH,
        select: { id: true },
      }),
    );
    for (const { id } of page) {
      if (Date.now() >= deadline) break; // the rest wait for the next run
      try {
        const r = await moveOne(tenantId, id, today, opts.hold);
        if (r === "moved") out.moved += 1;
        else if (r === "held") out.held += 1;
      } catch (e) {
        out.failed += 1;
        const code = typeof e === "object" && e !== null && "code" in e ? ` (${String((e as { code: unknown }).code)})` : "";
        console.error(`agreement-renewals: tenant ${tenantId} agreement ${id} failed: ${e instanceof Error ? e.name : typeof e}${code}`);
      }
    }
    seen += page.length;
    if (page.length < MOVE_BATCH) break;
    after = page[page.length - 1]!.id;
  }
  return out;
}

async function moveOne(tenantId: string, serviceId: string, today: string, hold: MoveHold | undefined): Promise<"moved" | "held" | "stays"> {
  return withTenant(
    tenantId,
    SYSTEM,
    async (tx) => {
      const rows = await tx.$queryRaw<
        {
          client_id: string;
          status: string;
          kind: string;
          billing_interval: string | null;
          renews_at: Date | null;
          renewal_day: number | null;
          ends_at: Date | null;
          invoice_renewals: boolean;
          price: string | null;
          currency: string | null;
          invoiced_through: Date | null;
          name: string;
          client_active: boolean;
        }[]
      >`
        SELECT s.client_id, s.status::text AS status, s.kind::text AS kind, s.billing_interval::text AS billing_interval,
               s.renews_at, s.renewal_day, s.ends_at, s.invoice_renewals, s.price_ex_vat::text AS price, s.currency,
               s.invoiced_through, s.name,
               EXISTS (SELECT 1 FROM client c WHERE c.tenant_id = s.tenant_id AND c.id = s.client_id AND c.status = 'ACTIVE') AS client_active
          FROM service s
         WHERE s.tenant_id = ${tenantId} AND s.id = ${serviceId}
           FOR UPDATE OF s`;
      const s = rows[0];
      if (!s || s.status !== "ACTIVE" || s.kind !== "RECURRING" || !isInterval(s.billing_interval) || s.renews_at === null) return "stays";
      const from = utcDay(s.renews_at);
      const anchor = anchorOf(from, s.renewal_day);
      if (anchor === null) return "stays";
      const step = nextRenewal(from, today, s.billing_interval, anchor);
      if (step === null) return "stays";
      // It ends before it would renew again: the end stands, the date stays.
      if (s.ends_at !== null && step.next > utcDay(s.ends_at)) return "stays";
      // A started period still owed a draft keeps its date (slice 113b).
      const facts: MoveFacts = {
        renewsOn: from,
        interval: s.billing_interval,
        anchorDay: anchor,
        endsOn: s.ends_at === null ? null : utcDay(s.ends_at),
        invoicedThrough: s.invoiced_through === null ? null : utcDay(s.invoiced_through),
        invoiceRenewals: s.invoice_renewals,
        price: s.price,
        currency: s.currency,
        clientActive: s.client_active,
        name: s.name,
      };
      if (hold?.(facts, today)) return "held";
      await tx.service.update({
        where: { id: serviceId },
        data: { renewsAt: dateColumn(step.next), renewalDay: anchor },
        select: { id: true },
      });
      await record(tx, {
        action: "service.renewed",
        targetType: "Service",
        targetId: serviceId,
        metadata: { clientId: s.client_id, from, to: step.next, steps: step.steps },
      });
      return "moved";
    },
    // A row a person holds waits at most this long; it moves next run (the security review's low).
    { lockTimeoutMs: 5_000 },
  );
}

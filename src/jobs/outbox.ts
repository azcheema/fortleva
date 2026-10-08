import { appUrl } from "@/config";
import { withPlatform, withTenant } from "@/db";
import { isRecipientRefusal, send, type SendOutcome } from "@/mailer";
import { isNotificationKind, NOTIFICATION_KINDS } from "@/notify/catalog";
import { CONTACT_DIGEST_MAIL, renderContactDigest } from "@/notify/client-digest";
import { clientSummaryToken } from "@/notify/client-summary-token";
import { synthesiseContactPrincipal } from "@/portal";
import { countClientSummary } from "@/portal/weekly-summary";
import {
  DIGEST_CATCH_UP_HOURS,
  DIGEST_DROPPED_LATE,
  DIGEST_DROPPED_UNWANTED,
  DIGEST_SEND_GRACE_HOURS,
  DIGEST_SENDING_TENANT_STATUSES,
  MEMBER_DIGEST_MAIL,
} from "@/notify/digest";
import { MAIL_WITHOUT_REPLY_TO, resolveReplyAddress } from "@/notify/reply-address-resolve";
import { isEmailTemplate, renderEmail } from "@/notify/templates";
import { MAIL_PREF_KEYS } from "@/preferences/config";

/**
 * The outbox drain (ARC-21; §6.18): claims due rows with FOR UPDATE SKIP
 * LOCKED under the platform system principal, resolves each one INSIDE
 * the claim transaction (unknown kind → DEAD, debounce cancelled → SKIPPED,
 * suppressed address → SUPPRESSED, template rendered), then sends each
 * remaining message OUTSIDE any database transaction and finalises it in
 * its own short transaction. Invoked by a Vercel Cron every 2 minutes
 * (Pro) later; today by after() kicks and the authenticated
 * POST /api/jobs/run. Safe to run concurrently — the claim is the lock.
 *
 * Delivery is AT-LEAST-ONCE: enqueue is exactly-once (the idempotency
 * key), but a send that succeeded just before its finalise failed is
 * re-sent when the lease is reclaimed. Two things the review found and
 * this shape fixes: a claimed row whose delivery threw stayed SENDING
 * forever (nothing reclaimed a stale lease and one throw aborted the whole
 * loop), and the external send ran inside a 5 s database transaction.
 * withPlatform writes the platform audit event for the claim and for each
 * finalise (TENANCY §12).
 */

const MAX_ATTEMPTS = 8;
/** A SENDING row older than this was abandoned mid-flight (crash, timeout) and is claimed again. */
const LEASE_MINUTES = 10;
/**
 * How long one drain may spend counting the clients' summaries again after its
 * claim (slice 101) — well inside the lease, leaving the sends their time.
 */
const RECOUNT_BUDGET_MS = 4 * 60_000;
/**
 * How long after its claim one drain may go on SENDING (slice 103, the design
 * review's low): with a real transport each send can take seconds (SES's
 * timeouts, one SDK retry), and a drain still sending when its rows' lease
 * ran out would race the next drain's reclaim of them — the same mail twice.
 * Two minutes short of the lease; past it the rows not attempted go back to
 * the queue (`releaseUnattempted`), re-checked by the next drain.
 */
const SEND_BUDGET_MS = (LEASE_MINUTES - 2) * 60_000;
/** Failed sends in a row that say the transport is down: the pass ends. */
const MAX_FAILURES_IN_A_ROW = 3;
/**
 * No claim with less than this left before the caller's `sendUntil` (the
 * fix-pass review's low): a batch claimed a moment before the deadline would
 * be leased for ten minutes and sent by nobody.
 */
const CLAIM_MARGIN_MS = 15_000;

type ClaimedRow = {
  id: string;
  tenant_id: string;
  receiver_type: string;
  receiver_id: string;
  kind: string;
  locale: string;
  to_email: string;
  params: Record<string, unknown> | null;
  notification_ids: string[];
  attempts: number;
  created_at: Date;
  send_after: Date;
  /**
   * The claim's own lease stamp, AS POSTGRES WROTE IT (`locked_at::text`) —
   * the same `now()` for every row of one claim. Text, never a JS `Date`: a
   * `Date` keeps milliseconds and the column microseconds, so a `Date` read
   * back would match no row.
   */
  lease: string;
};

type Outcome = "sent" | "skipped" | "suppressed" | "failed" | "dead";
type Prepared = {
  row: ClaimedRow;
  subject: string;
  text: string;
  /** RFC 8058's one-click address — the clients' weekly summary only (slice 101). */
  listUnsubscribe?: string;
};

/**
 * A client person's weekly summary that passed every check inside the claim
 * and is counted AGAIN, as the person, after it (slice 101): `since`/`until`
 * are the window its new lines count, set by the job.
 */
type Recount = {
  row: ClaimedRow;
  contact: { id: string; tenantId: string; clientId: string };
  since: Date;
  until: Date;
};

const SYSTEM = { type: "system", job: "outbox" } as const;

export async function drainOutbox(
  limit = 50,
  opts?: {
    /**
     * Drain ONE tenant's rows only. For a dbtest, which must never claim —
     * and "send" — another tenant's mail on the shared database (AGENTS.md:
     * no writes outside your own throwaway tenant; slice 100's design
     * review). Production drains every tenant.
     */
    readonly tenantId?: string;
    /**
     * No send STARTS after this moment (epoch ms) — the caller's own clock
     * (slice 103, the code review's medium): `POST /api/jobs/run` runs every
     * other job after the drain, inside one function's lifetime, and a slow
     * SES must not spend it all. Rows left unsent go back to the queue
     * (`releaseUnattempted`). `SEND_BUDGET_MS` from the claim bounds it either
     * way.
     */
    readonly sendUntil?: number;
  },
): Promise<{ sent: number; skipped: number; suppressed: number; failed: number; dead: number }> {
  const out = { sent: 0, skipped: 0, suppressed: 0, failed: 0, dead: 0 };
  const only = opts?.tenantId;
  // The lease starts at the claim (`locked_at = now()` in it); every budget
  // below is measured from just before it, so it can only err early.
  const claimStarted = Date.now();
  if (opts?.sendUntil !== undefined && opts.sendUntil - claimStarted < CLAIM_MARGIN_MS) return out;

  const { toSend: claimedToSend, recount } = await withPlatform(
    SYSTEM,
    only ? `claim one tenant's due email_outbox rows (FOR UPDATE SKIP LOCKED)` : "claim due email_outbox rows (FOR UPDATE SKIP LOCKED) and resolve them",
    async (tx) => {
      // OLDEST FIRST, FOR REAL (slice 103, the narrow re-check's medium): an
      // `UPDATE … RETURNING` keeps no order — the subquery's `ORDER BY` picks
      // WHICH rows, not the order they come back in (a hash join returns them
      // by id) — so the claim is wrapped and sorted. Sends then go oldest
      // first, and a pass that stops early hands back the newest.
      const claimed = only
        ? await tx.$queryRaw<ClaimedRow[]>`
      WITH claimed AS (
        UPDATE email_outbox SET status = 'SENDING', locked_at = now(), updated_at = now()
        WHERE id IN (
          SELECT id FROM email_outbox
          WHERE tenant_id = ${only}
            AND ((status IN ('QUEUED', 'FAILED') AND send_after <= now())
             OR (status = 'SENDING' AND locked_at < now() - make_interval(mins => ${LEASE_MINUTES})))
          ORDER BY send_after
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, tenant_id, receiver_type, receiver_id, kind, locale, to_email, params, notification_ids, attempts, created_at, send_after, locked_at::text AS lease
      )
      SELECT * FROM claimed ORDER BY send_after, id`
        : await tx.$queryRaw<ClaimedRow[]>`
      WITH claimed AS (
        UPDATE email_outbox SET status = 'SENDING', locked_at = now(), updated_at = now()
        WHERE id IN (
          SELECT id FROM email_outbox
          WHERE (status IN ('QUEUED', 'FAILED') AND send_after <= now())
             OR (status = 'SENDING' AND locked_at < now() - make_interval(mins => ${LEASE_MINUTES}))
          ORDER BY send_after
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, tenant_id, receiver_type, receiver_id, kind, locale, to_email, params, notification_ids, attempts, created_at, send_after, locked_at::text AS lease
      )
      SELECT * FROM claimed ORDER BY send_after, id`;
      const toSend: Prepared[] = [];
      const recount: Recount[] = [];
      // The summaries' receivers, read ONCE for the whole claim rather than
      // per row (the fix-pass review: two reads per summary inside a leased
      // transaction add up over a slow link). Keyed by tenant and member.
      const digestRows = claimed.filter((r) => r.kind === MEMBER_DIGEST_MAIL);
      const standing = new Map<string, { status: string; tenantStatus: string }>();
      const summaryPrefs = new Map<string, { emailLevel: string; digestCadence: string }>();
      if (digestRows.length > 0) {
        const ids = [...new Set(digestRows.map((r) => r.receiver_id))];
        for (const m of await tx.member.findMany({
          where: { id: { in: ids } },
          select: { id: true, tenantId: true, status: true, tenant: { select: { status: true } } },
        })) {
          standing.set(`${m.tenantId}:${m.id}`, { status: m.status, tenantStatus: m.tenant.status });
        }
        for (const p of await tx.notificationPreference.findMany({
          where: { receiverType: "MEMBER", receiverId: { in: ids } },
          select: { tenantId: true, receiverId: true, emailLevel: true, digestCadence: true },
        })) {
          summaryPrefs.set(`${p.tenantId}:${p.receiverId}`, { emailLevel: p.emailLevel, digestCadence: p.digestCadence });
        }
      }
      // The clients' summaries' receivers (slice 101), read once per claim like
      // the team's: each person's standing, their own stop, and their
      // workspace's switch — any of which may have changed since the job.
      const contactRows = claimed.filter((r) => r.kind === CONTACT_DIGEST_MAIL);
      const contactStanding = new Map<
        string,
        { status: string; invited: boolean; tenantStatus: string; clientId: string; email: string; clientArchived: boolean }
      >();
      const contactStopped = new Set<string>();
      const clientSummaryOff = new Set<string>();
      if (contactRows.length > 0) {
        const ids = [...new Set(contactRows.map((r) => r.receiver_id))];
        for (const c of await tx.contact.findMany({
          where: { id: { in: ids } },
          select: {
            id: true,
            tenantId: true,
            clientId: true,
            email: true,
            portalStatus: true,
            invitedAt: true,
            tenant: { select: { status: true } },
            client: { select: { archivedAt: true } },
          },
        })) {
          contactStanding.set(`${c.tenantId}:${c.id}`, {
            status: c.portalStatus,
            invited: c.invitedAt !== null,
            tenantStatus: c.tenant.status,
            clientId: c.clientId,
            email: c.email.toLowerCase(),
            clientArchived: c.client.archivedAt !== null,
          });
        }
        for (const p of await tx.notificationPreference.findMany({
          where: { receiverType: "CONTACT", receiverId: { in: ids }, digestCadence: "NONE" },
          select: { tenantId: true, receiverId: true },
        })) {
          contactStopped.add(`${p.tenantId}:${p.receiverId}`);
        }
        // The switch is ON unless it says `false` — `materializePreferences`'
        // reading of a boolean key with a true default.
        for (const pref of await tx.tenantPreference.findMany({
          where: {
            tenantId: { in: [...new Set(contactRows.map((r) => r.tenant_id))] },
            key: MAIL_PREF_KEYS.clientSummary,
          },
          select: { tenantId: true, value: true },
        })) {
          if (pref.value === false) clientSummaryOff.add(pref.tenantId);
        }
      }
      for (const row of claimed) {
        // TEMPLATE key, not notification kind (see notify/templates.ts):
        // outbox rows exist that no fan-out produced — the 2T weekly
        // self-reminder — and treating those as unknown killed them.
        if (!isEmailTemplate(row.kind)) {
          await tx.emailOutbox.update({ where: { id: row.id }, data: { status: "DEAD", lastError: "unknown kind", lockedAt: null } });
          out.dead += 1;
          continue;
        }
        const kind = row.kind;
        // Debounce cancellation: an assignment read within the window is
        // SKIPPED, not sent (§6.18). Only a fan-out kind has one — a row
        // with no notification behind it has nothing that could be read.
        const spec = isNotificationKind(kind) ? NOTIFICATION_KINDS[kind] : null;
        if (spec?.email?.cancelledIfRead && row.notification_ids.length > 0) {
          const unread = await tx.notification.count({ where: { id: { in: row.notification_ids }, readAt: null } });
          if (unread === 0) {
            await tx.emailOutbox.update({ where: { id: row.id }, data: { status: "SKIPPED", lockedAt: null } });
            out.skipped += 1;
            continue;
          }
        }
        // Suppression re-checked at send (a bounce may have landed since enqueue).
        const suppressed = await tx.emailSuppression.findUnique({ where: { email: row.to_email } });
        if (suppressed) {
          await tx.emailOutbox.update({ where: { id: row.id }, data: { status: "SUPPRESSED", lockedAt: null } });
          out.suppressed += 1;
          continue;
        }
        // A member's SUMMARY (slice 100) is rendered from the rows it covers
        // that are STILL unread now — bodies at send time (§6.18) — so it
        // never reports news its reader has already opened, and one whose
        // rows have all been read since is SKIPPED, like a read assignment.
        // A CLIENT PERSON'S weekly summary (slice 101, C69): still WANTED —
        // the person active, invited, at a client not archived, at the address
        // it was made for, not stopped by them, the workspace sending with its
        // switch on — and still ON TIME, as the team's is; then COUNTED AGAIN,
        // as the person, after this claim (`recount`, below).
        if (kind === CONTACT_DIGEST_MAIL) {
          const at = `${row.tenant_id}:${row.receiver_id}`;
          const person = contactStanding.get(at);
          const since = typeof row.params?.["since"] === "string" ? new Date(row.params["since"]) : null;
          const until = typeof row.params?.["until"] === "string" ? new Date(row.params["until"]) : null;
          const wanted =
            row.receiver_type === "CONTACT" &&
            person !== undefined &&
            person.status === "ACTIVE" &&
            person.invited &&
            !person.clientArchived &&
            person.email === row.to_email &&
            (DIGEST_SENDING_TENANT_STATUSES as readonly string[]).includes(person.tenantStatus) &&
            !contactStopped.has(at) &&
            !clientSummaryOff.has(row.tenant_id) &&
            since !== null &&
            until !== null &&
            Number.isFinite(since.getTime()) &&
            Number.isFinite(until.getTime());
          const late = summaryIsLate(row, new Date());
          if (!wanted || late) {
            // Tagged, so the next summary does not count from a summary
            // nobody received (`DIGEST_DROPPED_*`, src/notify/digest.ts).
            await tx.emailOutbox.update({
              where: { id: row.id },
              data: { status: "SKIPPED", lockedAt: null, lastError: late ? DIGEST_DROPPED_LATE : DIGEST_DROPPED_UNWANTED },
            });
            out.skipped += 1;
            continue;
          }
          recount.push({
            row,
            contact: { id: row.receiver_id, tenantId: row.tenant_id, clientId: person.clientId },
            since: since!,
            until: until!,
          });
          continue;
        }
        let params = row.params;
        if (kind === MEMBER_DIGEST_MAIL) {
          const now = new Date();
          // Still WANTED, and still on time (the code review's low): a member
          // who chose Never — or no email at all — after it was made, a
          // suspended member or workspace, or a summary still unsent hours
          // after it was made (a retrying transport) is dropped, not sent:
          // "each morning", never in the afternoon.
          const member = standing.get(`${row.tenant_id}:${row.receiver_id}`);
          const pref = summaryPrefs.get(`${row.tenant_id}:${row.receiver_id}`);
          const wanted =
            member?.status === "ACTIVE" &&
            (DIGEST_SENDING_TENANT_STATUSES as readonly string[]).includes(member.tenantStatus) &&
            pref?.emailLevel !== "NONE" &&
            pref?.digestCadence !== "NONE";
          const late = summaryIsLate(row, now);
          if (!wanted || late) {
            // Tagged, so the next summary does not count from a summary
            // nobody received (`DIGEST_DROPPED_*`, src/notify/digest.ts).
            await tx.emailOutbox.update({
              where: { id: row.id },
              data: { status: "SKIPPED", lockedAt: null, lastError: late ? DIGEST_DROPPED_LATE : DIGEST_DROPPED_UNWANTED },
            });
            out.skipped += 1;
            continue;
          }
          const counts = await tx.notification.groupBy({
            by: ["kind"],
            where: {
              // The row's own receiver, a second belt: the ids came from the
              // job, but a summary must never count anyone else's inbox.
              tenantId: row.tenant_id,
              receiverType: "MEMBER",
              receiverId: row.receiver_id,
              id: { in: row.notification_ids },
              readAt: null,
              archivedAt: null,
              OR: [{ snoozedTill: null }, { snoozedTill: { lte: now } }],
            },
            _count: { _all: true },
          });
          if (counts.length === 0) {
            await tx.emailOutbox.update({ where: { id: row.id }, data: { status: "SKIPPED", lockedAt: null } });
            out.skipped += 1;
            continue;
          }
          params = { counts: Object.fromEntries(counts.map((c) => [c.kind, c._count._all])) };
        }
        try {
          const msg = renderEmail(kind, row.locale, params);
          toSend.push({ row, subject: msg.subject, text: msg.text });
        } catch (e) {
          const dead = row.attempts + 1 >= MAX_ATTEMPTS;
          await tx.emailOutbox.update({ where: { id: row.id }, data: failureData(row, e, dead) });
          out[dead ? "dead" : "failed"] += 1;
        }
      }
      return { toSend, recount };
    },
    // A one-tenant drain's audit row is THAT tenant's (TENANCY §12) — and so
    // a dbtest's goes with its throwaway tenant (the code review's low).
    { readOnly: false, ...(only ? { targetTenantId: only } : {}) },
  );

  // THE CLIENTS' SUMMARIES, COUNTED AGAIN AT SEND (slice 101; the design
  // review's medium): the job counted to decide there was something to say,
  // but an hour or more can pass before this drain, in which a file can be
  // made internal, a sign-off answered, a profile changed. So each is counted
  // now, as the person, through the very function the job used — the
  // portal's own projections under their principal — outside the claim
  // (each projection opens its own transaction; the rows stay leased), in
  // sequence. Nothing left to say → SKIPPED, untagged (it still chains: it
  // lost nothing). A failure → FAILED with the usual backoff, never a mail of
  // zeros; logged by ids, name and code only.
  const prepared: Prepared[] = [...claimedToSend];
  const recountStarted = Date.now();
  for (const [i, item] of recount.entries()) {
    const { row } = item;
    // INSIDE THE LEASE (the code review's low): a recount that ran past
    // `LEASE_MINUTES` could have its rows claimed — and sent — by an
    // overlapping drain. Past the budget the rest go back to the queue, for
    // the next drain to check again (and drop if too late by then).
    if (Date.now() - recountStarted > RECOUNT_BUDGET_MS || Date.now() > (opts?.sendUntil ?? Number.POSITIVE_INFINITY)) {
      await releaseUnattempted(recount.slice(i).map((r) => r.row), only);
      break;
    }
    let mail: { subject: string; text: string } | null = null;
    let refused = false;
    try {
      const principal = await synthesiseContactPrincipal(row.tenant_id, item.contact);
      const counts = await countClientSummary(principal, item.since, item.until);
      if (counts === null) refused = true;
      else {
        mail = renderContactDigest(row.locale, counts, {
          portal: new URL("/portal", appUrl).toString(),
          unsubscribe: new URL(`/portal/unsubscribe/${clientSummaryToken(row.tenant_id, row.receiver_id)}`, appUrl).toString(),
        });
      }
    } catch (e) {
      // The NAME and code only, in the log and in the row's `lastError` (the
      // security review's nit): a Prisma message prints the query's
      // arguments, and the row is kept 90 days and goes into the tenant's
      // own export.
      const code = typeof e === "object" && e !== null && "code" in e ? ` (${String((e as { code: unknown }).code)})` : "";
      const what = `${e instanceof Error ? e.name : typeof e}${code}`;
      console.error(`outbox: client summary ${row.id} could not be counted: ${what}`);
      const dead = row.attempts + 1 >= MAX_ATTEMPTS;
      out[await finaliseUnsent(row, failureData(row, new Error(`client summary count failed: ${what}`), dead), dead ? "dead" : "failed", only)] += 1;
      continue;
    }
    if (refused) {
      // Refused EVERYWHERE — the person paused, or the portal switched off,
      // since the claim's checks: no longer wanted, and tagged so the next
      // summary does not count from it (the code review's low).
      out[await finaliseUnsent(row, { status: "SKIPPED", lockedAt: null, lastError: DIGEST_DROPPED_UNWANTED }, "skipped", only)] += 1;
      continue;
    }
    if (mail === null) {
      // `lastError` cleared: a row that failed once and has nothing to say on
      // its retry lost nothing, so it must still be a link in the chain — the
      // job chains only from an untagged SKIPPED (the security review's nit).
      out[await finaliseUnsent(row, { status: "SKIPPED", lockedAt: null, lastError: null }, "skipped", only)] += 1;
      continue;
    }
    prepared.push({
      row,
      subject: mail.subject,
      text: mail.text,
      listUnsubscribe: new URL(
        `/api/client-summary/unsubscribe/${clientSummaryToken(row.tenant_id, row.receiver_id)}`,
        appUrl,
      ).toString(),
    });
  }

  // WHERE A REPLY GOES (slice 100, C68 (c), (f)): every outbox mail belongs
  // to a workspace, and carries that workspace's reply address — once per
  // workspace per drain, each under its OWN system principal, outside the
  // claim (its rows are leased). A workspace whose address cannot be read is
  // logged by name and code and its mail goes without one: a reply that
  // bounces is a smaller failure than a notice that never leaves.
  const replyTo = new Map<string, string | undefined>();
  for (const tenantId of new Set(prepared.map((p) => p.row.tenant_id))) {
    try {
      const address = await withTenant(tenantId, { type: "system" }, (tx) => resolveReplyAddress(tx, tenantId));
      replyTo.set(tenantId, address ?? undefined);
    } catch (e) {
      replyTo.set(tenantId, undefined);
      const code = typeof e === "object" && e !== null && "code" in e ? ` (${String((e as { code: unknown }).code)})` : "";
      console.error(`outbox: reply address for tenant ${tenantId} unreadable: ${e instanceof Error ? e.name : typeof e}${code}`);
    }
  }

  // One row's failure never blocks the next: each send + finalise is
  // isolated and every path below resolves to an outcome — until the
  // transport looks DOWN: three transport failures in a row end the pass (the
  // code review's medium — each failed SES call can take half a minute). A
  // refusal of ONE recipient (a reserved domain, a dev allowlist) costs
  // nothing and says nothing about the transport, so it does not count (the
  // fix-pass review's low).
  const sendDeadline = Math.min(claimStarted + SEND_BUDGET_MS, opts?.sendUntil ?? Number.POSITIVE_INFINITY);
  // Oldest first across BOTH kinds — the claim's order, with the counted-again
  // client summaries put back in it (the final check's nit) — so a pass that
  // stops early hands back the newest, whatever they are.
  prepared.sort((a, b) => a.row.send_after.getTime() - b.row.send_after.getTime() || (a.row.id < b.row.id ? -1 : 1));
  let failedInARow = 0;
  for (const [i, item] of prepared.entries()) {
    // Inside the lease (`SEND_BUDGET_MS`) and the caller's own deadline. The
    // rows not attempted go straight back to the queue (the fix-pass review's
    // low) — never left leased for ten minutes, never sent by two drains.
    if (Date.now() > sendDeadline || failedInARow >= MAX_FAILURES_IN_A_ROW) {
      await releaseUnattempted(prepared.slice(i).map((p) => p.row), only);
      break;
    }
    // A security notice to the workspace's own members carries none: a reply
    // to it would go to an address an admin may have set
    // (`MAIL_WITHOUT_REPLY_TO`).
    const address = MAIL_WITHOUT_REPLY_TO.has(item.row.kind) ? undefined : replyTo.get(item.row.tenant_id);
    const { outcome, transportDown } = await sendAndFinalise(item, address, only);
    out[outcome] += 1;
    // Only a SENT mail proves the transport up; a refusal of one recipient or
    // a blocked address never reached it, so it leaves the streak as it was
    // (the narrow re-check's nit).
    if (transportDown) failedInARow += 1;
    else if (outcome === "sent") failedInARow = 0;
  }
  return out;
}

/**
 * Hand claimed rows that were never attempted back to the queue, in one short
 * transaction: QUEUED again, unleased, their attempts and `send_after` as they
 * were — the next drain takes them up. ONLY while the lease is still THIS
 * drain's (`locked_at` = the claim's own stamp — the narrow re-check's low): a
 * recount stalled past the lease may already have had its rows reclaimed by
 * another drain, and releasing those would let a third send them twice. A
 * release that fails leaves them for the lease reclaim, as before.
 */
async function releaseUnattempted(rows: readonly ClaimedRow[], only: string | undefined): Promise<void> {
  if (rows.length === 0) return;
  try {
    await withPlatform(
      SYSTEM,
      `release ${rows.length} unattempted outbox row(s)`,
      // Every row of one claim carries the same lease stamp, compared in SQL
      // against the text Postgres gave us.
      (tx) => tx.$executeRaw`
        UPDATE email_outbox SET status = 'QUEUED', locked_at = NULL, updated_at = now()
        WHERE id = ANY(${rows.map((r) => r.id)}::text[]) AND status = 'SENDING' AND locked_at = ${rows[0]!.lease}::timestamptz`,
      { readOnly: false, ...(only ? { targetTenantId: only } : {}) },
    );
  } catch (e) {
    // The lease reclaim takes them up in ten minutes. The NAME and code only,
    // as every catch here (a Prisma message prints its arguments).
    const code = typeof e === "object" && e !== null && "code" in e ? ` (${String((e as { code: unknown }).code)})` : "";
    console.error(`outbox: releasing ${rows.length} unattempted row(s) failed: ${e instanceof Error ? e.name : typeof e}${code}`);
  }
}

/**
 * A summary — the team's or a client person's — still unsent four hours after
 * its time: its three catch-up hours and one of grace. Measured from the
 * SUMMARY'S TIME (`params.dueAt`), else — a row made without one — from its
 * creation.
 */
function summaryIsLate(row: ClaimedRow, now: Date): boolean {
  const dueAt = typeof row.params?.["dueAt"] === "string" ? Date.parse(row.params["dueAt"]) : NaN;
  const from = Number.isFinite(dueAt) ? dueAt : new Date(row.created_at).getTime();
  return now.getTime() > from + (DIGEST_CATCH_UP_HOURS + DIGEST_SEND_GRACE_HOURS) * 3_600_000;
}

const failureData = (row: ClaimedRow, e: unknown, dead: boolean) => ({
  status: (dead ? "DEAD" : "FAILED") as "DEAD" | "FAILED",
  attempts: { increment: 1 },
  lastError: (e instanceof Error ? e.message : String(e)).slice(0, 500),
  // Exponential backoff: 1, 2, 4, 8 … minutes.
  sendAfter: new Date(Date.now() + 2 ** row.attempts * 60_000),
  lockedAt: null,
});

/**
 * Close a claimed row that will not be sent, in its own short transaction —
 * a client summary with nothing left to say, or one that could not be
 * counted. A finalise that itself fails leaves the row SENDING for the lease
 * reclaim, as `sendAndFinalise` does.
 */
async function finaliseUnsent(
  row: ClaimedRow,
  data: ReturnType<typeof failureData> | { status: "SKIPPED"; lockedAt: null; lastError: string | null },
  outcome: Outcome,
  only: string | undefined,
): Promise<Outcome> {
  try {
    await withPlatform(
      SYSTEM,
      `finalise outbox row ${row.id} (${row.kind}) unsent`,
      async (tx) => {
        await tx.emailOutbox.update({ where: { id: row.id }, data, select: { id: true } });
      },
      { readOnly: false, ...(only ? { targetTenantId: only } : {}) },
    );
    return outcome;
  } catch {
    return "failed";
  }
}

/**
 * Send one row and finalise it; `transportDown` when the send failed for a
 * reason other than refusing this one recipient — what the pass counts.
 */
async function sendAndFinalise(
  prepared: Prepared,
  replyTo: string | undefined,
  only: string | undefined,
): Promise<{ outcome: Outcome; transportDown: boolean }> {
  const result = await sendAndFinaliseRow(prepared, replyTo, only);
  return { outcome: result.outcome, transportDown: result.sendError !== null && !isRecipientRefusal(result.sendError) };
}

async function sendAndFinaliseRow(
  { row, subject, text, listUnsubscribe }: Prepared,
  replyTo: string | undefined,
  only: string | undefined,
): Promise<{ outcome: Outcome; sendError: unknown }> {
  let sendError: unknown = null;
  let outcome: SendOutcome | null = null;
  try {
    outcome = await send({
      to: row.to_email,
      subject,
      text,
      ...(replyTo ? { replyTo } : {}),
      ...(listUnsubscribe ? { listUnsubscribe } : {}),
    });
  } catch (e) {
    sendError = e;
  }
  try {
    const finalised = await withPlatform(
      SYSTEM,
      `finalise outbox row ${row.id} (${row.kind})`,
      async (tx) => {
        if (outcome === "suppressed") {
          // Blocked between the claim's check and the send (a bounce or a
          // complaint landed in between — slice 103): `send()` sent nothing,
          // and the row says so, as the claim's own check would have.
          await tx.emailOutbox.update({ where: { id: row.id }, data: { status: "SUPPRESSED", lockedAt: null } });
          return "suppressed" as const;
        }
        if (sendError === null) {
          await tx.emailOutbox.update({
            where: { id: row.id },
            data: { status: "SENT", sentAt: new Date(), attempts: { increment: 1 }, lockedAt: null },
          });
          // `emailedAt` says the mail ABOUT that one notification went. A
          // summary is an overview of many (C68 (h)) and counts them by time
          // instead (`digestSince`), so it stamps nothing.
          if (row.notification_ids.length > 0 && row.kind !== MEMBER_DIGEST_MAIL) {
            await tx.notification.updateMany({
              where: { id: { in: row.notification_ids } },
              data: { emailedAt: new Date() },
            });
          }
          return "sent" as const;
        }
        const dead = row.attempts + 1 >= MAX_ATTEMPTS;
        await tx.emailOutbox.update({ where: { id: row.id }, data: failureData(row, sendError, dead) });
        return dead ? ("dead" as const) : ("failed" as const);
      },
      { readOnly: false, ...(only ? { targetTenantId: only } : {}) },
    );
    return { outcome: finalised, sendError };
  } catch {
    // The finalise itself failed (connection, timeout): the row stays
    // SENDING and the lease reclaim revisits it — at-least-once.
    return { outcome: outcome === "suppressed" ? "suppressed" : sendError === null ? "sent" : "failed", sendError };
  }
}

import { withPlatform, withTenant } from "@/db";
import {
  CLIENT_DIGEST_HOUR,
  CLIENT_DIGEST_WEEKDAY,
  CONTACT_DIGEST_MAIL,
  clientDigestHasNews,
  contactDigestKey,
  type ClientDigestCounts,
} from "@/notify/client-digest";
import {
  DIGEST_SENDING_TENANT_STATUSES,
  DIGEST_SETTLE_MS,
  digestChainFloor,
  digestSince,
  periodDueNow,
} from "@/notify/digest";
import { synthesiseContactPrincipal } from "@/portal";
import { countClientSummary } from "@/portal/weekly-summary";
import { readPreferences } from "@/preferences/service";

/**
 * THE CLIENTS' WEEKLY SUMMARY EMAIL — the job (Phase 5 slice 101; founder
 * decision C69, on C68 (b), (e)). The rules — what a summary says, when it
 * has something to say — are `src/notify/client-digest.ts`'s; WHAT it counts
 * is `src/portal/weekly-summary.ts`'s, which reads only through the portal's
 * own projections as each person. This file decides who and when.
 *
 * WHO: every person at a client with portal access — `portalStatus ACTIVE`
 * and invited, `authorizePortal`'s own admission (C69 (b)), at a client the
 * agency has not archived — who has not
 * stopped their own summary (`NotificationPreference` CONTACT, cadence NONE,
 * `src/notify/client-summary.ts`), whose address is not suppressed, in a
 * workspace still sending whose switch (`mail.clientSummary`, C69 (d)) is on.
 *
 * WHEN: Monday 08:00 in the WORKSPACE's time zone (C68 (b)), and only in the
 * three hours after it — the team's summary's `periodDueNow`, so a missed
 * morning never becomes an afternoon mail. ONE outbox row per person per ISO
 * week (`digest:contact:<id>:<YYYY-Www>`, the idempotency key), and only when
 * there is something new OR something waiting on them (C69 (c)). "New" counts
 * from the person's LAST summary (`digestSince`, the team's chain rule), else
 * from a week back.
 *
 * The row carries TIMES only — the summary's (`params.dueAt`, from which the
 * outbox drops it if it is still unsent four hours later) and the window its
 * new lines count (`since`, `until`) — never a number or a name. The counts
 * here only decide whether there is anything to say: the OUTBOX COUNTS AGAIN
 * AT SEND, as the person, through the same function (the design review's
 * medium — an hour or more can pass, in which a file can be made internal or
 * a sign-off answered), after re-checking that the person, their client,
 * their workspace and both switches still want it (`src/jobs/outbox.ts`).
 *
 * Discovery is the one audited cross-tenant read (`withPlatform`, read-only,
 * ids only); each tenant then runs under its OWN system principal, and each
 * person's counts under THEIR contact principal. ONE TENANT'S FAILURE DOES
 * NOT SKIP THE REST: it is counted and logged by name and code only, and the
 * next hourly run retries it inside the catch-up hours. Invoked by
 * `POST /api/jobs/run` until Vercel Cron exists.
 *
 * COST, said rather than discovered: about ten short transactions per person
 * per count (each projection is its own), in sequence — once here, once more
 * at send, and here again in each of the three catch-up runs for a person
 * with nothing to say (no row stops the recount). A few hundred client people
 * is minutes once a week; the batching, when it is wanted, is per (client,
 * profile), whose counts but two — the person's own tasks and asks — would
 * share.
 */

const SYSTEM = { type: "system" } as const;
const SENDING = DIGEST_SENDING_TENANT_STATUSES as readonly string[];

export async function runClientDigests(
  now: Date = new Date(),
): Promise<{ tenants: number; enqueued: number; failed: number }> {
  const tenantIds = await withPlatform(
    { type: "system", job: "client-digests" },
    "list sending tenants with client people who have portal access",
    async (tx) => {
      const rows = await tx.contact.findMany({
        where: {
          portalStatus: "ACTIVE",
          invitedAt: { not: null },
          tenant: { status: { in: [...DIGEST_SENDING_TENANT_STATUSES] } },
        },
        select: { tenantId: true },
        distinct: ["tenantId"],
      });
      return rows.map((r) => r.tenantId);
    },
  );

  const out = { tenants: tenantIds.length, enqueued: 0, failed: 0 };
  for (const tenantId of tenantIds) {
    try {
      out.enqueued += await enqueueClientDigests(tenantId, now);
    } catch (e) {
      out.failed += 1;
      const code = typeof e === "object" && e !== null && "code" in e ? ` (${String((e as { code: unknown }).code)})` : "";
      console.error(`client-digests: tenant ${tenantId} failed: ${e instanceof Error ? e.name : typeof e}${code}`);
    }
  }
  return out;
}

/** One summary's outbox row, as `createMany` takes it. */
type OutboxRow = {
  readonly tenantId: string;
  readonly idempotencyKey: string;
  readonly receiverType: "CONTACT";
  readonly receiverId: string;
  readonly toEmail: string;
  readonly kind: string;
  readonly locale: string;
  readonly params: { readonly dueAt: string; readonly since: string; readonly until: string };
  readonly notificationIds: string[];
  readonly sendAfter: Date;
  readonly createdAt: Date;
};

type Due = {
  readonly contact: { readonly id: string; readonly tenantId: string; readonly clientId: string };
  readonly email: string;
  readonly locale: "sv" | "en";
  readonly key: string;
  readonly since: Date;
};

/**
 * Enqueue this tenant's due summaries. Exported for the dbtest, which runs it
 * against its own throwaway tenant rather than every tenant of the database.
 */
export async function enqueueClientDigests(tenantId: string, now: Date): Promise<number> {
  // Counted up to a minute ago, and the next summary starts from there
  // (`DIGEST_SETTLE_MS`): a row stamped just before a read and committed just
  // after it is the next summary's, never nobody's.
  const until = new Date(now.getTime() - DIGEST_SETTLE_MS);

  const plan = await withTenant(tenantId, SYSTEM, async (tx) => {
    // In SEQUENCE, never a `Promise.all` (AGENTS.md's standing trap).
    const tenant = await tx.tenant.findFirst({
      where: { id: tenantId },
      select: { status: true, defaultLocale: true },
    });
    if (!tenant || !SENDING.includes(tenant.status)) return null;
    const settings = await readPreferences(tx, tenantId);
    if (!settings.mail.clientSummary) return null;
    // The workspace's zone — already one of the curated list, or the
    // default, by `materializePreferences`.
    const period = periodDueNow(now, settings.timezone, "WEEKLY", CLIENT_DIGEST_HOUR, CLIENT_DIGEST_WEEKDAY);
    if (period === null) return null;

    const contacts = await tx.contact.findMany({
      // Not a client the agency has ARCHIVED (the design review's low):
      // archiving leaves its people's portal access as it was, and a finished
      // relationship must not get "1 thing waiting for your sign-off" every
      // Monday for ever. The outbox asks again at send.
      where: { tenantId, portalStatus: "ACTIVE", invitedAt: { not: null }, client: { archivedAt: null } },
      select: { id: true, tenantId: true, clientId: true, email: true, locale: true },
    });
    if (contacts.length === 0) return null;
    const ids = contacts.map((c) => c.id);
    const stopped = new Set(
      (
        await tx.notificationPreference.findMany({
          where: { tenantId, receiverType: "CONTACT", receiverId: { in: ids }, digestCadence: "NONE" },
          select: { receiverId: true },
        })
      ).map((p) => p.receiverId),
    );
    const keyOf = new Map(contacts.map((c) => [c.id, contactDigestKey(c.id, period.periodKey)]));
    // Already enqueued this week: the hourly job reaches a person up to three
    // times inside the window, and the key would refuse the row anyway — this
    // only saves counting their portal again.
    const done = new Set(
      (
        await tx.emailOutbox.findMany({
          where: { idempotencyKey: { in: [...keyOf.values()] } },
          select: { idempotencyKey: true },
        })
      ).map((r) => r.idempotencyKey),
    );
    const suppressed = new Set(
      (
        await tx.emailSuppression.findMany({
          where: { email: { in: contacts.map((c) => c.email.toLowerCase()) } },
          select: { email: true },
        })
      ).map((s) => s.email),
    );
    const candidates = contacts.filter(
      (c) => !stopped.has(c.id) && !done.has(keyOf.get(c.id)!) && !suppressed.has(c.email.toLowerCase()),
    );
    if (candidates.length === 0) return null;
    // Where each one's last summary was made: the next counts from there — a
    // summary on its way, sent, or skipped with nothing left to say. NOT one
    // the outbox DROPPED unsent (too late, or no longer wanted): its news
    // reached nobody, so the chain runs from the one before it.
    // The newest per person, as an allow-listed read rather than a `groupBy`
    // (this file is a portal surface by name: every read here is a select).
    const last = new Map(
      (
        await tx.emailOutbox.findMany({
          where: {
            tenantId,
            receiverType: "CONTACT",
            receiverId: { in: candidates.map((c) => c.id) },
            kind: CONTACT_DIGEST_MAIL,
            // Only as far back as a summary still chains (`digestChainFloor`):
            // `distinct` runs in memory, so without this every past summary
            // of every person would be read (the code review's nit).
            createdAt: { gte: digestChainFloor(period.previousAt, "WEEKLY") },
            OR: [
              { status: { in: ["QUEUED", "SENDING", "FAILED", "SENT"] } },
              { status: "SKIPPED", lastError: null },
            ],
          },
          select: { receiverId: true, createdAt: true },
          orderBy: [{ createdAt: "desc" }],
          distinct: ["receiverId"],
        })
      ).map((r) => [r.receiverId, r.createdAt]),
    );
    const due: Due[] = candidates.map((c) => ({
      contact: { id: c.id, tenantId: c.tenantId, clientId: c.clientId },
      email: c.email.toLowerCase(),
      locale: (c.locale ?? tenant.defaultLocale) === "sv" ? "sv" : "en",
      key: keyOf.get(c.id)!,
      since: digestSince(last.get(c.id) ?? null, period.previousAt, "WEEKLY"),
    }));
    return { dueAt: period.at, due };
  });
  if (plan === null) return 0;

  // Each person's counts under THEIR principal — outside the tenant
  // transaction above, because every projection opens its own. Here only to
  // decide whether there is anything to say; the outbox counts again, as the
  // person, at send.
  const data: OutboxRow[] = [];
  for (const d of plan.due) {
    let counts: ClientDigestCounts | null;
    try {
      const principal = await synthesiseContactPrincipal(tenantId, d.contact);
      counts = await countClientSummary(principal, d.since, until);
    } catch (e) {
      // ONE PERSON'S FAILURE DOES NOT SKIP THE REST (the design review's
      // low): no row for them, and the next hourly run inside the catch-up
      // hours tries again. Logged by ids, name and code only — never a
      // Prisma message, which prints the query's arguments.
      const code = typeof e === "object" && e !== null && "code" in e ? ` (${String((e as { code: unknown }).code)})` : "";
      console.error(
        `client-digests: tenant ${tenantId} contact ${d.contact.id} failed: ${e instanceof Error ? e.name : typeof e}${code}`,
      );
      continue;
    }
    // Null: refused everywhere — no portal to summarise (`countClientSummary`).
    if (counts === null || !clientDigestHasNews(counts)) continue;
    data.push({
      tenantId,
      idempotencyKey: d.key,
      receiverType: "CONTACT" as const,
      receiverId: d.contact.id,
      toEmail: d.email,
      kind: CONTACT_DIGEST_MAIL,
      locale: d.locale,
      // Times only — the summary's, and the window its NEW lines count — never
      // a number or a name: the outbox counts at send, as the person.
      params: { dueAt: plan.dueAt.toISOString(), since: d.since.toISOString(), until: until.toISOString() },
      notificationIds: [],
      // Due at once — stated a minute back, so an app clock ahead of the
      // database's cannot hold it out of the outbox's next claim.
      sendAfter: until,
      // Stated, not defaulted: the next summary counts from exactly here.
      createdAt: until,
    });
  }
  if (data.length === 0) return 0;
  return withTenant(tenantId, SYSTEM, async (tx) => {
    const { count } = await tx.emailOutbox.createMany({ data, skipDuplicates: true });
    return count;
  });
}

import { withPlatform, withTenant } from "@/db";

/**
 * THE INBOX'S HOUSEKEEPING (Phase 5 slice 104; founder decision C72 (f);
 * DATA_MODEL.md §5 R4): a notification more than `ARCHIVE_AFTER_DAYS` old, or
 * beyond its receiver's newest `KEEP_NEWEST`, moves to Archived by itself; an
 * archived one is deleted `DELETE_AFTER_MONTHS` after it was archived.
 *
 * BOTH HALVES RUN AS THE TENANT'S OWN SYSTEM PRINCIPAL, under
 * `withTenant(tenantId, {type:"system"})` with RLS live (TENANCY.md §12: jobs
 * touch a tenant's rows through `withTenant`, never through raw platform
 * writes). The platform door is used for discovery only.
 *
 *  · ARCHIVING is a state change any receiver can make to their own rows: the
 *    column-level UPDATE grant (`read_at, archived_at, snoozed_till`) is all
 *    it uses. Archiving also marks read (`COALESCE`), as the member's verb
 *    does — a filed row must not hold the badge up.
 *  · DELETING is held by the DATABASE (migration
 *    `20261008180000_notification_retention_delete`, the vault's pattern):
 *    `retention_delete` lets only the SYSTEM principal delete, and only a row
 *    whose `archived_at` is more than 12 months old; `portal_delete_deny`
 *    shuts contacts out. A first cut deleted through `withPlatform` — bounded by its own SQL
 *    alone, and writing a "delete" audit row into every active tenant's log
 *    on every run (the code and security reviews).
 *
 * NEITHER WRITES AN AUDIT ROW: inbox state is the receiver's, not a record —
 * a member's own archive writes none — and a year-old archived notification
 * going is R4 doing what it says, as the vault's share-link records going is
 * (slice 99). Counts are returned and logged. No job writes TENANCY §12's
 * `job.run` summary yet (recorded since slice 89).
 *
 * BOTH OUTER STATEMENTS REPEAT THEIR PICK'S CONDITIONS: Postgres re-checks
 * only the outer WHERE against a row changed while the statement waited for
 * it, so a member's snooze or restore landing in that window is honoured.
 *
 * THE AGE IS `GREATEST(created_at, snoozed_till)`: a row snoozed for a month
 * came back a month later, and its 90 days run from then. A row snoozed into
 * the future is never archived by either rule. A member who RESTORES a row
 * older than 90 days will see it filed again by the next run — the rule is
 * about the row's age, not about who last touched it (recorded, C72 (f)).
 *
 * Batched (`BATCH` rows a transaction, at most `MAX_BATCHES` a tenant a run):
 * what one run does not reach, the next takes. One tenant's failure does not
 * skip the rest (`vault-retention.ts`'s shape), logged by id, error name and
 * code only — a Prisma error's message prints the query's arguments.
 *
 * THIS JOB DELETES DATA, in every tenant of whatever database the server
 * points at — through `POST /api/jobs/run`, with the vault's retention. A
 * dbtest calls `applyNotificationRetention` for its own tenant, never this.
 */

export const ARCHIVE_AFTER_DAYS = 90;
export const KEEP_NEWEST = 500;
export const DELETE_AFTER_MONTHS = 12;

const BATCH = 1000;
const MAX_BATCHES = 20;
const DAY_MS = 86_400_000;
const JOB = "notification-retention";

const archiveCutoff = (now: Date): Date => new Date(now.getTime() - ARCHIVE_AFTER_DAYS * DAY_MS);

/** Calendar months back, in UTC (R4: "12 months after archive"). */
const deleteCutoff = (now: Date): Date => {
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() - DELETE_AFTER_MONTHS);
  return d;
};

/**
 * The tenants worth opening — the one cross-tenant read and the job's only
 * use of the platform door, ids only, audited by `withPlatform` as every
 * invocation is (one PLATFORM row a run, in no tenant's log). A SUPERSET by a day: each tenant
 * then decides which rows are due. Raw `DISTINCT`, never Prisma's `distinct`,
 * which de-duplicates in memory after reading every row.
 */
export async function notificationRetentionTenants(now: Date = new Date()): Promise<string[]> {
  const aged = new Date(archiveCutoff(now).getTime() + DAY_MS);
  const gone = new Date(deleteCutoff(now).getTime() + DAY_MS);
  return withPlatform(
    { type: "system", job: JOB },
    "list tenants with notifications to archive by age or count, or archived ones to delete",
    async (tx) => {
      // In sequence: one transaction, one connection (AGENTS.md's trap).
      const old = await tx.$queryRaw<{ tenant_id: string }[]>`
        SELECT DISTINCT tenant_id FROM notification
         WHERE archived_at IS NULL AND created_at < ${aged}`;
      const full = await tx.$queryRaw<{ tenant_id: string }[]>`
        SELECT DISTINCT tenant_id FROM (
          SELECT tenant_id FROM notification
           WHERE archived_at IS NULL
           GROUP BY tenant_id, receiver_type, receiver_id
          HAVING count(*) > ${KEEP_NEWEST}
        ) over_cap`;
      const due = await tx.$queryRaw<{ tenant_id: string }[]>`
        SELECT DISTINCT tenant_id FROM notification
         WHERE archived_at IS NOT NULL AND archived_at < ${gone}`;
      return [...new Set([...old, ...full, ...due].map((r) => r.tenant_id))];
    },
    // Three passes over the whole table, none index-assisted: the default
    // five seconds is a dev-sized budget (the security review's nit).
    { timeoutMs: 60_000 },
  );
}

/** One batch of the archive: by age, or beyond the receiver's newest `KEEP_NEWEST`. */
const archiveBatch = (tenantId: string, now: Date): Promise<number> =>
  withTenant(
    tenantId,
    { type: "system" },
    (tx) => tx.$executeRaw`
      WITH ranked AS (
        SELECT id, row_number() OVER (PARTITION BY receiver_type, receiver_id ORDER BY id DESC) AS n
          FROM notification
         WHERE tenant_id = ${tenantId} AND archived_at IS NULL
      ), picked AS (
        SELECT n.id
          FROM notification n
          JOIN ranked r ON r.id = n.id
         WHERE n.tenant_id = ${tenantId}
           AND n.archived_at IS NULL
           AND (n.snoozed_till IS NULL OR n.snoozed_till <= ${now})
           AND (GREATEST(n.created_at, n.snoozed_till) < ${archiveCutoff(now)} OR r.n > ${KEEP_NEWEST})
         ORDER BY n.id
         LIMIT ${BATCH}
      )
      UPDATE notification
         SET archived_at = ${now}, read_at = COALESCE(read_at, ${now})
       WHERE tenant_id = ${tenantId}
         AND archived_at IS NULL
         -- Repeated from the picked rows: Postgres re-checks only THIS clause
         -- against a row changed while the statement waited for it, so a
         -- member's snooze landing in that window is not archived away.
         AND (snoozed_till IS NULL OR snoozed_till <= ${now})
         AND id IN (SELECT id FROM picked)`,
    { timeoutMs: 30_000, lockTimeoutMs: 5_000 },
  );

/**
 * One batch of the delete: archived more than `DELETE_AFTER_MONTHS` ago. The
 * database holds the same line on its own clock (`retention_delete`); where
 * the two differ by hours at the edge, a row simply waits for the next run.
 */
const deleteBatch = (tenantId: string, now: Date): Promise<number> =>
  withTenant(
    tenantId,
    { type: "system" },
    (tx) => tx.$executeRaw`
      DELETE FROM notification
       WHERE tenant_id = ${tenantId}
         -- Repeated from the subquery: a member's restore is not deleted.
         AND archived_at IS NOT NULL
         AND archived_at < ${deleteCutoff(now)}
         AND id IN (
           SELECT id FROM notification
            WHERE tenant_id = ${tenantId}
              AND archived_at IS NOT NULL
              AND archived_at < ${deleteCutoff(now)}
            ORDER BY id
            LIMIT ${BATCH}
         )`,
    { timeoutMs: 30_000, lockTimeoutMs: 5_000 },
  );

const inBatches = async (batch: () => Promise<number>): Promise<number> => {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES; i += 1) {
    const n = await batch();
    total += n;
    if (n < BATCH) break;
  }
  return total;
};

/**
 * One tenant's run. Exported for the dbtest, which calls it for its OWN
 * tenant. Both halves are attempted; the first failure is thrown after.
 */
export async function applyNotificationRetention(
  tenantId: string,
  now: Date = new Date(),
): Promise<{ archived: number; deleted: number }> {
  const failures: unknown[] = [];
  let archived = 0;
  let deleted = 0;
  try {
    archived = await inBatches(() => archiveBatch(tenantId, now));
  } catch (e) {
    failures.push(e);
  }
  try {
    deleted = await inBatches(() => deleteBatch(tenantId, now));
  } catch (e) {
    failures.push(e);
  }
  if (failures.length > 0) throw failures[0];
  return { archived, deleted };
}

export async function runNotificationRetention(
  now: Date = new Date(),
): Promise<{ tenants: number; archived: number; deleted: number; failed: number }> {
  const tenantIds = await notificationRetentionTenants(now);
  const out = { tenants: tenantIds.length, archived: 0, deleted: 0, failed: 0 };
  for (const tenantId of tenantIds) {
    try {
      const r = await applyNotificationRetention(tenantId, now);
      out.archived += r.archived;
      out.deleted += r.deleted;
    } catch (e) {
      out.failed += 1;
      const code = typeof e === "object" && e !== null && "code" in e ? ` (${String((e as { code: unknown }).code)})` : "";
      console.error(`${JOB}: tenant ${tenantId} failed: ${e instanceof Error ? e.name : typeof e}${code}`);
    }
  }
  if (out.archived > 0 || out.deleted > 0) {
    console.info(`${JOB}: ${out.tenants} tenants, ${out.archived} archived, ${out.deleted} deleted`);
  }
  return out;
}

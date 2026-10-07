import { withPlatform } from "@/db";
import { BIN_DAYS, purgeVaultRetention, SHARE_LINK_KEPT_MONTHS } from "@/modules/vault";

/**
 * The vault's daily retention (Phase 3V slice 99; DATA_MODEL.md §5 R2;
 * founder decision C67 (a), (f)): a login binned `BIN_DAYS` ago is erased —
 * deleted with its secret and versions, or, when a client's contact sent
 * it or one of its share links' records is still young, kept only as a
 * bare record — and a share link's record is deleted
 * `SHARE_LINK_KEPT_MONTHS` after it expired, a bare record nobody sent with
 * the last of them. The
 * per-tenant body is the vault's (`purgeVaultRetention`); this file only
 * finds the tenants worth opening.
 *
 * Discovery is the one audited cross-tenant read (`withPlatform`,
 * read-only) and carries ids only. Its cutoffs are the job's clock with a
 * day to spare — a SUPERSET: each tenant then decides on the database's
 * clock, inside its own system transaction with RLS live, which rows are
 * due, so a tenant opened a few hours early simply has nothing to do yet.
 *
 * ONE TENANT'S FAILURE DOES NOT SKIP THE REST (the renewal reminders'
 * shape, `expiration-reminders.ts`): counted and logged — the tenant's id
 * and the error's name and code, never its message, which for a Prisma
 * error prints the query's arguments. Idempotent: what one run did not
 * reach (a cap, a row another transaction held), the next takes.
 *
 * THIS JOB DELETES DATA. `POST /api/jobs/run` runs it with every other job,
 * across every tenant of whatever database the server points at — the dev
 * database's real tenants included. That is retention doing what R2 says,
 * not a test harness's business: a dbtest calls `purgeVaultRetention` for
 * its own tenant, never this.
 */

const DAY_MS = 86_400_000;

export async function runVaultRetention(
  now: Date = new Date(),
): Promise<{ tenants: number; deleted: number; kept: number; released: number; links: number; failed: number }> {
  const binCutoff = new Date(now.getTime() - (BIN_DAYS - 1) * DAY_MS);
  const linkCutoff = new Date(now);
  linkCutoff.setUTCMonth(linkCutoff.getUTCMonth() - SHARE_LINK_KEPT_MONTHS);
  linkCutoff.setTime(linkCutoff.getTime() + DAY_MS);

  const tenantIds = await withPlatform(
    { type: "system", job: "vault-retention" },
    "list tenants with a login past its days in the bin, or a share link's record past its months",
    async (tx) => {
      // In sequence: one transaction, one connection (AGENTS.md's trap).
      const binned = await tx.credentialItem.findMany({
        where: { deletedAt: { lte: binCutoff }, purgedAt: null },
        select: { tenantId: true },
        distinct: ["tenantId"],
      });
      const links = await tx.credentialShareLink.findMany({
        where: { expiresAt: { lt: linkCutoff } },
        select: { tenantId: true },
        distinct: ["tenantId"],
      });
      // Tombstones nobody sent, kept while a link's record is young — a
      // superset again: each tenant decides which may go.
      const kept = await tx.credentialItem.findMany({
        where: { purgedAt: { not: null }, submittedByContactId: null },
        select: { tenantId: true },
        distinct: ["tenantId"],
      });
      return [...new Set([...binned, ...links, ...kept].map((r) => r.tenantId))];
    },
  );

  const out = { tenants: tenantIds.length, deleted: 0, kept: 0, released: 0, links: 0, failed: 0 };
  for (const tenantId of tenantIds) {
    try {
      const r = await purgeVaultRetention(tenantId);
      out.deleted += r.deleted;
      out.kept += r.kept;
      out.released += r.released;
      out.links += r.links;
    } catch (e) {
      out.failed += 1;
      const code = typeof e === "object" && e !== null && "code" in e ? ` (${String((e as { code: unknown }).code)})` : "";
      console.error(`vault-retention: tenant ${tenantId} failed: ${e instanceof Error ? e.name : typeof e}${code}`);
    }
  }
  return out;
}

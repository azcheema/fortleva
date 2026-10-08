-- ═══════════════════════════════════════════════════════════════════
-- Phase 5 slice 104 — THE INBOX'S HOUSEKEEPING DELETES AS THE TENANT'S OWN
-- SYSTEM PRINCIPAL, HELD BY THE DATABASE (founder decision C72 (f);
-- DATA_MODEL.md §5 R4, §6.18 item 12; TENANCY.md §12).
--
-- WHY. An archived notification is deleted 12 months after it was archived
-- (`src/jobs/notification-retention.ts`). The phase-2W migration granted
-- `app_runtime` no DELETE on `notification` ("retention = platform"), so the
-- first cut of the job deleted through `withPlatform` — a BYPASSRLS write on
-- tenant rows bounded by its own SQL alone, which TENANCY.md §12 forbids
-- ("jobs that touch a tenant's rows do so through withTenant, never through
-- raw app_platform writes") and which wrote a "delete" audit row into every
-- active tenant's log on every run (the slice's code and security reviews).
-- This follows the vault's retention instead (slice 99,
-- `credential_share_link`): DELETE granted to the runtime role, and what it
-- may delete held HERE. (The earlier migration of this slice,
-- `20261008160000_notification_reason`, says in its header that the job's
-- "platform half only deletes" — true when it was applied, superseded by
-- this one; an applied migration is never edited.)
--
-- WHAT IT ADDS.
--   1. `GRANT DELETE ON notification TO app_runtime`.
--   2. `portal_delete_deny` — RESTRICTIVE, FOR DELETE: a contact principal
--      deletes nothing, the twin of `portal_insert_deny` and in the shape the
--      contact census reads as an outright deny (`src/portal/census.dbtest.ts`
--      — the census of what a contact may write does not change).
--   3. `retention_delete` — RESTRICTIVE, FOR DELETE: under `withTenant` only
--      the SYSTEM principal deletes, and only a row whose `archived_at` is
--      more than 12 months old on the database's clock. (Precisely that: a
--      receiver may write its own `archived_at` — the column grant — so a
--      receiver could backdate ITS OWN row into the next run's delete; the
--      app only ever writes the present, and no one else's row is reachable.
--      The fix-pass review's nit.) A member cannot delete even their own
--      notification (there is no such verb); a refused delete is SILENT — 0
--      rows, not "permission denied" — so a future deleter (R4's contact rows,
--      when built) runs as SYSTEM or through the platform door. The job's own cutoff
--      (calendar months in UTC) and this one may differ by hours at the edge,
--      which only defers a row to the next run. `tenant_isolation` (PERMISSIVE,
--      FOR ALL) still binds every delete to the transaction's tenant, and
--      `principal_scope` (RESTRICTIVE, SELECT) admits SYSTEM, so the job's
--      WHERE can read what it deletes. A platform or owner connection
--      (BYPASSRLS — the harnesses' cleanups, a tenant's offboarding) is not
--      judged here.
--
-- DDL and grants only: no row is touched — `neon-smoke` is not owed.
-- ═══════════════════════════════════════════════════════════════════

GRANT DELETE ON notification TO app_runtime;

CREATE POLICY portal_delete_deny ON notification
  AS RESTRICTIVE FOR DELETE TO app_runtime
  USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');

CREATE POLICY retention_delete ON notification
  AS RESTRICTIVE FOR DELETE TO app_runtime
  USING (
    (SELECT current_setting('app.principal', true)) = 'system'
    AND archived_at IS NOT NULL
    AND archived_at < now() - interval '12 months'
  );

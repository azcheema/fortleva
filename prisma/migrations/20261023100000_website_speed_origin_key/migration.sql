-- ═══════════════════════════════════════════════════════════════════
-- Phase 6 slice 118 — THE DEDUPE KEY GAINS THE ORIGIN (the slice's own
-- dbtest, before any row existed outside throwaway tenants).
--
-- 20261023090000 made `(tenant_id, project_id, form_factor, period_end)`
-- unique, as "Google's past periods never change". True of one site — but
-- a project whose Production URL moves to another site starts a new
-- series, and the design keeps the old origin's rows as history. Those
-- rows hold the same period ends, so the new site's periods were refused
-- as duplicates and nothing was ever stored for it again. The key is now
-- per ORIGIN too: one row per project × site × device kind × period.
--
-- Forward, as every correction is (AGENTS.md: an applied migration is never
-- edited). The reads by project still use the index's prefix. DDL only, no
-- DML — no `neon-smoke.yml` dispatch owed; the two tables are empty outside
-- the dbtests' own tenants.
-- ═══════════════════════════════════════════════════════════════════

DROP INDEX "website_speed_week_project_kind_period_key";

-- Named by hand (Prisma's default would be over Postgres's 63 characters).
CREATE UNIQUE INDEX "website_speed_week_project_site_kind_period_key"
  ON "website_speed_week"("tenant_id", "project_id", "origin", "form_factor", "period_end");

-- ═══════════════════════════════════════════════════════════════════
-- Phase 6 slice 118 — THE WEBSITE SPEED CHARTS (founder decision C94;
-- docs/research/2026-10-14-slice-118-website-speed-design.md §2).
--
-- Fortleva keeps its own weekly copy of Google's Chrome UX Report numbers
-- for the whole site behind each project's Production URL (C94 (c)): one
-- row per project × device kind × rolling 28-day period — the three Core
-- Web Vitals' 75th percentiles and the share of visits in each of Google's
-- bands. The client sees a project's rows only after someone turns the
-- project's "Show to the client" switch on (C94 (a)), and only while the
-- project's portal is on.
--
-- 1. `website_speed_week` — class B, PROJECTSCOPED. The portal gate is the
--    standard three terms (client, visibility, portal_enabled), so the
--    table takes the WHOLE portal-switch mechanism of 20260928180000: the
--    stamp (`stamp_portal_enabled()`, try-only), the deferred heal, a
--    twelfth leg in `project_portal_enabled_fanout()` and in
--    `portal_switch_reconcile()` (both re-created WORD FOR WORD plus one
--    leg, last). `isolation.dbtest.ts` pins both bodies against the
--    registry (`PORTAL_ENABLED_FANOUT_TARGETS`).
--
-- 2. THE SWITCH: `project.portal_show_speed` (false by default). The rows'
--    `visibility` is DERIVED from it in the database — the
--    `project_time_summary` / `hours_sharing_mode` shape (20260821120000):
--    a BEFORE INSERT OR UPDATE stamp reads the project's switch and
--    overwrites any value a writer supplied; an AFTER UPDATE OF
--    portal_show_speed fan-out on `project` re-derives the project's rows.
--    The one writer of these rows is the weekly job, which takes
--    `SELECT … FOR SHARE` on the project row before it writes, so a write
--    and a switch press are serialised in either order (design §2.3).
--    `isolation.dbtest.ts` pins `project`'s exact trigger set; this adds
--    `project_speed_sharing_fanout` to it — an AFTER trigger that never
--    writes `portal_enabled` (the proof's third premise is untouched).
--
-- 3. `website_speed_check` — class A: one row per project, the last time
--    Google was asked and what came of it (OK, NO_DATA, REFUSED, FAILED,
--    with a short token, never Google's text). Staff bookkeeping the
--    team's card reads for its empty states; no contact reads it.
--
-- WHAT THE DATABASE REFUSES, beyond RLS: a period that is not Google's 28
-- days; a p75 below zero; a share outside 0..1; a metric's shares without
-- its p75 (or the reverse); a row with no metric at all; an origin that is
-- a page, carries a credential, or is not http(s).
--
-- CONTACT WRITES: none. `portal_gate`'s WITH CHECK denies contacts
-- outright and the three named `portal_no_*` policies repeat it, so the
-- census (`src/portal/census.dbtest.ts`) reads the table as closed by name.
--
-- DDL only — no DML, no `neon-smoke.yml` dispatch owed. No row exists in
-- either table (they are new), and `portal_show_speed` is false for every
-- project. Left out of Prisma's generated diff, as every migration since
-- they appeared has: the drift it always reports
-- (`document_tenant_id_tags_idx`, `search_index`, the `work_item` index
-- name) — hand-written objects Prisma does not model.
-- ═══════════════════════════════════════════════════════════════════

-- CreateEnum
CREATE TYPE "speed_form_factor" AS ENUM ('PHONE', 'DESKTOP');

-- CreateEnum
CREATE TYPE "speed_check_outcome" AS ENUM ('OK', 'NO_DATA', 'REFUSED', 'FAILED');

-- AlterTable: the switch (C94 (a)), off at birth
ALTER TABLE "project" ADD COLUMN "portal_show_speed" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "website_speed_week" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "form_factor" "speed_form_factor" NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "lcp_p75_ms" INTEGER,
    "inp_p75_ms" INTEGER,
    "cls_p75" DECIMAL(6,3),
    "lcp_good" DECIMAL(5,4),
    "lcp_needs_work" DECIMAL(5,4),
    "lcp_poor" DECIMAL(5,4),
    "inp_good" DECIMAL(5,4),
    "inp_needs_work" DECIMAL(5,4),
    "inp_poor" DECIMAL(5,4),
    "cls_good" DECIMAL(5,4),
    "cls_needs_work" DECIMAL(5,4),
    "cls_poor" DECIMAL(5,4),
    "visibility" "Visibility" NOT NULL DEFAULT 'INTERNAL',
    "portal_enabled" BOOLEAN NOT NULL DEFAULT false,
    "fetched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "website_speed_week_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "website_speed_check" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "origin" TEXT,
    "checked_at" TIMESTAMPTZ(6) NOT NULL,
    "outcome" "speed_check_outcome" NOT NULL,
    "detail" VARCHAR(40),

    CONSTRAINT "website_speed_check_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "website_speed_week_tenant_id_id_key" ON "website_speed_week"("tenant_id", "id");

-- CreateIndex
-- Named by hand: Prisma's default name is 66 characters, over Postgres's 63
-- (the pre-apply review's 1); the schema maps the same name.
CREATE UNIQUE INDEX "website_speed_week_project_kind_period_key" ON "website_speed_week"("tenant_id", "project_id", "form_factor", "period_end");

-- CreateIndex
CREATE INDEX "website_speed_week_tenant_id_client_id_visibility_idx" ON "website_speed_week"("tenant_id", "client_id", "visibility");

-- CreateIndex
CREATE UNIQUE INDEX "website_speed_check_tenant_id_id_key" ON "website_speed_check"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "website_speed_check_tenant_id_project_id_key" ON "website_speed_check"("tenant_id", "project_id");

-- AddForeignKey
ALTER TABLE "website_speed_week" ADD CONSTRAINT "website_speed_week_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_speed_week" ADD CONSTRAINT "website_speed_week_tenant_id_client_id_fkey" FOREIGN KEY ("tenant_id", "client_id") REFERENCES "client"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: with the project, as every projectScoped child (the
-- project's hard delete is the e2e harness's and the tenant teardown's;
-- the product archives).
ALTER TABLE "website_speed_week" ADD CONSTRAINT "website_speed_week_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "project"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_speed_check" ADD CONSTRAINT "website_speed_check_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_speed_check" ADD CONSTRAINT "website_speed_check_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "project"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── CHECKs — the row's own shape ────────────────────────────────────
-- Google's period is 28 days (the History API's collection periods;
-- design §1). A metric's p75 and its three shares
-- come and go together; a row with no metric at all says nothing and is
-- not stored. The origin is an ORIGIN — scheme and host (a port allowed),
-- never a path, a query, a fragment or a credential: it is what Google
-- was asked about, and it is shown to the client.
ALTER TABLE website_speed_week
  ADD CONSTRAINT website_speed_week_period_28_days
    CHECK (period_end - period_start = 27),
  ADD CONSTRAINT website_speed_week_p75_nonnegative
    CHECK ((lcp_p75_ms IS NULL OR lcp_p75_ms >= 0)
       AND (inp_p75_ms IS NULL OR inp_p75_ms >= 0)
       AND (cls_p75 IS NULL OR cls_p75 >= 0)),
  ADD CONSTRAINT website_speed_week_shares_unit
    CHECK ((lcp_good IS NULL OR lcp_good BETWEEN 0 AND 1)
       AND (lcp_needs_work IS NULL OR lcp_needs_work BETWEEN 0 AND 1)
       AND (lcp_poor IS NULL OR lcp_poor BETWEEN 0 AND 1)
       AND (inp_good IS NULL OR inp_good BETWEEN 0 AND 1)
       AND (inp_needs_work IS NULL OR inp_needs_work BETWEEN 0 AND 1)
       AND (inp_poor IS NULL OR inp_poor BETWEEN 0 AND 1)
       AND (cls_good IS NULL OR cls_good BETWEEN 0 AND 1)
       AND (cls_needs_work IS NULL OR cls_needs_work BETWEEN 0 AND 1)
       AND (cls_poor IS NULL OR cls_poor BETWEEN 0 AND 1)),
  ADD CONSTRAINT website_speed_week_metric_whole
    CHECK ((lcp_p75_ms IS NULL) = (lcp_good IS NULL)
       AND (lcp_good IS NULL) = (lcp_needs_work IS NULL)
       AND (lcp_good IS NULL) = (lcp_poor IS NULL)
       AND (inp_p75_ms IS NULL) = (inp_good IS NULL)
       AND (inp_good IS NULL) = (inp_needs_work IS NULL)
       AND (inp_good IS NULL) = (inp_poor IS NULL)
       AND (cls_p75 IS NULL) = (cls_good IS NULL)
       AND (cls_good IS NULL) = (cls_needs_work IS NULL)
       AND (cls_good IS NULL) = (cls_poor IS NULL)),
  ADD CONSTRAINT website_speed_week_some_metric
    CHECK (lcp_p75_ms IS NOT NULL OR inp_p75_ms IS NOT NULL OR cls_p75 IS NOT NULL),
  ADD CONSTRAINT website_speed_week_origin_shape
    CHECK (origin ~* '^https?://[^/?#@\s]+$' AND char_length(origin) <= 2048);

ALTER TABLE website_speed_check
  ADD CONSTRAINT website_speed_check_origin_shape
    CHECK (origin IS NULL OR (origin ~* '^https?://[^/?#@\s]+$' AND char_length(origin) <= 2048)),
  ADD CONSTRAINT website_speed_check_detail_token
    CHECK (detail IS NULL OR detail ~ '^[a-z_]{1,40}$');

-- ── The derived visibility (design §2.3) ────────────────────────────
-- A direct write to visibility is overwritten, like portal_enabled. Read
-- under the writer's own RLS: a project the writer cannot see is NOT
-- FOUND and refused.
CREATE OR REPLACE FUNCTION website_speed_week_stamp_visibility() RETURNS trigger
LANGUAGE plpgsql VOLATILE AS $fn$
DECLARE
  shown boolean;
BEGIN
  SELECT p.portal_show_speed INTO shown
    FROM project p
   WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.project_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'website_speed_week: project not found in tenant';
  END IF;
  NEW.visibility := CASE WHEN shown THEN 'CLIENT_VISIBLE'::"Visibility" ELSE 'INTERNAL'::"Visibility" END;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER website_speed_week_stamp_visibility
  BEFORE INSERT OR UPDATE OF project_id, visibility ON website_speed_week
  FOR EACH ROW EXECUTE FUNCTION website_speed_week_stamp_visibility();

-- The switch moves: re-derive the project's rows. AFTER UPDATE OF one
-- column, so it fires only when a statement SETs the switch; it never
-- touches portal_enabled (the portal-switch proof's third premise).
CREATE OR REPLACE FUNCTION project_speed_sharing_fanout() RETURNS trigger
LANGUAGE plpgsql VOLATILE AS $fn$
BEGIN
  IF NEW.portal_show_speed IS DISTINCT FROM OLD.portal_show_speed THEN
    UPDATE website_speed_week
       SET visibility = CASE WHEN NEW.portal_show_speed THEN 'CLIENT_VISIBLE'::"Visibility" ELSE 'INTERNAL'::"Visibility" END
     WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
  END IF;
  RETURN NULL;
END
$fn$;
CREATE TRIGGER project_speed_sharing_fanout
  AFTER UPDATE OF portal_show_speed ON project
  FOR EACH ROW EXECUTE FUNCTION project_speed_sharing_fanout();

-- ── Grants (deny-default, explicit per table) ───────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON website_speed_week TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON website_speed_check TO app_runtime;
-- app_platform already covers new tables via ALTER DEFAULT PRIVILEGES.

-- ── RLS — website_speed_week: class B projectScoped (three-term gate) ─
ALTER TABLE website_speed_week ENABLE ROW LEVEL SECURITY;
ALTER TABLE website_speed_week FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON website_speed_week
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (tenant_id = (SELECT current_setting('app.tenant_id', true)))
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true)));

-- Read gate: the standard three terms; the WITH CHECK denies contacts
-- outright (no contact ever writes here).
CREATE POLICY portal_gate ON website_speed_week
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING (
    (SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact'
    OR (
      client_id = (SELECT current_setting('app.client_id', true))
      AND visibility = 'CLIENT_VISIBLE'
      AND portal_enabled
    )
  )
  WITH CHECK (
    (SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact'
  );

-- The census's three named denies (20260920230000 / 20260920233000):
-- INSERT and UPDATE through WITH CHECK, DELETE through USING.
CREATE POLICY portal_no_insert ON website_speed_week
  AS RESTRICTIVE FOR INSERT TO app_runtime
  WITH CHECK ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');

CREATE POLICY portal_no_update ON website_speed_week
  AS RESTRICTIVE FOR UPDATE TO app_runtime
  WITH CHECK ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');

CREATE POLICY portal_no_delete ON website_speed_week
  AS RESTRICTIVE FOR DELETE TO app_runtime
  USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');

-- ── RLS — website_speed_check: class A (portal_deny; no visibility) ──
ALTER TABLE website_speed_check ENABLE ROW LEVEL SECURITY;
ALTER TABLE website_speed_check FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON website_speed_check
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (tenant_id = (SELECT current_setting('app.tenant_id', true)))
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true)));

CREATE POLICY portal_deny ON website_speed_check
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');

-- ── portal_enabled maintenance: stamp the new projectScoped table, its
--    heal, and extend the fan-out and the reconcile (TENANCY.md §7.2; the
--    trigger names are pinned by the posture dbtest as
--    <table>_stamp_portal_enabled and <table>_portal_heal) ─────────────
CREATE TRIGGER website_speed_week_stamp_portal_enabled
  BEFORE INSERT OR UPDATE OF project_id, portal_enabled ON website_speed_week
  FOR EACH ROW EXECUTE FUNCTION stamp_portal_enabled();

-- The heal, exactly as 20260928180000's DO block makes it for the other
-- ten tables (the same events and columns as the stamp it repairs).
CREATE CONSTRAINT TRIGGER website_speed_week_portal_heal
  AFTER INSERT OR UPDATE OF project_id, portal_enabled ON website_speed_week
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.project_id IS NOT NULL AND NOT NEW.portal_enabled
        AND current_setting('app.portal_in_doubt', true) = 'on'
        AND pg_trigger_depth() = 0)
  EXECUTE FUNCTION portal_heal_in_doubt();

-- The fan-out: 20260928180000's body word for word, plus the twelfth leg.
CREATE OR REPLACE FUNCTION project_portal_enabled_fanout() RETURNS trigger
LANGUAGE plpgsql VOLATILE AS $fn$
BEGIN
  IF NEW.portal_enabled IS DISTINCT FROM OLD.portal_enabled THEN
    IF current_setting('transaction_isolation') <> 'read committed' THEN
      RAISE EXCEPTION 'project_portal_enabled_fanout: the portal switch must run under READ COMMITTED';
    END IF;
    IF NOT portal_gate_try_exclusive(NEW.id) THEN
      RAISE EXCEPTION 'portal switch of project % raced a writer; retry', NEW.id
        USING ERRCODE = '55P03';
    END IF;
    UPDATE milestone            SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
    UPDATE project_version      SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
    UPDATE service              SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
    UPDATE document             SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
    UPDATE work_item            SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
    UPDATE work_item_activity   SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
    UPDATE comment              SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
    UPDATE search_index         SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
    UPDATE project_time_summary SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
    UPDATE time_report          SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
    UPDATE project_update       SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
    UPDATE website_speed_week   SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
  END IF;
  RETURN NULL;
END
$fn$;

-- The reconcile: 20260928180000's body word for word (comments aside),
-- plus the twelfth leg and its count term, last.
CREATE OR REPLACE FUNCTION portal_switch_reconcile(p_tenant text, p_project text)
RETURNS TABLE (rows_fixed integer, rows_skipped integer, portal_on boolean)
LANGUAGE plpgsql VOLATILE AS $fn$
DECLARE
  v boolean;
  n integer;
BEGIN
  rows_fixed := 0;
  rows_skipped := 0;
  portal_on := NULL;
  IF pg_current_xact_id_if_assigned() IS NOT NULL THEN
    RAISE EXCEPTION 'portal_switch_reconcile: the gate must be taken before the transaction writes or row-locks anything';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'portal_switch_reconcile: must run under READ COMMITTED';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(portal_gate_key_hi(p_project, 7401),
                                       portal_gate_key_lo(p_project, 7401));
  SELECT p.portal_enabled INTO v FROM project p WHERE p.tenant_id = p_tenant AND p.id = p_project;
  IF NOT FOUND THEN
    RETURN NEXT;
    RETURN;
  END IF;
  portal_on := v;

  UPDATE milestone SET portal_enabled = v WHERE tenant_id = p_tenant AND id IN (
    SELECT id FROM milestone WHERE tenant_id = p_tenant AND project_id = p_project
       AND portal_enabled IS DISTINCT FROM v FOR NO KEY UPDATE SKIP LOCKED);
  GET DIAGNOSTICS n = ROW_COUNT; rows_fixed := rows_fixed + n;
  UPDATE project_version SET portal_enabled = v WHERE tenant_id = p_tenant AND id IN (
    SELECT id FROM project_version WHERE tenant_id = p_tenant AND project_id = p_project
       AND portal_enabled IS DISTINCT FROM v FOR NO KEY UPDATE SKIP LOCKED);
  GET DIAGNOSTICS n = ROW_COUNT; rows_fixed := rows_fixed + n;
  UPDATE service SET portal_enabled = v WHERE tenant_id = p_tenant AND id IN (
    SELECT id FROM service WHERE tenant_id = p_tenant AND project_id = p_project
       AND portal_enabled IS DISTINCT FROM v FOR NO KEY UPDATE SKIP LOCKED);
  GET DIAGNOSTICS n = ROW_COUNT; rows_fixed := rows_fixed + n;
  UPDATE document SET portal_enabled = v WHERE tenant_id = p_tenant AND id IN (
    SELECT id FROM document WHERE tenant_id = p_tenant AND project_id = p_project
       AND portal_enabled IS DISTINCT FROM v FOR NO KEY UPDATE SKIP LOCKED);
  GET DIAGNOSTICS n = ROW_COUNT; rows_fixed := rows_fixed + n;
  UPDATE work_item SET portal_enabled = v WHERE tenant_id = p_tenant AND id IN (
    SELECT id FROM work_item WHERE tenant_id = p_tenant AND project_id = p_project
       AND portal_enabled IS DISTINCT FROM v FOR NO KEY UPDATE SKIP LOCKED);
  GET DIAGNOSTICS n = ROW_COUNT; rows_fixed := rows_fixed + n;
  UPDATE work_item_activity SET portal_enabled = v WHERE tenant_id = p_tenant AND id IN (
    SELECT id FROM work_item_activity WHERE tenant_id = p_tenant AND project_id = p_project
       AND portal_enabled IS DISTINCT FROM v FOR NO KEY UPDATE SKIP LOCKED);
  GET DIAGNOSTICS n = ROW_COUNT; rows_fixed := rows_fixed + n;
  UPDATE comment SET portal_enabled = v WHERE tenant_id = p_tenant AND id IN (
    SELECT id FROM comment WHERE tenant_id = p_tenant AND project_id = p_project
       AND portal_enabled IS DISTINCT FROM v FOR NO KEY UPDATE SKIP LOCKED);
  GET DIAGNOSTICS n = ROW_COUNT; rows_fixed := rows_fixed + n;
  UPDATE search_index SET portal_enabled = v WHERE tenant_id = p_tenant AND id IN (
    SELECT id FROM search_index WHERE tenant_id = p_tenant AND project_id = p_project
       AND portal_enabled IS DISTINCT FROM v FOR NO KEY UPDATE SKIP LOCKED);
  GET DIAGNOSTICS n = ROW_COUNT; rows_fixed := rows_fixed + n;
  UPDATE project_time_summary SET portal_enabled = v WHERE tenant_id = p_tenant AND id IN (
    SELECT id FROM project_time_summary WHERE tenant_id = p_tenant AND project_id = p_project
       AND portal_enabled IS DISTINCT FROM v FOR NO KEY UPDATE SKIP LOCKED);
  GET DIAGNOSTICS n = ROW_COUNT; rows_fixed := rows_fixed + n;
  UPDATE time_report SET portal_enabled = v WHERE tenant_id = p_tenant AND id IN (
    SELECT id FROM time_report WHERE tenant_id = p_tenant AND project_id = p_project
       AND portal_enabled IS DISTINCT FROM v FOR NO KEY UPDATE SKIP LOCKED);
  GET DIAGNOSTICS n = ROW_COUNT; rows_fixed := rows_fixed + n;
  UPDATE project_update SET portal_enabled = v WHERE tenant_id = p_tenant AND id IN (
    SELECT id FROM project_update WHERE tenant_id = p_tenant AND project_id = p_project
       AND portal_enabled IS DISTINCT FROM v FOR NO KEY UPDATE SKIP LOCKED);
  GET DIAGNOSTICS n = ROW_COUNT; rows_fixed := rows_fixed + n;
  UPDATE website_speed_week SET portal_enabled = v WHERE tenant_id = p_tenant AND id IN (
    SELECT id FROM website_speed_week WHERE tenant_id = p_tenant AND project_id = p_project
       AND portal_enabled IS DISTINCT FROM v FOR NO KEY UPDATE SKIP LOCKED);
  GET DIAGNOSTICS n = ROW_COUNT; rows_fixed := rows_fixed + n;

  SELECT
      (SELECT count(*) FROM milestone            WHERE tenant_id = p_tenant AND project_id = p_project AND portal_enabled IS DISTINCT FROM v)
    + (SELECT count(*) FROM project_version      WHERE tenant_id = p_tenant AND project_id = p_project AND portal_enabled IS DISTINCT FROM v)
    + (SELECT count(*) FROM service              WHERE tenant_id = p_tenant AND project_id = p_project AND portal_enabled IS DISTINCT FROM v)
    + (SELECT count(*) FROM document             WHERE tenant_id = p_tenant AND project_id = p_project AND portal_enabled IS DISTINCT FROM v)
    + (SELECT count(*) FROM work_item            WHERE tenant_id = p_tenant AND project_id = p_project AND portal_enabled IS DISTINCT FROM v)
    + (SELECT count(*) FROM work_item_activity   WHERE tenant_id = p_tenant AND project_id = p_project AND portal_enabled IS DISTINCT FROM v)
    + (SELECT count(*) FROM comment              WHERE tenant_id = p_tenant AND project_id = p_project AND portal_enabled IS DISTINCT FROM v)
    + (SELECT count(*) FROM search_index         WHERE tenant_id = p_tenant AND project_id = p_project AND portal_enabled IS DISTINCT FROM v)
    + (SELECT count(*) FROM project_time_summary WHERE tenant_id = p_tenant AND project_id = p_project AND portal_enabled IS DISTINCT FROM v)
    + (SELECT count(*) FROM time_report          WHERE tenant_id = p_tenant AND project_id = p_project AND portal_enabled IS DISTINCT FROM v)
    + (SELECT count(*) FROM project_update       WHERE tenant_id = p_tenant AND project_id = p_project AND portal_enabled IS DISTINCT FROM v)
    + (SELECT count(*) FROM website_speed_week   WHERE tenant_id = p_tenant AND project_id = p_project AND portal_enabled IS DISTINCT FROM v)
    INTO rows_skipped;
  RETURN NEXT;
END
$fn$;

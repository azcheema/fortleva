-- ═══════════════════════════════════════════════════════════════════
-- Phase 2T follow-up — the time-report delete guard needs a sanctioned
-- maintenance path. A published TimeReport is archive-only for every
-- application path (DATA_MODEL.md §6.15 D3), but tenant offboarding /
-- retention deletion and test teardown must be able to remove a whole
-- tenant — the first dbtest run proved the project cascade is refused
-- otherwise. Mirrors `app.audit_maintenance` (security_foundations):
-- a TRANSACTION-LOCAL GUC set only by platform maintenance jobs and
-- test teardown, never by a tenant-plane service. Runs as the owner.
-- ═══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION time_report_no_delete_published() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD.published_at IS NOT NULL
     AND current_setting('app.time_maintenance', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'REPORT_IMMUTABLE: a published time report cannot be deleted — archive it';
  END IF;
  RETURN OLD;
END
$fn$;

-- ═══════════════════════════════════════════════════════════════════
-- Phase 4 slice 114c — the nightly send's PEOPLE'S SIDE (founder decisions
-- C89 (c), (e) and C90; docs/research/2026-10-12-slice-114-fortnox-
-- connection-design.md §14).
--
-- When Fortnox stops taking the workspace's entries, its owners are told —
-- ONCE per breakage, then every Monday while it is still stopped (C89 (e)).
-- What "told" means must survive a read inbox row and a second run the same
-- hour, so the connection keeps it:
--
-- 1. `integration_connection.stop_told_at` — when the owners were last told
--    it is stopped (the first notice, then each Monday's reminder). NULL on a
--    connection just made.
--
-- 2. `integration_connection_guard` re-created WORD FOR WORD from
--    20261019090000's body, plus hunks marked "114c" (a unit test diffs it
--    against its predecessor — `src/modules/invoicing/fortnox-send-
--    migration.test.ts`, the 114b precedent): `stop_told_at` joins the
--    nightly send's upkeep columns (written only behind `app.fortnox_sending`,
--    which `fortnox-send.ts` alone sets — the census test); whenever the
--    sender changes it, the guard stamps it with its own clock
--    (`statement_timestamp()`), so the Monday rule never reads a time the
--    app chose, and refuses it being set back to NULL; and a connection is
--    born with it NULL. A person's disconnect
--    and reconnect still change nothing outside their own columns, so they
--    leave it as it was — the next breakage's `broken_since` is later, which
--    is what makes it a new one to tell.
--
-- Nothing else changes: every person's act on a delivery (booked by hand,
-- not in Fortnox, handed over in a file) was written into the delivery guard
-- by 20261020090000 so that guard is written once; the audit actions and the
-- notification kinds are the app's catalogues.
--
-- DDL only — no DML, no `neon-smoke.yml` dispatch owed. Existing rows take
-- NULL (never told — a connection stopped before this ships is told on the
-- next run, which is what C89 (e) wants). No grant changes (the column rides
-- the table's grants); RLS unchanged; the tenant export dumps the column with
-- the row. Left out of Prisma's generated diff, as every migration since
-- they appeared has: the drift it always reports
-- (`document_tenant_id_tags_idx`, `search_index`, the `work_item` index
-- name) — hand-written objects Prisma does not model.
-- ═══════════════════════════════════════════════════════════════════

-- AlterTable
ALTER TABLE "integration_connection" ADD COLUMN "stop_told_at" TIMESTAMPTZ(6);

-- ── The connection's guard, re-created (marked "114c" hunks only) ────

CREATE OR REPLACE FUNCTION integration_connection_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  who text := coalesce(current_setting('app.principal', true), '');
  who_id text := coalesce(current_setting('app.principal_id', true), '');
  at timestamptz := statement_timestamp();
  slack constant interval := interval '5 minutes';
  utc_today date := (statement_timestamp() AT TIME ZONE 'UTC')::date;
  maintenance boolean := coalesce(current_setting('app.invoice_maintenance', true), '') = 'on' AND current_user = 'app_platform';
  sending boolean := coalesce(current_setting('app.fortnox_sending', true), '') = 'on';
  att record;
  -- The upkeep columns slice 114b's sender writes.
  -- 114c: and when the owners were last told it is stopped (`stop_told_at`).
  upkeep constant text[] := ARRAY['status', 'broken_since', 'broken_reason', 'last_ok_at', 'last_night', 'send_lease_until', 'send_run_id', 'stop_told_at'];
  -- What a reconnect may change.
  reconnect constant text[] := ARRAY['status', 'connect_attempt_id', 'connected_by_member_id', 'connected_at',
                                     'company_name', 'broken_since', 'broken_reason', 'last_night'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF maintenance THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'INTEGRATION_CONNECTION_GUARD: a connection is never deleted';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF current_user IS DISTINCT FROM 'app_runtime' THEN
      RETURN NEW;
    END IF;
    IF who IS DISTINCT FROM 'member' OR NEW.connected_by_member_id IS DISTINCT FROM who_id
       OR NOT invoice_member_holds(NEW.tenant_id, who_id, 'invoice:connect_bookkeeping') THEN
      RAISE EXCEPTION 'INTEGRATION_CONNECTION_GUARD: only a member who may connect the bookkeeping program connects it, as themselves';
    END IF;
    SELECT a.member_id, a.provider, a.outcome, (a.xmin = pg_current_xact_id()::xid) AS fresh
      INTO att
      FROM integration_connect_attempt a
     WHERE a.tenant_id = NEW.tenant_id AND a.id = NEW.connect_attempt_id;
    IF NOT FOUND OR NOT att.fresh OR att.member_id IS DISTINCT FROM who_id
       OR att.provider IS DISTINCT FROM NEW.provider OR att.outcome IS DISTINCT FROM 'CONNECTED' THEN
      RAISE EXCEPTION 'INTEGRATION_CONNECTION_GUARD: a connection is made through its own connect attempt, given its outcome in this transaction';
    END IF;
    IF NEW.status IS DISTINCT FROM 'ACTIVE'
       OR NEW.disconnected_at IS NOT NULL OR NEW.broken_since IS NOT NULL OR NEW.last_ok_at IS NOT NULL
       OR NEW.send_lease_until IS NOT NULL
       -- 114c: nobody has been told anything about a connection just made.
       OR NEW.stop_told_at IS NOT NULL THEN
      RAISE EXCEPTION 'INTEGRATION_CONNECTION_GUARD: a connection starts ACTIVE, with nothing sent';
    END IF;
    IF NEW.created_at < at - slack OR NEW.created_at > at + slack THEN
      RAISE EXCEPTION 'INTEGRATION_CONNECTION_GUARD: a connection is made now';
    END IF;
    NEW.connected_at := at;
    -- The connect day, in the workspace's zone (S5: the first night waits for the next midnight).
    IF NEW.last_night IS NULL OR NEW.last_night < utc_today - 1 OR NEW.last_night > utc_today + 1 THEN
      RAISE EXCEPTION 'INTEGRATION_CONNECTION_GUARD: a connection''s first night is after the day it was made';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: who and which company never change; a disconnected one is history.
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.provider IS DISTINCT FROM OLD.provider OR NEW.transport IS DISTINCT FROM OLD.transport
     OR NEW.app_client_id IS DISTINCT FROM OLD.app_client_id OR NEW.external_tenant_id IS DISTINCT FROM OLD.external_tenant_id
     OR NEW.company_org_nr IS DISTINCT FROM OLD.company_org_nr OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'INTEGRATION_CONNECTION_GUARD: a connection''s company never changes';
  END IF;
  IF OLD.status = 'DISCONNECTED' THEN
    RAISE EXCEPTION 'INTEGRATION_CONNECTION_GUARD: a disconnected connection is history';
  END IF;
  IF current_user IS DISTINCT FROM 'app_runtime' THEN
    RETURN NEW;
  END IF;

  IF who = 'member' THEN
    IF NOT invoice_member_holds(NEW.tenant_id, who_id, 'invoice:connect_bookkeeping') THEN
      RAISE EXCEPTION 'INTEGRATION_CONNECTION_GUARD: only a member who may connect the bookkeeping program changes its connection';
    END IF;

    IF NEW.status = 'DISCONNECTED' THEN
      -- DISCONNECT: by them, now; nothing else changes (a live lease is no bar —
      -- a disconnect is the kill switch, the design review's S5).
      IF NEW.disconnected_by_member_id IS DISTINCT FROM who_id THEN
        RAISE EXCEPTION 'INTEGRATION_CONNECTION_GUARD: a member disconnects as themselves';
      END IF;
      NEW.disconnected_at := at;
      IF (to_jsonb(NEW) - 'status' - 'disconnected_at' - 'disconnected_by_member_id')
         IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'disconnected_at' - 'disconnected_by_member_id') THEN
        RAISE EXCEPTION 'INTEGRATION_CONNECTION_GUARD: a disconnect changes nothing else';
      END IF;
      RETURN NEW;
    END IF;

    IF OLD.status = 'BROKEN' AND NEW.status = 'ACTIVE'
       AND NEW.connect_attempt_id IS DISTINCT FROM OLD.connect_attempt_id THEN
      -- RECONNECT the same company: through a fresh attempt of theirs, its
      -- breakage cleared, its first night after today (S3, R2).
      SELECT a.member_id, a.provider, a.outcome, (a.xmin = pg_current_xact_id()::xid) AS fresh
        INTO att
        FROM integration_connect_attempt a
       WHERE a.tenant_id = NEW.tenant_id AND a.id = NEW.connect_attempt_id;
      IF NOT FOUND OR NOT att.fresh OR att.member_id IS DISTINCT FROM who_id
         OR att.provider IS DISTINCT FROM NEW.provider OR att.outcome IS DISTINCT FROM 'RECONNECTED' THEN
        RAISE EXCEPTION 'INTEGRATION_CONNECTION_GUARD: a reconnect goes through its own connect attempt, given its outcome in this transaction';
      END IF;
      IF NEW.connected_by_member_id IS DISTINCT FROM who_id OR NEW.broken_since IS NOT NULL
         OR NEW.last_night IS NULL OR NEW.last_night < utc_today - 1 OR NEW.last_night > utc_today + 1 THEN
        RAISE EXCEPTION 'INTEGRATION_CONNECTION_GUARD: a reconnect is theirs, clears the breakage and waits for the next night';
      END IF;
      NEW.connected_at := at;
      IF (to_jsonb(NEW) - reconnect) IS DISTINCT FROM (to_jsonb(OLD) - reconnect) THEN
        RAISE EXCEPTION 'INTEGRATION_CONNECTION_GUARD: a reconnect changes only who connected it, when, and its breakage';
      END IF;
      RETURN NEW;
    END IF;

    RAISE EXCEPTION 'INTEGRATION_CONNECTION_GUARD: a member only disconnects a connection, or reconnects a broken one';
  END IF;

  IF who = 'system' AND sending THEN
    -- THE NIGHTLY SEND'S UPKEEP (slice 114b): its own columns, never a disconnect.
    IF NEW.status NOT IN ('ACTIVE', 'BROKEN') THEN
      RAISE EXCEPTION 'INTEGRATION_CONNECTION_GUARD: the sender never disconnects a connection';
    END IF;
    IF (to_jsonb(NEW) - upkeep) IS DISTINCT FROM (to_jsonb(OLD) - upkeep) THEN
      RAISE EXCEPTION 'INTEGRATION_CONNECTION_GUARD: the sender writes only its own columns';
    END IF;
    -- A stop only a person's reconnect mends is held WHOLE: it stays BROKEN with
    -- its reason and its start — never restarted, nor its reason rewritten first
    -- and restarted after (the fix re-check's 3). The upkeep around it moves.
    IF OLD.status = 'BROKEN'
       AND coalesce(OLD.broken_reason ->> 'kind', '') IN ('CONSENT_GONE', 'NO_LICENCE', 'COMPANY_CHANGED')
       AND (NEW.status IS DISTINCT FROM 'BROKEN'
            OR NEW.broken_reason IS DISTINCT FROM OLD.broken_reason
            OR NEW.broken_since IS DISTINCT FROM OLD.broken_since) THEN
      RAISE EXCEPTION 'INTEGRATION_CONNECTION_GUARD: only a person''s reconnect mends a connection Fortnox no longer accepts';
    END IF;
    -- 114c: when the owners were told, on the database's clock — never a time the
    -- sender chose, and never taken back (the pre-apply review's low 1).
    IF NEW.stop_told_at IS NULL AND OLD.stop_told_at IS NOT NULL THEN
      RAISE EXCEPTION 'INTEGRATION_CONNECTION_GUARD: when the owners were told is never taken back';
    END IF;
    IF NEW.stop_told_at IS DISTINCT FROM OLD.stop_told_at THEN
      NEW.stop_told_at := at;
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'INTEGRATION_CONNECTION_GUARD: a connection is changed only by a member who may connect it, or by the nightly send';
END
$fn$;

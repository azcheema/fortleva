-- ═══════════════════════════════════════════════════════════════════
-- Phase 4 slice 114 — THE DIRECT FORTNOX CONNECTION, part 1: the connection
-- itself (founder decision C89 (a)–(e)). DATA_MODEL.md §6.13; the design and
-- its reviews: docs/research/2026-10-12-slice-114-fortnox-connection-design.md
-- (§10 overrides the body). Nothing is SENT by this slice — the nightly send
-- is slice 114b; the upkeep and lease columns below are written by it.
--
-- A workspace's OWNER (`invoice:connect_bookkeeping`, seeded on the owner
-- template only, ✦) connects its Fortnox company as a SERVICE ACCOUNT: a
-- press of Connect is an ATTEMPT (its OAuth `state` stored as a SHA-256, its
-- PKCE verifier until it is spent, ten minutes to come back); the callback
-- spends it, Fortnox is asked who the company is, and — when its org. number
-- is the workspace's — the CONNECTION row is written. Tokens come from the
-- app's own secret plus the company's TenantId (Fortnox's DatabaseNumber), so
-- NO per-workspace secret is stored anywhere.
--
-- 1. `integration_connect_attempt` (new, CLASS A) — written only by the
--    member who pressed Connect: made (the database dates it and gives it its
--    ten minutes), SPENT once before it expires (the verifier cleared in the
--    same write), then its OUTCOME set once, within fifteen minutes of being
--    spent. Never deleted but by platform maintenance.
--
-- 2. `integration_connection` (new, CLASS A) — one LIVE (ACTIVE or BROKEN)
--    per workspace and provider, and one live per Fortnox company across
--    EVERY workspace (Fortnox keeps one service consent per app and company:
--    two workspaces on it would share its revocation; the design review's
--    Q1, kept by both reviews). On the runtime role:
--      - INSERT: a member, as themselves, holding the code, through an
--        attempt of theirs (spent by the callback's first transaction) whose
--        outcome CONNECTED is written IN THIS TRANSACTION; ACTIVE; dated now.
--      - UPDATE by a member holding the code: DISCONNECT (ACTIVE or BROKEN →
--        DISCONNECTED, by them, now — nothing else changes), or RECONNECT the
--        same company (BROKEN → ACTIVE through an attempt whose outcome
--        RECONNECTED is written in this transaction; its breakage cleared).
--      - UPDATE by SYSTEM behind `app.fortnox_sending` (slice 114b's sender
--        alone): the upkeep columns only — ACTIVE ↔ BROKEN with its reason,
--        `last_ok_at`, `last_night`, the send lease. Never a DISCONNECTED row,
--        and never a row stopped for a reason only a person's reconnect mends
--        (CONSENT_GONE, NO_LICENCE, COMPANY_CHANGED — the design review's S3,
--        held here too: the code review of slice 114).
--      - A DISCONNECTED row is history: never changed again.
--    The platform and owner roles (the harnesses' fixtures, test setup) are
--    not judged (`invoice_series_guard`'s rule); every CHECK still holds.
--    DELETE: platform maintenance only (`app.invoice_maintenance`).
--
-- Every GUC is read through `coalesce(…, '')` — an unset one reads NULL, and
-- `NOT NULL` refuses nothing (the slice-113b pre-apply review's HIGH).
-- ═══════════════════════════════════════════════════════════════════

-- CreateEnum
CREATE TYPE "integration_provider" AS ENUM ('FORTNOX');

-- CreateEnum
CREATE TYPE "integration_status" AS ENUM ('ACTIVE', 'BROKEN', 'DISCONNECTED');

-- CreateTable
CREATE TABLE "integration_connect_attempt" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "provider" "integration_provider" NOT NULL,
    "member_id" TEXT NOT NULL,
    "state_hash" TEXT NOT NULL,
    "pkce_verifier" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "outcome" TEXT,
    "seen_company_name" TEXT,
    "seen_org_nr" TEXT,

    CONSTRAINT "integration_connect_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_connection" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "provider" "integration_provider" NOT NULL,
    "status" "integration_status" NOT NULL DEFAULT 'ACTIVE',
    "transport" TEXT NOT NULL,
    "app_client_id" TEXT NOT NULL,
    "external_tenant_id" TEXT NOT NULL,
    "company_name" TEXT NOT NULL,
    "company_org_nr" TEXT NOT NULL,
    "connect_attempt_id" TEXT NOT NULL,
    "connected_by_member_id" TEXT NOT NULL,
    "connected_at" TIMESTAMPTZ(6) NOT NULL,
    "disconnected_by_member_id" TEXT,
    "disconnected_at" TIMESTAMPTZ(6),
    "broken_since" TIMESTAMPTZ(6),
    "broken_reason" JSONB,
    "last_ok_at" TIMESTAMPTZ(6),
    "last_night" DATE,
    "send_lease_until" TIMESTAMPTZ(6),
    "send_run_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_connection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "integration_connect_attempt_state_hash_key" ON "integration_connect_attempt"("state_hash");

-- CreateIndex
CREATE INDEX "integration_connect_attempt_tenant_id_member_id_created_at_idx" ON "integration_connect_attempt"("tenant_id", "member_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "integration_connect_attempt_tenant_id_id_key" ON "integration_connect_attempt"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "integration_connection_tenant_id_connect_attempt_id_key" ON "integration_connection"("tenant_id", "connect_attempt_id");

-- CreateIndex
CREATE INDEX "integration_connection_tenant_id_provider_status_idx" ON "integration_connection"("tenant_id", "provider", "status");

-- CreateIndex
CREATE UNIQUE INDEX "integration_connection_tenant_id_id_key" ON "integration_connection"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "integration_connect_attempt" ADD CONSTRAINT "integration_connect_attempt_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_connection" ADD CONSTRAINT "integration_connection_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_connection" ADD CONSTRAINT "integration_connection_tenant_id_connect_attempt_id_fkey" FOREIGN KEY ("tenant_id", "connect_attempt_id") REFERENCES "integration_connect_attempt"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── 1. The attempt's shape ──────────────────────────────────────────
ALTER TABLE integration_connect_attempt
  -- A SHA-256 in hex; the verifier is RFC 7636's 43–128 unreserved characters.
  ADD CONSTRAINT integration_connect_attempt_state_hash_shape CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT integration_connect_attempt_verifier_shape
    CHECK (pkce_verifier IS NULL OR pkce_verifier ~ '^[A-Za-z0-9._~-]{43,128}$'),
  ADD CONSTRAINT integration_connect_attempt_ten_minutes CHECK (expires_at = created_at + interval '10 minutes'),
  -- Spent once, the verifier gone with it; an outcome only after.
  ADD CONSTRAINT integration_connect_attempt_spent_clears CHECK (used_at IS NULL OR pkce_verifier IS NULL),
  ADD CONSTRAINT integration_connect_attempt_outcome_after_use CHECK (outcome IS NULL OR used_at IS NOT NULL),
  ADD CONSTRAINT integration_connect_attempt_outcome_known CHECK (
    outcome IS NULL OR outcome IN (
      'CONNECTED',      -- a new connection
      'RECONNECTED',    -- the same company's BROKEN connection back to ACTIVE
      'DENIED',         -- the administrator said no at Fortnox, or Fortnox sent an error
      'NO_LICENCE',     -- Fortnox: the company lacks the integration add-on
      'NO_ORG_NR',      -- the workspace's company card has no org. number
      'ORG_MISMATCH',   -- Fortnox's company is not the workspace's (seen_* say whose)
      'NOT_SERVICE',    -- consented as a person, not as a service account
      'ELSEWHERE',      -- that Fortnox company is connected to another workspace
      'OTHER_COMPANY',  -- this workspace is connected to another Fortnox company
      'ALREADY',        -- this workspace was connected to that company meanwhile (another tab, another owner)
      'BUSY',           -- a bookkeeping file was being made: press Connect again
      'FAILED')),       -- Fortnox could not be reached, answered out of shape, or the connect broke
  ADD CONSTRAINT integration_connect_attempt_seen_shape CHECK (
    (seen_company_name IS NULL OR char_length(seen_company_name) BETWEEN 1 AND 200)
    AND (seen_org_nr IS NULL OR char_length(seen_org_nr) BETWEEN 1 AND 20)
    AND (seen_company_name IS NULL) = (seen_org_nr IS NULL)
    AND (seen_company_name IS NULL OR outcome IS NOT NULL));


-- ── 2. The connection's shape ───────────────────────────────────────
ALTER TABLE integration_connection
  ADD CONSTRAINT integration_connection_transport CHECK (transport IN ('fake', 'live')),
  ADD CONSTRAINT integration_connection_app_client_id_shape CHECK (app_client_id ~ '^[A-Za-z0-9._-]{1,200}$'),
  ADD CONSTRAINT integration_connection_external_shape CHECK (external_tenant_id ~ '^[0-9]{1,20}$'),
  ADD CONSTRAINT integration_connection_company_name CHECK (char_length(company_name) BETWEEN 1 AND 200),
  ADD CONSTRAINT integration_connection_org_nr_shape CHECK (company_org_nr ~ '^[0-9]{6}-[0-9]{4}$'),
  -- Disconnected iff both of its facts are set.
  ADD CONSTRAINT integration_connection_disconnected CHECK (
    (status = 'DISCONNECTED') = (disconnected_at IS NOT NULL)
    AND (disconnected_at IS NULL) = (disconnected_by_member_id IS NULL)),
  -- BROKEN carries when and why; a disconnect keeps a breakage it had (the
  -- design review's R6 (d)).
  ADD CONSTRAINT integration_connection_broken CHECK (
    (broken_since IS NULL) = (broken_reason IS NULL)
    AND (status <> 'BROKEN' OR broken_since IS NOT NULL)
    AND (broken_since IS NULL OR status IN ('BROKEN', 'DISCONNECTED'))
    AND (broken_reason IS NULL OR (jsonb_typeof(broken_reason) = 'object' AND coalesce(jsonb_typeof(broken_reason -> 'kind'), '') = 'string'))),
  ADD CONSTRAINT integration_connection_lease CHECK ((send_lease_until IS NULL) = (send_run_id IS NULL));

-- One live connection per workspace and provider…
CREATE UNIQUE INDEX integration_connection_live_per_workspace
  ON integration_connection (tenant_id, provider) WHERE status <> 'DISCONNECTED';
-- …and one live per Fortnox company, across every workspace (Q1).
CREATE UNIQUE INDEX integration_connection_live_per_company
  ON integration_connection (provider, external_tenant_id) WHERE status <> 'DISCONNECTED';


-- ── 3. The attempt's guard ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION integration_connect_attempt_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  who text := coalesce(current_setting('app.principal', true), '');
  who_id text := coalesce(current_setting('app.principal_id', true), '');
  at timestamptz := statement_timestamp();
  maintenance boolean := coalesce(current_setting('app.invoice_maintenance', true), '') = 'on' AND current_user = 'app_platform';
  -- What never changes once written.
  fixed constant text[] := ARRAY['id', 'tenant_id', 'provider', 'member_id', 'state_hash', 'created_at', 'expires_at'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF maintenance THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'INTEGRATION_CONNECT_ATTEMPT_GUARD: a connect attempt is never deleted';
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- Dated here, whatever the app sent: ten minutes to come back.
    NEW.created_at := at;
    NEW.expires_at := at + interval '10 minutes';
    IF current_user IS DISTINCT FROM 'app_runtime' THEN
      RETURN NEW;
    END IF;
    IF who IS DISTINCT FROM 'member' OR NEW.member_id IS DISTINCT FROM who_id
       OR NOT invoice_member_holds(NEW.tenant_id, who_id, 'invoice:connect_bookkeeping') THEN
      RAISE EXCEPTION 'INTEGRATION_CONNECT_ATTEMPT_GUARD: only a member who may connect the bookkeeping program starts a connect, as themselves';
    END IF;
    IF NEW.used_at IS NOT NULL OR NEW.outcome IS NOT NULL OR NEW.pkce_verifier IS NULL
       OR NEW.seen_company_name IS NOT NULL OR NEW.seen_org_nr IS NOT NULL THEN
      RAISE EXCEPTION 'INTEGRATION_CONNECT_ATTEMPT_GUARD: a connect attempt starts unspent, with its verifier';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF (to_jsonb(NEW) - 'used_at' - 'pkce_verifier' - 'outcome' - 'seen_company_name' - 'seen_org_nr')
     IS DISTINCT FROM (to_jsonb(OLD) - 'used_at' - 'pkce_verifier' - 'outcome' - 'seen_company_name' - 'seen_org_nr') THEN
    RAISE EXCEPTION 'INTEGRATION_CONNECT_ATTEMPT_GUARD: % never change', array_to_string(fixed, ', ');
  END IF;
  IF current_user IS DISTINCT FROM 'app_runtime' THEN
    RETURN NEW;
  END IF;
  IF who IS DISTINCT FROM 'member' OR OLD.member_id IS DISTINCT FROM who_id THEN
    RAISE EXCEPTION 'INTEGRATION_CONNECT_ATTEMPT_GUARD: only the member who started a connect finishes it';
  END IF;

  IF OLD.used_at IS NULL AND NEW.used_at IS NOT NULL THEN
    -- SPENT: once, before it expires; the verifier goes with it, nothing else changes.
    IF at >= OLD.expires_at THEN
      RAISE EXCEPTION 'INTEGRATION_CONNECT_ATTEMPT_GUARD: a connect attempt is spent before it expires';
    END IF;
    IF NEW.outcome IS NOT NULL OR NEW.seen_company_name IS NOT NULL OR NEW.seen_org_nr IS NOT NULL THEN
      RAISE EXCEPTION 'INTEGRATION_CONNECT_ATTEMPT_GUARD: a connect attempt is spent, then its outcome is set';
    END IF;
    NEW.used_at := at;
    NEW.pkce_verifier := NULL;
    RETURN NEW;
  END IF;

  IF OLD.used_at IS NOT NULL AND OLD.outcome IS NULL AND NEW.outcome IS NOT NULL
     AND NEW.used_at IS NOT DISTINCT FROM OLD.used_at AND NEW.pkce_verifier IS NULL THEN
    -- ITS OUTCOME: once, within fifteen minutes of being spent (the callback's own work).
    IF at > OLD.used_at + interval '15 minutes' THEN
      RAISE EXCEPTION 'INTEGRATION_CONNECT_ATTEMPT_GUARD: a connect attempt''s outcome is set as it is spent';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'INTEGRATION_CONNECT_ATTEMPT_GUARD: a connect attempt is spent once, then given its outcome once';
END
$fn$;

CREATE TRIGGER integration_connect_attempt_guard
  BEFORE INSERT OR UPDATE OR DELETE ON integration_connect_attempt
  FOR EACH ROW EXECUTE FUNCTION integration_connect_attempt_guard();


-- ── 4. The connection's guard ───────────────────────────────────────
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
  upkeep constant text[] := ARRAY['status', 'broken_since', 'broken_reason', 'last_ok_at', 'last_night', 'send_lease_until', 'send_run_id'];
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
       OR NEW.send_lease_until IS NOT NULL THEN
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
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'INTEGRATION_CONNECTION_GUARD: a connection is changed only by a member who may connect it, or by the nightly send';
END
$fn$;

CREATE TRIGGER integration_connection_guard
  BEFORE INSERT OR UPDATE OR DELETE ON integration_connection
  FOR EACH ROW EXECUTE FUNCTION integration_connection_guard();


-- ── Grants (deny-default, explicit per table) ───────────────────────
GRANT SELECT, INSERT, UPDATE ON integration_connect_attempt TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON integration_connection TO app_runtime;
-- app_platform already covers new tables via ALTER DEFAULT PRIVILEGES.

-- ── RLS: integration_connect_attempt — class A (portal_deny) ────────
ALTER TABLE integration_connect_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_connect_attempt FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON integration_connect_attempt
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (tenant_id = (SELECT current_setting('app.tenant_id', true)))
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true)));

CREATE POLICY portal_deny ON integration_connect_attempt
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');

-- ── RLS: integration_connection — class A (portal_deny) ─────────────
ALTER TABLE integration_connection ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_connection FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON integration_connection
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (tenant_id = (SELECT current_setting('app.tenant_id', true)))
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true)));

CREATE POLICY portal_deny ON integration_connection
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');

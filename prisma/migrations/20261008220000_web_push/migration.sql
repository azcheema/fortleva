-- ═══════════════════════════════════════════════════════════════════
-- Phase 5 slice 106 — PHONE AND BROWSER NOTIFICATIONS (Web Push; PLAN Phase 5
-- "Web Push"; founder decision C74 (a)–(k); ARC-25 Stage B; DATA_MODEL.md
-- §6.18; SECURITY.md §6.2, §9.2, §10).
--
-- WHAT IT ADDS.
--   1. `push_subscription` (class A + RESTRICTIVE `own_device`) — one browser
--      or installed app that gets ONE member's notifications: the push
--      service's endpoint, the browser's keys (v2-encrypted, AAD
--      `tenantId:push_subscription:<id>:keys`), the fingerprint of OUR key it
--      subscribed with (`vapid_key`), a label ("Chrome · Android"), and the
--      member-plane SESSION it is live under (`session_id`, NO foreign key:
--      Better Auth deletes sessions on sign-out, "Your devices" and an owner's
--      reset — the row then goes dormant, which is C74 (d)).
--      Unique per (tenant, member, endpoint), NOT per endpoint as DATA_MODEL
--      first sketched it: one browser on a shared computer may hold rows for
--      two members, and only the one whose sign-in is alive is ever sent to.
--      Member FK ON DELETE CASCADE (a device means nothing without its
--      member); tenant FK RESTRICT (the convention).
--   2. `notification.pushed_at` — THE PUSH LEDGER: the drain has dealt with
--      this notification (sent, or decided not to) and never reconsiders it.
--      The claim IS the stamp, so a push is at most once. A column-level
--      UPDATE grant (the drain runs as the tenant's SYSTEM principal under
--      RLS) and a guard trigger: only SYSTEM may set or clear it — a member
--      cannot re-arm a buzz or silence one by writing it, though their own
--      rows' other three columns stay theirs to write as before.
--   3. `notification_push_due` — a partial index on (tenant_id, created_at)
--      for INSTANT rows to members; the drain only ever reads the last fifteen
--      minutes of it. Historic rows stay NULL: no backfill.
--   4. `notification_preference.push_level` — the phone's own level (C74
--      (b)), the email ladder's enum, PARTICIPATING by default. A constant
--      default: no rewrite.
--
-- DDL AND GRANTS ONLY — no row is touched: `neon-smoke` is not owed.
--
-- NEVER THE CLIENT. Class A: a contact principal reads and writes zero rows of
-- `push_subscription`. `notification` and `notification_preference` keep their
-- existing policies; contacts get no push (the skip list, CP3).
-- ═══════════════════════════════════════════════════════════════════

-- AlterTable
ALTER TABLE "notification" ADD COLUMN     "pushed_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "notification_preference" ADD COLUMN     "push_level" "email_level" NOT NULL DEFAULT 'PARTICIPATING';

-- CreateTable
CREATE TABLE "push_subscription" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "keys_ciphertext" TEXT NOT NULL,
    "vapid_key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "bound_at" TIMESTAMPTZ(6) NOT NULL,
    "fail_count" INTEGER NOT NULL DEFAULT 0,
    "last_sent_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "push_subscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "push_subscription_tenant_id_member_id_endpoint_key" ON "push_subscription"("tenant_id", "member_id", "endpoint");

-- AddForeignKey
ALTER TABLE "push_subscription" ADD CONSTRAINT "push_subscription_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_subscription" ADD CONSTRAINT "push_subscription_tenant_id_member_id_fkey" FOREIGN KEY ("tenant_id", "member_id") REFERENCES "member"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── The row's own shape ─────────────────────────────────────────────
-- The app checks the endpoint against the four push services
-- (`pushEndpointUrl`, src/config) and STORES ITS CANONICAL FORM (the parsed
-- URL's `href`: lower-case scheme and host, ASCII, nothing stripped later — the
-- migration review's low: a raw string the parser accepts could otherwise fail
-- this CHECK, overflow the unique index, or spell one device two ways), and the
-- keys against the curve (`receiverKeysOf`, src/push/web-push.ts); the
-- database holds the outline a later writer must meet too: printable ASCII
-- after `https://`, at most 1024 bytes.
ALTER TABLE push_subscription
  ADD CONSTRAINT push_subscription_endpoint
    CHECK (endpoint ~ '^https://[!-~]+$' AND octet_length(endpoint) <= 1024),
  ADD CONSTRAINT push_subscription_label
    CHECK (char_length(label) BETWEEN 1 AND 80),
  ADD CONSTRAINT push_subscription_fail_count
    CHECK (fail_count >= 0);

-- ── Grants (deny-default, explicit per table) ───────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON push_subscription TO app_runtime;
-- The drain stamps and releases the ledger as SYSTEM under RLS. Members held
-- UPDATE on (read_at, archived_at, snoozed_till) only; the guard below keeps
-- this column the drain's alone.
GRANT UPDATE (pushed_at) ON notification TO app_runtime;
-- app_platform already covers new tables via ALTER DEFAULT PRIVILEGES.

-- ── RLS — class A (portal_deny) + own_device ────────────────────────
ALTER TABLE push_subscription ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscription FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON push_subscription
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (tenant_id = (SELECT current_setting('app.tenant_id', true)))
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true)));

CREATE POLICY portal_deny ON push_subscription
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');

-- A member's devices are THEIRS: no colleague, owner or admin reads, moves or
-- removes them (the settings page has no seat that acts for someone else),
-- and an impersonating operator — who would run as the member's own
-- principal — is refused by the application before it turns one on, re-links
-- or removes one (it may see their labels and dates, as the page does)
-- (`src/push/devices.ts`). The drain and its housekeeping run as the
-- tenant's SYSTEM principal. `platform_admin` gets nothing.
CREATE POLICY own_device ON push_subscription
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING (
    (SELECT current_setting('app.principal', true)) = 'system'
    OR (
      (SELECT current_setting('app.principal', true)) = 'member'
      AND member_id = (SELECT current_setting('app.principal_id', true))
    )
  )
  WITH CHECK (
    (SELECT current_setting('app.principal', true)) = 'system'
    OR (
      (SELECT current_setting('app.principal', true)) = 'member'
      AND member_id = (SELECT current_setting('app.principal_id', true))
    )
  );

-- ── The push ledger is the drain's alone ────────────────────────────
-- Only the tenant's SYSTEM principal may set or clear `pushed_at`: a member's
-- write to their own notification (read, archive, snooze — the column grant)
-- never names it; one that did would re-arm a push already dealt with, or
-- silence one. A connection with no principal set (the platform/owner role:
-- the harnesses' cleanups, an offboarding) is not judged here, as the vault's
-- guards do not judge it.
CREATE OR REPLACE FUNCTION notification_pushed_at_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF COALESCE(current_setting('app.principal', true), '') NOT IN ('', 'system')
     AND (
       (TG_OP = 'INSERT' AND NEW.pushed_at IS NOT NULL)
       OR (TG_OP = 'UPDATE' AND NEW.pushed_at IS DISTINCT FROM OLD.pushed_at)
     ) THEN
    RAISE EXCEPTION 'notification.pushed_at is written by the push drain only'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER notification_pushed_at_guard
  BEFORE INSERT OR UPDATE OF pushed_at ON notification
  FOR EACH ROW EXECUTE FUNCTION notification_pushed_at_guard();

-- ── What the drain reads ────────────────────────────────────────────
-- NOT on `pushed_at` (the migration review's nit): a predicate naming it would
-- make every claim and release a non-HOT update touching every index of
-- `notification`, and would not keep the index small anyway — rows whose
-- receiver has no device are never stamped. The claim's own literals
-- (`class = 'INSTANT' AND receiver_type = 'MEMBER'`) imply this predicate.
-- Not CONCURRENTLY: inside the migration's transaction, as 20260920190000.
CREATE INDEX notification_push_due
  ON notification (tenant_id, created_at)
  WHERE class = 'INSTANT' AND receiver_type = 'MEMBER';

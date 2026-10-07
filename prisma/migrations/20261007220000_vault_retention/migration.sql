-- ═══════════════════════════════════════════════════════════════════
-- Phase 3V slice 99 — THE VAULT CLEAN-UP: the bin purge and the share
-- links' retention sweep. DATA_MODEL.md §5 R2 ("CredentialSecret and
-- CredentialVersion are hard-deleted with their CredentialItem (soft-
-- delete window 30 d, then purge including versions); CredentialShareLink
-- rows kept 12 months after expiry as evidence" — or until their login is
-- erased, whichever comes first: a link's row goes with its login); founder
-- decision C67 (a): a login a CLIENT SENT (slice 96) is erased like any
-- other, but the name they sent it under and the date stay, so their own
-- "what we sent you" list stays true. DDL only — no row is touched here;
-- the daily job (`src/jobs/vault-retention.ts` →
-- `src/modules/vault/retention.ts`) does the work.
--
-- 1. `credential_item.purged_at` — set ONCE, by the job, on a binned
--    login a contact handed over, when everything but the client's record
--    of it is erased: the row stays as a TOMBSTONE carrying only its
--    client, the contact who sent it, the name they sent it under and its
--    date (`readPortalSubmissions` lists exactly those; `deleteContact`
--    counts it as the contact's writing). Its secret, old versions and
--    share links are deleted by the job; a login nobody sent is deleted
--    outright, and its secret, versions and links go with it by the FKs'
--    cascade. A tombstone itself leaves only through a platform or owner
--    connection (a tenant's offboarding, the harnesses' teardowns): 3b
--    does not judge one.
-- 2. `credential_item_purged_shape` — what a tombstone may hold, restated
--    so no writer can leave a username, an address, a note, tags, a TOTP
--    flag, a team's rename or a project behind on one. The project goes
--    so a tombstone never RESTRICTs a project's delete; the client stays
--    (the client's list is read by it, and `credential_item_submitted_
--    needs_client` needs it) — clients are only ever archived.
-- 3. `credential_item_purge_guard` — a tombstone never changes again;
--    only the SYSTEM principal makes one, of a login binned at least 30
--    days that a contact handed over, stamped within five minutes of its
--    statement; and the client's record (its id, date, type, bin date, no
--    member author) is left exactly as it was.
-- 3b. `credential_item_delete_guard` — under `withTenant`, only the SYSTEM
--    principal deletes a login, and only one binned 30 days that nobody
--    sent; a member or contact deletes none. A platform or owner
--    connection (the principal GUC unset: the harnesses' teardowns, a
--    tenant's offboarding) is not this guard's to judge. In code, the
--    retention module is the one deleter
--    (`src/modules/vault/vault-boundary.test.ts`).
-- 4. `credential_item_bin_idx` — the job's pick: a tenant's binned logins
--    not yet erased, oldest first. A PARTIAL index Prisma cannot express:
--    `schema.prisma` says so beside `purgedAt`, so a generated diff that
--    proposes dropping it is refused.
-- 5. `credential_share_link` gains DELETE for `app_runtime` (its
--    migration said this one would add it; its `expires_at` index for the
--    sweep came with the table) and `credential_share_link_delete_guard`:
--    a link row is deleted WITH its login (inside the FK's cascade, where
--    the login row is already gone — measured on PG 18.6 in a rolled-back
--    transaction: a cascaded child's BEFORE DELETE trigger sees its parent
--    as deleted at `pg_trigger_depth()` 2, a direct delete sees it present
--    at depth 1 — and 3b decides who may make a login gone), or by the
--    SYSTEM principal once the link expired more than 12 months ago, or
--    once its login is a tombstone (the job erases a sent login's links
--    itself, since the row stays). A platform or owner connection is not
--    this guard's to judge either, as 3b's is not. Nothing else deletes one.
--
-- The design was reviewed by a fresh agent before this file was written,
-- and this file before it was applied (no high or medium; its lows and nits
-- taken: the cascade branch bound to the cascade's depth, a platform
-- connection left unjudged by the link guard as by 3b, the record's id
-- held, the tenant column in the job's index, the lists' `coalesce`, the
-- wording above — and, in the job, the tombstone's visibility and seal
-- SET outright), then its revision re-checked.
-- ═══════════════════════════════════════════════════════════════════

-- ── 1. The column ────────────────────────────────────────────────────
ALTER TABLE "credential_item" ADD COLUMN "purged_at" TIMESTAMPTZ(6);

-- ── 2. What a tombstone may hold ─────────────────────────────────────
-- `tags` and `secret_field_keys` are nullable in the table; an absent list
-- holds nothing either (`coalesce`), so the shape is exact.
ALTER TABLE credential_item
  ADD CONSTRAINT credential_item_purged_shape
    CHECK (purged_at IS NULL OR (
      deleted_at IS NOT NULL
      AND submitted_by_contact_id IS NOT NULL
      AND name = submitted_name
      AND username IS NULL AND url IS NULL AND notes IS NULL
      AND coalesce(cardinality(tags), 0) = 0 AND coalesce(cardinality(secret_field_keys), 0) = 0
      AND NOT has_totp
      AND expires_at IS NULL AND rotate_every_days IS NULL AND last_rotated_at IS NULL
      AND NOT needs_rotation AND compromised_at IS NULL
      AND project_id IS NULL AND archived_at IS NULL
      AND updated_by_member_id IS NULL
      AND visibility = 'INTERNAL' AND sealed_at IS NULL));

-- ── 3. The guard: made once, by the job, never changed after ─────────
-- SECURITY INVOKER (the default): it reads nothing but its own row and the
-- transaction's GUCs. The principal GUC is the one `withTenant` sets as
-- its first statement; unset — a platform or owner connection — it is
-- NULL/'' and matches no rule that purges.
CREATE OR REPLACE FUNCTION credential_item_purge_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  stamp timestamptz := statement_timestamp();
  slack constant interval := interval '5 minutes';
BEGIN
  IF OLD.purged_at IS NOT NULL THEN
    RAISE EXCEPTION 'CREDENTIAL_PURGE_GUARD: an erased login never changes';
  END IF;
  IF current_setting('app.principal', true) IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'CREDENTIAL_PURGE_GUARD: only the retention job erases a login';
  END IF;
  IF OLD.submitted_by_contact_id IS NULL THEN
    RAISE EXCEPTION 'CREDENTIAL_PURGE_GUARD: a login nobody sent is deleted, not kept';
  END IF;
  IF OLD.deleted_at IS NULL OR OLD.deleted_at > now() - interval '30 days' THEN
    RAISE EXCEPTION 'CREDENTIAL_PURGE_GUARD: a login is erased only after 30 days in the bin';
  END IF;
  IF NEW.purged_at < stamp - slack OR NEW.purged_at > stamp + slack THEN
    RAISE EXCEPTION 'CREDENTIAL_PURGE_GUARD: an erasure is stamped when it happens';
  END IF;
  -- What the client's record IS stays as it was: which row it is (an id
  -- change would cascade into the secret's rows and orphan the audit
  -- trail), the date they see on their list (`created_at`), what kind of
  -- login it was, when it was binned, and that no member authored it.
  -- (`submitted_*` and `client_id` are the submission guard's to hold.)
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.type IS DISTINCT FROM OLD.type
     OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
     OR NEW.created_by_member_id IS DISTINCT FROM OLD.created_by_member_id THEN
    RAISE EXCEPTION 'CREDENTIAL_PURGE_GUARD: an erasure keeps the client''s record as it was';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER credential_item_purge_guard
  BEFORE UPDATE ON credential_item
  FOR EACH ROW
  WHEN (OLD.purged_at IS NOT NULL OR NEW.purged_at IS NOT NULL)
  EXECUTE FUNCTION credential_item_purge_guard();

-- ── 3b. Who deletes a login: the job, and only from the bin ──────────
-- `app_runtime` has held DELETE on `credential_item` since the vault core,
-- and a login's DELETE cascades to its secret, its old versions and its
-- links — so the database says who may (the design review's medium: with
-- no guard here, `credential_share_link_delete_guard`'s "the login is
-- gone" would be a way round it). Under `withTenant` the principal GUC is
-- always set: a MEMBER or CONTACT deletes no login (a member's delete is
-- the soft one, `deleted_at`); the SYSTEM principal deletes one binned at
-- least 30 days that nobody sent and that is not a tombstone. With the
-- GUC unset — a platform or owner connection: the harnesses' teardowns,
-- a tenant's offboarding — it is not this guard's to judge (an
-- `app_runtime` connection outside `withTenant` sees no row at all:
-- `tenant_isolation` needs `app.tenant_id`).
CREATE OR REPLACE FUNCTION credential_item_delete_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  who text := coalesce(current_setting('app.principal', true), '');
BEGIN
  IF who = '' THEN
    RETURN OLD;
  END IF;
  IF who = 'system'
     AND OLD.deleted_at IS NOT NULL AND OLD.deleted_at <= now() - interval '30 days'
     AND OLD.submitted_by_contact_id IS NULL AND OLD.purged_at IS NULL THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'CREDENTIAL_DELETE_GUARD: a login leaves the bin after 30 days, by the retention job';
END
$fn$;

CREATE TRIGGER credential_item_delete_guard
  BEFORE DELETE ON credential_item
  FOR EACH ROW EXECUTE FUNCTION credential_item_delete_guard();

-- ── 4. The job's pick ────────────────────────────────────────────────
CREATE INDEX credential_item_bin_idx
  ON credential_item (tenant_id, deleted_at)
  WHERE deleted_at IS NOT NULL AND purged_at IS NULL;

-- ── 5. Share links: the sweep's grant and guard ──────────────────────
-- (Its index, `credential_share_link_expires_at_idx`, came with the table
-- in slice 90, "the retention sweep (later)".) "The login is gone" is
-- believed only INSIDE a cascade (depth > 1): a direct delete of a link
-- whose login merely cannot be SEEN falls through to the principal's rules
-- (the migration review's low — no principal that sees links sees fewer
-- logins today, but a later slice might give one).
CREATE OR REPLACE FUNCTION credential_share_link_delete_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  who text := coalesce(current_setting('app.principal', true), '');
  login_purged timestamptz;
BEGIN
  IF who = '' THEN
    RETURN OLD;
  END IF;
  SELECT c.purged_at INTO login_purged
    FROM credential_item c
   WHERE c.tenant_id = OLD.tenant_id AND c.id = OLD.credential_id;
  IF NOT FOUND AND pg_trigger_depth() > 1 THEN
    -- With its login: the FK's cascade (the login row is already gone).
    RETURN OLD;
  END IF;
  IF who IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'CRED_SHARE_LINK_DELETE_GUARD: a link goes with its login, or with time';
  END IF;
  IF OLD.expires_at < now() - interval '12 months' OR login_purged IS NOT NULL THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'CRED_SHARE_LINK_DELETE_GUARD: a link is kept 12 months after it expired';
END
$fn$;

CREATE TRIGGER credential_share_link_delete_guard
  BEFORE DELETE ON credential_share_link
  FOR EACH ROW EXECUTE FUNCTION credential_share_link_delete_guard();

-- ── Grants (deny-default, explicit per table) ───────────────────────
-- The policies already cover DELETE: `tenant_isolation` (PERMISSIVE FOR
-- ALL) and `portal_deny` (RESTRICTIVE FOR ALL) — a contact deletes nothing.
GRANT DELETE ON credential_share_link TO app_runtime;

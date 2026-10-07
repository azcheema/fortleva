-- ═══════════════════════════════════════════════════════════════════
-- Phase 3V slice 99, part two — A SHARE LINK'S RECORD KEEPS ITS 12 MONTHS
-- EVEN WHEN ITS LOGIN IS ERASED SOONER (founder decision C67 (f), asked
-- after the security review: the link row is the only place the address a
-- password was shared to is kept — the audit never carries it — and part
-- one let a login's erasure at 30 days take its links' records with it).
-- DDL only. Corrects `20261007220000_vault_retention` FORWARD: that file was
-- applied to the dev database before the question was asked, so it is not
-- edited; the three functions are replaced and the CHECK is swapped by name.
--
-- What changes:
-- 1. A login NOBODY sent may now be a tombstone too: when its 30 days in
--    the bin are up while one of its share links is still within its 12
--    months, the job erases its secret and versions and empties it as it
--    does a sent one — but keeps its NAME (its client, type, dates and the
--    member who made it stay too), so the links' records still say which
--    login went where. `credential_item_purged_shape` keeps every other
--    term; only "a tombstone was sent, and is named as sent" becomes "a
--    SENT tombstone is named as sent".
-- 2. `credential_item_purge_guard` no longer refuses a login nobody sent.
-- 3. `credential_item_delete_guard`: the SYSTEM principal deletes a login
--    nobody sent, binned 30 days — a tombstone of one included — only while
--    NO share link of it is still within its 12 months (a login's DELETE
--    cascades to its links, so this is where the 12 months are held). A
--    sent login, tombstone or not, is never deleted by it.
-- 4. `credential_share_link_delete_guard`: a tombstone's links are no
--    longer deleted early; the SYSTEM principal deletes a link only 12
--    months past its expiry (or inside its login's cascade, which 3 now
--    allows only once its links are that old).
-- 5. `credential_item_kept_for_links_idx` — the job's pick of tombstones
--    nobody sent, to delete once their links' records are gone.
-- 6. `credential_item_born_live` — no INSERT writes a tombstone, now that
--    the CHECK no longer needs a sender on one.
--
-- Reviewed by a fresh agent before it was applied (one low taken: item 6),
-- and its revision re-checked.
-- ═══════════════════════════════════════════════════════════════════

-- ── 1. What a tombstone may hold ─────────────────────────────────────
ALTER TABLE credential_item DROP CONSTRAINT credential_item_purged_shape;
ALTER TABLE credential_item
  ADD CONSTRAINT credential_item_purged_shape
    CHECK (purged_at IS NULL OR (
      deleted_at IS NOT NULL
      AND (submitted_by_contact_id IS NULL OR name = submitted_name)
      AND username IS NULL AND url IS NULL AND notes IS NULL
      AND coalesce(cardinality(tags), 0) = 0 AND coalesce(cardinality(secret_field_keys), 0) = 0
      AND NOT has_totp
      AND expires_at IS NULL AND rotate_every_days IS NULL AND last_rotated_at IS NULL
      AND NOT needs_rotation AND compromised_at IS NULL
      AND project_id IS NULL AND archived_at IS NULL
      AND updated_by_member_id IS NULL
      AND visibility = 'INTERNAL' AND sealed_at IS NULL));

-- ── 2. The purge guard: any binned login, 30 days on ─────────────────
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
  IF OLD.deleted_at IS NULL OR OLD.deleted_at > now() - interval '30 days' THEN
    RAISE EXCEPTION 'CREDENTIAL_PURGE_GUARD: a login is erased only after 30 days in the bin';
  END IF;
  IF NEW.purged_at < stamp - slack OR NEW.purged_at > stamp + slack THEN
    RAISE EXCEPTION 'CREDENTIAL_PURGE_GUARD: an erasure is stamped when it happens';
  END IF;
  -- What the record IS stays as it was: which row it is (an id change would
  -- cascade into the secret's rows and orphan the audit trail), whose it
  -- is, its date, what kind of login it was, when it was binned, who made
  -- it. (A sent login's `submitted_*` are the submission guard's to hold;
  -- the CHECK holds a sent tombstone's name — the name it was SENT under.)
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.client_id IS DISTINCT FROM OLD.client_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.type IS DISTINCT FROM OLD.type
     OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
     OR NEW.created_by_member_id IS DISTINCT FROM OLD.created_by_member_id THEN
    RAISE EXCEPTION 'CREDENTIAL_PURGE_GUARD: an erasure keeps the record as it was';
  END IF;
  -- A login nobody sent keeps its NAME as a tombstone: its links' records
  -- are kept to say which login went where.
  IF OLD.submitted_by_contact_id IS NULL AND NEW.name IS DISTINCT FROM OLD.name THEN
    RAISE EXCEPTION 'CREDENTIAL_PURGE_GUARD: an erasure keeps the record as it was';
  END IF;
  RETURN NEW;
END
$fn$;

-- ── 3. Who deletes a login: the job, from the bin, after its links ───
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
     AND OLD.submitted_by_contact_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM credential_share_link l
                      WHERE l.tenant_id = OLD.tenant_id AND l.credential_id = OLD.id
                        AND l.expires_at >= now() - interval '12 months') THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'CREDENTIAL_DELETE_GUARD: a login leaves the bin after 30 days, by the retention job, once its share links are 12 months old';
END
$fn$;

-- ── 4. A share link's record: with its login, or 12 months on ────────
CREATE OR REPLACE FUNCTION credential_share_link_delete_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  who text := coalesce(current_setting('app.principal', true), '');
BEGIN
  IF who = '' THEN
    RETURN OLD;
  END IF;
  PERFORM 1 FROM credential_item c
   WHERE c.tenant_id = OLD.tenant_id AND c.id = OLD.credential_id;
  IF NOT FOUND AND pg_trigger_depth() > 1 THEN
    -- With its login: the FK's cascade (the login row is already gone, and
    -- `credential_item_delete_guard` let it go only once its links were
    -- 12 months past expiry).
    RETURN OLD;
  END IF;
  IF who IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'CRED_SHARE_LINK_DELETE_GUARD: a link goes with its login, or with time';
  END IF;
  IF OLD.expires_at < now() - interval '12 months' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'CRED_SHARE_LINK_DELETE_GUARD: a link is kept 12 months after it expired';
END
$fn$;

-- ── 5. The job's pick of tombstones nobody sent ──────────────────────
CREATE INDEX credential_item_kept_for_links_idx
  ON credential_item (tenant_id, purged_at)
  WHERE purged_at IS NOT NULL AND submitted_by_contact_id IS NULL;

-- ── 6. A login is born live ──────────────────────────────────────────
-- Part one's CHECK needed a sender on every tombstone, and only the
-- submission broker inserts a sender — with `deleted_at` NULL — so no
-- INSERT could make one. Item 1 above drops that term for a login nobody
-- sent, which would let any principal holding INSERT write a row already
-- erased: a "tombstone" nobody made, and one binned under 30 days would
-- stop the job's release phase until it aged (this file's review's low).
-- So: a tombstone is made by the job's UPDATE, never by an INSERT — for
-- every principal, a platform or owner connection included.
CREATE OR REPLACE FUNCTION credential_item_born_live() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION 'CREDENTIAL_PURGE_GUARD: a login is born live — only the retention job erases one';
END
$fn$;

CREATE TRIGGER credential_item_born_live
  BEFORE INSERT ON credential_item
  FOR EACH ROW
  WHEN (NEW.purged_at IS NOT NULL)
  EXECUTE FUNCTION credential_item_born_live();

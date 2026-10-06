-- ═══════════════════════════════════════════════════════════════════
-- Phase 3V slice 96 — PORTAL SUBMISSION: a client hands a login over
-- through their portal, straight into the agency's vault (founder decision
-- C64, 2026-10-06; AUTHZ.md §8's `portal.credential.submit`, a BROKERED
-- write — `src/modules/vault/submission-portal-writes.ts`). The contact
-- proves, in their own transaction, that they may; the write then runs as
-- SYSTEM with every column derived by the broker, never by the form.
-- DATA_MODEL.md §6.17.
--
-- DDL only, no DML — no `neon-smoke.yml` dispatch owed. Two nullable
-- columns, an index, five CHECKs every existing row satisfies (no row has
-- either column set yet) and one guard function on two triggers. No grant
-- changes: grants are per table, so the new columns inherit
-- `credential_item`'s.
--
-- 1. `credential_item.submitted_by_contact_id` — the contact who handed it
--    over. ATTRIBUTION, NO FK — the house convention for a contact's own
--    writing (a comment's author, a request's reporter, a sealed ask's
--    asker): `deleteContact` (src/clients/service.ts) refuses to delete a
--    contact who has written anything, and counts this column, so the
--    login never reads as sent by nobody. Indexed with the tenant for the
--    contact's own "what you sent" list and that count.
--
-- 2. `credential_item.submitted_name` — the name AS THE CLIENT SENT IT,
--    which never changes (the pre-apply review's HIGH). The client's own
--    list of what they sent (C64 (b)) shows this, never `name`: the team
--    may rename the login, and a name a member wrote — "ACME root, reused
--    bank password" — must never reach a client's screen. Equal to `name`
--    at birth; `name` is then the team's to edit, this is not.
--
-- 3. CHECKs:
--    - `credential_item_submitted_by_length` — an id's shape bound.
--    - `credential_item_submitted_needs_client` — a contact belongs to a
--      client, and what they send is that client's (never the agency's
--      own, C49).
--    - `credential_item_submitted_one_author` — a login is created by a
--      member OR handed over by a contact, never both: a member can never
--      make a login of theirs read "sent by the client".
--    - `credential_item_submitted_name_pair` — the snapshot exists exactly
--      when the sender does.
--    - `credential_item_submitted_name_length` — the name's own bound (the
--      service's 200 characters).
--
-- 4. `credential_item_submission_guard` — what the database holds, for
--    ANY writer, about a login handed over:
--    INSERT (only when the sender is set — a member's own create is not
--    touched):
--    - written by the SYSTEM principal only (the portal's broker): a
--      member principal cannot forge a submission, and a contact principal
--      cannot insert into `credential_item` at all (`portal_no_insert`);
--    - born as sent: the snapshot equal to the name, no member as its
--      author or its editor, stamped now (five minutes either way — the
--      application stamps `created_at`, and the snapshot's date is what
--      the client's list shows);
--    - born for the team only (C64): INTERNAL, not sealed, no
--      authenticator seed, live (not archived, not binned). A member may
--      show it to the client, seal it or add a seed afterwards, as on any
--      login — those are UPDATEs this guard does not read;
--    - by an ACTIVE, invited contact OF THAT LOGIN'S CLIENT, whose row the
--      guard locks `FOR SHARE`: ending the contact's access (an UPDATE of
--      that row) waits for the hand-over to commit, or the hand-over waits
--      for it and then refuses (READ COMMITTED re-reads the row it waited
--      for, which is no longer ACTIVE). `deleteContact` takes the
--      contact's row `FOR UPDATE` before it reads the status and counts
--      what they wrote, so a hand-over can neither commit between that
--      count and the DELETE nor slip in after it: the login is counted, or
--      the guard finds no contact. The broker takes the same share lock
--      earlier in the same transaction (`submitterStanding`), so for the
--      product's one writer this adds no wait and no new lock order.
--      `app_runtime` holds UPDATE on `contact`, which `FOR SHARE` needs;
--      under SYSTEM no portal policy narrows the read.
--    UPDATE (only when the sender or the snapshot would change, or a
--    handed-over login's client would): refused — who sent it and what
--    they called it never change, and a login handed over by a client's
--    contact never moves to another client. Nothing in the product moves
--    a login (`updateCredential` offers no such field); this is the
--    database saying so for these columns' sake. A future erasure of a
--    contact's writing (none is built — the founder's rule is to refuse
--    the delete) must change this guard by name.
--    Every refusal raises `CREDENTIAL_SUBMISSION_GUARD`, never a value.
--    Triggers on one event fire in name order: `credential_item_client_
--    match` (a project of the same client) runs before these.
--    search_path pinned (the function reads a table by name).
-- ═══════════════════════════════════════════════════════════════════

-- AlterTable
ALTER TABLE "credential_item" ADD COLUMN     "submitted_by_contact_id" TEXT,
ADD COLUMN     "submitted_name" TEXT;

-- CreateIndex
CREATE INDEX "credential_item_tenant_id_submitted_by_contact_id_idx" ON "credential_item"("tenant_id", "submitted_by_contact_id");

ALTER TABLE credential_item
  ADD CONSTRAINT credential_item_submitted_by_length
    CHECK (submitted_by_contact_id IS NULL OR char_length(submitted_by_contact_id) BETWEEN 1 AND 64),
  ADD CONSTRAINT credential_item_submitted_needs_client
    CHECK (submitted_by_contact_id IS NULL OR client_id IS NOT NULL),
  ADD CONSTRAINT credential_item_submitted_one_author
    CHECK (submitted_by_contact_id IS NULL OR created_by_member_id IS NULL),
  ADD CONSTRAINT credential_item_submitted_name_pair
    CHECK ((submitted_name IS NULL) = (submitted_by_contact_id IS NULL)),
  ADD CONSTRAINT credential_item_submitted_name_length
    CHECK (submitted_name IS NULL OR char_length(submitted_name) BETWEEN 1 AND 200);

CREATE OR REPLACE FUNCTION credential_item_submission_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  stamp timestamptz := statement_timestamp();
  slack constant interval := interval '5 minutes';
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF current_setting('app.principal', true) IS DISTINCT FROM 'system' THEN
      RAISE EXCEPTION 'CREDENTIAL_SUBMISSION_GUARD: a login is handed over through the portal''s broker';
    END IF;
    IF NEW.submitted_name IS DISTINCT FROM NEW.name
       OR NEW.updated_by_member_id IS NOT NULL
       OR NEW.created_at < stamp - slack OR NEW.created_at > stamp + slack THEN
      RAISE EXCEPTION 'CREDENTIAL_SUBMISSION_GUARD: a login handed over is born as it was sent';
    END IF;
    IF NEW.visibility IS DISTINCT FROM 'INTERNAL' OR NEW.sealed_at IS NOT NULL OR NEW.has_totp
       OR NEW.archived_at IS NOT NULL OR NEW.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'CREDENTIAL_SUBMISSION_GUARD: a login handed over arrives for the team only';
    END IF;
    PERFORM 1 FROM contact c
      WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.submitted_by_contact_id
        AND c.client_id = NEW.client_id
        AND c.portal_status = 'ACTIVE' AND c.invited_at IS NOT NULL
      FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'CREDENTIAL_SUBMISSION_GUARD: only an active contact of the client hands a login over';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'CREDENTIAL_SUBMISSION_GUARD: who handed a login over, and what they called it, never change, nor whose it is';
END
$fn$;

CREATE TRIGGER credential_item_submission_insert
  BEFORE INSERT ON credential_item
  FOR EACH ROW
  WHEN (NEW.submitted_by_contact_id IS NOT NULL)
  EXECUTE FUNCTION credential_item_submission_guard();

CREATE TRIGGER credential_item_submission_update
  BEFORE UPDATE OF submitted_by_contact_id, submitted_name, client_id ON credential_item
  FOR EACH ROW
  WHEN (OLD.submitted_by_contact_id IS DISTINCT FROM NEW.submitted_by_contact_id
        OR OLD.submitted_name IS DISTINCT FROM NEW.submitted_name
        OR (OLD.submitted_by_contact_id IS NOT NULL AND OLD.client_id IS DISTINCT FROM NEW.client_id))
  EXECUTE FUNCTION credential_item_submission_guard();

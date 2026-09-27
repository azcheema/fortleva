-- ═══════════════════════════════════════════════════════════════════
-- Phase 3 — VERSION SIGN-OFF (decision #7, v1-lite): the client's
-- approve / request-changes decision on a shipped `project_version` and
-- on a shared `document` of kind DELIVERABLE. DATA_MODEL.md §6.5 and
-- §6.8; AUTHZ.md §8 (`portal.version.approve`, `portal.deliverable.
-- approve` — CONTACT_PRIMARY only); TENANCY.md §7.2, the two census
-- entries this opens.
--
-- WHAT THIS DOES, IN ONE PARAGRAPH. `project_version` has carried its
-- approval columns since 20260816180000 with no writer; `document` was
-- specified to mirror them and never got them. This migration adds the
-- six document columns, pins the SHAPE of an approval on both tables
-- with CHECKs, and then opens the two census doors the write-census
-- migration (20260920230000) said it would: `portal_no_update` is
-- DROPPED on both tables and replaced by a named policy plus two
-- BEFORE UPDATE triggers, so that a CONTACT principal may update
-- exactly the four decision columns, exactly once per request, on
-- exactly the rows `portal_gate` already admits. Everything else a
-- contact might try on these tables is refused as before.
--
-- WHY THE WRITE IS DIRECT AND NOT BROKERED. Every other contact-caused
-- write in the product runs as `system` after `authorizePortal()`
-- (`portal-writes.ts`), because RLS could not express it. This one it
-- can: the row is already gated (client, SHIPPED / CLIENT_VISIBLE, the
-- portal switch), the columns are few and fixed, and the actor is the
-- principal itself. A direct write means the DATABASE is the last line
-- — a contact whose session was somehow handed another client's id
-- cannot decide that client's version, whatever the application does
-- — which is the property DATA_MODEL §2.3, SECURITY §5.1 and AUTHZ §8
-- all reserved for these columns. The audit row is written in the same
-- contact transaction (`portal_audit_insert` admits a row describing
-- the contact itself); the agency's notification is NOT — a contact
-- cannot insert `notification` rows (`portal_insert_deny`) — and
-- follows in a system transaction after the commit. The decision is
-- durable before anyone is told; the reverse would be worse.
--
-- DDL only, no DML — no `neon-smoke.yml` dispatch is owed.

-- ── 1. `document` gains the approval block DATA_MODEL §6.8 specifies ──
--
-- Mirroring `project_version`'s five, plus `approval_version_number`:
-- the `file_version.version_number` a request was made about, so
-- "what exactly did the client approve" is answerable after the agency
-- uploads v3. Stamped when staff REQUEST sign-off (the newest COMMITTED
-- version at that moment), never by the contact — the contact decides
-- on what was asked, and the trigger below refuses them the column.
--
-- `approval_by_contact_id` is attribution with no FK, as on
-- `project_version` and as every `*_by_member_id` in the schema
-- (DATA_MODEL §3): a decision must survive the contact's erasure.
ALTER TABLE "document"
  ADD COLUMN "approval_status"         "ApprovalStatus" NOT NULL DEFAULT 'NOT_REQUESTED',
  ADD COLUMN "approval_requested_at"   TIMESTAMPTZ(6),
  ADD COLUMN "approval_decided_at"     TIMESTAMPTZ(6),
  ADD COLUMN "approval_by_contact_id"  TEXT,
  ADD COLUMN "approval_note"           TEXT,
  ADD COLUMN "approval_version_number" INTEGER;

-- ── 2. The SHAPE of an approval, on both tables ──────────────────────
--
-- Four invariants, each a CHECK rather than a convention, because two
-- writers on two planes (staff requesting, the client deciding) will
-- each be edited by people who did not read the other:
--
--   · a decision — APPROVED or CHANGES_REQUESTED — carries WHO and WHEN,
--     and only a decision does (a PENDING or NOT_REQUESTED row has
--     neither);
--   · a row that was never asked about has no `requested_at`, and every
--     other status has one (a decision keeps the ask it answered);
--   · a note is the client's words ON a decision, so it needs one;
--   · on `document`, only a DELIVERABLE is ever asked, and an ask
--     always names the version it is about.
--
-- WHAT THE SHAPE DELIBERATELY ALLOWS: a decided document whose newest
-- version is NEWER than `approval_version_number`. When staff upload a
-- further version, a PENDING ask is voided (the client must not approve
-- bytes they never saw — `addVersion` resets it), but a DECISION stands,
-- pinned to the number it was about, until staff ask again. That is the
-- column's whole purpose (§6.8: "so what exactly was approved is
-- answerable"); the surfaces print the number beside the word.
--
-- NOT VALID + VALIDATE, the pattern 20260912120000 records. The scan is
-- trivially safe: `project_version`'s columns have had no writer since
-- they were created, so every row is NOT_REQUESTED with four NULLs, and
-- `document`'s were created NULL one statement above.
ALTER TABLE "project_version"
  ADD CONSTRAINT project_version_approval_decision_shape CHECK (
    (approval_status IN ('APPROVED', 'CHANGES_REQUESTED'))
      = (approval_decided_at IS NOT NULL AND approval_by_contact_id IS NOT NULL)
  ) NOT VALID,
  ADD CONSTRAINT project_version_approval_requested_shape CHECK (
    (approval_status = 'NOT_REQUESTED') = (approval_requested_at IS NULL)
  ) NOT VALID,
  ADD CONSTRAINT project_version_approval_note_on_decision CHECK (
    approval_note IS NULL OR approval_decided_at IS NOT NULL
  ) NOT VALID;
ALTER TABLE "project_version" VALIDATE CONSTRAINT project_version_approval_decision_shape;
ALTER TABLE "project_version" VALIDATE CONSTRAINT project_version_approval_requested_shape;
ALTER TABLE "project_version" VALIDATE CONSTRAINT project_version_approval_note_on_decision;

ALTER TABLE "document"
  ADD CONSTRAINT document_approval_decision_shape CHECK (
    (approval_status IN ('APPROVED', 'CHANGES_REQUESTED'))
      = (approval_decided_at IS NOT NULL AND approval_by_contact_id IS NOT NULL)
  ) NOT VALID,
  ADD CONSTRAINT document_approval_requested_shape CHECK (
    (approval_status = 'NOT_REQUESTED') = (approval_requested_at IS NULL)
  ) NOT VALID,
  ADD CONSTRAINT document_approval_note_on_decision CHECK (
    approval_note IS NULL OR approval_decided_at IS NOT NULL
  ) NOT VALID,
  ADD CONSTRAINT document_approval_deliverable_only CHECK (
    approval_status = 'NOT_REQUESTED' OR kind = 'DELIVERABLE'
  ) NOT VALID,
  ADD CONSTRAINT document_approval_version_shape CHECK (
    (approval_status = 'NOT_REQUESTED') = (approval_version_number IS NULL)
  ) NOT VALID;
ALTER TABLE "document" VALIDATE CONSTRAINT document_approval_decision_shape;
ALTER TABLE "document" VALIDATE CONSTRAINT document_approval_requested_shape;
ALTER TABLE "document" VALIDATE CONSTRAINT document_approval_note_on_decision;
ALTER TABLE "document" VALIDATE CONSTRAINT document_approval_deliverable_only;
ALTER TABLE "document" VALIDATE CONSTRAINT document_approval_version_shape;

-- ── 3. Two partial indexes for "waiting on you" ─────────────────────
--
-- The portal home lists every PENDING ask of the client across its
-- projects, and the member's surfaces will want the same set the other
-- way round. Partial on the one status that is ever listed, so the
-- index is a few rows per tenant however many versions ship.
CREATE INDEX "project_version_pending_approval_idx"
  ON "project_version" ("tenant_id", "client_id")
  WHERE approval_status = 'PENDING';
CREATE INDEX "document_pending_approval_idx"
  ON "document" ("tenant_id", "client_id")
  WHERE approval_status = 'PENDING';

-- ── 4. The search feed stops firing on columns it does not index ─────
--
-- `search_feed_document` (20260820170000, body since 20260906150000)
-- was `AFTER INSERT OR UPDATE OR DELETE` with no column list, and it
-- upserts an `entity_type = 'DOCUMENT'` row — which the census
-- migration 20260921000000 pins a CONTACT principal out of
-- (`portal_comment_rows_only_update`). So before this line a contact's
-- approval UPDATE, having passed every policy and trigger on
-- `document`, would have been refused one step later inside a trigger
-- that reads nothing it writes. Narrowed to exactly the columns
-- `search_upsert` is handed. A decision changes none of them, so the
-- feed is not consulted; a rename, a visibility flip, a move or a soft
-- delete still is. Same effect for a MEMBER's update of these columns:
-- one fewer index write per decision, which is a side benefit and not
-- the reason.
DROP TRIGGER search_feed_document ON document;
CREATE TRIGGER search_feed_document
  AFTER INSERT OR DELETE OR UPDATE OF name, tags, visibility, portal_enabled, client_id, project_id, deleted_at
  ON document
  FOR EACH ROW EXECUTE FUNCTION search_feed_document();

-- ── 5. The census opens: two named doors, each three layers deep ─────
--
-- Layer 1 — THE POLICY. `portal_no_update` (a WITH CHECK deny with no
-- USING, 20260920233000 — and it stays a WITH CHECK here for the same
-- reason: a USING term would make every non-PENDING row of these tables
-- UNLOCKABLE by a contact, and `comment_denorm_guard` share-locks a
-- comment's subject, which may be a version or a deliverable) is
-- replaced by `portal_approval_update`: a contact's NEW row must be a
-- decision, made by the principal itself, dated. `portal_gate`'s own
-- WITH CHECK still binds the client, SHIPPED / CLIENT_VISIBLE and the
-- portal switch on the same NEW row, so the two policies AND into "a
-- decision, by you, on a row you may read".
--
-- What a policy cannot say is WHICH COLUMNS changed or WHAT THE ROW
-- WAS, which is why there are two triggers.
--
-- Layer 2 — `portal_contact_columns_only(...)`, the census-readable
-- half. A generic BEFORE UPDATE trigger function that takes the
-- permitted column names as its ARGUMENTS and refuses a contact
-- principal any change outside them, by comparing the OLD and NEW row
-- images with those keys removed. The arguments are the point:
-- `src/portal/census.dbtest.ts` reads them back from `pg_trigger`, so
-- the census stays a COMPUTED property of the database at column
-- granularity rather than a `"*"` with a comment saying "trust the
-- trigger". `updated_at` is on the list because the ORM stamps it on
-- every update; it is listed rather than exempted in the function so
-- the census prints what is true.
--
-- Layer 3 — `portal_approval_decision()`, the transition. A contact may
-- only turn PENDING into APPROVED or CHANGES_REQUESTED, must name
-- themself, must date it. "Exactly once per request" (PLAN Phase 3's
-- ship test) is this trigger's OLD-row check: a second decision on a
-- decided row finds no PENDING to answer. The service's `UPDATE … WHERE
-- approval_status = 'PENDING'` makes the same choice one layer up, so
-- in practice a double submit sees zero rows and this never fires; it
-- is here for the application that forgets.
--
-- Both functions read `app.principal` and do nothing for a member or
-- the system principal: staff write these columns through their own
-- services (request, re-request, the reset on a new version), under
-- `requireAccess`, and the CHECKs above bound them.

CREATE OR REPLACE FUNCTION portal_contact_columns_only() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  o    jsonb;
  n    jsonb;
  col  text;
BEGIN
  IF (SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact' THEN
    RETURN NEW;
  END IF;
  o := to_jsonb(OLD);
  n := to_jsonb(NEW);
  FOREACH col IN ARRAY TG_ARGV LOOP
    o := o - col;
    n := n - col;
  END LOOP;
  IF o <> n THEN
    RAISE EXCEPTION 'PORTAL_COLUMNS: a contact may update only % on %',
      array_to_string(TG_ARGV, ', '), TG_TABLE_NAME
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION portal_approval_decision() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF (SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact' THEN
    RETURN NEW;
  END IF;
  IF OLD.approval_status <> 'PENDING' THEN
    RAISE EXCEPTION 'PORTAL_APPROVAL: no sign-off was requested on this % row', TG_TABLE_NAME
      USING ERRCODE = '42501';
  END IF;
  IF NEW.approval_status NOT IN ('APPROVED', 'CHANGES_REQUESTED') THEN
    RAISE EXCEPTION 'PORTAL_APPROVAL: a contact may only approve or request changes'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.approval_by_contact_id IS DISTINCT FROM (SELECT current_setting('app.principal_id', true)) THEN
    RAISE EXCEPTION 'PORTAL_APPROVAL: a decision names the contact who made it'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.approval_decided_at IS NULL THEN
    RAISE EXCEPTION 'PORTAL_APPROVAL: a decision is dated'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$fn$;

-- project_version: SHIPPED and portal-enabled are `portal_gate`'s
-- WITH CHECK terms; the decision shape is this policy's.
DROP POLICY portal_no_update ON project_version;
CREATE POLICY portal_approval_update ON project_version
  AS RESTRICTIVE FOR UPDATE TO app_runtime
  WITH CHECK (
    (SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact'
    OR (
      approval_status IN ('APPROVED', 'CHANGES_REQUESTED')
      AND approval_by_contact_id = (SELECT current_setting('app.principal_id', true))
      AND approval_decided_at IS NOT NULL
    )
  );
CREATE TRIGGER project_version_portal_columns
  BEFORE UPDATE ON project_version
  FOR EACH ROW EXECUTE FUNCTION portal_contact_columns_only(
    'approval_status', 'approval_decided_at', 'approval_by_contact_id', 'approval_note', 'updated_at'
  );
CREATE TRIGGER project_version_portal_approval
  BEFORE UPDATE OF approval_status, approval_decided_at, approval_by_contact_id, approval_note
  ON project_version
  FOR EACH ROW EXECUTE FUNCTION portal_approval_decision();

-- document: the same, plus the two terms `portal_gate` does not carry
-- and a deliverable's decision needs — the kind, and the soft delete.
DROP POLICY portal_no_update ON document;
CREATE POLICY portal_approval_update ON document
  AS RESTRICTIVE FOR UPDATE TO app_runtime
  WITH CHECK (
    (SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact'
    OR (
      approval_status IN ('APPROVED', 'CHANGES_REQUESTED')
      AND approval_by_contact_id = (SELECT current_setting('app.principal_id', true))
      AND approval_decided_at IS NOT NULL
      AND kind = 'DELIVERABLE'
      AND deleted_at IS NULL
    )
  );
CREATE TRIGGER document_portal_columns
  BEFORE UPDATE ON document
  FOR EACH ROW EXECUTE FUNCTION portal_contact_columns_only(
    'approval_status', 'approval_decided_at', 'approval_by_contact_id', 'approval_note', 'updated_at'
  );
CREATE TRIGGER document_portal_approval
  BEFORE UPDATE OF approval_status, approval_decided_at, approval_by_contact_id, approval_note
  ON document
  FOR EACH ROW EXECUTE FUNCTION portal_approval_decision();

-- ── What this migration deliberately does NOT touch ─────────────────
--
-- NO GRANT: both tables' UPDATE grants are table-level (20260808191500,
-- 20260816180000), so the new columns are covered, and a column GRANT
-- cannot help here — every principal shares `app_runtime`, and members
-- must go on writing the other columns (20260920233000's correction).
--
-- NO `portal_no_insert` / `portal_no_delete` change: a contact still
-- creates and deletes nothing on either table.
--
-- NO `updated_at` trigger: the ORM stamps it, which is why the column
-- is on the permitted list rather than in a BEFORE trigger of its own.

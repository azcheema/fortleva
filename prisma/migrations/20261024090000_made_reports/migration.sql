-- ═══════════════════════════════════════════════════════════════════
-- Phase 7 slice 119 — THE MONTHLY REPORT FORTLEVA MAKES (founder decision
-- C95; docs/research/2026-10-15-slice-119-monthly-report-design.md §1).
--
-- A made report IS a client report (a `document` of kind REPORT, slice
-- 115) whose PDF Fortleva drew from what the client can already see in
-- their portal — read AS one of the client's own people through the
-- portal's projections. What is new is the RECORD of the making, one row
-- per made report:
--
--   `made_report` — class A (tenant_isolation + portal_deny): the language
--   the PDF was drawn in, the team's two texts (the summary and "Coming
--   next"), the projects ticked, every task and update the PDF names (ids
--   only — what the publish check share-locks), whose view it was read as,
--   the FINGERPRINT of what was drawn (sha256 over the canonical content)
--   and the drawing's template version. The client reads the PDF, never
--   this row.
--
-- WHAT THE DATABASE REFUSES, beyond RLS: a language other than sv / en; a
-- text over 2 000 characters; no project, or more than 25; more than 500
-- tasks or 60 updates (the drawing's ceiling — a report refuses rather than
-- trims); a fingerprint that is not 64 hex digits; a row on a document that
-- is not a live REPORT of the same tenant (`made_report_kind_guard`); and
-- any UPDATE of a row once written (`made_report_frozen`) — a made report
-- is the record of what was made; a different report is a different
-- document.
--
-- CONTACT WRITES: none. `portal_deny` closes the table to a contact
-- principal outright.
--
-- DDL only — no DML, no `neon-smoke.yml` dispatch owed. The table is new.
-- Left out of Prisma's generated diff, as every migration since they
-- appeared has: the drift it always reports (`document_tenant_id_tags_idx`,
-- `search_index`, the `work_item` index name) — hand-written objects Prisma
-- does not model.
-- ═══════════════════════════════════════════════════════════════════

-- CreateTable
CREATE TABLE "made_report" (
    "document_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "locale" VARCHAR(2) NOT NULL,
    "summary" TEXT,
    "coming_next" TEXT,
    "project_ids" TEXT[] NOT NULL,
    "task_ids" TEXT[] NOT NULL,
    "update_ids" TEXT[] NOT NULL,
    "as_contact_id" TEXT NOT NULL,
    "content_sha256" CHAR(64) NOT NULL,
    "template_version" SMALLINT NOT NULL,
    "made_at" TIMESTAMPTZ(6) NOT NULL,
    "made_by_member_id" TEXT,

    CONSTRAINT "made_report_pkey" PRIMARY KEY ("document_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "made_report_tenant_id_document_id_key" ON "made_report"("tenant_id", "document_id");

-- AddForeignKey
ALTER TABLE "made_report" ADD CONSTRAINT "made_report_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: with the document — the harness's teardown and the tenant
-- teardown hard-delete documents; the product soft-deletes, and the row
-- stays with the soft-deleted document as its versions do.
ALTER TABLE "made_report" ADD CONSTRAINT "made_report_tenant_id_document_id_fkey" FOREIGN KEY ("tenant_id", "document_id") REFERENCES "document"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── CHECKs — the row's own shape ────────────────────────────────────
ALTER TABLE made_report
  ADD CONSTRAINT made_report_locale
    CHECK (locale IN ('sv', 'en')),
  ADD CONSTRAINT made_report_summary_length
    CHECK (summary IS NULL OR char_length(summary) <= 2000),
  ADD CONSTRAINT made_report_coming_next_length
    CHECK (coming_next IS NULL OR char_length(coming_next) <= 2000),
  ADD CONSTRAINT made_report_projects_bounded
    CHECK (cardinality(project_ids) BETWEEN 1 AND 25),
  ADD CONSTRAINT made_report_tasks_bounded
    CHECK (cardinality(task_ids) <= 500),
  ADD CONSTRAINT made_report_updates_bounded
    CHECK (cardinality(update_ids) <= 60),
  ADD CONSTRAINT made_report_sha256_shape
    CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT made_report_template_version_positive
    CHECK (template_version >= 1);

-- ── The kind guard: a made report is a live REPORT of the same tenant ──
-- A CHECK cannot look at another table; this BEFORE INSERT trigger is the
-- belt for a writer that forgets. Nothing in the app changes a document's
-- kind after insert (slice 115's search feed relies on the same), and a
-- REPORT's shape is held by its CHECKs, so the insert's answer holds for
-- the row's life. Runs under the inserting principal (not SECURITY
-- DEFINER): `document` is readable to the member and the system principal,
-- and a contact never reaches this table. `search_path` pinned, as the
-- invoice guards pin theirs: an unqualified `document` must be public's.
--
-- THE TOKEN IS IN THE MESSAGE: Prisma's pg adapter forwards a trigger's
-- `CONSTRAINT =` for a foreign-key violation only, so the name a caller
-- classifies on (and a dbtest reads from the error's meta) is the message's
-- first word, as every other guard in this schema does it (the pre-apply
-- review's medium). The two tokens do not contain one another.
CREATE OR REPLACE FUNCTION made_report_kind_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM document d
    WHERE d.tenant_id = NEW.tenant_id
      AND d.id = NEW.document_id
      AND d.kind = 'REPORT'
      AND d.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'made_report_kind_guard: the document is not a live REPORT of this tenant'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER made_report_kind_guard
  BEFORE INSERT ON made_report
  FOR EACH ROW EXECUTE FUNCTION made_report_kind_guard();

-- ── Frozen: written once, never changed ─────────────────────────────
-- (Both FKs say ON UPDATE CASCADE, Prisma's default; a cascaded key change
-- would meet this trigger and be refused — ids never change, so it is
-- theory, said so a reader does not wonder.)
CREATE OR REPLACE FUNCTION made_report_frozen() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'made_report_frozen: a made report is never changed — make a new one'
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER made_report_frozen
  BEFORE UPDATE ON made_report
  FOR EACH ROW EXECUTE FUNCTION made_report_frozen();

-- ── Grants ──────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON made_report TO app_runtime;

-- ── RLS — class A (portal_deny; no visibility) ──────────────────────
ALTER TABLE made_report ENABLE ROW LEVEL SECURITY;
ALTER TABLE made_report FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON made_report
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (tenant_id = (SELECT current_setting('app.tenant_id', true)))
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true)));

CREATE POLICY portal_deny ON made_report
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');

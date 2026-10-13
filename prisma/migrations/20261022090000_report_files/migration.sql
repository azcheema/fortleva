-- ═══════════════════════════════════════════════════════════════════
-- Phase 6 slice 115 — CLIENT REPORT FILES (founder decision C91;
-- docs/research/2026-10-13-slice-115-report-files-design.md §2).
--
-- A client report is a `document` of kind REPORT — the kind the enum has
-- carried since Phase 2 for exactly this, and which nothing has written
-- until now (the upload's `UploadKind` refuses it) — so it reaches the
-- portal through `portal_gate` on `document`, unchanged: the same policy,
-- download broker, budget and audit as every shared file. Publishing is the
-- document's own visibility flip. DATA_MODEL §6.10's separate
-- `PerformanceReport` row for an uploaded report (a second visibility over
-- the same file) is NOT built; that table waits for the CrUX snapshots.
--
-- 1. Two columns on `document`:
--    - `report_month` — the month a report covers, as its first day;
--    - `report_published_at` — when it was last published to the client
--      (every move INTERNAL → CLIENT_VISIBLE; the portal shows it and the
--      clients' weekly summary counts a report as new by it).
--
-- 2. Five CHECKs hold a report's shape for every writer, the app's one
--    (`src/documents/reports.ts`) and the one that forgets:
--    - a month on, and only on, kind REPORT;
--    - the month a first day, within a sane range;
--    - a report is the CLIENT'S: a client, no project, no anchor (so
--      `portal_enabled` is TRUE by the stamp trigger's own rule, and no
--      project switch or task visibility enters into it);
--    - a publish stamp on a REPORT only;
--    - a REPORT the client can see carries its publish stamp.
--
-- 3. `search_feed_document()` re-created WORD FOR WORD from
--    20260927140000's body plus one term marked "slice 115": a REPORT is
--    treated as deleted — no `search_index` row. A document search hit
--    links to a Files tab, and reports are listed only on the client's
--    Reports tab (design §0). The kind never changes after insert, so the
--    insert's answer holds; the trigger itself is untouched.
--
-- A contact can write neither column: `document_portal_columns`
-- (`portal_contact_columns_only`) refuses every column a contact changes
-- outside its named list, which these are not on.
--
-- DDL only — no DML, no `neon-smoke.yml` dispatch owed. No row has kind
-- REPORT (nothing writes it — checked in code before applying), so every
-- CHECK validates against NULLs. No grant changes (the columns ride the
-- table's grants); RLS unchanged; the tenant export dumps both columns with
-- the row. Left out of Prisma's generated diff, as every migration since
-- they appeared has: the drift it always reports
-- (`document_tenant_id_tags_idx`, `search_index`, the `work_item` index
-- name) — hand-written objects Prisma does not model.
-- ═══════════════════════════════════════════════════════════════════

-- AlterTable
ALTER TABLE "document" ADD COLUMN "report_month" DATE,
ADD COLUMN "report_published_at" TIMESTAMPTZ(6);

-- ── A report's shape ────────────────────────────────────────────────

ALTER TABLE document
  ADD CONSTRAINT document_report_month_shape
  CHECK ((kind = 'REPORT') = (report_month IS NOT NULL));

ALTER TABLE document
  ADD CONSTRAINT document_report_month_first
  CHECK (
    report_month IS NULL
    OR (
      extract(day FROM report_month) = 1
      AND report_month >= DATE '2000-01-01'
      AND report_month < DATE '2100-01-01'
    )
  );

ALTER TABLE document
  ADD CONSTRAINT document_report_company_level
  CHECK (
    kind <> 'REPORT'
    OR (client_id IS NOT NULL AND project_id IS NULL AND attached_to_type IS NULL AND attached_to_id IS NULL)
  );

ALTER TABLE document
  ADD CONSTRAINT document_report_published_shape
  CHECK (report_published_at IS NULL OR kind = 'REPORT');

ALTER TABLE document
  ADD CONSTRAINT document_report_published_when_shared
  CHECK (kind <> 'REPORT' OR visibility = 'INTERNAL' OR report_published_at IS NOT NULL);

-- ── The document search feed, re-created (one "slice 115" term) ─────

CREATE OR REPLACE FUNCTION search_feed_document() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  -- A contact principal may not write `search_index` rows of any
  -- entity type but COMMENT (migration 20260921000000), and can change
  -- no column the index reads (`portal_contact_columns_only`), so there
  -- is nothing for the feed to do on its behalf.
  IF (SELECT current_setting('app.principal', true)) = 'contact' THEN
    RETURN NULL;
  END IF;
  -- slice 115: a client REPORT is never in the index (it is listed only
  -- on the client's Reports tab) — treated exactly as a deleted row.
  IF TG_OP = 'DELETE' OR NEW.deleted_at IS NOT NULL OR NEW.kind = 'REPORT' THEN
    DELETE FROM search_index
     WHERE tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id)
       AND entity_type = 'DOCUMENT'
       AND entity_id = COALESCE(NEW.id, OLD.id);
    RETURN NULL;
  END IF;
  PERFORM search_upsert(
    NEW.tenant_id, 'DOCUMENT', NEW.id, NEW.client_id, NEW.project_id,
    NEW.visibility, NEW.portal_enabled, NEW.name,
    NULL, NULL, array_to_string(NEW.tags, ' '), NULL, NULL);
  RETURN NULL;
END
$fn$;

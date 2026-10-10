-- ═══════════════════════════════════════════════════════════════════
-- Phase 4 slice 110b — THE TIME BREAKDOWN PAGE on an invoice's PDF
-- (founder decisions C80 (d), C81). DATA_MODEL.md §6.7; the design and its
-- review: docs/research/2026-10-10-slice-110b-hours-page-design.md.
--
-- An OPTIONAL page (a tick on the draft, off by default) listing each day's
-- billed hours and what they were for — the title of a task the client may
-- see, "Other work" for every other hour — and never who did the work, nor a
-- note (C81 (a)). FIXED AT ISSUE like the rest of the invoice.
--
-- 1. `invoice.include_hours` — the draft's tick; an INVOICE's only (CHECK).
--    Frozen at issue by `invoice_guard`'s frozen-row diff (not "mutable").
--
-- 2. `invoice.hours_page` — the page, WRITTEN BY THE DATABASE as the invoice
--    leaves DRAFT (4.), as the seller's and buyer's snapshots are: what a
--    client reads about tasks is decided here, not by application code
--    alone. NULL on a draft (CHECK); frozen after the issue (the diff).
--    `invoice` is class B (slice 109): a main contact's RLS reads the whole
--    sent row — the page is what their PDF prints, nothing more.
--
-- 3. `work_item_named_to_client()` — the SQL twin of `namedTaskShared`
--    (src/modules/time/reports.ts) as `sharedTasks` applies it
--    (src/modules/invoicing/hours-record.ts): CLIENT_VISIBLE, and — when
--    soft-deleted — its parent (if any) and its root (if not itself) still
--    CLIENT_VISIBLE; an ancestor that no longer exists counts as INTERNAL. A
--    dbtest holds the two equal over a matrix of real rows.
--    `invoice_hours_page()` — the page from the invoice's RECORD of the hours
--    it billed (`invoice_line_time_entry`: each hour as it was added — day,
--    task, billed seconds), never the live entries: rows of (day, task title
--    or NULL, seconds) per line, summed per day and printed text, zero-second
--    rows left out. ONE implementation: the guard at issue, and the draft's
--    preview and issue fingerprint (src/modules/invoicing/hours-page.ts) —
--    what the issuer saw is what is frozen.
--
-- 4. `invoice_billed_hours_guard` (its own trigger since slice 110, firing
--    BEFORE `invoice_guard` by name; its column list unchanged — every exit
--    from DRAFT names `status`) replaced: as the invoice leaves DRAFT it
--    writes `hours_page` — whatever the application sent is overwritten —
--    and refuses an issue that changes the tick (the pay link's precedent:
--    what the issuer saw, and the draft's audited edit, decide it).
--
-- DDL only — no DML, no `neon-smoke.yml` dispatch owed. The CHECKs validate
-- against every existing row's `false` / NULL.
-- ═══════════════════════════════════════════════════════════════════

-- AlterTable
ALTER TABLE "invoice" ADD COLUMN     "hours_page" JSONB,
ADD COLUMN     "include_hours" BOOLEAN NOT NULL DEFAULT false;


-- ── 1–2. The tick and the page ──────────────────────────────────────
ALTER TABLE invoice
  -- A credit note credits; the breakdown is its invoice's (C81).
  ADD CONSTRAINT invoice_include_hours_kind
    CHECK (NOT include_hours OR kind = 'INVOICE'),
  -- Written only as the invoice leaves DRAFT, and only with the tick.
  ADD CONSTRAINT invoice_hours_page_issued
    CHECK (hours_page IS NULL OR (include_hours AND status <> 'DRAFT'));


-- ── 3. The rule, and the page ───────────────────────────────────────
-- May a client see this task named? (`namedTaskShared`'s twin.) False for an
-- id that does not exist. Runs as its caller: a member's tenant isolation.
CREATE OR REPLACE FUNCTION work_item_named_to_client(p_tenant text, p_item text) RETURNS boolean
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT coalesce((
    SELECT w.visibility = 'CLIENT_VISIBLE'
           AND (w.deleted_at IS NULL
                OR (    (w.parent_id IS NULL
                         OR EXISTS (SELECT 1 FROM work_item par
                                     WHERE par.tenant_id = w.tenant_id AND par.id = w.parent_id
                                       AND par.visibility = 'CLIENT_VISIBLE'))
                    AND (w.root_id = w.id
                         OR EXISTS (SELECT 1 FROM work_item rt
                                     WHERE rt.tenant_id = w.tenant_id AND rt.id = w.root_id
                                       AND rt.visibility = 'CLIENT_VISIBLE'))))
      FROM work_item w
     WHERE w.tenant_id = p_tenant AND w.id = p_item), false)
$fn$;

-- The page, or NULL when the invoice records no hours:
--   {"version": 1, "lines": [{"lineId": …, "rows": [{"date": "YYYY-MM-DD",
--    "task": <title> | null, "seconds": <int>}, …]}, …]}
-- Lines in position order; rows by day, named tasks before "Other work", then
-- by title in byte order (deterministic: the fingerprint hashes this text).
CREATE OR REPLACE FUNCTION invoice_hours_page(p_tenant text, p_invoice text) RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $fn$
  WITH rec AS (
    SELECT h.invoice_line_id, h.client_id, h.work_item_id, h.local_date, h.billed_seconds
      FROM invoice_line_time_entry h
     WHERE h.tenant_id = p_tenant AND h.invoice_id = p_invoice
  ), named AS (
    -- Only a task OF THE INVOICE'S CLIENT is ever named (the design review's
    -- low: a database belt, not only `work_item_no_move` and the app), and
    -- the rule runs only on the tasks the record names (after the join). The
    -- title trimmed of spaces, tabs, line breaks, no-break and ideographic
    -- spaces, cut to 500 characters and trimmed again; nothing left is "Other
    -- work" (the migration review's nits).
    SELECT w.id,
           CASE WHEN work_item_named_to_client(p_tenant, w.id)
                THEN nullif(btrim(left(btrim(w.title, ' ' || chr(9) || chr(10) || chr(13) || chr(160) || chr(12288)), 500),
                                  ' ' || chr(9) || chr(10) || chr(13) || chr(160) || chr(12288)), '')
           END AS title
      FROM work_item w
      JOIN (SELECT DISTINCT rec.work_item_id, rec.client_id FROM rec WHERE rec.work_item_id IS NOT NULL) used
        ON used.work_item_id = w.id AND used.client_id = w.client_id
     WHERE w.tenant_id = p_tenant
  ), day_rows AS (
    SELECT rec.invoice_line_id, rec.local_date, named.title AS task, sum(rec.billed_seconds) AS seconds
      FROM rec
      LEFT JOIN named ON named.id = rec.work_item_id
     GROUP BY rec.invoice_line_id, rec.local_date, named.title
    HAVING sum(rec.billed_seconds) > 0
  ), page_lines AS (
    SELECT d.invoice_line_id, l.position,
           jsonb_agg(jsonb_build_object('date', to_char(d.local_date::timestamp, 'YYYY-MM-DD'), 'task', d.task, 'seconds', d.seconds)
                     ORDER BY d.local_date, d.task IS NULL, d.task COLLATE "C") AS rows
      FROM day_rows d
      JOIN invoice_line l ON l.tenant_id = p_tenant AND l.id = d.invoice_line_id
     GROUP BY d.invoice_line_id, l.position
  )
  SELECT CASE WHEN count(*) = 0 THEN NULL
              ELSE jsonb_build_object(
                     'version', 1,
                     'lines', jsonb_agg(jsonb_build_object('lineId', pl.invoice_line_id, 'rows', pl.rows)
                                        ORDER BY pl.position, pl.invoice_line_id))
         END
    FROM page_lines pl
$fn$;


-- ── 4. The invoice's hours guard, replaced ──────────────────────────
-- Everything slice 110 held is held unchanged; what is new is marked (110b).
CREATE OR REPLACE FUNCTION invoice_billed_hours_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  -- A draft holding tracked hours keeps their currency: its lines are priced
  -- in it (slice 110's review, M3).
  IF NEW.currency IS DISTINCT FROM OLD.currency
     AND EXISTS (SELECT 1 FROM invoice_line_time_entry h WHERE h.tenant_id = NEW.tenant_id AND h.invoice_id = NEW.id) THEN
    RAISE EXCEPTION 'INVOICE_HAS_HOURS: a draft holding tracked hours keeps their currency';
  END IF;
  IF OLD.status = 'DRAFT' AND NEW.status <> 'DRAFT' THEN
    -- Leaving DRAFT: every hour the invoice's record names is marked on that
    -- very line now. The reverse (every hour marked on its lines has a
    -- record) is the join rule's; a split's second half is the one mark
    -- without one.
    IF EXISTS (SELECT 1
                 FROM invoice_line_time_entry h
                 JOIN time_entry e ON e.tenant_id = h.tenant_id AND e.id = h.time_entry_id
                WHERE h.tenant_id = NEW.tenant_id AND h.invoice_id = NEW.id
                  AND e.invoice_line_id IS DISTINCT FROM h.invoice_line_id) THEN
      RAISE EXCEPTION 'INVOICE_HOURS_MISMATCH: the hours this invoice records are not all on it';
    END IF;
    -- (110b) The tick is the draft's: the issue itself never sets or clears it.
    IF NEW.include_hours IS DISTINCT FROM OLD.include_hours THEN
      RAISE EXCEPTION 'INVOICE_GUARD: the time breakdown is the draft''s, never set by the issue';
    END IF;
    -- (110b) The time breakdown, written here and nowhere else — from the
    -- record as it stands, task names by the rule as it stands now.
    NEW.hours_page := CASE WHEN NEW.include_hours THEN invoice_hours_page(NEW.tenant_id, NEW.id) END;
  END IF;
  RETURN NEW;
END
$fn$;

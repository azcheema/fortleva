-- ═══════════════════════════════════════════════════════════════════
-- Slice 124 — PROJECT TEMPLATES (founder decision C100;
-- docs/research/2026-10-16-slice-124-project-templates-design.md §7).
--
-- `project_template` has existed since 20260820170000 with its grants and
-- its class-A policies (`tenant_isolation` + `portal_deny`), and nothing has
-- ever written it. This slice is its first writer: "Save as template" on a
-- project, Settings → Templates (rename, delete), and New project from a
-- template. The services refuse every bad value first; these are the
-- database's own copies of the rules a later writer could forget.
--
--   · a name is one line of at most 80 characters with something in it;
--   · names are unique in a workspace IGNORING CASE — decided by Postgres's
--     `lower()`, which is the fold the service maps to TEMPLATE_NAME_TAKEN
--     (JavaScript's lower-casing differs on a final sigma or a dotted
--     capital I — slice 123's lesson), beside the schema's case-sensitive
--     `project_template_tenant_id_name_key`;
--   · `definition` is a JSON object, and at most 4 MiB in Postgres's own
--     text form. The SERVICE's cap is smaller — 3 MiB as `JSON.stringify`
--     writes it (`TEMPLATE_MAX_BYTES`) — because `jsonb` prints a space
--     after every `:` and `,` (for this document's shape at most about a
--     fifth longer): the service refuses first, with a sentence, and this is
--     the belt, so no writer can store a template that applying would have
--     to read whole into one transaction;
--   · `task_count` / `milestone_count`: the document's two list lengths,
--     written with it, so the New project form and Settings list templates
--     without reading a single document (the pre-apply review's NIT);
--   · `saved_at`: when the document was last written — made or replaced —
--     which a RENAME does not move (`updated_at` does);
--   · `source_project_id`: the project a template was last saved from —
--     attribution, NO foreign key (a project may be deleted; its template
--     stays, and Settings then shows the date alone).
--
-- CONTACT WRITES: none — class A (`portal_deny`), unchanged.
--
-- DDL only — no DML, no `neon-smoke.yml` dispatch owed. The guard refuses
-- to run against a database where an existing row already breaks a rule it
-- adds, so no CHECK or index is ever half-added. Left out of Prisma's
-- generated diff except the column (the drift it always reports is the
-- hand-written objects Prisma does not model; this adds an expression
-- UNIQUE and CHECKs, neither modelled).
-- ═══════════════════════════════════════════════════════════════════

-- ── The table lock, FIRST ───────────────────────────────────────────
-- The CHECKs below take ACCESS EXCLUSIVE; taken at once with a bounded wait
-- (the imports migration's lesson, 20261026090000), never upgraded from the
-- guard's read.
SET LOCAL lock_timeout = '10s';
LOCK TABLE project_template IN ACCESS EXCLUSIVE MODE;

-- ── Guards ──────────────────────────────────────────────────────────
-- `row_security = off` IS LOAD-BEARING (20260906150000's reasoning): the
-- table is FORCE ROW LEVEL SECURITY with policies `TO app_runtime`, so a
-- migrating role without BYPASSRLS would see NO rows and every guard would
-- pass having looked at nothing. Off, such a role FAILS the read.
SET LOCAL row_security = off;
DO $guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM project_template
    WHERE NOT (btrim(name) <> '' AND name = btrim(name) AND name !~ '[[:cntrl:]]' AND char_length(name) <= 80)
  ) THEN
    RAISE EXCEPTION 'slice 124: a project_template name is blank, multi-line or too long; fix it before this migration';
  END IF;
  IF EXISTS (
    SELECT 1 FROM project_template
    GROUP BY tenant_id, lower(name) HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'slice 124: a workspace has two project templates named alike; fix it before this migration';
  END IF;
  IF EXISTS (
    SELECT 1 FROM project_template
    WHERE jsonb_typeof(definition) IS DISTINCT FROM 'object'
       OR octet_length(definition::text) > 4194304
  ) THEN
    RAISE EXCEPTION 'slice 124: a project_template definition is not an object or is over 4 MB; fix it before this migration';
  END IF;
END
$guard$;

-- ── project_template ────────────────────────────────────────────────

-- One line, ≤ 80, not blank, no space at either end — the service's
-- `templateName` (it collapses any whitespace run to a space, trims, and
-- refuses a control character). `char_length` counts code points, as the
-- service does, and `btrim` strips less than JavaScript's `trim`, so this
-- can never refuse what the service accepted.
ALTER TABLE project_template
  ADD CONSTRAINT project_template_name_ok
  CHECK (btrim(name) <> '' AND name = btrim(name) AND name !~ '[[:cntrl:]]' AND char_length(name) <= 80);

-- Unique per workspace IGNORING CASE (the label and stage precedent,
-- 20260915180000 / 20261027090000). Mapped to TEMPLATE_NAME_TAKEN.
CREATE UNIQUE INDEX project_template_name_ci_key
  ON project_template (tenant_id, lower(name));

-- The shape INSIDE the object is the service's (parsed with zod on every
-- use and refused as TEMPLATE_INVALID when it fails), because a CHECK
-- cannot say "every task's stage is a key of the stage list".
ALTER TABLE project_template
  ADD CONSTRAINT project_template_definition_object
  CHECK (jsonb_typeof(definition) = 'object');

-- The size, in Postgres's text form, a CHECK of its own so the one mapped
-- to TEMPLATE_TOO_LARGE can never be mistaken for the shape (the review's
-- LOW): 4 MiB here, 3 MiB by `JSON.stringify` in the service (above).
ALTER TABLE project_template
  ADD CONSTRAINT project_template_definition_size
  CHECK (octet_length(definition::text) <= 4194304);

-- The counts, the saved moment and the source (above). The counts default
-- to 0 only for the guard's sake (the table has no rows); every writer sets
-- both from the document it writes, in the same statement.
ALTER TABLE project_template
  ADD COLUMN task_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN milestone_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN saved_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN source_project_id TEXT;

ALTER TABLE project_template
  ADD CONSTRAINT project_template_counts_range
  CHECK (task_count BETWEEN 0 AND 1000 AND milestone_count BETWEEN 0 AND 100);

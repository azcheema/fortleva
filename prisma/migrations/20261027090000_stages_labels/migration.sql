-- ═══════════════════════════════════════════════════════════════════
-- Slice 123 — THE WORKSPACE'S OWN STAGES AND LABELS (founder decision C99;
-- docs/research/2026-10-15-slice-123-stages-labels-design.md §8).
--
-- The stage editors (Settings → Stages for the workspace default, a
-- project's Stages page for its own) and the labels page are the first
-- writers of a state's name, a state's default mark and a label's name and
-- colour after creation. The services refuse every bad value first; these
-- are the database's own copies of the rules a later writer could forget.
--
--   `workflow_state`:
--     · a name is never blank (the seed-key migration, 20260901180000,
--       left an EMPTY name to "the state editor slice that will first let
--       anyone type one" — this is that slice);
--     · a name, once written, is never cleared: NULL means "still the
--       seeded default, shown in the viewer's language", so `SET name =
--       NULL` would turn a renamed stage back into a translated one (the
--       same migration: "the state editor, when it ships, must refuse to
--       clear a name") — now held here, not only by the write path;
--     · a name is one line of at most 40 characters, unique per project
--       ignoring case;
--     · at most ONE stage per project is where new tasks start
--       (`is_default`) — the triage Accept, the import and every create
--       read "the" default, and two would make that a coin toss — and it
--       is a Backlog or To do stage.
--   `label`: a name is never blank; a colour is one of the seven palette
--     TOKEN NAMES (never a hex literal — UI.md §10) or NULL.
--   `workflow_preset`: `states` is a JSON array (its first writer).
--
-- CONTACT WRITES: none — every table here is class A (`portal_deny`).
--
-- DDL only — no DML, no `neon-smoke.yml` dispatch owed. Each guard below
-- refuses to run against a database where an existing row already breaks
-- the rule it adds, so no CHECK or index is ever half-added. Left out of
-- Prisma's generated diff, as every migration since they appeared has (the
-- drift it always reports is the hand-written objects Prisma does not
-- model; this adds a partial UNIQUE, a trigger and CHECKs, none modelled).
-- ═══════════════════════════════════════════════════════════════════

-- ── The table locks, FIRST ──────────────────────────────────────────
-- The CHECKs below take ACCESS EXCLUSIVE on all three tables; taking a
-- weaker lock for the guard's read and upgrading later is the deadlock the
-- imports migration's pre-apply review found (20261026090000). So the
-- strongest level at once, with a bounded wait: the migration holds the
-- three small tables for its few milliseconds, or fails clean.
SET LOCAL lock_timeout = '10s';
LOCK TABLE workflow_state, label, workflow_preset IN ACCESS EXCLUSIVE MODE;

-- ── Guards ──────────────────────────────────────────────────────────
-- `row_security = off` IS LOAD-BEARING (20260906150000's reasoning): all
-- three tables are FORCE ROW LEVEL SECURITY with policies `TO app_runtime`,
-- so a migrating role without BYPASSRLS would see NO rows and every guard
-- would pass having looked at nothing. Off, such a role FAILS the read.
SET LOCAL row_security = off;
DO $guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM workflow_state
    WHERE name IS NOT NULL
      AND NOT (btrim(name) <> '' AND name !~ '[[:cntrl:]]' AND char_length(name) <= 40)
  ) THEN
    RAISE EXCEPTION 'slice 123: a workflow_state name is blank, multi-line or too long; fix it before this migration';
  END IF;
  IF EXISTS (
    SELECT 1 FROM workflow_state WHERE name IS NOT NULL
    GROUP BY tenant_id, project_id, lower(name) HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'slice 123: a project has two stages named alike; fix it before this migration';
  END IF;
  IF EXISTS (
    SELECT 1 FROM workflow_state WHERE is_default
    GROUP BY tenant_id, project_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'slice 123: a project has two default workflow states; fix it before this migration';
  END IF;
  IF EXISTS (SELECT 1 FROM workflow_state WHERE is_default AND category NOT IN ('BACKLOG', 'TODO')) THEN
    RAISE EXCEPTION 'slice 123: a default workflow state is not Backlog or To do; fix it before this migration';
  END IF;
  IF EXISTS (
    SELECT 1 FROM label
    WHERE NOT (btrim(name) <> '' AND name !~ '[[:cntrl:]]' AND char_length(name) <= 40)
  ) THEN
    RAISE EXCEPTION 'slice 123: a label name is blank, multi-line or too long; fix it before this migration';
  END IF;
  IF EXISTS (
    SELECT 1 FROM label
    WHERE color IS NOT NULL
      AND color NOT IN ('red', 'orange', 'olive', 'teal', 'blue', 'purple', 'pink')
  ) THEN
    RAISE EXCEPTION 'slice 123: a label has a colour outside the palette; fix it before this migration';
  END IF;
  IF EXISTS (SELECT 1 FROM workflow_preset WHERE jsonb_typeof(states) IS DISTINCT FROM 'array') THEN
    RAISE EXCEPTION 'slice 123: a workflow_preset is not an array; fix it before this migration';
  END IF;
END
$guard$;

-- ── workflow_state ──────────────────────────────────────────────────

-- A name is one line of at most 40 characters with something in it — the
-- services' `singleLineName` (it collapses any whitespace run to a space
-- and refuses a control character), held here as a belt. `char_length`
-- counts code points, never more than the services' count, so this can
-- never refuse what they accepted. And unique per project IGNORING CASE —
-- the label precedent (20260915180000: "any later writer of name would
-- have bypassed" a service check; the workspace default's copy is a
-- second writer), beside the schema's case-sensitive index.
ALTER TABLE workflow_state
  ADD CONSTRAINT workflow_state_name_not_blank
  CHECK (name IS NULL OR (btrim(name) <> '' AND name !~ '[[:cntrl:]]' AND char_length(name) <= 40));

CREATE UNIQUE INDEX workflow_state_name_ci_key
  ON workflow_state (tenant_id, project_id, lower(name))
  WHERE name IS NOT NULL;

-- One way: NULL → a name is the rename; a name → NULL is refused. A
-- belt — the stage services never write NULL — so its token is unmapped
-- in `db-errors.ts` and a raise surfaces as the bug it would be.
CREATE OR REPLACE FUNCTION workflow_state_name_one_way() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD.name IS NOT NULL AND NEW.name IS NULL THEN
    RAISE EXCEPTION 'WORKFLOW_STATE_NAME_ONE_WAY: a renamed stage cannot go back to its default name';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER workflow_state_name_one_way
  BEFORE UPDATE OF name ON workflow_state
  FOR EACH ROW EXECUTE FUNCTION workflow_state_name_one_way();

-- At most one "new tasks start here" per project. "Exactly one" stays the
-- services' (a project with no states yet has none, and the lazy seed
-- writes its whole set in one statement). Moving the mark clears the old
-- row before it sets the new one; the stage editors serialise on the
-- project's `work_states:` key, so this is the belt, mapped to a sentence.
CREATE UNIQUE INDEX workflow_state_one_default
  ON workflow_state (tenant_id, project_id)
  WHERE is_default;

-- ...and it is a Backlog or To do stage (design §3.4). Load-bearing, not
-- tidy: `createItem` and the import put a new task STRAIGHT into the
-- default state without the state machine, so a default on a Done stage
-- that needs approval would let anyone with `work_item:edit` create tasks
-- already done — past the approval gate, with no completion stamp — and a
-- Triage default would fail every create on the triage CHECK. `category`
-- is immutable (`workflow_state_category_immutable`), so a row CHECK is
-- sound for the life of the row (the migration review's MEDIUM).
ALTER TABLE workflow_state
  ADD CONSTRAINT workflow_state_default_kind
  CHECK (NOT is_default OR category IN ('BACKLOG', 'TODO'));

-- ── label ───────────────────────────────────────────────────────────

-- The stage name's rule (above): one line, ≤ 40, not blank. The import
-- folds a cell's newlines and tabs to spaces and drops other controls
-- before a label name reaches here (`import/rules.ts`).
ALTER TABLE label
  ADD CONSTRAINT label_name_not_blank
  CHECK (btrim(name) <> '' AND name !~ '[[:cntrl:]]' AND char_length(name) <= 40);

-- The palette's TOKEN NAMES (`src/lib/label-colors.ts` maps each to one
-- of the `--entity-*` identity hues, which globals.css anchors at 3:1
-- against every surface). A new colour is a migration and a token,
-- together, on purpose: a value the UI cannot render must not be storable.
ALTER TABLE label
  ADD CONSTRAINT label_color_token
  CHECK (color IS NULL OR color IN ('red', 'orange', 'olive', 'teal', 'blue', 'purple', 'pink'));

-- ── workflow_preset ─────────────────────────────────────────────────

-- The shape INSIDE the array is the service's (parsed with zod and
-- checked against the stage rules on every read, falling back to
-- Fortleva's built-in set), because a CHECK cannot say "the kinds in
-- order, one default of kind Backlog or To do".
ALTER TABLE workflow_preset
  ADD CONSTRAINT workflow_preset_states_is_array
  CHECK (jsonb_typeof(states) = 'array');

-- ── Stage names follow the VIEWER's language until renamed ──────────
-- (DATA_MODEL §6.14 amended 2026-09-01; founder decision 2026-08-31.)
--
-- The mechanism is a NULL name plus a durable `seed_key`:
--   name IS NULL      ⇒ still wearing its seeded default; the UI renders
--                       the seed key through i18n, in the viewer's locale
--   name IS NOT NULL  ⇒ plain TENANT TEXT, never translated again
-- Writing a name IS the rename. There is no boolean to fall out of sync
-- and no trigger to forget, which is why this shape was chosen over a
-- `name_is_default` flag. But be precise about "forever": it is the
-- WRITE PATH that enforces it, not the schema — `UPDATE … SET name =
-- NULL` puts a state back into translate-mode, and the slice's own test
-- uses exactly that to reset its fixture. The state editor, when it
-- ships, must refuse to clear a name (and to store a blank one).
--
-- SCOPE, stated plainly: this changes what a NEW project's board reads.
-- Existing projects gain the seed_key identity below but keep their
-- stored names, so they keep rendering the same words to every viewer
-- until someone opts them in. That flip discards names tenants typed,
-- so it is the founder's call and is NOT made here — see PLAN §0.
--
-- RETIRES AN OPERATIONAL INSTRUCTION. 20260831120000's header says its
-- two data statements are "idempotent and re-runnable (the heal … run
-- them once more after the deploy)". That stops being true here: its
-- INSERT writes a hard-coded 'In review'/'Granskning' NAME with no
-- seed_key, and it used to be stopped by the (tenant, project, name)
-- unique — which no longer sees it, because seeded names are NULL. A
-- re-run would mint a SECOND review column that neither unique catches.
-- If that heal is ever wanted again it must be gated on
--   NOT EXISTS (SELECT 1 FROM workflow_state s
--                WHERE s.tenant_id = … AND s.project_id = …
--                  AND s.seed_key = 'IN_REVIEW')
-- rather than on rank occupancy. PLAN §0 carries the same note.
--
-- No new table: the workflow_state grant is table-level, its RLS
-- policies apply to new columns as to every other, and class A
-- (portal_deny) is untouched — the same reasoning the 2W-R migration
-- (20260831120000) records for its own ADD COLUMN.

CREATE TYPE state_seed_key AS ENUM (
  'BACKLOG', 'TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE', 'CANCELLED', 'TRIAGE'
);

-- SEVEN keys against six categories, and the reason is narrow: the
-- IN_PROGRESS category carries TWO seeded defaults (In progress, then In
-- review — 2W-R). Every other category carries exactly one. This is
-- therefore not a copy of state_category and cannot be derived from it.
ALTER TABLE workflow_state
  ADD COLUMN seed_key state_seed_key;

-- The one-way door. Dropping NOT NULL cannot fail and rewrites nothing;
-- existing rows keep their values.
ALTER TABLE workflow_state
  ALTER COLUMN name DROP NOT NULL;

-- ── Backfill: identity only, nothing anyone can see ─────────────────
-- Gives every CANONICAL project's states their durable key. It does NOT
-- touch `name`, so no board changes on deploy and no tenant loses a name
-- it chose — including naxdor, whose stages were renamed to English by
-- hand on 2026-08-31 and must keep reading exactly that.
--
-- KEYED ON (category, rank-order), never on names. Name matching is the
-- wrong key and PLAN §0 ruled it out before this was written: naxdor's
-- hand-renamed English names are byte-identical to the English seed
-- table, so no name comparison can tell "untouched" from "deliberately
-- renamed to the same words". Rank order can, because it is positional —
-- the same reasoning 20260831120000 used to place the review column.
--
-- GUARDED to the canonical seven-state shape. The repo has projects that
-- violate it (portal-gate.dbtest.ts's single-state project; the orphaned
-- partial-state gate-* projects; and PLAN §0's standing correction
-- records a project that ended with THREE IN_PROGRESS states). A
-- positional key would mis-assign every one of them, so they are skipped
-- and left NULL — which is safe: a NULL seed_key with a non-NULL name is
-- simply tenant text, exactly what they render today.
--
-- WHAT THIS DELIBERATELY DOES NOT DO, and it is the founder's call, not
-- an oversight: it does not NULL any name, so existing projects gain the
-- identity but not yet the behaviour — their stages keep rendering their
-- stored text in every viewer's language. Flipping a project to
-- translate-until-renamed afterwards is one statement over this column
-- (`UPDATE workflow_state SET name = NULL WHERE seed_key IS NOT NULL
-- AND …`), and it is a decision about discarding names tenants typed,
-- which is why it is not made here. See PLAN §0.
WITH canonical AS (
  SELECT tenant_id, project_id
    FROM workflow_state
   GROUP BY tenant_id, project_id
  HAVING count(*) = 7
     AND count(*) FILTER (WHERE category = 'BACKLOG')     = 1
     AND count(*) FILTER (WHERE category = 'TODO')        = 1
     AND count(*) FILTER (WHERE category = 'IN_PROGRESS') = 2
     AND count(*) FILTER (WHERE category = 'DONE')        = 1
     AND count(*) FILTER (WHERE category = 'CANCELLED')   = 1
     AND count(*) FILTER (WHERE category = 'TRIAGE')      = 1
),
keyed AS (
  SELECT s.id,
         s.category,
         row_number() OVER (
           PARTITION BY s.tenant_id, s.project_id, s.category ORDER BY s.rank
         ) AS rn
    FROM workflow_state s
    JOIN canonical c
      ON c.tenant_id = s.tenant_id AND c.project_id = s.project_id
)
UPDATE workflow_state w
   SET seed_key = (
         CASE WHEN k.category = 'IN_PROGRESS' AND k.rn = 2
              THEN 'IN_REVIEW'
              ELSE k.category::text
         END
       )::state_seed_key
  FROM keyed k
 WHERE w.id = k.id;

-- One of each default per project. Two jobs: it states the invariant,
-- and it restores the race-safety that ensureProjectStates' createMany
-- used to get from the (tenant, project, name) unique — with seeded
-- names now NULL, NULLs no longer collide, so `skipDuplicates` needs a
-- non-NULL key to dedupe two concurrent lazy seeds. (The deterministic
-- rank unique would also catch them; this makes it explicit rather than
-- incidental.) NULL seed_key — a tenant-created state, or a skipped
-- non-canonical one — does not participate, so tenants may still create
-- as many states as they like. Created AFTER the backfill on purpose: if
-- the positional key ever produced a duplicate, this fails the migration
-- loudly instead of leaving a half-keyed project behind.
CREATE UNIQUE INDEX "workflow_state_tenant_id_project_id_seed_key_key"
  ON workflow_state (tenant_id, project_id, seed_key);

-- A state must be renderable. Dropping NOT NULL on `name` opens exactly
-- one bad row — (NULL, NULL) — which would render as an unnamed column
-- with no key to translate. The rule is: a tenant-created state carries
-- a name, a seeded one carries a key, and every row carries at least
-- one. Enforced here so the display helper's fallback is unreachable
-- rather than merely unlikely. (An EMPTY name is a different question —
-- it was insertable before this migration too, and belongs to the state
-- editor slice that will first let anyone type one.)
ALTER TABLE workflow_state
  ADD CONSTRAINT workflow_state_name_or_seed_key
  CHECK (name IS NOT NULL OR seed_key IS NOT NULL);

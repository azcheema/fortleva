-- ── 2W-R: Review stage + approval-gated Done (DATA_MODEL §6.14) ──────
-- Entering a requires_approval state needs work_item:approve ON TOP OF
-- work_item:edit — the gate lives in transitionState so every entry
-- point (backlog select, board drag, move picker, create-into-column,
-- future bulk) runs it. Reopening (leaving a gated state) stays free.
-- No new table: the workflow_state grant is table-level, its RLS
-- policies apply to the new column as to every other, and class A
-- (portal_deny) is untouched. Both data statements are idempotent and
-- re-runnable (the heal for a project first touched by pre-deploy code:
-- run them once more after the deploy).

ALTER TABLE workflow_state
  ADD COLUMN requires_approval boolean NOT NULL DEFAULT false;

-- Every existing DONE-category state becomes the gated column.
UPDATE workflow_state SET requires_approval = true WHERE category = 'DONE';

-- One Review state per project that already has (lazily-seeded) states.
-- Rank: appending 'V' (the fractional-indexing digit-alphabet midpoint)
-- to the project's LAST IN_PROGRESS rank yields a key strictly between
-- it and its successor under COLLATE "C" — generateKeyBetween('a2','a3')
-- is exactly 'a2V', and every project today carries untouched seeded
-- ranks (no state editor exists). Computed from the actual rank, not an
-- assumed one. Locale: the same en/sv branch ensureProjectStates uses;
-- the name is tenant text thereafter. The NOT EXISTS belt refuses to
-- mint a key past a row already occupying (rank, rank||'V']; ON
-- CONFLICT covers the (name) and (rank) uniques — such a project is
-- left as-is rather than half-migrated.
INSERT INTO workflow_state
  (id, tenant_id, project_id, name, category, rank,
   is_default, is_hidden, requires_approval, created_at, updated_at)
SELECT
  gen_random_uuid()::text,
  ip.tenant_id,
  ip.project_id,
  CASE WHEN t.default_locale = 'sv' THEN 'Granskning' ELSE 'In review' END,
  'IN_PROGRESS'::state_category,
  ip.rank || 'V',
  false,
  false,
  false,
  now(),
  now()
FROM (
  SELECT DISTINCT ON (tenant_id, project_id) tenant_id, project_id, rank
    FROM workflow_state
   WHERE category = 'IN_PROGRESS'
   ORDER BY tenant_id, project_id, rank DESC
) ip
JOIN tenant t ON t.id = ip.tenant_id
WHERE NOT EXISTS (
  SELECT 1 FROM workflow_state s
   WHERE s.tenant_id = ip.tenant_id AND s.project_id = ip.project_id
     AND s.rank > ip.rank AND s.rank <= ip.rank || 'V'
)
ON CONFLICT DO NOTHING;

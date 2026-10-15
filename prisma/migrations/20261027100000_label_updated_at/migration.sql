-- ═══════════════════════════════════════════════════════════════════
-- Slice 123 (founder decision C99 (b)), part 2 — `label.updated_at`.
--
-- The labels page renames and recolours a label, and a colleague's open
-- board must see it: the board's freshness token (`projectWorkVersion`,
-- `src/modules/work/items.ts`) said since 2026-09-16 that "the settings
-- surface that adds [a rename] must add `label.updated_at` here too". A
-- rename touches no task and no `work_item_label` row, so nothing the token
-- read could move.
--
-- A plain column with a default — existing rows read as "changed now",
-- which costs one extra board refresh after deploy and nothing else. Prisma
-- stamps it on every update (`@updatedAt`). Class A as the table is; no
-- policy, grant or trigger changes.
--
-- A separate migration from 20261027090000 only because that one was
-- already applied to dev when this was found (an applied migration is never
-- edited — its checksum).
--
-- DDL only — no DML, no `neon-smoke.yml` dispatch owed. Adding a column with
-- a constant default does not rewrite the table (Postgres 11+).
-- ═══════════════════════════════════════════════════════════════════

SET LOCAL lock_timeout = '10s';

ALTER TABLE label
  ADD COLUMN updated_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

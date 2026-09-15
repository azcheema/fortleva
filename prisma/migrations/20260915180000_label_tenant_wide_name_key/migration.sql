-- Tenant-wide label names are unique case-insensitively, and the DATABASE
-- decides (the L-key slice, 2026-09-15). The schema's unique index is
-- (tenant_id, project_id, name) — and a NULL project_id is DISTINCT to a
-- unique index, so two tenant-wide labels named alike were both accepted,
-- which is why DATA_MODEL §6.14 said "app also checks". The first cut of
-- the label service checked under a tenant-wide advisory lock; the review
-- showed that lock is held to COMMIT across the create's audit and join
-- writes, serialising every creator in the tenant behind the slowest one
-- while each waits holding FOR SHARE on its own task — and that any later
-- writer of `name` (a rename, an import) would bypass the check entirely.
-- A partial unique expression index has neither problem: no lock, no
-- probe round trip, every writer covered. `dbErrorMapper` maps the
-- index's name to LABEL_TAKEN (src/modules/work/db-errors.ts), as it maps
-- `work_type_name_live` — the Neon spike (2026-08-20) proved partial
-- uniques hold under FORCE RLS for app_runtime under a concurrent race.
-- Project-scoped names stay with the schema's composite index (case-
-- sensitive; nothing creates one yet). DDL only, no DML: no smoke run owed.
CREATE UNIQUE INDEX label_tenant_wide_name_key ON label (tenant_id, lower(name))
  WHERE project_id IS NULL;

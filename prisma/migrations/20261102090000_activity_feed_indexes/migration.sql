-- Slice 133 (founder decision C110): the Activity page reads a workspace's
-- work events BY TIME — a window of days, newest first, and "the newest
-- event before this window" to find the next one back. On these three
-- tables every existing index leads with a work item, a subject, a client
-- or a project after the tenant, so a read across the workspace by
-- `created_at` had only the tenant prefix to use.
--
-- NOT `CONCURRENTLY`: Prisma runs each migration in a transaction, where
-- Postgres forbids it (20260920190000 says the same). A plain CREATE INDEX
-- holds SHARE on its table for the build — harmless at today's sizes; a
-- deploy-window consideration once these tables are large.
--
-- Names are Prisma's defaults for the matching `@@index` in schema.prisma,
-- so the model and the database do not drift. DDL only, no DML: no
-- neon-smoke run owed.
CREATE INDEX "work_item_activity_tenant_id_created_at_idx"
  ON "work_item_activity"("tenant_id", "created_at");

CREATE INDEX "document_tenant_id_created_at_idx"
  ON "document"("tenant_id", "created_at");

CREATE INDEX "comment_tenant_id_created_at_idx"
  ON "comment"("tenant_id", "created_at");

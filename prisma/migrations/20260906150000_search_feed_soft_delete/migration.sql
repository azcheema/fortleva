-- ── search_feed_document: leave the index on a SOFT delete ──────────
--
-- THE DEFECT. `search_feed_document` branched on `TG_OP = 'DELETE'`
-- alone, while its two siblings branch on
-- `TG_OP = 'DELETE' OR NEW.deleted_at IS NOT NULL`
-- (search_feed_work_item, search_feed_comment — 20260820170000
-- migration.sql:1216 and :1242). But a document is ONLY EVER soft
-- deleted: `softDeleteDocument` (src/documents/service.ts) is the sole
-- delete path in the application and it writes `deleted_at`. So the
-- delete reached this trigger as an UPDATE, the upsert branch ran, and
-- the index row SURVIVED.
--
-- WHY IT MATTERS MORE THAN A STALE ROW. `search_upsert` refreshes
-- `updated_at = now()`, so deleting a document did not merely leave it
-- searchable — it made it the MOST RECENT hit. On a CLIENT_VISIBLE
-- document of a portal-enabled project the row satisfies `portal_gate`
-- in full, so the first thing a contact would have found is a file
-- their agency had just deleted. Unreachable today only because nothing
-- queries `search_index` yet; live the moment /search ships, which is
-- why it is repaired before the reader is written rather than after.
--
-- The condition is copied verbatim from the work_item feed rather than
-- reinvented, so the three feeds now read identically at the branch and
-- a future reader can see at a glance that they agree.

CREATE OR REPLACE FUNCTION search_feed_document() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.deleted_at IS NOT NULL THEN
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

-- ── DML: evict the rows the old trigger left behind ─────────────────
-- Every document soft-deleted before this migration still has its index
-- row. The trigger fix only stops NEW ones accumulating; these have to
-- be swept explicitly, or the leak survives the repair.
--
-- `row_security = off` IS LOAD-BEARING, and OWNERSHIP IS NOT THE REASON
-- these statements reach the rows. `search_index` is FORCE ROW LEVEL
-- SECURITY, which subjects the owner to its policies too, and both
-- policies are `TO app_runtime` — so a migration role that is not
-- app_runtime matches no permissive policy, every row is filtered, and
-- the DELETE reports success having removed NOTHING. TENANCY.md §11
-- (the role table) records `app_migrate` as exactly that: "owner;
-- subject to FORCE RLS on DML". In practice the Neon-created role
-- carries BYPASSRLS and the sweep works — but a migration whose whole
-- purpose is evicting rows must not rest on an assumption its own docs
-- contradict, and a filtered sweep is indistinguishable afterwards from
-- a successful one.
--
-- With row_security off, Postgres raises `query would be affected by
-- row-level security policy` instead of quietly filtering: for a
-- BYPASSRLS role this is a no-op, and for any other it turns a silent
-- no-op into a failed migration. That is the outcome worth having.
--
-- SET LOCAL, so it lasts only for this migration's transaction.
SET LOCAL row_security = off;

DELETE FROM search_index si
 WHERE si.entity_type = 'DOCUMENT'
   AND EXISTS (
     SELECT 1 FROM document d
      WHERE d.tenant_id = si.tenant_id
        AND d.id = si.entity_id
        AND d.deleted_at IS NOT NULL
   );

-- And the mirror of it: an index row whose document does not exist at
-- all. `search_index` has NO foreign key (by design — it is fed by
-- triggers, not by cascade), so nothing else would ever remove one.
--
-- No retention job hard-deletes documents today — `src/jobs/` holds
-- only the upload expiry, the outbox, the time sweep and the weekly
-- reminder, and the schema's "soft delete (30 d), then hard delete" is
-- a plan rather than code. What DOES hard-delete through the platform
-- client is test cleanup and `e2e/fixtures/seed-cli.ts`. So this is a
-- belt against rows the trigger feed can no longer account for, not a
-- sweep after a job that exists.
--
-- It deletes on the ABSENCE of evidence, which is the weaker of the two
-- forms — under a filtered read of `document` its NOT EXISTS would be
-- true for every row. That is precisely what the `row_security = off`
-- above converts from a silent catastrophe into a raised error.
DELETE FROM search_index si
 WHERE si.entity_type = 'DOCUMENT'
   AND NOT EXISTS (
     SELECT 1 FROM document d
      WHERE d.tenant_id = si.tenant_id AND d.id = si.entity_id
   );

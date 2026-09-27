-- ── The document search feed keeps its recency bump, and stops firing
--    for a contact by RULE rather than by column list ──────────────────
--
-- Phase 3 slice 70's fix pass (the security review's third note).
-- `20260927120000` narrowed `search_feed_document` to the columns
-- `search_upsert` is handed, so that a contact's approval UPDATE — which
-- changes none of them — would not fire a feed the census forbids a
-- contact (`portal_comment_rows_only_update` pins `search_index` to
-- `entity_type = 'COMMENT'` under a contact principal). The list was
-- exact for CONTENT and wrong for RECENCY: `addVersion` bumps only
-- `updated_at`, which used to fire the feed and refresh
-- `search_index.updated_at` — the ranking tiebreaker (`src/search/
-- rebuild.ts`) — so after the narrowing a new version of a document no
-- longer moved it up among equal-rank hits.
--
-- THE FIX IS TO SAY THE ACTUAL RULE. The feed must not run for a contact
-- principal — not because a contact never touches the fed columns (the
-- column trigger already guarantees that) but because the feed's target
-- table refuses them. So the function returns early under a contact
-- principal, and the trigger fires on every INSERT, DELETE and on any
-- UPDATE that can change what the index holds or how fresh it is:
-- the fed columns, plus `updated_at`. A member's `addVersion` bumps
-- `updated_at` and refreshes the row's recency as before; a contact's
-- decision, which Prisma stamps `updated_at` on too, fires the trigger
-- and is answered with RETURN NULL before any write.
--
-- Written as a rule inside the function rather than a WHEN clause on the
-- trigger, so a future column added to `search_upsert`'s argument list
-- has one place to be added and the contact guard cannot be forgotten
-- alongside it.
--
-- DDL only, no DML — no `neon-smoke.yml` dispatch is owed.

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

DROP TRIGGER search_feed_document ON document;
CREATE TRIGGER search_feed_document
  AFTER INSERT OR DELETE OR UPDATE OF name, tags, visibility, portal_enabled, client_id, project_id, deleted_at, updated_at
  ON document
  FOR EACH ROW EXECUTE FUNCTION search_feed_document();

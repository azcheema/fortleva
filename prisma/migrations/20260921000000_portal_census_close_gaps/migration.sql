-- THE CENSUS CLOSES THE THREE ENTRIES IT HAD MERELY MEASURED.
--
-- Migrations `20260920230000` + `20260920233000` closed every class-B
-- table and then PINNED what remained. Two fresh reviews (code +
-- security, 2026-09-20) independently landed on the same objection, and
-- it is the right one: the pinned remainder was justified with reasons
-- that do not survive checking, on the very standard the first
-- migration set for itself — *"none of it was reachable… that is
-- exactly why it had to be closed"*. Measuring a hole and writing it
-- down is not closing it.
--
-- ── 1. `search_index`: DELETE was never needed, and INSERT/UPDATE were
--       wider than the one path that needs them ────────────────────
--
-- The header of `20260920230000` said narrowing this table "would break
-- that path". True for INSERT and UPDATE — `search_upsert` is
-- `INSERT … ON CONFLICT DO UPDATE`, so the comment feed needs both.
-- FALSE for DELETE: `search_feed_comment`'s delete branch runs only on
-- `TG_OP = 'DELETE' OR NEW.deleted_at IS NOT NULL` on `comment`, and a
-- contact can do neither (`comment` has carried `portal_no_update` and
-- `portal_no_delete` since 2W). So DELETE was free to close and was
-- left open for no reason.
--
-- What it cost: `portal_gate` on `search_index` binds client, visibility
-- and portal_enabled, and NOTHING else — not `entity_type`, not
-- `entity_id`, not `title`/`body_text`. A contact-principal transaction
-- could therefore `DELETE FROM search_index WHERE client_id = <own>` and
-- silently empty the TENANT'S OWN STAFF SEARCH of every client-visible
-- project, document, work item and comment; or plant rows of any
-- `entity_type` (the `project_id IS NULL` branch needs no project at
-- all); or rewrite the `title`/`body_text` of its client's rows, which
-- members read.
--
-- Closed by: an outright DELETE deny, and an INSERT/UPDATE narrowing to
-- `entity_type = 'COMMENT'` — the only entity a contact-caused trigger
-- ever feeds. `search_upsert` is `LANGUAGE sql` with invoker rights, so
-- the WITH CHECK applies to it and the narrowing is exactly the width of
-- the path. Written as a SEPARATE restrictive policy rather than by
-- rewriting `portal_gate`, so the read gate keeps one shape across the
-- schema and this file's additions are all visible under one name
-- prefix.
--
-- ── 2. `audit_event`: a contact could forge a MEMBER'S audit row ───
--
-- `audit_tenant_insert` is `WITH CHECK (tenant_id = app.tenant_id)` and
-- nothing else; `audit_portal_select_deny` is `FOR SELECT` only; and
-- `audit_event_immutable` makes every row permanent. A contact-principal
-- transaction could therefore append rows carrying `actor_type =
-- 'MEMBER'`, any `actor_id`, any `action` string (the catalog is a
-- TypeScript check, not a constraint) and `visibility = 'TENANT'` —
-- landing in the tenant's own audit log as a staff action, unreadable
-- back by its author and unremovable by anyone. Write-only evidence
-- poisoning rather than a leak, in the one table SECURITY.md §7 treats
-- as evidentiary.
--
-- Closed without touching the other two planes: when — and only when —
-- `app.principal` is `contact`, an insert must describe the contact
-- itself. That is exactly what `audit.record()` already produces under a
-- contact principal (`src/audit/record.ts` derives `actorType` from the
-- ALS principal and `actorId` from `principal.id`), so the legitimate
-- future path is permitted verbatim and nothing else is. `visibility` is
-- pinned to TENANT because a PLATFORM-visibility row from tenant context
-- is a catalog misuse the application already refuses.
--
-- ── 3. `comment` gives up the last `USING`-shaped deny ────────────
--
-- `20260920233000` left `comment`'s pre-existing `portal_no_update`
-- alone, on the grounds that no contact-caused path locks a comment
-- row. That is true today and both reviewers verified it independently
-- (`comment_denorm_guard`'s parent read is a plain SELECT; the
-- `parent_id` FK lock is an RI check, which bypasses RLS). But it leaves
-- the dangerous shape on the ONE table a contact actually writes, and
-- the previous migration's own argument was that "which tables does a
-- contact path lock?" is a list that grows and a per-table rule is one
-- that will be got wrong. The first reply guard that reads its parent
-- under contention would reproduce `COMMENT_SUBJECT_GONE` on the one
-- permitted contact write. One DROP and one CREATE removes the
-- exception; the deny is identical in effect.
--
-- DDL only, no DML — no `neon-smoke.yml` dispatch owed.

-- ── 1. search_index ────────────────────────────────────────────────
CREATE POLICY portal_no_delete ON search_index
  AS RESTRICTIVE FOR DELETE TO app_runtime
  USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');

-- INSERT and UPDATE stay possible for a contact, because the comment
-- feed trigger runs under the contact's own principal — but only for the
-- entity that trigger writes.
CREATE POLICY portal_comment_rows_only ON search_index
  AS RESTRICTIVE FOR INSERT TO app_runtime
  WITH CHECK (
    (SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact'
    OR entity_type = 'COMMENT'
  );

CREATE POLICY portal_comment_rows_only_update ON search_index
  AS RESTRICTIVE FOR UPDATE TO app_runtime
  WITH CHECK (
    (SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact'
    OR entity_type = 'COMMENT'
  );

-- ── 2. audit_event ─────────────────────────────────────────────────
CREATE POLICY portal_audit_insert ON audit_event
  AS RESTRICTIVE FOR INSERT TO app_runtime
  WITH CHECK (
    (SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact'
    OR (
      actor_type = 'CONTACT'
      AND actor_id = (SELECT current_setting('app.principal_id', true))
      AND visibility = 'TENANT'
    )
  );

-- ── 3. comment ─────────────────────────────────────────────────────
DROP POLICY portal_no_update ON comment;
CREATE POLICY portal_no_update ON comment
  AS RESTRICTIVE FOR UPDATE TO app_runtime
  WITH CHECK ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');

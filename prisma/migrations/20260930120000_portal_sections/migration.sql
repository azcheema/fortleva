-- ── The per-section switches on a project's portal ─────────────────
--
-- Founder decision C47 (2026-09-29), with the home-page answer of
-- 2026-09-30: an agency may hide four parts of a project from the
-- client's portal — Tasks, Updates, Milestones and Files — and a hidden
-- part leaves the project's one-screen page and the project's card on
-- the client's home. Hours already has its own column
-- (`hours_sharing_mode`) and is not one of these.
--
-- THESE ARE LAYOUT, NOT ACCESS CONTROL, and that is the decision rather
-- than a shortcut (C47b: "just the section", against the "gone
-- everywhere" recommendation). Whatever the agency has shared stays
-- reachable: a task page from "Waiting on you" or "Your agency replied",
-- a file from the client's Files page, a post from the all-updates page,
-- an ask to approve from the home. Taking something away from a client
-- remains what it has always been — making it INTERNAL — and every row a
-- switch touches is already CLIENT_VISIBLE, so nothing internal can
-- reach a client through one.
--
-- SO: NO POLICY, NO STAMP, NO TRIGGER. `portal_gate` is untouched,
-- nothing fans these out to a child row the way `portal_enabled` is, and
-- no child row carries a copy. The portal's projections read them off
-- the PROJECT row under the contact principal — as a relation filter or
-- a selected column — which `project`'s own `portal_gate` already admits
-- for exactly the projects a contact may see. No column grant is needed:
-- `project` is granted to `app_runtime` table-wide.
--
-- NOT NULL DEFAULT true, so every project that exists keeps showing
-- everything it showed yesterday, and a project created tomorrow starts
-- the same way. Adding a column with a constant default is a catalogue-
-- only change on Postgres 11+ (no table rewrite) and takes a brief
-- ACCESS EXCLUSIVE lock on `project`, released at commit.
--
-- `search_feed_project` fires on every UPDATE of `project` and re-upserts
-- the project's own search row from columns this migration does not
-- touch; a switch press therefore re-writes that one row with the same
-- text and refreshes its `updated_at` — which breaks ties among equal-
-- rank search hits — exactly as any other project edit does.
--
-- Written only by `setPortalSection` (src/projects/service.ts), under
-- `project:manage_portal`, audited `project.portal_section_changed`.
--
-- DDL only, no DML: no `neon-smoke.yml` dispatch is owed before it.
ALTER TABLE "project"
  ADD COLUMN "portal_show_tasks"      BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "portal_show_updates"    BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "portal_show_milestones" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "portal_show_files"      BOOLEAN NOT NULL DEFAULT true;

-- ═══════════════════════════════════════════════════════════════════
-- Phase 5 slice 104 — INBOX POLISH: WHY A NOTIFICATION REACHED YOU
-- (PLAN Phase 5 "Inbox polish … reason chip"; founder decision C72 (d);
-- DATA_MODEL.md §6.18).
--
-- WHAT IT ADDS. `notification.reason` — why this notification reached its
-- receiver ("Assigned to you", "Your project", …), written by
-- `notify.emit` (src/notify/emit.ts) from now on. NULL for every row before
-- this migration (C72 (d): only notifications from now on get the tag) — and
-- ALWAYS NULL on a client contact's row: the CHECK below allows a reason on a
-- MEMBER row only (the migration review's nit — a database fact, not just a
-- habit of `emit`'s; a contact inbox that wants reasons widens it).
--
-- A CLOSED SET, held here too (`src/notify/reasons.ts` holds it in code): a
-- reason a newer build adds — mentions, when they arrive (C44) — comes with
-- a migration that widens the CHECK, so a row can never carry a word the
-- inbox does not know how to say.
--
-- WHO MAY WRITE IT. Nothing new is granted, on purpose:
--   * `app_runtime` holds table-level INSERT on `notification` since the
--     phase-2W migration, which covers the new column — `emit` writes it in
--     the row's one INSERT;
--   * `app_runtime`'s UPDATE is column-level (`read_at, archived_at,
--     snoozed_till`) and does NOT grow: once written, the reason cannot be
--     changed by the runtime role — it is a fact about why the row was sent
--     (`app_platform`, BYPASSRLS with table-level DML, could; nothing of ours
--     does — the retention job's archive runs as `app_runtime`, and its
--     platform half only deletes);
--   * a contact principal inserts nothing here (`portal_insert_deny`).
--
-- DDL only: no backfill (C72 (d)), no data touched — `neon-smoke` is not
-- owed by this migration. The unread badge's partial index the PLAN line
-- also names already exists (`notification_unread`, phase 2W).
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE notification ADD COLUMN reason TEXT;

ALTER TABLE notification
  ADD CONSTRAINT notification_reason_known CHECK (
    reason IS NULL OR (receiver_type = 'MEMBER' AND reason IN (
      'ASSIGNEE',
      'REQUESTER',
      'PROJECT_LEAD',
      'PROJECT_MEMBER',
      'CLIENT_MEMBER',
      'BUDGET_WATCHER',
      'VAULT_ACCESS',
      'OWNER'
    ))
  );

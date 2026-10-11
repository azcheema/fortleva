-- ═══════════════════════════════════════════════════════════════════
-- Phase 4 slice 112c2 — A SIGNED CONTRACT'S END IN THE RENEWAL
-- REMINDERS (founder decision C86 (c)). The design's §15
-- (docs/research/2026-10-10-slice-112-contracts-design.md).
--
-- WHAT CHANGES. `expiration_reminder_sent` records one row per renewal
-- reminder that went out (slice 89): its subject, the day it was about
-- and the band. A signed contract's end is its fourth subject, beside an
-- asset, an agreement and a login. The subject-type CHECK is widened by
-- name — the widening slice 89's migration named in advance ("a new
-- subject (the `Contract` of a later phase) widens
-- `expiration_reminder_sent_subject_type` by name").
--
-- `subject_id` names a `contract` row, with no foreign key, as for the
-- other three: the job's own sweep removes a row once its day has passed,
-- and a contract deleted (one put in and deleted, slice 112c) leaves its
-- rows to that sweep. The table's key, grants and RLS (class A:
-- tenant_isolation + portal_deny) are unchanged.
--
-- A plain DROP + ADD in the migration's one transaction: the new set
-- contains the old, so every existing row satisfies it.
--
-- DDL only, no DML — no `neon-smoke.yml` dispatch owed.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE expiration_reminder_sent DROP CONSTRAINT expiration_reminder_sent_subject_type;
ALTER TABLE expiration_reminder_sent
  ADD CONSTRAINT expiration_reminder_sent_subject_type
    CHECK (subject_type IN ('ClientAsset', 'Service', 'CredentialItem', 'Contract'));

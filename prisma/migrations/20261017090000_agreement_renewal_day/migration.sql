-- ═══════════════════════════════════════════════════════════════════
-- Phase 4 slice 113 — AN AGREEMENT'S RENEWAL DATE MOVES ON BY ITSELF
-- (founder decision C88, 2026-10-12, stated with its second round).
-- DATA_MODEL.md §6.6; the design:
-- docs/research/2026-10-12-slice-113-renewal-invoices-design.md §2.
--
-- Until now nothing moved `service.renews_at`: a monthly agreement left
-- Renewals after its first date and never came back. A daily job
-- (`src/jobs/agreement-renewals.ts` → `src/services/renewals.ts`) now moves
-- a running recurring agreement's PASSED renewal date to the next renewal,
-- in whole intervals on its ANCHOR day — so an agreement renewing on the
-- 31st renews on 28 February and on 31 March again.
--
-- 1. `service.renewal_day smallint NULL` — the anchor day. NULL means "the
--    day of `renews_at`", which is what every existing row means: NO
--    BACKFILL. The job writes it as it moves a date on; a person setting the
--    date resets it to NULL (their day is the new anchor). Internal: on the
--    portal tripwire's never-selected list (`service` is class B). The
--    table's grants are table-level, so it is covered.
-- 2. CHECK `service_renewal_day_range`: 1–31 or NULL. No other CHECK's name
--    contains it, nor it another's.
--
-- DDL only, no DML — no `neon-smoke.yml` dispatch owed. The CHECK validates
-- every existing row: the column is new and NULL.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE service ADD COLUMN renewal_day SMALLINT;

ALTER TABLE service
  ADD CONSTRAINT service_renewal_day_range CHECK (renewal_day IS NULL OR renewal_day BETWEEN 1 AND 31);

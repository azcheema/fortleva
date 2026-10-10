-- ═══════════════════════════════════════════════════════════════════
-- Phase 4 slice 111b — THE CASH METHOD'S YEAR END (founder decision C83,
-- on C82 (e)), part 1 of 2: the four events' names, ALONE.
--
-- Postgres refuses a new enum value inside the transaction that added it
-- ("unsafe use of new value"), and part 2 (`20261011090100_invoice_year_end`)
-- uses them in an index predicate and a CHECK — so they are added here, in
-- a migration of their own (`20260816180000_phase2_core_domain`'s precedent:
-- values added, used only later).
--
--   YEAR_END                  an invoice unpaid on the financial year's last
--                             day E, booked as a receivable on E
--   YEAR_END_REVERSED         that booking negated on E + 1
--   YEAR_END_UNDONE           that booking withdrawn on E — a payment on or
--                             before E was marked after the year end (C83 (b))
--   YEAR_END_REVERSAL_UNDONE  the reversal withdrawn with it, on the file's
--                             day (kept inside E + 1's year)
--
-- DDL only — no DML, no `neon-smoke.yml` dispatch owed.
-- ═══════════════════════════════════════════════════════════════════

-- AlterEnum
ALTER TYPE "invoice_export_event" ADD VALUE 'YEAR_END';
ALTER TYPE "invoice_export_event" ADD VALUE 'YEAR_END_REVERSED';
ALTER TYPE "invoice_export_event" ADD VALUE 'YEAR_END_UNDONE';
ALTER TYPE "invoice_export_event" ADD VALUE 'YEAR_END_REVERSAL_UNDONE';

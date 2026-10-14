-- ═══════════════════════════════════════════════════════════════════
-- Phase 7 slice 120 — REPORTS DRAFTED BY THEMSELVES ON THE 1ST (founder
-- decision C96; docs/research/2026-10-15-slice-120-report-drafts-design.md
-- §1).
--
-- Every kick of the jobs route now DRAFTS, in every sending workspace whose
-- switch is on, the monthly report of the month that just ended for every
-- client with someone in the portal and something to show — exactly the
-- report the Make a report button makes (slice 119), with every maker
-- column NULL. Two things the database learns:
--
--   `monthly_report_draft` — class A (tenant_isolation + portal_deny): the
--   drafter's LEDGER, one row per client and month it has CONSIDERED, with
--   the outcome (a draft made; a report already there; nobody who could
--   read it; nothing to show; too large to draw; failed). Deciding "nothing
--   to show" costs a derivation as the client's own contact, so a (client,
--   month) is decided ONCE — the UNIQUE key is the whole guard against two
--   kicks drafting twice. FAILED is tried again, up to three times.
--
--   `notification_reason_known` WIDENED by one reason, `REPORT_ACCESS` —
--   "they can publish that client's reports": the people the new inbox
--   notice `report.drafted` reaches when they are not assigned to the
--   client itself (CLIENT_MEMBER then) — the renewal drafts' precedent
--   (`INVOICE_ACCESS`, migration 20261018090000).
--
-- CONTACT WRITES: none. `portal_deny` closes the ledger to a contact
-- principal outright; `notification` is unchanged but for its CHECK.
--
-- DDL only — no DML, no `neon-smoke.yml` dispatch owed. Widening a CHECK
-- re-validates the existing rows (every stored reason is in the old set, a
-- subset of the new). Left out of Prisma's generated diff, as every
-- migration since they appeared has: the drift it always reports
-- (`document_tenant_id_tags_idx`, `search_index`, the `work_item` index
-- name) — hand-written objects Prisma does not model.
-- ═══════════════════════════════════════════════════════════════════

-- CreateTable
CREATE TABLE "monthly_report_draft" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "month" DATE NOT NULL,
    "outcome" TEXT NOT NULL,
    "document_id" TEXT,
    "attempts" SMALLINT NOT NULL DEFAULT 1,
    "decided_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "monthly_report_draft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "monthly_report_draft_tenant_id_id_key" ON "monthly_report_draft"("tenant_id", "id");

-- CreateIndex: ONE decision per client and month — the guard against two
-- kicks drafting the same month twice: a DRAFTED row is written in the SAME
-- transaction as the draft's rows, so the second kick's write is refused
-- whole (its blob deleted, no draft filed) and counted.
CREATE UNIQUE INDEX "monthly_report_draft_tenant_id_client_id_month_key" ON "monthly_report_draft"("tenant_id", "client_id", "month");

-- AddForeignKey
ALTER TABLE "monthly_report_draft" ADD CONSTRAINT "monthly_report_draft_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: with the client — a client hard-deleted (the harness's
-- teardown) takes its ledger; the product archives clients and never
-- deletes one.
ALTER TABLE "monthly_report_draft" ADD CONSTRAINT "monthly_report_draft_tenant_id_client_id_fkey" FOREIGN KEY ("tenant_id", "client_id") REFERENCES "client"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── CHECKs — the row's own shape ────────────────────────────────────
-- `document_id` is attribution (no FK): the product soft-deletes a document
-- and the harness hard-deletes one, and the row is the record that a
-- decision was taken either way. It is set exactly when a draft was made.
ALTER TABLE monthly_report_draft
  ADD CONSTRAINT monthly_report_draft_month_first
    CHECK (month = date_trunc('month', month)::date),
  ADD CONSTRAINT monthly_report_draft_outcome_known
    CHECK (outcome IN ('DRAFTED', 'EXISTS', 'NO_AUDIENCE', 'EMPTY', 'TOO_LARGE', 'FAILED')),
  ADD CONSTRAINT monthly_report_draft_document_when_drafted
    CHECK ((outcome = 'DRAFTED') = (document_id IS NOT NULL)),
  ADD CONSTRAINT monthly_report_draft_attempts_bounded
    CHECK (attempts BETWEEN 1 AND 3);

-- ── Grants ──────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON monthly_report_draft TO app_runtime;

-- ── RLS — class A (portal_deny; no visibility) ──────────────────────
ALTER TABLE monthly_report_draft ENABLE ROW LEVEL SECURITY;
ALTER TABLE monthly_report_draft FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON monthly_report_draft
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (tenant_id = (SELECT current_setting('app.tenant_id', true)))
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true)));

CREATE POLICY portal_deny ON monthly_report_draft
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');

-- ── The reason set, widened ─────────────────────────────────────────
-- One statement: the swap is atomic whether or not the runner wraps the file.
-- `REPORT_ACCESS` sits after `INVOICE_ACCESS` and before `OWNER`, the order
-- `src/notify/reasons.ts` keeps (the precedence).
ALTER TABLE notification
  DROP CONSTRAINT notification_reason_known,
  ADD CONSTRAINT notification_reason_known CHECK (
    reason IS NULL OR (receiver_type = 'MEMBER' AND reason IN (
      'ASSIGNEE',
      'REQUESTER',
      'PROJECT_LEAD',
      'PROJECT_MEMBER',
      'CLIENT_MEMBER',
      'BUDGET_WATCHER',
      'VAULT_ACCESS',
      'INVOICE_ACCESS',
      'REPORT_ACCESS',
      'OWNER'
    ))
  );

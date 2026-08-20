-- ═══════════════════════════════════════════════════════════════════
-- Phase 2T — time (PLAN.md Phase 2T; DATA_MODEL.md §6.15 as amended
-- 2026-08-20 with the founder deltas D1–D6; SECURITY.md §9.7 posture).
--   * TimeEntry (one running timer per member; ad-hoc pair-null client/
--     project; rate snapshot at write; lock trigger + bypass GUC),
--     RateCard (immutable rows; SERVICE scope; EXCLUDE no-overlap),
--     ProjectBudget + BudgetAlert, ProjectTimeSummary (the only LIVE
--     portal time surface — class B, no member id by construction),
--     StaffNotice + StaffNoticeAcknowledgment (the notice gate),
--     Shift + ShiftBreak (D1 attendance — closed rows only for others),
--     TimeReport (D3 immutable published snapshots; 4-term gate),
--     WorkType (D5 tenant lookup, never rate-bearing);
--     Project.default_service_id (D4 — the Service is the agreement).
--   * RLS: class A (9 tables, portal_deny); class B projectScoped
--     (project_time_summary 3-term gate, time_report 4-term gate) with
--     the trigger-maintained portal_enabled and the project fan-out
--     extended to both.
-- Hand-written: Prisma-expressible DDL from `migrate diff`, then the
-- partial uniques, EXCLUDE, CHECKs, triggers, GRANTs and RLS posture
-- appended by hand (phase2_core_domain template). Runs as the owner.
-- ═══════════════════════════════════════════════════════════════════

-- CreateEnum
CREATE TYPE "time_entry_mode" AS ENUM ('TIMER', 'MANUAL', 'DURATION');

-- CreateEnum
CREATE TYPE "time_entry_source" AS ENUM ('TIMER', 'MANUAL', 'IMPORT');

-- CreateEnum
CREATE TYPE "rate_source" AS ENUM ('SERVICE', 'PROJECT_MEMBER', 'PROJECT', 'MEMBER', 'TENANT', 'MANUAL', 'NONE');

-- CreateEnum
CREATE TYPE "time_lock_reason" AS ENUM ('INVOICED', 'INVOICE_DRAFT', 'LOCK_DATE', 'APPROVED', 'BILLED_EXTERNAL', 'WRITTEN_OFF');

-- CreateEnum
CREATE TYPE "time_review_reason" AS ENUM ('AUTO_STOPPED', 'OVERLAP_TRUNCATED', 'STOP_BEFORE_START', 'SKEW_CLAMPED');

-- CreateEnum
CREATE TYPE "rate_kind" AS ENUM ('BILL', 'COST');

-- CreateEnum
CREATE TYPE "rate_scope" AS ENUM ('TENANT', 'MEMBER', 'PROJECT', 'PROJECT_MEMBER', 'SERVICE');

-- CreateEnum
CREATE TYPE "budget_kind" AS ENUM ('HOURS', 'MONEY');

-- CreateEnum
CREATE TYPE "billing_model" AS ENUM ('T_AND_M', 'FIXED_FEE', 'RETAINER', 'NON_BILLABLE');

-- CreateEnum
CREATE TYPE "budget_period" AS ENUM ('NONE', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY');

-- CreateEnum
CREATE TYPE "budget_status" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "time_report_status" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "time_report_group_by" AS ENUM ('DAY', 'WORK_ITEM', 'EPIC', 'SERVICE');

-- AlterTable
ALTER TABLE "project" ADD COLUMN     "default_service_id" TEXT;

-- CreateTable
CREATE TABLE "time_entry" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "client_id" TEXT,
    "project_id" TEXT,
    "service_id" TEXT,
    "work_type_id" TEXT,
    "work_item_id" TEXT,
    "member_id" TEXT NOT NULL,
    "description" TEXT,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "stopped_at" TIMESTAMPTZ(6),
    "duration_seconds" INTEGER,
    "timezone" VARCHAR(64) NOT NULL,
    "local_date" DATE NOT NULL,
    "entry_mode" "time_entry_mode" NOT NULL,
    "source" "time_entry_source" NOT NULL DEFAULT 'TIMER',
    "billable" BOOLEAN NOT NULL,
    "bill_rate" DECIMAL(12,2),
    "currency" CHAR(3),
    "rate_source" "rate_source" NOT NULL DEFAULT 'NONE',
    "bill_rate_card_id" TEXT,
    "cost_rate_card_id" TEXT,
    "locked_reason" "time_lock_reason",
    "locked_at" TIMESTAMPTZ(6),
    "invoice_line_id" TEXT,
    "retainer_period_id" TEXT,
    "billed_externally_at" TIMESTAMPTZ(6),
    "written_off_at" TIMESTAMPTZ(6),
    "needs_review" BOOLEAN NOT NULL DEFAULT false,
    "review_reason" "time_review_reason",
    "client_event_id" TEXT,
    "client_started_at" TIMESTAMPTZ(6),
    "skew_ms" INTEGER,
    "created_by_member_id" TEXT,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "time_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_card" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "kind" "rate_kind" NOT NULL,
    "scope" "rate_scope" NOT NULL,
    "member_id" TEXT,
    "project_id" TEXT,
    "service_id" TEXT,
    "amount" DECIMAL(12,2),
    "amount_ciphertext" TEXT,
    "currency" CHAR(3) NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "created_by_member_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_card_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_budget" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "kind" "budget_kind" NOT NULL,
    "billing_model" "billing_model" NOT NULL DEFAULT 'T_AND_M',
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" CHAR(3),
    "period" "budget_period" NOT NULL DEFAULT 'NONE',
    "period_anchor" DATE,
    "include_non_billable" BOOLEAN NOT NULL DEFAULT false,
    "thresholds" INTEGER[] DEFAULT ARRAY[80, 100]::INTEGER[],
    "notify_member_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "budget_status" NOT NULL DEFAULT 'ACTIVE',
    "created_by_member_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "project_budget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_alert" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "budget_id" TEXT NOT NULL,
    "period_key" TEXT NOT NULL,
    "threshold" INTEGER NOT NULL,
    "sent_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "budget_alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_time_summary" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "period_month" DATE NOT NULL,
    "billable_seconds" INTEGER NOT NULL DEFAULT 0,
    "non_billable_seconds" INTEGER NOT NULL DEFAULT 0,
    "billable_amount" DECIMAL(12,2),
    "budget_seconds" INTEGER,
    "budget_amount" DECIMAL(12,2),
    "currency" CHAR(3),
    "visibility" "Visibility" NOT NULL DEFAULT 'INTERNAL',
    "portal_enabled" BOOLEAN NOT NULL DEFAULT false,
    "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_time_summary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_notice" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "locale" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "purposes" TEXT[],
    "jurisdiction_tags" TEXT[],
    "published_at" TIMESTAMPTZ(6),
    "published_by_member_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_notice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_notice_acknowledgment" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "notice_id" TEXT NOT NULL,
    "notice_version" INTEGER NOT NULL,
    "locale" TEXT NOT NULL,
    "acknowledged_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_notice_acknowledgment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "stopped_at" TIMESTAMPTZ(6),
    "worked_seconds" INTEGER,
    "timezone" VARCHAR(64) NOT NULL,
    "local_date" DATE NOT NULL,
    "note" TEXT,
    "needs_review" BOOLEAN NOT NULL DEFAULT false,
    "review_reason" "time_review_reason",
    "created_by_member_id" TEXT,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "shift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift_break" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "shift_id" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "stopped_at" TIMESTAMPTZ(6),
    "duration_seconds" INTEGER,
    "note" TEXT,
    "created_by_member_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "shift_break_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "time_report" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "period_start" DATE NOT NULL,
    "period_end" DATE NOT NULL,
    "group_by" "time_report_group_by" NOT NULL DEFAULT 'DAY',
    "include_amounts" BOOLEAN NOT NULL DEFAULT false,
    "include_non_billable" BOOLEAN NOT NULL DEFAULT false,
    "snapshot" JSONB NOT NULL,
    "total_seconds" INTEGER NOT NULL DEFAULT 0,
    "billable_seconds" INTEGER NOT NULL DEFAULT 0,
    "billable_amount" DECIMAL(12,2),
    "currency" CHAR(3),
    "status" "time_report_status" NOT NULL DEFAULT 'DRAFT',
    "visibility" "Visibility" NOT NULL DEFAULT 'INTERNAL',
    "portal_enabled" BOOLEAN NOT NULL DEFAULT false,
    "generated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(6),
    "published_by_member_id" TEXT,
    "created_by_member_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "time_report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_type" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "default_billable" BOOLEAN,
    "archived_at" TIMESTAMPTZ(6),
    "created_by_member_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "work_type_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "time_entry_tenant_id_member_id_started_at_idx" ON "time_entry"("tenant_id", "member_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "time_entry_tenant_id_project_id_started_at_idx" ON "time_entry"("tenant_id", "project_id", "started_at");

-- CreateIndex
CREATE INDEX "time_entry_tenant_id_work_item_id_idx" ON "time_entry"("tenant_id", "work_item_id");

-- CreateIndex
CREATE INDEX "time_entry_tenant_id_service_id_idx" ON "time_entry"("tenant_id", "service_id");

-- CreateIndex
CREATE INDEX "time_entry_tenant_id_work_type_id_idx" ON "time_entry"("tenant_id", "work_type_id");

-- CreateIndex
CREATE INDEX "time_entry_tenant_id_local_date_member_id_idx" ON "time_entry"("tenant_id", "local_date", "member_id");

-- CreateIndex
CREATE INDEX "time_entry_tenant_id_cost_rate_card_id_idx" ON "time_entry"("tenant_id", "cost_rate_card_id");

-- CreateIndex
CREATE INDEX "time_entry_tenant_id_bill_rate_card_id_idx" ON "time_entry"("tenant_id", "bill_rate_card_id");

-- CreateIndex
CREATE INDEX "time_entry_tenant_id_invoice_line_id_idx" ON "time_entry"("tenant_id", "invoice_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "time_entry_tenant_id_id_key" ON "time_entry"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "time_entry_tenant_id_member_id_client_event_id_key" ON "time_entry"("tenant_id", "member_id", "client_event_id");

-- CreateIndex
CREATE INDEX "rate_card_tenant_id_kind_scope_project_id_member_id_effecti_idx" ON "rate_card"("tenant_id", "kind", "scope", "project_id", "member_id", "effective_from");

-- CreateIndex
CREATE INDEX "rate_card_tenant_id_service_id_kind_idx" ON "rate_card"("tenant_id", "service_id", "kind");

-- CreateIndex
CREATE INDEX "rate_card_tenant_id_member_id_kind_idx" ON "rate_card"("tenant_id", "member_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "rate_card_tenant_id_id_key" ON "rate_card"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "project_budget_tenant_id_project_id_status_idx" ON "project_budget"("tenant_id", "project_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "project_budget_tenant_id_id_key" ON "project_budget"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "budget_alert_tenant_id_budget_id_period_key_threshold_key" ON "budget_alert"("tenant_id", "budget_id", "period_key", "threshold");

-- CreateIndex
CREATE INDEX "project_time_summary_tenant_id_client_id_visibility_idx" ON "project_time_summary"("tenant_id", "client_id", "visibility");

-- CreateIndex
CREATE UNIQUE INDEX "project_time_summary_tenant_id_project_id_period_month_key" ON "project_time_summary"("tenant_id", "project_id", "period_month");

-- CreateIndex
CREATE UNIQUE INDEX "staff_notice_tenant_id_version_locale_key" ON "staff_notice"("tenant_id", "version", "locale");

-- CreateIndex
CREATE UNIQUE INDEX "staff_notice_tenant_id_id_key" ON "staff_notice"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "staff_notice_acknowledgment_tenant_id_member_id_idx" ON "staff_notice_acknowledgment"("tenant_id", "member_id");

-- CreateIndex
CREATE UNIQUE INDEX "staff_notice_acknowledgment_tenant_id_member_id_notice_id_n_key" ON "staff_notice_acknowledgment"("tenant_id", "member_id", "notice_id", "notice_version");

-- CreateIndex
CREATE INDEX "shift_tenant_id_member_id_started_at_idx" ON "shift"("tenant_id", "member_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "shift_tenant_id_local_date_member_id_idx" ON "shift"("tenant_id", "local_date", "member_id");

-- CreateIndex
CREATE UNIQUE INDEX "shift_tenant_id_id_key" ON "shift"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "shift_break_tenant_id_shift_id_idx" ON "shift_break"("tenant_id", "shift_id");

-- CreateIndex
CREATE INDEX "shift_break_tenant_id_member_id_started_at_idx" ON "shift_break"("tenant_id", "member_id", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "shift_break_tenant_id_id_key" ON "shift_break"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "time_report_tenant_id_project_id_period_start_idx" ON "time_report"("tenant_id", "project_id", "period_start");

-- CreateIndex
CREATE INDEX "time_report_tenant_id_client_id_visibility_idx" ON "time_report"("tenant_id", "client_id", "visibility");

-- CreateIndex
CREATE UNIQUE INDEX "time_report_tenant_id_id_key" ON "time_report"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "work_type_tenant_id_archived_at_sort_order_idx" ON "work_type"("tenant_id", "archived_at", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "work_type_tenant_id_id_key" ON "work_type"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "project" ADD CONSTRAINT "project_tenant_id_default_service_id_fkey" FOREIGN KEY ("tenant_id", "default_service_id") REFERENCES "service"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_entry" ADD CONSTRAINT "time_entry_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_entry" ADD CONSTRAINT "time_entry_tenant_id_client_id_fkey" FOREIGN KEY ("tenant_id", "client_id") REFERENCES "client"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_entry" ADD CONSTRAINT "time_entry_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "project"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_entry" ADD CONSTRAINT "time_entry_tenant_id_service_id_fkey" FOREIGN KEY ("tenant_id", "service_id") REFERENCES "service"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_entry" ADD CONSTRAINT "time_entry_tenant_id_work_type_id_fkey" FOREIGN KEY ("tenant_id", "work_type_id") REFERENCES "work_type"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_entry" ADD CONSTRAINT "time_entry_tenant_id_work_item_id_fkey" FOREIGN KEY ("tenant_id", "work_item_id") REFERENCES "work_item"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_entry" ADD CONSTRAINT "time_entry_tenant_id_member_id_fkey" FOREIGN KEY ("tenant_id", "member_id") REFERENCES "member"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_entry" ADD CONSTRAINT "time_entry_tenant_id_bill_rate_card_id_fkey" FOREIGN KEY ("tenant_id", "bill_rate_card_id") REFERENCES "rate_card"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_entry" ADD CONSTRAINT "time_entry_tenant_id_cost_rate_card_id_fkey" FOREIGN KEY ("tenant_id", "cost_rate_card_id") REFERENCES "rate_card"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_card" ADD CONSTRAINT "rate_card_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_card" ADD CONSTRAINT "rate_card_tenant_id_member_id_fkey" FOREIGN KEY ("tenant_id", "member_id") REFERENCES "member"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_card" ADD CONSTRAINT "rate_card_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "project"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rate_card" ADD CONSTRAINT "rate_card_tenant_id_service_id_fkey" FOREIGN KEY ("tenant_id", "service_id") REFERENCES "service"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_budget" ADD CONSTRAINT "project_budget_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_budget" ADD CONSTRAINT "project_budget_tenant_id_client_id_fkey" FOREIGN KEY ("tenant_id", "client_id") REFERENCES "client"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_budget" ADD CONSTRAINT "project_budget_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "project"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_alert" ADD CONSTRAINT "budget_alert_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_alert" ADD CONSTRAINT "budget_alert_tenant_id_budget_id_fkey" FOREIGN KEY ("tenant_id", "budget_id") REFERENCES "project_budget"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_time_summary" ADD CONSTRAINT "project_time_summary_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_time_summary" ADD CONSTRAINT "project_time_summary_tenant_id_client_id_fkey" FOREIGN KEY ("tenant_id", "client_id") REFERENCES "client"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_time_summary" ADD CONSTRAINT "project_time_summary_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "project"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_notice" ADD CONSTRAINT "staff_notice_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_notice_acknowledgment" ADD CONSTRAINT "staff_notice_acknowledgment_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_notice_acknowledgment" ADD CONSTRAINT "staff_notice_acknowledgment_tenant_id_member_id_fkey" FOREIGN KEY ("tenant_id", "member_id") REFERENCES "member"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_notice_acknowledgment" ADD CONSTRAINT "staff_notice_acknowledgment_tenant_id_notice_id_fkey" FOREIGN KEY ("tenant_id", "notice_id") REFERENCES "staff_notice"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift" ADD CONSTRAINT "shift_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift" ADD CONSTRAINT "shift_tenant_id_member_id_fkey" FOREIGN KEY ("tenant_id", "member_id") REFERENCES "member"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_break" ADD CONSTRAINT "shift_break_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_break" ADD CONSTRAINT "shift_break_tenant_id_shift_id_fkey" FOREIGN KEY ("tenant_id", "shift_id") REFERENCES "shift"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_break" ADD CONSTRAINT "shift_break_tenant_id_member_id_fkey" FOREIGN KEY ("tenant_id", "member_id") REFERENCES "member"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_report" ADD CONSTRAINT "time_report_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_report" ADD CONSTRAINT "time_report_tenant_id_client_id_fkey" FOREIGN KEY ("tenant_id", "client_id") REFERENCES "client"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_report" ADD CONSTRAINT "time_report_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "project"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_type" ADD CONSTRAINT "work_type_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- Hand-written from here on (DATA_MODEL.md §6.15 as amended 2026-08-20;
-- every line below has a data-layer test in src/modules/time or src/db).
-- ═══════════════════════════════════════════════════════════════════

-- ── Partial uniques + partial indexes ───────────────────────────────
-- One running timer per member; one open shift per member; one open
-- break per shift (⇒ transitively one open break per member); one
-- ACTIVE budget per project; live work-type names unique per tenant
-- (reusable after archive). All enforced by the database, not the app —
-- the Neon spike (2026-08-20) proved partial uniques hold under FORCE
-- RLS for app_runtime, including under a concurrent race.
CREATE UNIQUE INDEX time_entry_one_running ON time_entry (tenant_id, member_id)
  WHERE stopped_at IS NULL AND deleted_at IS NULL;
CREATE INDEX time_entry_uninvoiced ON time_entry (tenant_id, project_id, member_id)
  WHERE invoice_line_id IS NULL AND billable AND deleted_at IS NULL;
CREATE UNIQUE INDEX shift_one_open ON shift (tenant_id, member_id)
  WHERE stopped_at IS NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX shift_break_one_open ON shift_break (tenant_id, shift_id)
  WHERE stopped_at IS NULL;
CREATE UNIQUE INDEX project_budget_one_active ON project_budget (tenant_id, project_id)
  WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX work_type_name_live ON work_type (tenant_id, name)
  WHERE archived_at IS NULL;

-- ── RateCard no-overlap: the EXCLUDE constraint (decided by the Neon
--    spike, ARCHITECTURE.md §8 — no app-check fallback) ─────────────
-- Dimension = (tenant, kind, scope, member, project, service); NULLs
-- coalesced to '' so cards of the same scope compare equal on the
-- absent axes. Half-open daterange: a card closed on its own
-- effective_from is an empty range and never conflicts.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE rate_card ADD CONSTRAINT rate_card_no_overlap
  EXCLUDE USING gist (
    tenant_id WITH =,
    kind WITH =,
    scope WITH =,
    coalesce(member_id, '') WITH =,
    coalesce(project_id, '') WITH =,
    coalesce(service_id, '') WITH =,
    daterange(effective_from, effective_to, '[)') WITH &&
  );

-- ── CHECKs ──────────────────────────────────────────────────────────
-- TimeEntry: the pinned set + the 2026-08-20 D2/D4 set. The service
-- writes whole-second timestamps and duration = floor(epoch diff).
ALTER TABLE time_entry
  ADD CONSTRAINT time_entry_duration_pairs CHECK ((stopped_at IS NULL) = (duration_seconds IS NULL)),
  ADD CONSTRAINT time_entry_stop_after_start CHECK (stopped_at IS NULL OR stopped_at >= started_at),
  ADD CONSTRAINT time_entry_duration_exact CHECK (duration_seconds IS NULL OR duration_seconds = floor(EXTRACT(EPOCH FROM (stopped_at - started_at)))::int),
  ADD CONSTRAINT time_entry_billable_rate CHECK (billable OR bill_rate IS NULL),
  ADD CONSTRAINT time_entry_bill_rate_nonneg CHECK (bill_rate IS NULL OR bill_rate >= 0),
  ADD CONSTRAINT time_entry_note_or_item CHECK (work_item_id IS NOT NULL OR nullif(btrim(description), '') IS NOT NULL),
  ADD CONSTRAINT time_entry_adhoc_pair CHECK ((client_id IS NULL) = (project_id IS NULL)),
  ADD CONSTRAINT time_entry_item_needs_project CHECK (work_item_id IS NULL OR project_id IS NOT NULL),
  ADD CONSTRAINT time_entry_adhoc_nonbillable CHECK (project_id IS NOT NULL OR NOT billable),
  ADD CONSTRAINT time_entry_service_needs_project CHECK (service_id IS NULL OR project_id IS NOT NULL),
  ADD CONSTRAINT time_entry_lock_pairs CHECK ((locked_reason IS NULL) = (locked_at IS NULL));

-- RateCard: amount by kind; scope ↔ axis nullness; COST never per
-- agreement; effective range; non-negative amounts.
ALTER TABLE rate_card
  ADD CONSTRAINT rate_card_amount_by_kind
    CHECK (((kind = 'BILL') = (amount IS NOT NULL)) AND ((kind = 'COST') = (amount_ciphertext IS NOT NULL))),
  ADD CONSTRAINT rate_card_scope_nullness CHECK (
    CASE scope
      WHEN 'TENANT'         THEN member_id IS NULL     AND project_id IS NULL     AND service_id IS NULL
      WHEN 'MEMBER'         THEN member_id IS NOT NULL AND project_id IS NULL     AND service_id IS NULL
      WHEN 'PROJECT'        THEN member_id IS NULL     AND project_id IS NOT NULL AND service_id IS NULL
      WHEN 'PROJECT_MEMBER' THEN member_id IS NOT NULL AND project_id IS NOT NULL AND service_id IS NULL
      WHEN 'SERVICE'        THEN member_id IS NULL     AND project_id IS NULL     AND service_id IS NOT NULL
    END),
  ADD CONSTRAINT rate_card_cost_scope CHECK (kind <> 'COST' OR scope IN ('MEMBER', 'TENANT')),
  ADD CONSTRAINT rate_card_effective_range CHECK (effective_to IS NULL OR effective_to >= effective_from),
  ADD CONSTRAINT rate_card_amount_nonneg CHECK (amount IS NULL OR amount >= 0);

-- ProjectBudget / BudgetAlert
ALTER TABLE project_budget
  ADD CONSTRAINT project_budget_period_anchor CHECK (period = 'NONE' OR period_anchor IS NOT NULL),
  ADD CONSTRAINT project_budget_thresholds_range
    CHECK (cardinality(thresholds) <= 10 AND 1 <= ALL (thresholds) AND 200 >= ALL (thresholds)),
  ADD CONSTRAINT project_budget_amount_positive CHECK (amount > 0),
  ADD CONSTRAINT project_budget_money_currency CHECK (kind <> 'MONEY' OR currency IS NOT NULL);
ALTER TABLE budget_alert
  ADD CONSTRAINT budget_alert_threshold_range CHECK (threshold BETWEEN 1 AND 200);

-- ProjectTimeSummary: first-of-month rows, non-negative totals.
ALTER TABLE project_time_summary
  ADD CONSTRAINT project_time_summary_month_start CHECK (period_month = date_trunc('month', period_month)::date),
  ADD CONSTRAINT project_time_summary_seconds_nonneg CHECK (billable_seconds >= 0 AND non_billable_seconds >= 0);

-- StaffNotice / WorkType
ALTER TABLE staff_notice
  ADD CONSTRAINT staff_notice_version_positive CHECK (version >= 1);
ALTER TABLE work_type
  ADD CONSTRAINT work_type_name_nonblank CHECK (btrim(name) <> ''),
  ADD CONSTRAINT work_type_sort_order_nonneg CHECK (sort_order >= 0);

-- Shift / ShiftBreak (D1): the same interval discipline as TimeEntry;
-- worked_seconds is bounded by the span (exact equality vs Σ breaks is
-- cross-row — service-maintained + property-tested, not CHECK-able).
ALTER TABLE shift
  ADD CONSTRAINT shift_stop_after_start CHECK (stopped_at IS NULL OR stopped_at >= started_at),
  ADD CONSTRAINT shift_worked_pairs CHECK ((stopped_at IS NULL) = (worked_seconds IS NULL)),
  ADD CONSTRAINT shift_worked_range
    CHECK (worked_seconds IS NULL OR (worked_seconds >= 0 AND worked_seconds <= floor(EXTRACT(EPOCH FROM (stopped_at - started_at)))::int));
ALTER TABLE shift_break
  ADD CONSTRAINT shift_break_stop_after_start CHECK (stopped_at IS NULL OR stopped_at >= started_at),
  ADD CONSTRAINT shift_break_duration_pairs CHECK ((stopped_at IS NULL) = (duration_seconds IS NULL)),
  ADD CONSTRAINT shift_break_duration_exact CHECK (duration_seconds IS NULL OR duration_seconds = floor(EXTRACT(EPOCH FROM (stopped_at - started_at)))::int);

-- TimeReport (D3): period order; DRAFT ⇔ unpublished; client-visible
-- only once PUBLISHED (so the 4-term gate's status term is never the
-- only thing standing between a draft and a contact).
ALTER TABLE time_report
  ADD CONSTRAINT time_report_period_order CHECK (period_end >= period_start),
  ADD CONSTRAINT time_report_draft_unpublished CHECK ((status = 'DRAFT') = (published_at IS NULL)),
  ADD CONSTRAINT time_report_visible_only_published CHECK (visibility = 'INTERNAL' OR status = 'PUBLISHED'),
  ADD CONSTRAINT time_report_seconds_nonneg
    CHECK (total_seconds >= 0 AND billable_seconds >= 0 AND billable_seconds <= total_seconds);

-- ── Domain triggers (SECURITY INVOKER — they read under the caller's
--    RLS; messages start with a stable token the service maps to a
--    DomainError code) ─────────────────────────────────────────────

-- A locked entry refuses UPDATE and DELETE unless the transaction-local
-- GUC app.time_lock_bypass = 'on' — set ONLY by the invoicing service
-- (Phase 4), always with an audit row. Locking an unlocked row is a
-- normal update (OLD.locked_reason IS NULL); unlocking needs the bypass.
CREATE OR REPLACE FUNCTION time_entry_lock_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD.locked_reason IS NOT NULL
     AND coalesce(current_setting('app.time_lock_bypass', true), '') <> 'on' THEN
    RAISE EXCEPTION 'ENTRY_LOCKED: time entry % is locked (%)', OLD.id, OLD.locked_reason;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER time_entry_lock_guard
  BEFORE UPDATE OR DELETE ON time_entry
  FOR EACH ROW EXECUTE FUNCTION time_entry_lock_guard();

-- Scope guard (NULL-tolerant, 2026-08-20): validates ONLY when the
-- entry carries a project — client_id is DERIVED from the project
-- (never trusted from the writer), the work item must belong to the
-- project, and an agreement must belong to the same client and (when
-- project-scoped) the same project. Ad-hoc entries (project NULL) pass
-- through; the CHECKs already force their other axes NULL.
CREATE OR REPLACE FUNCTION time_entry_scope_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_client     text;
  v_wi_project text;
  v_s_client   text;
  v_s_project  text;
BEGIN
  IF NEW.project_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT p.client_id INTO v_client
    FROM project p
   WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.project_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'time_entry: project not found in tenant';
  END IF;
  NEW.client_id := v_client;
  IF NEW.work_item_id IS NOT NULL THEN
    SELECT wi.project_id INTO v_wi_project
      FROM work_item wi
     WHERE wi.tenant_id = NEW.tenant_id AND wi.id = NEW.work_item_id;
    IF NOT FOUND OR v_wi_project <> NEW.project_id THEN
      RAISE EXCEPTION 'time_entry: work item must belong to the entry''s project';
    END IF;
  END IF;
  IF NEW.service_id IS NOT NULL THEN
    SELECT s.client_id, s.project_id INTO v_s_client, v_s_project
      FROM service s
     WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.service_id;
    IF NOT FOUND OR v_s_client <> NEW.client_id
       OR (v_s_project IS NOT NULL AND v_s_project <> NEW.project_id) THEN
      RAISE EXCEPTION 'SERVICE_CLIENT_MISMATCH: agreement must belong to the entry''s client (and project, when project-scoped)';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER time_entry_scope_guard
  BEFORE INSERT OR UPDATE OF client_id, project_id, work_item_id, service_id ON time_entry
  FOR EACH ROW EXECUTE FUNCTION time_entry_scope_guard();

-- RateCard rows are immutable: the only permitted change is closing an
-- open card (effective_to NULL → date). A change = close + insert, so a
-- card id is a stable snapshot target for TimeEntry rows.
CREATE OR REPLACE FUNCTION rate_card_immutable() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF (to_jsonb(NEW) - 'effective_to') IS DISTINCT FROM (to_jsonb(OLD) - 'effective_to') THEN
    RAISE EXCEPTION 'RATE_CARD_IMMUTABLE: rate card rows are immutable — close the card and insert a new one';
  END IF;
  IF NEW.effective_to IS DISTINCT FROM OLD.effective_to AND OLD.effective_to IS NOT NULL THEN
    RAISE EXCEPTION 'RATE_CARD_IMMUTABLE: a closed rate card cannot be reopened or re-closed';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER rate_card_immutable
  BEFORE UPDATE ON rate_card
  FOR EACH ROW EXECUTE FUNCTION rate_card_immutable();

-- ProjectTimeSummary.visibility is DERIVED from Project.hoursSharingMode
-- (CLIENT_VISIBLE iff ≠ NONE) and billable_amount is nulled unless the
-- mode is BILLABLE_AMOUNT — stamped on every write, fanned out when the
-- project's mode changes (the app recomputes the amounts afterwards).
-- A direct write to visibility is overwritten, like portal_enabled.
CREATE OR REPLACE FUNCTION project_time_summary_stamp_visibility() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  mode "HoursSharingMode";
BEGIN
  SELECT p.hours_sharing_mode INTO mode
    FROM project p
   WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.project_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'project_time_summary: project not found in tenant';
  END IF;
  NEW.visibility := CASE WHEN mode <> 'NONE' THEN 'CLIENT_VISIBLE'::"Visibility" ELSE 'INTERNAL'::"Visibility" END;
  IF mode <> 'BILLABLE_AMOUNT' THEN
    NEW.billable_amount := NULL;
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER project_time_summary_stamp_visibility
  BEFORE INSERT OR UPDATE OF project_id, visibility, billable_amount ON project_time_summary
  FOR EACH ROW EXECUTE FUNCTION project_time_summary_stamp_visibility();

CREATE OR REPLACE FUNCTION project_hours_sharing_fanout() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.hours_sharing_mode IS DISTINCT FROM OLD.hours_sharing_mode THEN
    UPDATE project_time_summary
       SET visibility = CASE WHEN NEW.hours_sharing_mode <> 'NONE'
                             THEN 'CLIENT_VISIBLE'::"Visibility" ELSE 'INTERNAL'::"Visibility" END,
           billable_amount = CASE WHEN NEW.hours_sharing_mode = 'BILLABLE_AMOUNT'
                                  THEN billable_amount ELSE NULL END
     WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
  END IF;
  RETURN NULL;
END
$fn$;
CREATE TRIGGER project_hours_sharing_fanout
  AFTER UPDATE OF hours_sharing_mode ON project
  FOR EACH ROW EXECUTE FUNCTION project_hours_sharing_fanout();

-- TimeReport (D3): immutable once published — only status (PUBLISHED →
-- ARCHIVED), visibility (publish/unpublish) and the stamped/updated
-- columns may change; published rows cannot be deleted (archive only).
CREATE OR REPLACE FUNCTION time_report_immutable() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_old jsonb;
  v_new jsonb;
BEGIN
  IF OLD.published_at IS NULL THEN
    RETURN NEW;
  END IF;
  v_old := to_jsonb(OLD) - 'status' - 'visibility' - 'portal_enabled' - 'updated_at';
  v_new := to_jsonb(NEW) - 'status' - 'visibility' - 'portal_enabled' - 'updated_at';
  IF v_new IS DISTINCT FROM v_old THEN
    RAISE EXCEPTION 'REPORT_IMMUTABLE: a published time report cannot be edited — archive it and generate a new one';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'PUBLISHED' AND NEW.status = 'ARCHIVED') THEN
    RAISE EXCEPTION 'REPORT_IMMUTABLE: a published time report may only move to ARCHIVED';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER time_report_immutable
  BEFORE UPDATE ON time_report
  FOR EACH ROW EXECUTE FUNCTION time_report_immutable();

CREATE OR REPLACE FUNCTION time_report_no_delete_published() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD.published_at IS NOT NULL THEN
    RAISE EXCEPTION 'REPORT_IMMUTABLE: a published time report cannot be deleted — archive it';
  END IF;
  RETURN OLD;
END
$fn$;
CREATE TRIGGER time_report_no_delete_published
  BEFORE DELETE ON time_report
  FOR EACH ROW EXECUTE FUNCTION time_report_no_delete_published();

-- ShiftBreak bounds (D1): the break lies inside its parent shift, and
-- member_id is STAMPED from the shift (denormalised, never trusted).
-- Triggers, not app-only: bounds are absolute invariants with several
-- writer paths (self-service, time:edit_any, a future import).
CREATE OR REPLACE FUNCTION shift_break_bounds_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  s shift%ROWTYPE;
BEGIN
  SELECT * INTO s FROM shift
   WHERE tenant_id = NEW.tenant_id AND id = NEW.shift_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'shift_break: shift not found in tenant';
  END IF;
  NEW.member_id := s.member_id;
  IF NEW.started_at < s.started_at THEN
    RAISE EXCEPTION 'BREAK_OUT_OF_BOUNDS: a break cannot start before its shift';
  END IF;
  IF s.stopped_at IS NOT NULL AND (NEW.stopped_at IS NULL OR NEW.stopped_at > s.stopped_at) THEN
    RAISE EXCEPTION 'BREAK_OUT_OF_BOUNDS: a break must lie inside its closed shift';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER shift_break_bounds_guard
  BEFORE INSERT OR UPDATE OF shift_id, started_at, stopped_at ON shift_break
  FOR EACH ROW EXECUTE FUNCTION shift_break_bounds_guard();

-- A shift edit cannot orphan a break (and closing a shift with an open
-- break is refused — clockOut closes the break first, same tx).
CREATE OR REPLACE FUNCTION shift_shrink_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF EXISTS (
    SELECT 1 FROM shift_break b
     WHERE b.tenant_id = NEW.tenant_id AND b.shift_id = NEW.id
       AND (b.started_at < NEW.started_at
            OR (NEW.stopped_at IS NOT NULL
                AND (b.stopped_at IS NULL OR b.stopped_at > NEW.stopped_at)))
  ) THEN
    RAISE EXCEPTION 'SHIFT_SHRINK: the new shift span would leave a break outside it';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER shift_shrink_guard
  BEFORE UPDATE OF started_at, stopped_at ON shift
  FOR EACH ROW EXECUTE FUNCTION shift_shrink_guard();

-- ── Grants (deny-default, explicit per table) ───────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE
  ON time_entry, rate_card, project_budget, budget_alert, project_time_summary,
     staff_notice, staff_notice_acknowledgment, shift, shift_break, time_report,
     work_type
  TO app_runtime;
-- app_platform already covers new tables via ALTER DEFAULT PRIVILEGES.

-- ── RLS — class A (portal_deny; never a visibility column) ──────────
-- time_entry is the table the never-list guards hardest: a contact
-- principal reads ZERO rows here, ever — the only portal time surfaces
-- are the two class-B tables below.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'time_entry', 'rate_card', 'project_budget', 'budget_alert',
    'staff_notice', 'staff_notice_acknowledgment', 'shift', 'shift_break',
    'work_type'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %I
        AS PERMISSIVE FOR ALL TO app_runtime
        USING      (tenant_id = (SELECT current_setting('app.tenant_id', true)))
        WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true)))
    $p$, t);
    EXECUTE format($p$
      CREATE POLICY portal_deny ON %I
        AS RESTRICTIVE FOR ALL TO app_runtime
        USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact')
    $p$, t);
  END LOOP;
END
$$;

-- ── RLS — class B projectScoped: project_time_summary, time_report ──
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['project_time_summary', 'time_report'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %I
        AS PERMISSIVE FOR ALL TO app_runtime
        USING      (tenant_id = (SELECT current_setting('app.tenant_id', true)))
        WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true)))
    $p$, t);
  END LOOP;
END
$$;

-- portal_gate: project_time_summary — the standard three-term form.
-- visibility here is trigger-derived from Project.hoursSharingMode, so
-- a contact reads a month row only when the project shares hours AND
-- the project's portal is on AND it is their client.
CREATE POLICY portal_gate ON project_time_summary
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING (
    (SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact'
    OR (
      client_id = (SELECT current_setting('app.client_id', true))
      AND visibility = 'CLIENT_VISIBLE'
      AND portal_enabled
    )
  )
  WITH CHECK (
    (SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact'
    OR (
      client_id = (SELECT current_setting('app.client_id', true))
      AND visibility = 'CLIENT_VISIBLE'
      AND portal_enabled
    )
  );

-- portal_gate: time_report — FOUR-term (+ status = 'PUBLISHED'). The
-- CHECK above already forbids CLIENT_VISIBLE on a non-published row;
-- the status term is belt-and-braces at the gate itself.
CREATE POLICY portal_gate ON time_report
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING (
    (SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact'
    OR (
      client_id = (SELECT current_setting('app.client_id', true))
      AND visibility = 'CLIENT_VISIBLE'
      AND portal_enabled
      AND status = 'PUBLISHED'
    )
  )
  WITH CHECK (
    (SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact'
    OR (
      client_id = (SELECT current_setting('app.client_id', true))
      AND visibility = 'CLIENT_VISIBLE'
      AND portal_enabled
      AND status = 'PUBLISHED'
    )
  );

-- ── portal_enabled maintenance: stamp the two new projectScoped
--    tables and extend the project fan-out (TENANCY.md §7.2) ─────────
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['project_time_summary', 'time_report'] LOOP
    EXECUTE format($t$
      CREATE TRIGGER %I_stamp_portal_enabled
        BEFORE INSERT OR UPDATE OF project_id, portal_enabled ON %I
        FOR EACH ROW EXECUTE FUNCTION stamp_portal_enabled()
    $t$, t, t);
  END LOOP;
END
$$;

CREATE OR REPLACE FUNCTION project_portal_enabled_fanout() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.portal_enabled IS DISTINCT FROM OLD.portal_enabled THEN
    UPDATE milestone            SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
    UPDATE project_version      SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
    UPDATE service              SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
    UPDATE document             SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
    UPDATE work_item            SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
    UPDATE work_item_activity   SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
    UPDATE comment              SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
    UPDATE search_index         SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
    UPDATE project_time_summary SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
    UPDATE time_report          SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
  END IF;
  RETURN NULL;
END
$fn$;
-- No backfill: every table in this migration is new.

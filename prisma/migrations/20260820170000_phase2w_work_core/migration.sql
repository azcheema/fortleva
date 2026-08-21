-- CreateEnum
CREATE TYPE "state_category" AS ENUM ('BACKLOG', 'TODO', 'IN_PROGRESS', 'DONE', 'CANCELLED', 'TRIAGE');

-- CreateEnum
CREATE TYPE "work_item_type" AS ENUM ('EPIC', 'TASK', 'SUBTASK');

-- CreateEnum
CREATE TYPE "work_item_kind" AS ENUM ('TASK', 'BUG', 'REQUEST');

-- CreateEnum
CREATE TYPE "work_item_priority" AS ENUM ('NONE', 'LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "triage_status" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'SNOOZED', 'DUPLICATE');

-- CreateEnum
CREATE TYPE "work_item_source" AS ENUM ('IN_APP', 'PORTAL', 'EMAIL', 'IMPORT');

-- CreateEnum
CREATE TYPE "comment_subject_type" AS ENUM ('WORK_ITEM', 'PROJECT_UPDATE', 'DOCUMENT', 'FILE_VERSION', 'PROJECT_VERSION');

-- CreateEnum
CREATE TYPE "receiver_type" AS ENUM ('MEMBER', 'CONTACT');

-- CreateEnum
CREATE TYPE "notification_class" AS ENUM ('INSTANT', 'COALESCED', 'DIGEST_ONLY');

-- CreateEnum
CREATE TYPE "subscription_level" AS ENUM ('WATCH', 'PARTICIPATE', 'MUTED');

-- CreateEnum
CREATE TYPE "email_level" AS ENUM ('ALL', 'PARTICIPATING', 'MENTIONS', 'NONE');

-- CreateEnum
CREATE TYPE "digest_cadence" AS ENUM ('NONE', 'DAILY', 'WEEKLY');

-- CreateEnum
CREATE TYPE "email_outbox_status" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'FAILED', 'DEAD', 'SUPPRESSED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "suppression_reason" AS ENUM ('HARD_BOUNCE', 'COMPLAINT', 'UNSUBSCRIBED', 'MANUAL');

-- (drift artifact removed: the diff proposed dropping the hand-written
-- GIN index document_tenant_id_tags_idx, which lives outside the
-- datamodel by design — never drop it here.)

-- CreateTable
CREATE TABLE "workflow_state" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "category" "state_category" NOT NULL,
    "rank" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "is_hidden" BOOLEAN NOT NULL DEFAULT false,
    "wip_limit" INTEGER,
    "definition_of_done" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "workflow_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_preset" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "states" JSONB NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "workflow_preset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_item" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "type" "work_item_type" NOT NULL DEFAULT 'TASK',
    "kind" "work_item_kind" NOT NULL DEFAULT 'TASK',
    "title" TEXT NOT NULL,
    "description" JSONB,
    "description_text" TEXT,
    "state_id" TEXT NOT NULL,
    "state_category" "state_category" NOT NULL,
    "priority" "work_item_priority" NOT NULL DEFAULT 'NONE',
    "assignee_member_id" TEXT,
    "assignee_contact_id" TEXT,
    "parent_id" TEXT,
    "root_id" TEXT NOT NULL,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "milestone_id" TEXT,
    "fixed_in_version_id" TEXT,
    "rank" TEXT NOT NULL,
    "estimate_minutes" INTEGER,
    "remaining_minutes" INTEGER,
    "start_date" DATE,
    "target_date" DATE,
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "visibility" "Visibility" NOT NULL DEFAULT 'INTERNAL',
    "portal_enabled" BOOLEAN NOT NULL DEFAULT false,
    "triage_status" "triage_status",
    "snoozed_until" TIMESTAMPTZ(6),
    "duplicate_of_id" TEXT,
    "source" "work_item_source" NOT NULL DEFAULT 'IN_APP',
    "checklist_total" INTEGER NOT NULL DEFAULT 0,
    "checklist_done" INTEGER NOT NULL DEFAULT 0,
    "source_system" TEXT,
    "source_id" TEXT,
    "import_job_id" TEXT,
    "created_by_member_id" TEXT,
    "reported_by_contact_id" TEXT,
    "archived_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "work_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_item_activity" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "work_item_id" TEXT NOT NULL,
    "actor_member_id" TEXT,
    "actor_contact_id" TEXT,
    "field" TEXT NOT NULL,
    "old_value" TEXT,
    "new_value" TEXT,
    "old_ref" TEXT,
    "new_ref" TEXT,
    "comment_id" TEXT,
    "visibility" "Visibility" NOT NULL DEFAULT 'INTERNAL',
    "portal_enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_item_activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "label" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "project_id" TEXT,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "label_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_item_label" (
    "tenant_id" TEXT NOT NULL,
    "work_item_id" TEXT NOT NULL,
    "label_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_item_label_pkey" PRIMARY KEY ("tenant_id","work_item_id","label_id")
);

-- CreateTable
CREATE TABLE "work_item_collaborator" (
    "tenant_id" TEXT NOT NULL,
    "work_item_id" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "added_by_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_item_collaborator_pkey" PRIMARY KEY ("tenant_id","work_item_id","member_id")
);

-- CreateTable
CREATE TABLE "work_item_subscriber" (
    "tenant_id" TEXT NOT NULL,
    "work_item_id" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "level" "subscription_level" NOT NULL DEFAULT 'WATCH',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "work_item_subscriber_pkey" PRIMARY KEY ("tenant_id","work_item_id","member_id")
);

-- CreateTable
CREATE TABLE "comment" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "client_id" TEXT,
    "project_id" TEXT,
    "subject_type" "comment_subject_type" NOT NULL,
    "subject_id" TEXT NOT NULL,
    "parent_id" TEXT,
    "author_member_id" TEXT,
    "author_contact_id" TEXT,
    "body" JSONB NOT NULL,
    "body_text" TEXT NOT NULL,
    "visibility" "Visibility" NOT NULL DEFAULT 'INTERNAL',
    "portal_enabled" BOOLEAN NOT NULL DEFAULT false,
    "edited_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mention" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "comment_id" TEXT NOT NULL,
    "mentioned_member_id" TEXT,
    "mentioned_contact_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mention_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_template" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "locale" TEXT,
    "definition" JSONB NOT NULL,
    "created_by_member_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "project_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "receiver_type" "receiver_type" NOT NULL,
    "receiver_id" TEXT NOT NULL,
    "client_id" TEXT,
    "project_id" TEXT,
    "kind" TEXT NOT NULL,
    "class" "notification_class" NOT NULL DEFAULT 'COALESCED',
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "actor_type" "ActorType",
    "actor_id" TEXT,
    "params" JSONB,
    "dedupe_key" TEXT,
    "read_at" TIMESTAMPTZ(6),
    "archived_at" TIMESTAMPTZ(6),
    "snoozed_till" TIMESTAMPTZ(6),
    "emailed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription" (
    "tenant_id" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "level" "subscription_level" NOT NULL DEFAULT 'PARTICIPATE',
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_pkey" PRIMARY KEY ("tenant_id","member_id","entity_type","entity_id")
);

-- CreateTable
CREATE TABLE "notification_preference" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "receiver_type" "receiver_type" NOT NULL DEFAULT 'MEMBER',
    "receiver_id" TEXT NOT NULL,
    "email_level" "email_level" NOT NULL DEFAULT 'PARTICIPATING',
    "in_app_level" "email_level" NOT NULL DEFAULT 'ALL',
    "digest_cadence" "digest_cadence" NOT NULL DEFAULT 'DAILY',
    "digest_hour" INTEGER NOT NULL DEFAULT 8,
    "digest_weekday" INTEGER,
    "quiet_hours_from" INTEGER,
    "quiet_hours_to" INTEGER,
    "timezone" TEXT,
    "per_kind" JSONB,
    "unsubscribe_token_hash" TEXT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "notification_preference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_outbox" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "receiver_type" "receiver_type" NOT NULL,
    "receiver_id" TEXT NOT NULL,
    "to_email" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "params" JSONB,
    "notification_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "config_set" TEXT,
    "send_after" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "email_outbox_status" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "locked_at" TIMESTAMPTZ(6),
    "sent_at" TIMESTAMPTZ(6),
    "ses_message_id" TEXT,
    "message_id_header" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "email_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_suppression" (
    "email" TEXT NOT NULL,
    "reason" "suppression_reason" NOT NULL,
    "source" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_suppression_pkey" PRIMARY KEY ("email")
);

-- CreateIndex
CREATE INDEX "workflow_state_tenant_id_project_id_category_idx" ON "workflow_state"("tenant_id", "project_id", "category");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_state_tenant_id_project_id_name_key" ON "workflow_state"("tenant_id", "project_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_state_tenant_id_project_id_rank_key" ON "workflow_state"("tenant_id", "project_id", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_state_tenant_id_id_key" ON "workflow_state"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_preset_tenant_id_name_key" ON "workflow_preset"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "work_item_tenant_id_project_id_state_id_rank_idx" ON "work_item"("tenant_id", "project_id", "state_id", "rank");

-- CreateIndex
CREATE INDEX "work_item_tenant_id_project_id_state_category_rank_idx" ON "work_item"("tenant_id", "project_id", "state_category", "rank");

-- CreateIndex
CREATE INDEX "work_item_tenant_id_assignee_member_id_state_category_targe_idx" ON "work_item"("tenant_id", "assignee_member_id", "state_category", "target_date");

-- CreateIndex
CREATE INDEX "work_item_tenant_id_parent_id_idx" ON "work_item"("tenant_id", "parent_id");

-- CreateIndex
CREATE INDEX "work_item_tenant_id_root_id_idx" ON "work_item"("tenant_id", "root_id");

-- CreateIndex
CREATE INDEX "work_item_tenant_id_milestone_id_idx" ON "work_item"("tenant_id", "milestone_id");

-- CreateIndex
CREATE INDEX "work_item_tenant_id_client_id_visibility_state_category_idx" ON "work_item"("tenant_id", "client_id", "visibility", "state_category");

-- CreateIndex
CREATE INDEX "work_item_tenant_id_project_id_archived_at_idx" ON "work_item"("tenant_id", "project_id", "archived_at");

-- CreateIndex
CREATE INDEX "work_item_tenant_id_project_id_triage_status_idx" ON "work_item"("tenant_id", "project_id", "triage_status");

-- CreateIndex
CREATE INDEX "work_item_tenant_id_source_system_source_id_idx" ON "work_item"("tenant_id", "source_system", "source_id");

-- CreateIndex
CREATE UNIQUE INDEX "work_item_tenant_id_project_id_number_key" ON "work_item"("tenant_id", "project_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "work_item_tenant_id_project_id_rank_key" ON "work_item"("tenant_id", "project_id", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "work_item_tenant_id_id_key" ON "work_item"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "work_item_activity_tenant_id_work_item_id_created_at_idx" ON "work_item_activity"("tenant_id", "work_item_id", "created_at");

-- CreateIndex
CREATE INDEX "work_item_activity_tenant_id_client_id_visibility_idx" ON "work_item_activity"("tenant_id", "client_id", "visibility");

-- CreateIndex
CREATE UNIQUE INDEX "label_tenant_id_project_id_name_key" ON "label"("tenant_id", "project_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "label_tenant_id_id_key" ON "label"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "work_item_label_tenant_id_label_id_idx" ON "work_item_label"("tenant_id", "label_id");

-- CreateIndex
CREATE INDEX "work_item_collaborator_tenant_id_member_id_idx" ON "work_item_collaborator"("tenant_id", "member_id");

-- CreateIndex
CREATE INDEX "work_item_subscriber_tenant_id_member_id_idx" ON "work_item_subscriber"("tenant_id", "member_id");

-- CreateIndex
CREATE INDEX "comment_tenant_id_subject_type_subject_id_created_at_idx" ON "comment"("tenant_id", "subject_type", "subject_id", "created_at");

-- CreateIndex
CREATE INDEX "comment_tenant_id_client_id_visibility_idx" ON "comment"("tenant_id", "client_id", "visibility");

-- CreateIndex
CREATE INDEX "comment_tenant_id_project_id_created_at_idx" ON "comment"("tenant_id", "project_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "comment_tenant_id_id_key" ON "comment"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "mention_tenant_id_mentioned_member_id_idx" ON "mention"("tenant_id", "mentioned_member_id");

-- CreateIndex
CREATE UNIQUE INDEX "mention_tenant_id_comment_id_mentioned_member_id_mentioned__key" ON "mention"("tenant_id", "comment_id", "mentioned_member_id", "mentioned_contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_template_tenant_id_name_key" ON "project_template"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "notification_tenant_id_receiver_type_receiver_id_created_at_idx" ON "notification"("tenant_id", "receiver_type", "receiver_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "notification_tenant_id_receiver_type_receiver_id_dedupe_key_idx" ON "notification"("tenant_id", "receiver_type", "receiver_id", "dedupe_key");

-- CreateIndex
CREATE INDEX "notification_tenant_id_entity_type_entity_id_idx" ON "notification"("tenant_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "subscription_tenant_id_entity_type_entity_id_idx" ON "subscription"("tenant_id", "entity_type", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_preference_tenant_id_receiver_type_receiver_id_key" ON "notification_preference"("tenant_id", "receiver_type", "receiver_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_outbox_idempotency_key_key" ON "email_outbox"("idempotency_key");

-- CreateIndex
CREATE INDEX "email_outbox_status_send_after_idx" ON "email_outbox"("status", "send_after");

-- CreateIndex
CREATE INDEX "email_outbox_tenant_id_receiver_type_receiver_id_created_at_idx" ON "email_outbox"("tenant_id", "receiver_type", "receiver_id", "created_at" DESC);

-- CreateIndex
-- (drift artifact removed: the live GIN index document_tenant_id_tags_idx
-- already exists with an equivalent definition — never recreate it here.)

-- AddForeignKey
ALTER TABLE "workflow_state" ADD CONSTRAINT "workflow_state_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_state" ADD CONSTRAINT "workflow_state_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "project"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_preset" ADD CONSTRAINT "workflow_preset_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item" ADD CONSTRAINT "work_item_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item" ADD CONSTRAINT "work_item_tenant_id_client_id_fkey" FOREIGN KEY ("tenant_id", "client_id") REFERENCES "client"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item" ADD CONSTRAINT "work_item_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "project"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item" ADD CONSTRAINT "work_item_tenant_id_state_id_fkey" FOREIGN KEY ("tenant_id", "state_id") REFERENCES "workflow_state"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item" ADD CONSTRAINT "work_item_tenant_id_assignee_member_id_fkey" FOREIGN KEY ("tenant_id", "assignee_member_id") REFERENCES "member"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item" ADD CONSTRAINT "work_item_tenant_id_assignee_contact_id_fkey" FOREIGN KEY ("tenant_id", "assignee_contact_id") REFERENCES "contact"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item" ADD CONSTRAINT "work_item_tenant_id_parent_id_fkey" FOREIGN KEY ("tenant_id", "parent_id") REFERENCES "work_item"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item" ADD CONSTRAINT "work_item_tenant_id_milestone_id_fkey" FOREIGN KEY ("tenant_id", "milestone_id") REFERENCES "milestone"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item" ADD CONSTRAINT "work_item_tenant_id_fixed_in_version_id_fkey" FOREIGN KEY ("tenant_id", "fixed_in_version_id") REFERENCES "project_version"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item" ADD CONSTRAINT "work_item_tenant_id_duplicate_of_id_fkey" FOREIGN KEY ("tenant_id", "duplicate_of_id") REFERENCES "work_item"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item_activity" ADD CONSTRAINT "work_item_activity_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item_activity" ADD CONSTRAINT "work_item_activity_tenant_id_client_id_fkey" FOREIGN KEY ("tenant_id", "client_id") REFERENCES "client"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item_activity" ADD CONSTRAINT "work_item_activity_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "project"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item_activity" ADD CONSTRAINT "work_item_activity_tenant_id_work_item_id_fkey" FOREIGN KEY ("tenant_id", "work_item_id") REFERENCES "work_item"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "label" ADD CONSTRAINT "label_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "label" ADD CONSTRAINT "label_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "project"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item_label" ADD CONSTRAINT "work_item_label_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item_label" ADD CONSTRAINT "work_item_label_tenant_id_work_item_id_fkey" FOREIGN KEY ("tenant_id", "work_item_id") REFERENCES "work_item"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item_label" ADD CONSTRAINT "work_item_label_tenant_id_label_id_fkey" FOREIGN KEY ("tenant_id", "label_id") REFERENCES "label"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item_collaborator" ADD CONSTRAINT "work_item_collaborator_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item_collaborator" ADD CONSTRAINT "work_item_collaborator_tenant_id_work_item_id_fkey" FOREIGN KEY ("tenant_id", "work_item_id") REFERENCES "work_item"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item_collaborator" ADD CONSTRAINT "work_item_collaborator_tenant_id_member_id_fkey" FOREIGN KEY ("tenant_id", "member_id") REFERENCES "member"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item_subscriber" ADD CONSTRAINT "work_item_subscriber_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item_subscriber" ADD CONSTRAINT "work_item_subscriber_tenant_id_work_item_id_fkey" FOREIGN KEY ("tenant_id", "work_item_id") REFERENCES "work_item"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_item_subscriber" ADD CONSTRAINT "work_item_subscriber_tenant_id_member_id_fkey" FOREIGN KEY ("tenant_id", "member_id") REFERENCES "member"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment" ADD CONSTRAINT "comment_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment" ADD CONSTRAINT "comment_tenant_id_client_id_fkey" FOREIGN KEY ("tenant_id", "client_id") REFERENCES "client"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment" ADD CONSTRAINT "comment_tenant_id_project_id_fkey" FOREIGN KEY ("tenant_id", "project_id") REFERENCES "project"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment" ADD CONSTRAINT "comment_tenant_id_parent_id_fkey" FOREIGN KEY ("tenant_id", "parent_id") REFERENCES "comment"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mention" ADD CONSTRAINT "mention_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mention" ADD CONSTRAINT "mention_tenant_id_comment_id_fkey" FOREIGN KEY ("tenant_id", "comment_id") REFERENCES "comment"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_template" ADD CONSTRAINT "project_template_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_tenant_id_client_id_fkey" FOREIGN KEY ("tenant_id", "client_id") REFERENCES "client"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_tenant_id_member_id_fkey" FOREIGN KEY ("tenant_id", "member_id") REFERENCES "member"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preference" ADD CONSTRAINT "notification_preference_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ════════════════════════════════════════════════════════════════════
-- HAND-WRITTEN SECTION (everything below this marker; the DDL above is
-- `prisma migrate diff` output). Phase 2W one-way doors: collation,
-- CHECKs, domain triggers, grants, RLS posture (class A / class B /
-- the Notification principal-scope carve-out / global suppression),
-- portal_enabled stamping + fan-out extension, and the search_index
-- (configs verified by scripts/neon-spike.ts 2026-08-20, 5/5 PASS).
-- ════════════════════════════════════════════════════════════════════

-- ── Collation: rank keys are byte-ordered, never locale-ordered ─────
ALTER TABLE workflow_state ALTER COLUMN rank TYPE text COLLATE "C";
ALTER TABLE work_item ALTER COLUMN rank TYPE text COLLATE "C";

-- ── CHECKs (DATA_MODEL.md §6.14 — every line has a data-layer test) ──
ALTER TABLE work_item
  ADD CONSTRAINT work_item_depth_range CHECK (depth BETWEEN 0 AND 2),
  ADD CONSTRAINT work_item_epic_is_root CHECK (type <> 'EPIC' OR (parent_id IS NULL AND depth = 0)),
  ADD CONSTRAINT work_item_task_depth CHECK (type <> 'TASK' OR depth <= 1),
  ADD CONSTRAINT work_item_subtask_depth CHECK (type <> 'SUBTASK' OR depth >= 1),
  ADD CONSTRAINT work_item_single_assignee CHECK (num_nonnulls(assignee_member_id, assignee_contact_id) <= 1),
  ADD CONSTRAINT work_item_contact_assignee_visible CHECK (assignee_contact_id IS NULL OR visibility = 'CLIENT_VISIBLE'),
  ADD CONSTRAINT work_item_request_source CHECK (kind <> 'REQUEST' OR source IN ('PORTAL', 'EMAIL', 'IN_APP')),
  ADD CONSTRAINT work_item_triage_has_status CHECK (triage_status IS NOT NULL OR state_category <> 'TRIAGE');

ALTER TABLE comment
  ADD CONSTRAINT comment_single_author CHECK (num_nonnulls(author_member_id, author_contact_id) = 1),
  ADD CONSTRAINT comment_client_visible_needs_client CHECK (visibility <> 'CLIENT_VISIBLE' OR client_id IS NOT NULL);

ALTER TABLE notification
  ADD CONSTRAINT notification_contact_needs_client CHECK (receiver_type <> 'CONTACT' OR client_id IS NOT NULL);

-- The unread badge (partial; §6.18)
CREATE INDEX notification_unread ON notification (tenant_id, receiver_type, receiver_id)
  WHERE read_at IS NULL AND archived_at IS NULL;

-- ── Domain triggers (SECURITY INVOKER — they read under the caller's
--    RLS, which is load-bearing: a contact resolving a comment subject
--    can only see rows the portal gate already allows) ────────────────

-- A state's category never changes (rollups/portal read categories).
CREATE OR REPLACE FUNCTION workflow_state_category_immutable() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.category IS DISTINCT FROM OLD.category THEN
    RAISE EXCEPTION 'workflow_state.category is immutable (create a new state and remap)';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER workflow_state_category_immutable
  BEFORE UPDATE OF category ON workflow_state
  FOR EACH ROW EXECUTE FUNCTION workflow_state_category_immutable();

-- Parent/tree guard: derives depth + root_id, enforces same-project,
-- strictly-higher parent type, depth <= 2 (which with the type ordering
-- also makes cycles unrepresentable), and child <= parent visibility.
-- Reparenting an item that has children is refused (service operation).
CREATE OR REPLACE FUNCTION work_item_parent_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  p work_item%ROWTYPE;
  rank_new int;
  rank_parent int;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.parent_id IS DISTINCT FROM OLD.parent_id THEN
    IF EXISTS (SELECT 1 FROM work_item c
                WHERE c.tenant_id = NEW.tenant_id AND c.parent_id = NEW.id) THEN
      RAISE EXCEPTION 'reparenting an item with children is a service operation';
    END IF;
  END IF;
  IF NEW.parent_id IS NULL THEN
    NEW.depth := 0;
    NEW.root_id := NEW.id;
  ELSE
    SELECT * INTO p FROM work_item
     WHERE tenant_id = NEW.tenant_id AND id = NEW.parent_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'parent work item not found in tenant';
    END IF;
    IF p.project_id <> NEW.project_id THEN
      RAISE EXCEPTION 'parent must belong to the same project';
    END IF;
    rank_new := CASE NEW.type WHEN 'EPIC' THEN 0 WHEN 'TASK' THEN 1 ELSE 2 END;
    rank_parent := CASE p.type WHEN 'EPIC' THEN 0 WHEN 'TASK' THEN 1 ELSE 2 END;
    IF rank_parent >= rank_new THEN
      RAISE EXCEPTION 'parent type must be strictly higher (EPIC > TASK > SUBTASK)';
    END IF;
    NEW.depth := p.depth + 1;
    NEW.root_id := p.root_id;
    IF NEW.depth > 2 THEN
      RAISE EXCEPTION 'work item tree is at most three levels deep';
    END IF;
    IF NEW.visibility = 'CLIENT_VISIBLE' AND p.visibility <> 'CLIENT_VISIBLE' THEN
      RAISE EXCEPTION 'a child cannot be CLIENT_VISIBLE under an INTERNAL parent';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER work_item_parent_guard
  BEFORE INSERT OR UPDATE OF parent_id, type, visibility, project_id ON work_item
  FOR EACH ROW EXECUTE FUNCTION work_item_parent_guard();

-- stateCategory is derived truth: synced from the state row, which must
-- belong to the same tenant AND project.
CREATE OR REPLACE FUNCTION work_item_state_sync() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  cat state_category;
BEGIN
  SELECT category INTO cat FROM workflow_state
   WHERE tenant_id = NEW.tenant_id AND id = NEW.state_id
     AND project_id = NEW.project_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'state does not belong to the item''s project';
  END IF;
  NEW.state_category := cat;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER work_item_state_sync
  BEFORE INSERT OR UPDATE OF state_id ON work_item
  FOR EACH ROW EXECUTE FUNCTION work_item_state_sync();

-- Moving an item across projects (or rewriting its denormalised client)
-- is a service operation — renumber, restate, re-rank, re-client —
-- never a column update.
CREATE OR REPLACE FUNCTION work_item_no_move() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.client_id IS DISTINCT FROM OLD.client_id THEN
    RAISE EXCEPTION 'moving a work item across projects is a service operation';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER work_item_no_move
  BEFORE UPDATE OF project_id, client_id ON work_item
  FOR EACH ROW EXECUTE FUNCTION work_item_no_move();

-- Downgrade refusal: flipping an item to INTERNAL is refused while any
-- CLIENT_VISIBLE child item / comment / attached document exists (the
-- bulk action flips children first, deepest first, in one tx).
CREATE OR REPLACE FUNCTION work_item_visibility_downgrade_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD.visibility = 'CLIENT_VISIBLE' AND NEW.visibility = 'INTERNAL' THEN
    IF EXISTS (SELECT 1 FROM work_item c
                WHERE c.tenant_id = NEW.tenant_id AND c.parent_id = NEW.id
                  AND c.visibility = 'CLIENT_VISIBLE' AND c.deleted_at IS NULL)
       OR EXISTS (SELECT 1 FROM comment c
                WHERE c.tenant_id = NEW.tenant_id AND c.subject_type = 'WORK_ITEM'
                  AND c.subject_id = NEW.id
                  AND c.visibility = 'CLIENT_VISIBLE' AND c.deleted_at IS NULL)
       OR EXISTS (SELECT 1 FROM document d
                WHERE d.tenant_id = NEW.tenant_id AND d.attached_to_type = 'WORK_ITEM'
                  AND d.attached_to_id = NEW.id AND d.visibility = 'CLIENT_VISIBLE') THEN
      RAISE EXCEPTION 'cannot make the item private while client-visible children exist';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER work_item_visibility_downgrade_guard
  BEFORE UPDATE OF visibility ON work_item
  FOR EACH ROW EXECUTE FUNCTION work_item_visibility_downgrade_guard();

-- Same refusal for documents that carry client-visible comments.
CREATE OR REPLACE FUNCTION document_visibility_downgrade_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD.visibility = 'CLIENT_VISIBLE' AND NEW.visibility = 'INTERNAL' THEN
    IF EXISTS (SELECT 1 FROM comment c
                WHERE c.tenant_id = NEW.tenant_id
                  AND c.visibility = 'CLIENT_VISIBLE' AND c.deleted_at IS NULL
                  AND ((c.subject_type = 'DOCUMENT' AND c.subject_id = NEW.id)
                    OR (c.subject_type = 'FILE_VERSION' AND c.subject_id IN (
                          SELECT fv.id FROM file_version fv
                           WHERE fv.tenant_id = NEW.tenant_id AND fv.document_id = NEW.id)))) THEN
      RAISE EXCEPTION 'cannot make the document private while client-visible comments exist';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER document_visibility_downgrade_guard
  BEFORE UPDATE OF visibility ON document
  FOR EACH ROW EXECUTE FUNCTION document_visibility_downgrade_guard();

-- Comment subject guard: validates the soft pointer, denormalises
-- client_id/project_id from the subject, refuses CLIENT_VISIBLE on an
-- invisible subject, and pins threads to one subject. Named
-- comment_denorm_guard so it fires BEFORE comment_stamp_portal_enabled
-- (alphabetical trigger order — the stamp needs project_id set).
CREATE OR REPLACE FUNCTION comment_denorm_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_client  text;
  v_project text;
  v_visible boolean;
  par       comment%ROWTYPE;
BEGIN
  IF NEW.subject_type = 'WORK_ITEM' THEN
    SELECT wi.client_id, wi.project_id, (wi.visibility = 'CLIENT_VISIBLE')
      INTO v_client, v_project, v_visible
      FROM work_item wi
     WHERE wi.tenant_id = NEW.tenant_id AND wi.id = NEW.subject_id;
  ELSIF NEW.subject_type = 'DOCUMENT' THEN
    SELECT d.client_id, d.project_id, (d.visibility = 'CLIENT_VISIBLE')
      INTO v_client, v_project, v_visible
      FROM document d
     WHERE d.tenant_id = NEW.tenant_id AND d.id = NEW.subject_id;
  ELSIF NEW.subject_type = 'PROJECT_VERSION' THEN
    SELECT pv.client_id, pv.project_id, (pv.status = 'SHIPPED')
      INTO v_client, v_project, v_visible
      FROM project_version pv
     WHERE pv.tenant_id = NEW.tenant_id AND pv.id = NEW.subject_id;
  ELSIF NEW.subject_type = 'FILE_VERSION' THEN
    SELECT d.client_id, d.project_id, (d.visibility = 'CLIENT_VISIBLE')
      INTO v_client, v_project, v_visible
      FROM file_version fv
      JOIN document d ON d.tenant_id = fv.tenant_id AND d.id = fv.document_id
     WHERE fv.tenant_id = NEW.tenant_id AND fv.id = NEW.subject_id;
  ELSE
    RAISE EXCEPTION 'comment subject type % not available yet', NEW.subject_type;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'comment subject not found in tenant';
  END IF;
  NEW.client_id := v_client;
  NEW.project_id := v_project;
  IF NEW.visibility = 'CLIENT_VISIBLE' AND NOT v_visible THEN
    RAISE EXCEPTION 'a comment cannot be CLIENT_VISIBLE on a subject the client cannot see';
  END IF;
  IF NEW.parent_id IS NOT NULL THEN
    SELECT * INTO par FROM comment
     WHERE tenant_id = NEW.tenant_id AND id = NEW.parent_id;
    IF NOT FOUND OR par.subject_type <> NEW.subject_type OR par.subject_id <> NEW.subject_id THEN
      RAISE EXCEPTION 'a reply must share its parent''s subject';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER comment_denorm_guard
  BEFORE INSERT OR UPDATE OF subject_type, subject_id, parent_id, visibility ON comment
  FOR EACH ROW EXECUTE FUNCTION comment_denorm_guard();

-- ── Grants (deny-default, explicit per table) ───────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE
  ON workflow_state, workflow_preset, work_item, work_item_activity,
     label, work_item_label, work_item_collaborator, work_item_subscriber,
     comment, mention, project_template, subscription,
     notification_preference, email_outbox
  TO app_runtime;
-- Notification: INSERT via notify.emit, UPDATE limited to inbox verbs;
-- DELETE (retention) is platform-only.
GRANT SELECT, INSERT ON notification TO app_runtime;
GRANT UPDATE (read_at, archived_at, snoozed_till) ON notification TO app_runtime;
-- Suppression is read-at-enqueue only for the runtime; writes come from
-- the SNS webhook / platform console under app_platform.
GRANT SELECT ON email_suppression TO app_runtime;

-- ── RLS — class A (portal_deny) ─────────────────────────────────────
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'workflow_state', 'workflow_preset', 'label', 'work_item_label',
    'work_item_collaborator', 'work_item_subscriber', 'mention',
    'project_template', 'subscription', 'notification_preference',
    'email_outbox'
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

-- ── RLS — class B projectScoped: work_item, work_item_activity ──────
-- Read gate is the standard three-term form; the WITH CHECK denies
-- contacts outright — a contact principal never INSERTs/UPDATEs these
-- tables directly (REQUEST intake is a brokered system-principal write;
-- this is defence in depth, not the grant).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['work_item', 'work_item_activity'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON %I
        AS PERMISSIVE FOR ALL TO app_runtime
        USING      (tenant_id = (SELECT current_setting('app.tenant_id', true)))
        WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true)))
    $p$, t);
    EXECUTE format($p$
      CREATE POLICY portal_gate ON %I
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
        )
    $p$, t);
  END LOOP;
END
$$;

-- ── RLS — comment: the ONE table a contact INSERTs directly ─────────
-- (contact-writable census, TENANCY.md §7.2). Reads: standard 3-term.
-- Contact INSERT is allowed only for a CLIENT_VISIBLE comment on the
-- contact's own client, authored as themselves, in a portal-enabled
-- context. Contact UPDATE/DELETE: none in v1.
ALTER TABLE comment ENABLE ROW LEVEL SECURITY;
ALTER TABLE comment FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON comment
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (tenant_id = (SELECT current_setting('app.tenant_id', true)))
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true)));

CREATE POLICY portal_gate ON comment
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
      visibility = 'CLIENT_VISIBLE'
      AND client_id = (SELECT current_setting('app.client_id', true))
      AND author_contact_id = (SELECT current_setting('app.principal_id', true))
      AND portal_enabled
    )
  );

CREATE POLICY portal_no_update ON comment
  AS RESTRICTIVE FOR UPDATE TO app_runtime
  USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');

CREATE POLICY portal_no_delete ON comment
  AS RESTRICTIVE FOR DELETE TO app_runtime
  USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');

-- ── RLS — notification: the principalScoped carve-out (§6.18) ───────
-- Reads and inbox updates are bound to the RECEIVER: a member sees own
-- MEMBER rows, a contact sees own CONTACT rows of its client, the
-- system principal sees all (fan-out + digests). INSERT is any
-- non-contact principal in tenant context (notify.emit fans out to
-- other receivers, so INSERT cannot be receiver-bound — and MUST use
-- createMany: INSERT..RETURNING would trip the SELECT binding).
-- DELETE is not granted to the runtime role at all (retention =
-- platform). Posture asserted by isolation.dbtest.ts (principalScoped).
ALTER TABLE notification ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON notification
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (tenant_id = (SELECT current_setting('app.tenant_id', true)))
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true)));

CREATE POLICY principal_scope ON notification
  AS RESTRICTIVE FOR SELECT TO app_runtime
  USING (
    (SELECT current_setting('app.principal', true)) IN ('system', 'platform_admin')
    OR (
      (SELECT current_setting('app.principal', true)) = 'member'
      AND receiver_type = 'MEMBER'
      AND receiver_id = (SELECT current_setting('app.principal_id', true))
    )
    OR (
      (SELECT current_setting('app.principal', true)) = 'contact'
      AND receiver_type = 'CONTACT'
      AND receiver_id = (SELECT current_setting('app.principal_id', true))
      AND client_id = (SELECT current_setting('app.client_id', true))
    )
  );

CREATE POLICY principal_scope_update ON notification
  AS RESTRICTIVE FOR UPDATE TO app_runtime
  USING (
    (SELECT current_setting('app.principal', true)) IN ('system', 'platform_admin')
    OR (
      (SELECT current_setting('app.principal', true)) = 'member'
      AND receiver_type = 'MEMBER'
      AND receiver_id = (SELECT current_setting('app.principal_id', true))
    )
    OR (
      (SELECT current_setting('app.principal', true)) = 'contact'
      AND receiver_type = 'CONTACT'
      AND receiver_id = (SELECT current_setting('app.principal_id', true))
      AND client_id = (SELECT current_setting('app.client_id', true))
    )
  )
  WITH CHECK (
    (SELECT current_setting('app.principal', true)) IN ('system', 'platform_admin')
    OR (
      (SELECT current_setting('app.principal', true)) = 'member'
      AND receiver_type = 'MEMBER'
      AND receiver_id = (SELECT current_setting('app.principal_id', true))
    )
    OR (
      (SELECT current_setting('app.principal', true)) = 'contact'
      AND receiver_type = 'CONTACT'
      AND receiver_id = (SELECT current_setting('app.principal_id', true))
      AND client_id = (SELECT current_setting('app.client_id', true))
    )
  );

CREATE POLICY portal_insert_deny ON notification
  AS RESTRICTIVE FOR INSERT TO app_runtime
  WITH CHECK ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');

-- ── RLS — email_suppression: global platform-owned (§6.18) ──────────
-- The global-table pattern (security_foundations): runtime may read
-- (checked at enqueue), contacts never.
ALTER TABLE email_suppression ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_suppression FORCE ROW LEVEL SECURITY;

CREATE POLICY allow_runtime ON email_suppression
  AS PERMISSIVE FOR ALL TO app_runtime
  USING (true) WITH CHECK (true);

CREATE POLICY portal_deny ON email_suppression
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');

-- ── portal_enabled maintenance: stamp the new projectScoped tables ──
-- (reuses stamp_portal_enabled() from the phase2 migration; trigger
-- names are pinned by the posture dbtest as <table>_stamp_portal_enabled.
-- comment_denorm_guard sorts before comment_stamp_portal_enabled, so
-- the stamp sees the denormalised project_id.)
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['work_item', 'work_item_activity', 'comment'] LOOP
    EXECUTE format($t$
      CREATE TRIGGER %I_stamp_portal_enabled
        BEFORE INSERT OR UPDATE OF project_id, portal_enabled ON %I
        FOR EACH ROW EXECUTE FUNCTION stamp_portal_enabled()
    $t$, t, t);
  END LOOP;
END
$$;

-- Fan-out now reaches every projectScoped table incl. the new three and
-- the search index (CREATE OR REPLACE; the posture dbtest checks each
-- UPDATE line against the registry).
CREATE OR REPLACE FUNCTION project_portal_enabled_fanout() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.portal_enabled IS DISTINCT FROM OLD.portal_enabled THEN
    UPDATE milestone          SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
    UPDATE project_version    SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
    UPDATE service            SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
    UPDATE document           SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
    UPDATE work_item          SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
    UPDATE work_item_activity SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
    UPDATE comment            SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
    UPDATE search_index       SET portal_enabled = NEW.portal_enabled WHERE tenant_id = NEW.tenant_id AND project_id = NEW.id;
  END IF;
  RETURN NULL;
END
$fn$;

-- ════════════════════════════════════════════════════════════════════
-- SEARCH (§6.19) — hand-written DDL; the app reads via $queryRaw only.
-- Configurations + IMMUTABLE generated column verified on the real
-- Neon project by scripts/neon-spike.ts (2026-08-20, 5/5 PASS).
-- ════════════════════════════════════════════════════════════════════

-- unaccent is a cluster-level extension the spike installed by hand on
-- the Neon project; declared here (idempotent, review 2026-08-21) so a
-- from-scratch `migrate deploy` — a new region, a local Postgres, a
-- restore — is self-contained. btree_gin / btree_gist are declared the
-- same way in their migrations.
CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE TEXT SEARCH CONFIGURATION fortleva_sv ( COPY = swedish );
ALTER TEXT SEARCH CONFIGURATION fortleva_sv
  ALTER MAPPING FOR hword, hword_part, word WITH unaccent, swedish_stem;
CREATE TEXT SEARCH CONFIGURATION fortleva_en ( COPY = english );
ALTER TEXT SEARCH CONFIGURATION fortleva_en
  ALTER MAPPING FOR hword, hword_part, word WITH unaccent, english_stem;

CREATE TABLE search_index (
  id                 text PRIMARY KEY DEFAULT (uuidv7())::text,
  tenant_id          text NOT NULL,
  entity_type        text NOT NULL, -- 'WORK_ITEM' | 'COMMENT' | 'DOCUMENT' | 'PROJECT' | 'CLIENT' | 'CONTACT' | …
  entity_id          text NOT NULL,
  client_id          text,          -- NULL = tenant-internal
  project_id         text,
  visibility         "Visibility" NOT NULL DEFAULT 'INTERNAL',
  portal_enabled     boolean NOT NULL DEFAULT false,
  title              text NOT NULL,
  subtitle           text,
  body_text          text,
  meta_text          text,          -- tags, username, url… never a secret
  lang               regconfig NOT NULL,
  search             tsvector GENERATED ALWAYS AS (
                       setweight(to_tsvector(lang, coalesce(title, '')), 'A') ||
                       setweight(to_tsvector(lang, coalesce(subtitle, '') || ' ' || coalesce(meta_text, '')), 'B') ||
                       setweight(to_tsvector(lang, left(coalesce(body_text, ''), 100000)), 'C')
                     ) STORED,
  state_category     state_category,
  assignee_member_id text,          -- staff filter; STRIPPED from portal projections
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT search_index_client_visible_needs_client
    CHECK (visibility <> 'CLIENT_VISIBLE' OR client_id IS NOT NULL),
  CONSTRAINT search_index_entity_unique UNIQUE (tenant_id, entity_type, entity_id)
);
CREATE INDEX search_index_tenant_updated  ON search_index (tenant_id, updated_at DESC);
CREATE INDEX search_index_project_updated ON search_index (tenant_id, project_id, updated_at DESC);
CREATE INDEX search_index_client_vis      ON search_index (tenant_id, client_id, visibility, updated_at DESC);
-- NO GIN on `search` at v1 (non-leakproof under FORCE RLS — §6.19).

GRANT SELECT, INSERT, UPDATE, DELETE ON search_index TO app_runtime;

ALTER TABLE search_index ENABLE ROW LEVEL SECURITY;
ALTER TABLE search_index FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON search_index
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (tenant_id = (SELECT current_setting('app.tenant_id', true)))
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true)));

-- Gate: three-term form when project-anchored, two-term otherwise.
-- The WITH CHECK also allows the one contact-caused write path — the
-- comment feed trigger firing under a contact INSERT.
CREATE POLICY portal_gate ON search_index
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING (
    (SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact'
    OR (
      client_id = (SELECT current_setting('app.client_id', true))
      AND visibility = 'CLIENT_VISIBLE'
      AND (project_id IS NULL OR portal_enabled)
    )
  )
  WITH CHECK (
    (SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact'
    OR (
      client_id = (SELECT current_setting('app.client_id', true))
      AND visibility = 'CLIENT_VISIBLE'
      AND (project_id IS NULL OR portal_enabled)
    )
  );

-- Language resolution for feed rows. SECURITY DEFINER, deliberately and
-- narrowly: the ONE contact-caused feed write (comment INSERT) cannot
-- read the tenant row under its own principal (portal_deny), and the
-- only fact returned is the tenant's default locale — not data.
-- search_path pinned; single-row lookup; fail-open to English.
CREATE OR REPLACE FUNCTION search_lang(tid text) RETURNS regconfig
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT CASE WHEN (SELECT default_locale FROM tenant WHERE id = tid) = 'sv'
              THEN 'fortleva_sv'::regconfig
              ELSE 'fortleva_en'::regconfig
         END
$fn$;

-- One upsert helper; each feed trigger builds its own projection.
CREATE OR REPLACE FUNCTION search_upsert(
  p_tenant text, p_type text, p_id text, p_client text, p_project text,
  p_visibility "Visibility", p_portal boolean, p_title text,
  p_subtitle text, p_body text, p_meta text,
  p_state state_category, p_assignee text
) RETURNS void
LANGUAGE sql AS $fn$
  INSERT INTO search_index (
    tenant_id, entity_type, entity_id, client_id, project_id,
    visibility, portal_enabled, title, subtitle, body_text, meta_text,
    lang, state_category, assignee_member_id, updated_at
  ) VALUES (
    p_tenant, p_type, p_id, p_client, p_project,
    p_visibility, p_portal, p_title, p_subtitle, p_body, p_meta,
    search_lang(p_tenant), p_state, p_assignee, now()
  )
  ON CONFLICT (tenant_id, entity_type, entity_id) DO UPDATE SET
    client_id = EXCLUDED.client_id,
    project_id = EXCLUDED.project_id,
    visibility = EXCLUDED.visibility,
    portal_enabled = EXCLUDED.portal_enabled,
    title = EXCLUDED.title,
    subtitle = EXCLUDED.subtitle,
    body_text = EXCLUDED.body_text,
    meta_text = EXCLUDED.meta_text,
    lang = EXCLUDED.lang,
    state_category = EXCLUDED.state_category,
    assignee_member_id = EXCLUDED.assignee_member_id,
    updated_at = now()
$fn$;

-- Feed: work_item (soft-deleted rows leave the index; archived stay).
CREATE OR REPLACE FUNCTION search_feed_work_item() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_key text;
BEGIN
  IF TG_OP = 'DELETE' OR NEW.deleted_at IS NOT NULL THEN
    DELETE FROM search_index
     WHERE tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id)
       AND entity_type = 'WORK_ITEM'
       AND entity_id = COALESCE(NEW.id, OLD.id);
    RETURN NULL;
  END IF;
  SELECT p.key INTO v_key FROM project p
   WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.project_id;
  PERFORM search_upsert(
    NEW.tenant_id, 'WORK_ITEM', NEW.id, NEW.client_id, NEW.project_id,
    NEW.visibility, NEW.portal_enabled, NEW.title,
    coalesce(v_key, '?') || '-' || NEW.number,
    NEW.description_text, NULL,
    NEW.state_category, NEW.assignee_member_id);
  RETURN NULL;
END
$fn$;
CREATE TRIGGER search_feed_work_item
  AFTER INSERT OR UPDATE OR DELETE ON work_item
  FOR EACH ROW EXECUTE FUNCTION search_feed_work_item();

-- Feed: comment.
CREATE OR REPLACE FUNCTION search_feed_comment() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.deleted_at IS NOT NULL THEN
    DELETE FROM search_index
     WHERE tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id)
       AND entity_type = 'COMMENT'
       AND entity_id = COALESCE(NEW.id, OLD.id);
    RETURN NULL;
  END IF;
  PERFORM search_upsert(
    NEW.tenant_id, 'COMMENT', NEW.id, NEW.client_id, NEW.project_id,
    NEW.visibility, NEW.portal_enabled,
    left(coalesce(NEW.body_text, ''), 140),
    NULL, NEW.body_text, NULL, NULL, NULL);
  RETURN NULL;
END
$fn$;
CREATE TRIGGER search_feed_comment
  AFTER INSERT OR UPDATE OR DELETE ON comment
  FOR EACH ROW EXECUTE FUNCTION search_feed_comment();

-- Feed: document.
CREATE OR REPLACE FUNCTION search_feed_document() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM search_index
     WHERE tenant_id = OLD.tenant_id AND entity_type = 'DOCUMENT' AND entity_id = OLD.id;
    RETURN NULL;
  END IF;
  PERFORM search_upsert(
    NEW.tenant_id, 'DOCUMENT', NEW.id, NEW.client_id, NEW.project_id,
    NEW.visibility, NEW.portal_enabled, NEW.name,
    NULL, NULL, array_to_string(NEW.tags, ' '), NULL, NULL);
  RETURN NULL;
END
$fn$;
CREATE TRIGGER search_feed_document
  AFTER INSERT OR UPDATE OR DELETE ON document
  FOR EACH ROW EXECUTE FUNCTION search_feed_document();

-- Feed: project (structural row — client-visible iff portal-enabled).
CREATE OR REPLACE FUNCTION search_feed_project() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM search_index
     WHERE tenant_id = OLD.tenant_id AND entity_type = 'PROJECT' AND entity_id = OLD.id;
    RETURN NULL;
  END IF;
  PERFORM search_upsert(
    NEW.tenant_id, 'PROJECT', NEW.id, NEW.client_id, NEW.id,
    'CLIENT_VISIBLE', NEW.portal_enabled, NEW.name,
    NEW.key, NEW.scope_summary, NULL, NULL, NULL);
  RETURN NULL;
END
$fn$;
CREATE TRIGGER search_feed_project
  AFTER INSERT OR UPDATE OR DELETE ON project
  FOR EACH ROW EXECUTE FUNCTION search_feed_project();

-- Feed: client (staff search only — INTERNAL by construction).
CREATE OR REPLACE FUNCTION search_feed_client() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM search_index
     WHERE tenant_id = OLD.tenant_id AND entity_type = 'CLIENT' AND entity_id = OLD.id;
    RETURN NULL;
  END IF;
  PERFORM search_upsert(
    NEW.tenant_id, 'CLIENT', NEW.id, NEW.id, NULL,
    'INTERNAL', false, NEW.name,
    NULL, NULL, coalesce(NEW.org_nr, ''), NULL, NULL);
  RETURN NULL;
END
$fn$;
CREATE TRIGGER search_feed_client
  AFTER INSERT OR UPDATE OR DELETE ON client
  FOR EACH ROW EXECUTE FUNCTION search_feed_client();

-- Feed: contact (staff search only — INTERNAL by construction).
CREATE OR REPLACE FUNCTION search_feed_contact() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM search_index
     WHERE tenant_id = OLD.tenant_id AND entity_type = 'CONTACT' AND entity_id = OLD.id;
    RETURN NULL;
  END IF;
  PERFORM search_upsert(
    NEW.tenant_id, 'CONTACT', NEW.id, NEW.client_id, NULL,
    'INTERNAL', false, NEW.name,
    NULL, NULL, NEW.email, NULL, NULL);
  RETURN NULL;
END
$fn$;
CREATE TRIGGER search_feed_contact
  AFTER INSERT OR UPDATE OR DELETE ON contact
  FOR EACH ROW EXECUTE FUNCTION search_feed_contact();

-- Backfill the index for rows that predate the triggers (runs as the
-- migration owner — no RLS concern).
INSERT INTO search_index (tenant_id, entity_type, entity_id, client_id, project_id,
                          visibility, portal_enabled, title, subtitle, body_text, meta_text, lang)
SELECT p.tenant_id, 'PROJECT', p.id, p.client_id, p.id,
       'CLIENT_VISIBLE', p.portal_enabled, p.name, p.key, p.scope_summary, NULL, search_lang(p.tenant_id)
  FROM project p
ON CONFLICT (tenant_id, entity_type, entity_id) DO NOTHING;

INSERT INTO search_index (tenant_id, entity_type, entity_id, client_id, project_id,
                          visibility, portal_enabled, title, subtitle, body_text, meta_text, lang)
SELECT c.tenant_id, 'CLIENT', c.id, c.id, NULL,
       'INTERNAL', false, c.name, NULL, NULL, coalesce(c.org_nr, ''), search_lang(c.tenant_id)
  FROM client c
ON CONFLICT (tenant_id, entity_type, entity_id) DO NOTHING;

INSERT INTO search_index (tenant_id, entity_type, entity_id, client_id, project_id,
                          visibility, portal_enabled, title, subtitle, body_text, meta_text, lang)
SELECT ct.tenant_id, 'CONTACT', ct.id, ct.client_id, NULL,
       'INTERNAL', false, ct.name, NULL, NULL, ct.email, search_lang(ct.tenant_id)
  FROM contact ct
ON CONFLICT (tenant_id, entity_type, entity_id) DO NOTHING;

INSERT INTO search_index (tenant_id, entity_type, entity_id, client_id, project_id,
                          visibility, portal_enabled, title, subtitle, body_text, meta_text, lang)
SELECT d.tenant_id, 'DOCUMENT', d.id, d.client_id, d.project_id,
       d.visibility, d.portal_enabled, d.name, NULL, NULL, array_to_string(d.tags, ' '), search_lang(d.tenant_id)
  FROM document d
ON CONFLICT (tenant_id, entity_type, entity_id) DO NOTHING;

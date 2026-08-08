-- Composite GIN indexes over (text, text[]) need btree_gin (document tags index)
CREATE EXTENSION IF NOT EXISTS btree_gin;

-- CreateEnum
CREATE TYPE "SessionPlane" AS ENUM ('MEMBER', 'PLATFORM');

-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'OFFBOARDING', 'CLOSED');

-- CreateEnum
CREATE TYPE "MemberStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "InviteStatus" AS ENUM ('PENDING', 'ACCEPTED', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "RolePermissionSource" AS ENUM ('TEMPLATE', 'TENANT_GRANT', 'TENANT_REVOKE');

-- CreateEnum
CREATE TYPE "Visibility" AS ENUM ('INTERNAL', 'CLIENT_VISIBLE');

-- CreateEnum
CREATE TYPE "AttachableType" AS ENUM ('CLIENT', 'PROJECT', 'PROJECT_VERSION', 'MILESTONE', 'SERVICE', 'CONTRACT', 'INVOICE', 'ISSUE');

-- CreateEnum
CREATE TYPE "FileObjectStatus" AS ENUM ('PENDING', 'COMMITTED', 'DELETED');

-- CreateEnum
CREATE TYPE "ScanStatus" AS ENUM ('UNSCANNED', 'CLEAN', 'INFECTED');

-- CreateEnum
CREATE TYPE "FileKind" AS ENUM ('GENERAL', 'INVOICE_PDF', 'CONTRACT_PDF', 'SIGNATURE_EVIDENCE', 'THUMBNAIL', 'EXPORT');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('MEMBER', 'CONTACT', 'PLATFORM_ADMIN', 'SYSTEM');

-- CreateEnum
CREATE TYPE "AuditVisibility" AS ENUM ('TENANT', 'PLATFORM');

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "locale" TEXT,
    "platform_role" TEXT,
    "role" TEXT,
    "banned" BOOLEAN NOT NULL DEFAULT false,
    "ban_reason" TEXT,
    "ban_expires" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "plane" "SessionPlane" NOT NULL DEFAULT 'MEMBER',
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "impersonated_by" TEXT,
    "active_tenant_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "password" TEXT,
    "access_token" TEXT,
    "refresh_token" TEXT,
    "id_token" TEXT,
    "access_token_expires_at" TIMESTAMPTZ(6),
    "refresh_token_expires_at" TIMESTAMPTZ(6),
    "scope" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "two_factor" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "backup_codes" TEXT NOT NULL,

    CONSTRAINT "two_factor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "passkey" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT,
    "public_key" TEXT NOT NULL,
    "credential_id" TEXT NOT NULL,
    "counter" INTEGER NOT NULL,
    "device_type" TEXT NOT NULL,
    "backed_up" BOOLEAN NOT NULL,
    "transports" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "passkey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legal_name" TEXT,
    "slug" TEXT NOT NULL,
    "status" "TenantStatus" NOT NULL DEFAULT 'TRIALING',
    "entitlements" JSONB NOT NULL,
    "entitlements_updated_at" TIMESTAMPTZ(6),
    "plan_code" TEXT,
    "stripe_customer_id" TEXT,
    "stripe_subscription_id" TEXT,
    "billing_currency" CHAR(3),
    "trial_ends_at" TIMESTAMPTZ(6),
    "permissions_version" INTEGER NOT NULL DEFAULT 1,
    "cell" TEXT,
    "database_url" TEXT,
    "org_nr" TEXT,
    "vat_number" TEXT,
    "seat" TEXT,
    "f_skatt_approved" BOOLEAN NOT NULL DEFAULT false,
    "address_line1" TEXT,
    "address_line2" TEXT,
    "postal_code" TEXT,
    "city" TEXT,
    "country_code" CHAR(2),
    "bankgiro" TEXT,
    "plusgiro" TEXT,
    "iban" TEXT,
    "bic" TEXT,
    "storage_used_bytes" BIGINT NOT NULL DEFAULT 0,
    "default_locale" TEXT NOT NULL DEFAULT 'sv',
    "suspended_at" TIMESTAMPTZ(6),
    "offboarded_at" TIMESTAMPTZ(6),
    "delete_after" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_preference" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_by_member_id" TEXT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tenant_preference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_counter" (
    "tenant_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "tenant_counter_pkey" PRIMARY KEY ("tenant_id","key")
);

-- CreateTable
CREATE TABLE "feature_flag" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "default_on" BOOLEAN NOT NULL DEFAULT false,
    "tenant_overrides" JSONB,
    "remove_by" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "feature_flag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "status" "MemberStatus" NOT NULL DEFAULT 'ACTIVE',
    "title" TEXT,
    "invited_by_id" TEXT,
    "joined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "suspended_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_invite" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "proposed_role_ids" JSONB NOT NULL,
    "token_hash" TEXT NOT NULL,
    "status" "InviteStatus" NOT NULL DEFAULT 'PENDING',
    "invited_by_member_id" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "accepted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_invite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permission" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "requires_mfa" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "template_key" TEXT,
    "cloned_from_key" TEXT,
    "template_version" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permission" (
    "tenant_id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "permission_id" TEXT NOT NULL,
    "source" "RolePermissionSource" NOT NULL DEFAULT 'TENANT_GRANT',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_permission_pkey" PRIMARY KEY ("tenant_id","role_id","permission_id")
);

-- CreateTable
CREATE TABLE "member_role" (
    "tenant_id" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "assigned_by_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_role_pkey" PRIMARY KEY ("tenant_id","member_id","role_id")
);

-- CreateTable
CREATE TABLE "document" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "client_id" TEXT,
    "project_id" TEXT,
    "name" TEXT NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "visibility" "Visibility" NOT NULL DEFAULT 'INTERNAL',
    "attached_to_type" "AttachableType",
    "attached_to_id" TEXT,
    "created_by_member_id" TEXT,
    "created_by_contact_id" TEXT,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_version" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "document_id" TEXT NOT NULL,
    "version_number" INTEGER NOT NULL,
    "file_object_id" TEXT NOT NULL,
    "note" TEXT,
    "uploaded_by_member_id" TEXT,
    "uploaded_by_contact_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "file_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_object" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "r2_key" TEXT NOT NULL,
    "kind" "FileKind" NOT NULL DEFAULT 'GENERAL',
    "sha256" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "content_type" TEXT NOT NULL,
    "original_filename" TEXT,
    "status" "FileObjectStatus" NOT NULL DEFAULT 'PENDING',
    "scan_status" "ScanStatus" NOT NULL DEFAULT 'UNSCANNED',
    "created_by_member_id" TEXT,
    "created_by_contact_id" TEXT,
    "committed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "file_object_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_event" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT,
    "actor_type" "ActorType" NOT NULL,
    "actor_id" TEXT,
    "impersonator_id" TEXT,
    "action" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" TEXT,
    "metadata" JSONB,
    "request_id" TEXT,
    "ip" TEXT,
    "user_agent" TEXT,
    "visibility" "AuditVisibility" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_key" ON "session"("token");

-- CreateIndex
CREATE INDEX "session_user_id_idx" ON "session"("user_id");

-- CreateIndex
CREATE INDEX "session_expires_at_idx" ON "session"("expires_at");

-- CreateIndex
CREATE INDEX "account_user_id_idx" ON "account"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "account_provider_id_account_id_key" ON "account"("provider_id", "account_id");

-- CreateIndex
CREATE INDEX "verification_identifier_idx" ON "verification"("identifier");

-- CreateIndex
CREATE INDEX "verification_expires_at_idx" ON "verification"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "two_factor_user_id_key" ON "two_factor"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "passkey_credential_id_key" ON "passkey"("credential_id");

-- CreateIndex
CREATE INDEX "passkey_user_id_idx" ON "passkey"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_slug_key" ON "tenant"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_stripe_customer_id_key" ON "tenant"("stripe_customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_preference_tenant_id_key_key" ON "tenant_preference"("tenant_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "feature_flag_key_key" ON "feature_flag"("key");

-- CreateIndex
CREATE INDEX "member_user_id_idx" ON "member"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "member_tenant_id_user_id_key" ON "member"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "member_tenant_id_id_key" ON "member"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "member_invite_token_hash_key" ON "member_invite"("token_hash");

-- CreateIndex
CREATE INDEX "member_invite_tenant_id_email_idx" ON "member_invite"("tenant_id", "email");

-- CreateIndex
CREATE INDEX "member_invite_expires_at_idx" ON "member_invite"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "permission_code_key" ON "permission"("code");

-- CreateIndex
CREATE INDEX "role_tenant_id_template_key_idx" ON "role"("tenant_id", "template_key");

-- CreateIndex
CREATE UNIQUE INDEX "role_tenant_id_name_key" ON "role"("tenant_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "role_tenant_id_id_key" ON "role"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "role_permission_tenant_id_permission_id_idx" ON "role_permission"("tenant_id", "permission_id");

-- CreateIndex
CREATE INDEX "member_role_tenant_id_role_id_idx" ON "member_role"("tenant_id", "role_id");

-- CreateIndex
CREATE INDEX "document_tenant_id_client_id_visibility_idx" ON "document"("tenant_id", "client_id", "visibility");

-- CreateIndex
CREATE INDEX "document_tenant_id_project_id_idx" ON "document"("tenant_id", "project_id");

-- CreateIndex
CREATE INDEX "document_tenant_id_attached_to_type_attached_to_id_idx" ON "document"("tenant_id", "attached_to_type", "attached_to_id");

-- CreateIndex
CREATE INDEX "document_tenant_id_tags_idx" ON "document" USING GIN ("tenant_id" text_ops, "tags");

-- CreateIndex
CREATE UNIQUE INDEX "document_tenant_id_id_key" ON "document"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "file_version_tenant_id_file_object_id_idx" ON "file_version"("tenant_id", "file_object_id");

-- CreateIndex
CREATE UNIQUE INDEX "file_version_tenant_id_document_id_version_number_key" ON "file_version"("tenant_id", "document_id", "version_number");

-- CreateIndex
CREATE UNIQUE INDEX "file_object_r2_key_key" ON "file_object"("r2_key");

-- CreateIndex
CREATE INDEX "file_object_tenant_id_status_idx" ON "file_object"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "file_object_tenant_id_sha256_idx" ON "file_object"("tenant_id", "sha256");

-- CreateIndex
CREATE INDEX "file_object_tenant_id_kind_idx" ON "file_object"("tenant_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "file_object_tenant_id_id_key" ON "file_object"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "audit_event_tenant_id_created_at_idx" ON "audit_event"("tenant_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_event_tenant_id_target_type_target_id_idx" ON "audit_event"("tenant_id", "target_type", "target_id");

-- CreateIndex
CREATE INDEX "audit_event_actor_type_actor_id_created_at_idx" ON "audit_event"("actor_type", "actor_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_event_request_id_idx" ON "audit_event"("request_id");

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "passkey" ADD CONSTRAINT "passkey_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_preference" ADD CONSTRAINT "tenant_preference_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_counter" ADD CONSTRAINT "tenant_counter_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member" ADD CONSTRAINT "member_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member" ADD CONSTRAINT "member_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_invite" ADD CONSTRAINT "member_invite_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role" ADD CONSTRAINT "role_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_tenant_id_role_id_fkey" FOREIGN KEY ("tenant_id", "role_id") REFERENCES "role"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_role" ADD CONSTRAINT "member_role_tenant_id_member_id_fkey" FOREIGN KEY ("tenant_id", "member_id") REFERENCES "member"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_role" ADD CONSTRAINT "member_role_tenant_id_role_id_fkey" FOREIGN KEY ("tenant_id", "role_id") REFERENCES "role"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document" ADD CONSTRAINT "document_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_version" ADD CONSTRAINT "file_version_tenant_id_document_id_fkey" FOREIGN KEY ("tenant_id", "document_id") REFERENCES "document"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_version" ADD CONSTRAINT "file_version_tenant_id_file_object_id_fkey" FOREIGN KEY ("tenant_id", "file_object_id") REFERENCES "file_object"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_object" ADD CONSTRAINT "file_object_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

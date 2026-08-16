-- ═══════════════════════════════════════════════════════════════════
-- Phase 1b foundations (plan §4 Phase 1b; SECURITY.md §6, DATA_MODEL §4).
--   * TenantKey — per-tenant envelope key (wrapped DEK), class A.
--   * Member.timezone / work_country / hours_per_day (locale fields).
-- Hand-written: Prisma-expressible DDL from `migrate diff`, then the
-- GRANT + RLS posture appended by hand (security_foundations template).
-- ═══════════════════════════════════════════════════════════════════

-- CreateEnum
CREATE TYPE "TenantKeyStatus" AS ENUM ('ACTIVE', 'RETIRED');

-- AlterTable
ALTER TABLE "member" ADD COLUMN     "hours_per_day" DECIMAL(4,2),
ADD COLUMN     "timezone" VARCHAR(64),
ADD COLUMN     "work_country" CHAR(2);

-- CreateTable
CREATE TABLE "tenant_key" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "key_id" TEXT NOT NULL,
    "wrapped_dek" TEXT NOT NULL,
    "root_key_id" TEXT NOT NULL,
    "status" "TenantKeyStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retired_at" TIMESTAMPTZ(6),

    CONSTRAINT "tenant_key_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tenant_key_tenant_id_status_idx" ON "tenant_key"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_key_tenant_id_key_id_key" ON "tenant_key"("tenant_id", "key_id");

-- AddForeignKey
ALTER TABLE "tenant_key" ADD CONSTRAINT "tenant_key_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Grants (deny-default; SECURITY.md §6: keys are never deleted by
-- the runtime role — retirement is a status UPDATE) ─────────────────
GRANT SELECT, INSERT, UPDATE ON tenant_key TO app_runtime;
-- app_platform already covers new tables via ALTER DEFAULT PRIVILEGES.

-- ── RLS — class A template (TENANCY.md §6.2 + §7.2 portal_deny) ─────
ALTER TABLE tenant_key ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_key FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenant_key
  AS PERMISSIVE FOR ALL TO app_runtime
  USING      (tenant_id = (SELECT current_setting('app.tenant_id', true)))
  WITH CHECK (tenant_id = (SELECT current_setting('app.tenant_id', true)));

CREATE POLICY portal_deny ON tenant_key
  AS RESTRICTIVE FOR ALL TO app_runtime
  USING ((SELECT current_setting('app.principal', true)) IS DISTINCT FROM 'contact');

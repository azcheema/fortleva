-- ═══════════════════════════════════════════════════════════════════
-- Phase 1b: step-up MFA (SECURITY.md §3.5, AUTHZ.md §7.5).
--   * session.mfa_verified_at — last interactive second-factor
--     verification on this session (NULL = none). Read by
--     requireTenantContext() → authorize() for ✦ codes.
--   * two_factor.verified / failed_verification_count / locked_until —
--     columns the Better Auth 1.6.26 twoFactor plugin writes on
--     enable / verify / lockout; missing until now (enable failed).
-- AUTH-class tables (TENANCY.md §6.3): no tenant RLS, portal_deny and
-- the app_runtime GRANTs from security_foundations already cover them.
-- ═══════════════════════════════════════════════════════════════════

-- AlterTable
ALTER TABLE "session" ADD COLUMN     "mfa_verified_at" TIMESTAMPTZ(6);

-- AlterTable
ALTER TABLE "two_factor" ADD COLUMN     "failed_verification_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "locked_until" TIMESTAMPTZ(6),
ADD COLUMN     "verified" BOOLEAN NOT NULL DEFAULT true;

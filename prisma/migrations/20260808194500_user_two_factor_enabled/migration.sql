-- Better Auth twoFactor plugin requires this column on user
-- (vendor plumbing; the authoritative MFA state remains the TwoFactor
-- row + our permission-attached enforcement, AUTHZ.md §7.5).
ALTER TABLE "user" ADD COLUMN "two_factor_enabled" BOOLEAN NOT NULL DEFAULT false;

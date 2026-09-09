/**
 * The platform-console admission rule, as PURE policy.
 *
 * It lives in its own module, importing nothing, for a reason worth
 * keeping: `./session` reaches `./index` and therefore `@/db/client`,
 * which throws without DATABASE_URL. A policy that can only be exercised
 * with a database in reach is a policy that gets tested against a
 * database or not at all — and this one is the gate in front of
 * `app_platform`, a BYPASSRLS cross-tenant role. Here it is a plain
 * function over plain values, and src/auth/platform-gate.test.ts pins
 * the whole matrix with no connection, no cookie and no Better Auth.
 * (CI leans on that: the unit suite runs in the isolation job before
 * `migrate deploy`, and nothing in it may open a connection.)
 */

/**
 * Why the console admits a request, or why it does not. A discriminated
 * result rather than a boolean because the two MFA outcomes need
 * DIFFERENT remedies — "enrol a factor" and "present the one you have"
 * are not the same instruction, and sending an unenrolled operator to a
 * verify prompt is how a sole operator gets locked out of their own
 * console.
 */
export type PlatformGate =
  | "no_session"
  | "not_superadmin"
  | "not_enrolled"
  | "unverified"
  | "ok";

export interface PlatformGateInput {
  /**
   * Optional like every other field, and for the same reason: absent
   * must DENY. A caller that forgets to pass it gets "no_session",
   * never an accidental pass.
   */
  readonly hasSession?: boolean;
  readonly plane?: string | null;
  readonly platformRole?: string | null;
  readonly twoFactorEnabled?: boolean | null;
  readonly mfaVerifiedAt?: Date | string | null;
}

/**
 * FAILS CLOSED at every step: anything not positively recognised is a
 * denial, and the checks are ordered so a denial never leaks a fact the
 * caller had not already established (see the ordering cases in the
 * test). Optional fields are typed optional on purpose — a MISSING
 * field is the failure this slice was written for. Better Auth returns
 * `undefined` for any column absent from an instance's declared table
 * schema (the USER_ADDITIONAL_FIELDS note in ./index), so `undefined`
 * must deny rather than pass.
 */
export function platformGateDecision(input: PlatformGateInput): PlatformGate {
  if (!input.hasSession) return "no_session";
  // Plane check on the ROW: a MEMBER session replayed against the
  // platform plane is rejected even if cookie handling ever regresses.
  if (input.plane !== "PLATFORM") return "no_session";
  // The authoritative platform flag (AUTHZ.md §9): User.platformRole —
  // never the admin-plugin `role` mirror, never a tenant Role.
  if (input.platformRole !== "SUPERADMIN") return "not_superadmin";
  // MFA is MANDATORY on this plane (SECURITY.md §3.5). It reaches
  // `app_platform`, a BYPASSRLS cross-tenant role; a password alone
  // must never get there. Both documents said so for months while the
  // code checked neither of the next two lines.
  if (input.twoFactorEnabled !== true) return "not_enrolled";
  // A factor must have been presented to THIS session. The stamp is
  // written only on /two-factor/verify-totp and
  // /two-factor/verify-backup-code (isFreshFactorPath), so a
  // trusted-device or password-only sign-in leaves it null and is
  // refused here. Session-LIFETIME rather than a rolling step-up
  // window, because the ops host has no step-up route to send anyone to:
  // a rolling window would strand the operator mid-task with no remedy
  // in reach.
  //
  // BE HONEST ABOUT WHAT THAT COSTS. "8h" on the platform session is an
  // IDLE timeout, not an absolute ceiling — `updateAge: 60 * 60` means
  // each use past the hour re-extends `expiresAt`, and the refresh is a
  // partial UPDATE that preserves this stamp. So a console session that
  // is used keeps rolling, and this check keeps passing, indefinitely.
  // An earlier draft of this comment claimed the 8h expiry bounded it;
  // that was wrong. Bounding it needs either an absolute session cap or
  // a stamp-age check here, and both need a step-up route on the ops
  // host first — tracked, not silently assumed away.
  if (!input.mfaVerifiedAt) return "unverified";
  return "ok";
}

/**
 * What may be done to a second factor, as PURE policy.
 *
 * Split from ./factor-guard for the same reason ./platform-gate is split
 * from ./session: the guard reaches `@/db/client`, which throws without
 * DATABASE_URL, so a rule that lived beside it could only be tested with
 * a database in reach. This is the rule that decides whether a password
 * holder can take over an account, so it is exercised by
 * src/auth/factor-policy.test.ts as a plain function over plain values.
 */

/** Better Auth endpoints that can change or reveal a second factor. */
export const GUARDED_FACTOR_PATHS = new Set([
  "/two-factor/enable",
  "/two-factor/disable",
  "/two-factor/get-totp-uri",
  "/two-factor/generate-backup-codes",
]);

/**
 * How recently a factor must have been PRESENTED for backup-code reissue
 * to be allowed. Far tighter than the 15-minute step-up window used for
 * permission checks: the caller stamps the session by verifying a live
 * code in the same request, so this only has to survive clock skew and
 * one round trip — never a user's train of thought.
 */
export const REISSUE_WINDOW_MS = 5 * 60_000;

export type FactorVerdict =
  /** Not a guarded path, or the account is not one this policy protects. */
  | "allow"
  /** No readable session: we cannot tell whose factor this would touch. */
  | "no_session"
  /** Reissue attempted without recent proof of the current factor. */
  | "needs_recent_factor"
  /** Enable on an account that already holds a verified factor. */
  | "already_enrolled"
  /** Disable / reveal: never permitted for this account. */
  | "frozen";

export interface FactorPolicyInput {
  readonly path: string;
  readonly hasSession?: boolean;
  /** Only a platform principal's factor is frozen; members self-serve. */
  readonly isPlatformPrincipal?: boolean;
  readonly hasVerifiedFactor?: boolean;
  readonly mfaVerifiedAt?: Date | string | null;
  /**
   * True only inside the backup-code reissue action (./reissue-intent).
   * A request cannot set it, which is the point: the stamp alone was too
   * loose, because every member-plane step-up writes one.
   */
  readonly hasReissueIntent?: boolean;
  readonly now: number;
}

/**
 * FAILS CLOSED: anything not positively recognised denies.
 *
 * The shape of the rule, and the reasoning behind each branch:
 *  - `disable` and `get-totp-uri` are never allowed. Both hand a password
 *    holder the account outright — one removes the factor, the other
 *    returns the secret.
 *  - `enable` is allowed only when NO verified factor exists. Better Auth
 *    otherwise deletes the secret and backup codes and recreates the row
 *    as verified, which is a silent factor swap with no proof of
 *    possession of the old one. First enrolment stays open: it is the
 *    bounded bootstrap window SECURITY.md §3.5 documents.
 *  - `generate-backup-codes` is allowed on TWO conditions together: the
 *    process-local marker only the reissue action opens
 *    (./reissue-intent), and a fresh `mfaVerifiedAt`, which only
 *    `verifyStepUpWithHeaders()` writes and only after verifying a live
 *    TOTP or an existing backup code. The stamp alone was the first
 *    version and was too loose — every member-plane step-up writes one,
 *    so a stolen member cookie plus the password could reissue inside
 *    the window of an unrelated step-up. Blocking it outright was the
 *    version of this policy and was wrong in a way that matters more than
 *    the attack it prevented: codes are shown once, at enrolment, and
 *    nothing else in this product can produce them — so an operator who
 *    loses them has no safety net, and a lost authenticator becomes a
 *    permanent lockout recoverable only by editing the database.
 */
export function factorMutationVerdict(input: FactorPolicyInput): FactorVerdict {
  if (!GUARDED_FACTOR_PATHS.has(input.path)) return "allow";
  if (!input.hasSession) return "no_session";
  // Ordinary members keep self-service 2FA; only the platform principal's
  // factor guards `app_platform`.
  if (!input.isPlatformPrincipal) return "allow";

  if (input.path === "/two-factor/generate-backup-codes") {
    // TWO conditions, and the marker is the load-bearing one. Keyed on
    // the stamp alone, a stolen member cookie plus the password could
    // reissue within the window of any unrelated step-up — the weak
    // plane minting the strong plane's second factors. The marker cannot
    // be set by a request; the stamp stays as the second condition so a
    // caller that forgets to verify a live code gets nothing either.
    if (!input.hasReissueIntent) return "needs_recent_factor";
    const raw = input.mfaVerifiedAt;
    if (!raw) return "needs_recent_factor";
    const stamp = raw instanceof Date ? raw.getTime() : Date.parse(raw);
    if (Number.isNaN(stamp)) return "needs_recent_factor";
    // A stamp in the future is a clock problem, not proof.
    const age = input.now - stamp;
    if (age < 0 || age > REISSUE_WINDOW_MS) return "needs_recent_factor";
    return "allow";
  }

  if (input.path === "/two-factor/enable") {
    return input.hasVerifiedFactor ? "already_enrolled" : "allow";
  }

  return "frozen";
}

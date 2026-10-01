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
  /** Not a guarded path, a first enrolment, or a reissue with proof. */
  | "allow"
  /** No readable session: we cannot tell whose factor this would touch. */
  | "no_session"
  /** Reissue attempted without recent proof of the current factor. */
  | "needs_recent_factor"
  /** Enable on an account that already holds a verified factor. */
  | "already_enrolled"
  /** Disable / reveal: never permitted — to a request or to our own code. */
  | "frozen";

/**
 * Deliberately says nothing about WHO the account belongs to (slice 83).
 * Until then a member's factor was self-service — `isPlatformPrincipal:
 * false` answered "allow" on all four paths — so a stolen member session
 * plus the password could read the seed, swap the factor, remove it or
 * mint backup codes, and with any of those pass every ✦ step-up a member
 * is asked for: the vault's reveal, role changes, the export. The rule
 * is the operator's rule for everyone now, and with no field for the
 * principal's kind the guard cannot hand one back an exemption.
 */
export interface FactorPolicyInput {
  readonly path: string;
  readonly hasSession?: boolean;
  /**
   * The account counts as ENROLLED — by the user's `twoFactorEnabled` flag
   * OR a verified factor row, whichever says so. Either alone is how the
   * plugin decides elsewhere (sign-in and step-up read the flag; `enable`
   * reads the row), so the guard asks both. Absent reads as enrolled.
   */
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
 * It applies to EVERY account with a factor — a member's and the
 * operator's alike — because what it protects is the step-up, and both
 * planes step up on the same factor. Nothing a member is offered needs
 * more: `/account` only enrols a first factor and reissues codes through
 * the action below; it has never had a "turn off" or "replace" control.
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
 *    the window of an unrelated step-up (and a backup code passes the
 *    vault's step-up as well as a live code does). Blocking it outright was the
 *    version of this policy and was wrong in a way that matters more than
 *    the attack it prevented: codes are shown once, at enrolment, and
 *    nothing else in this product can produce them — so an operator who
 *    loses them has no safety net, and a lost authenticator becomes a
 *    permanent lockout recoverable only by editing the database.
 */
export function factorMutationVerdict(input: FactorPolicyInput): FactorVerdict {
  if (!GUARDED_FACTOR_PATHS.has(input.path)) return "allow";
  if (!input.hasSession) return "no_session";

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
    // `=== false`, not falsy: a caller that forgot to ask is answered as
    // if the account were enrolled, which refuses (code review, slice 83).
    return input.hasVerifiedFactor === false ? "allow" : "already_enrolled";
  }

  return "frozen";
}

/**
 * The two code checks, when they run in Better Auth's SESSION mode — a
 * live session cookie came with them. Without one they finish a sign-in
 * and the plugin counts attempts per challenge and locks the account; with
 * one they count nothing (`verify-two-factor.mjs`'s session branch), so
 * each is an oracle for "is this code right?" to whoever holds a session.
 */
export const SESSION_VERIFY_PATHS = new Set(["/two-factor/verify-totp", "/two-factor/verify-backup-code"]);

export type SessionVerifyVerdict =
  /** The product's own step-up (./step-up), which spent the budget first. */
  | "allow"
  /** Confirming a first enrolment: allowed under a daily cap per member. */
  | "budget"
  /** An enrolled account asked over HTTP: only the step-up may ask. */
  | "step_up_only";

/**
 * Who may check a code against a live session (slice 83, the security
 * review's medium). Over HTTP the product asks it in one case only: the
 * enrolment screen confirming a factor that is not yet enrolled
 * (`/account`, `/ops/login`'s ramp) — answered under a daily cap per
 * member (`auth.enrol_confirm`), because a pending factor's code is
 * otherwise guessable with nothing but a session, for as long as the
 * pending row sits there, and a right guess mints a session stamped as
 * fresh. Every
 * check of an ENROLLED factor is the step-up, which runs in-process inside
 * its marker (./step-up-intent); without the marker it is a stolen
 * session guessing codes, and it is refused before Better Auth answers.
 */
export function sessionVerifyVerdict(input: {
  readonly enrolled: boolean;
  readonly hasStepUpIntent: boolean;
}): SessionVerifyVerdict {
  if (input.hasStepUpIntent) return "allow";
  return input.enrolled ? "step_up_only" : "budget";
}

/* eslint-disable no-restricted-imports -- sanctioned auth-layer consumer
   of the raw client (TENANCY.md §6.3), same as src/auth/index.ts. */
import { APIError } from "better-auth/api";

import { runtimeClient } from "@/db/client";
import { allowStrict } from "@/ratelimit";

import {
  GUARDED_FACTOR_PATHS,
  SESSION_VERIFY_PATHS,
  factorMutationVerdict,
  sessionVerifyVerdict,
} from "./factor-policy";
import { hasReissueIntent } from "./reissue-intent";
import { hasReplaceIntent } from "./replace-intent";
import { hasStepUpIntent } from "./step-up-intent";

/**
 * A PASSWORD MUST NEVER BE ABLE TO TAKE OVER ANYONE'S SECOND FACTOR.
 *
 * This module is the IO half; ./factor-policy holds the rule, its
 * reasoning, and its tests.
 *
 * The platform gate (./platform-gate) and every member step-up
 * (./step-up — the vault's reveal, role changes, the export) are only as
 * strong as the factor they check, and Better Auth's two-factor endpoints
 * are guarded by a session plus the account password — never by the
 * EXISTING factor. Four of them defeat a step-up for whoever holds the
 * password: `disable` removes it, `enable` on an enrolled account
 * silently swaps it, `get-totp-uri` returns the secret,
 * `generate-backup-codes` reissues the codes.
 *
 * IT GUARDS EVERY ACCOUNT, not only a SUPERADMIN's (slice 83). The first
 * version froze the operator's factor and left members self-service,
 * which handed a stolen member session plus the password the seed of the
 * factor the vault's step-up asks for. So the guard reads no role and is
 * given no plane: the policy has no input a role could fill, the guard
 * takes the instance's own cookie name from its context, a source pin in
 * vault-boundary.test.ts refuses a role or plane in this file, and — the
 * proof — `auth-audit.dbtest.ts` drives the live endpoints as an enrolled
 * member.
 *
 * AND THE CODE CHECKS, when a live session comes with them (slice 83, the
 * security review's medium): Better Auth counts no attempts in that mode,
 * so a stolen session alone could guess a live code and hand it to the
 * step-up. Only the step-up may ask that of an enrolled factor
 * (./step-up-intent); a first enrolment's confirmation is asked under a
 * daily cap per member (`auth.enrol_confirm`, ten a day, with an
 * in-process floor). ./factor-policy's `sessionVerifyVerdict`.
 *
 * IT RUNS AS THE INSTANCE'S OWN `hooks.before`, ahead of every plugin's
 * before-hook. A plugin that turns some other credential into a session
 * cookie in ITS before-hook (bearer, jwt, one-time-token — none is
 * registered today) would leave this guard reading no session where the
 * endpoint then finds one. Adding such a plugin means revisiting this.
 *
 * THE GUARD KEYS ON THE USER, NOT THE PLANE, and that is the whole point.
 * An earlier version lived only on the platform instance, which achieved
 * nothing: `TwoFactor.userId` is `@unique`, so a SUPERADMIN has exactly
 * ONE factor row and the member instance's `/api/auth/two-factor/disable`
 * deletes the very same row — the weak plane (7-day rolling,
 * sameSite=lax, no MFA requirement) mutating the strong plane's
 * credential. That is the same "both instances share one row set"
 * reasoning that removed `admin()`; it applies here too, so this runs on
 * BOTH instances.
 *
 * ROTATION AND RECOVERY. A lost authenticator is recovered with a backup
 * code; backup codes can be reissued from `/account` on proof of the
 * current factor; and since slice 84 (C50) the factor itself can be
 * REPLACED there, on the password plus proof of the current factor — a
 * live code, or an unused backup code when the phone is gone — through
 * the replacement marker (./replace-intent). A workspace owner can reset a
 * teammate's factor from Settings → Members (`./member-reset`), which is
 * the RUNBOOK reset below done by the app. Anything else — a sole owner,
 * a console principal, a member of more than one workspace — is the
 * operator's database reset, and it is
 * TWO statements at heart, which is worth stating exactly, because
 * getting it wrong bricks the account:
 *
 *     DELETE FROM two_factor WHERE user_id = $1;
 *     UPDATE "user" SET two_factor_enabled = false WHERE id = $1;
 *
 * The second is not optional. Better Auth decides whether to demand a
 * factor from `user.twoFactorEnabled`, NOT from the row's existence.
 * Delete the row alone and sign-in still demands a code, both verify
 * endpoints answer TOTP_NOT_ENABLED, no session is ever created, and
 * `/two-factor/enable` has no session to run under — a permanent lockout
 * with no way back through any request. (A session that SURVIVED the
 * half-applied reset is refused `enable` too, because the flag still says
 * enrolled — slice 83; before that, it let whoever held the password
 * plant their own factor.) Clearing the flag returns the account to the
 * first-enrolment ramp. Neither statement writes an audit row: record the
 * reset by hand (RUNBOOK §8), since `/two-factor/disable`, the only path
 * that wrote `auth.mfa_disabled`, is refused to every request.
 */

/**
 * What the guard needs of a Better Auth middleware context, and no more.
 * No PLANE: the instance's own `authCookies` name the cookie, so the guard
 * has nothing a plane test could be written against.
 */
export interface FactorGuardCtx {
  readonly path: string;
  getSignedCookie(key: string, secret: string): Promise<string | false | null>;
  readonly context: {
    readonly secret: string;
    readonly authCookies: { readonly sessionToken: { readonly name: string } };
  };
}

export async function guardFactorEndpoints(ctx: FactorGuardCtx): Promise<void> {
  const mutation = GUARDED_FACTOR_PATHS.has(ctx.path);
  if (!mutation && !SESSION_VERIFY_PATHS.has(ctx.path)) return;

  // THE SESSION BETTER AUTH WILL SEE, read the way it reads it — the same
  // call `getSession` makes (`api/routes/session.mjs`): its cookie parser,
  // its signature check, the instance's own cookie name. The guard used to
  // parse the header itself, and the two parsers disagreed: better-call
  // strips a quoted value (`name="<token>.<sig>"`) and the hand parser did
  // not, so a quoted cookie was "no session" here and a live session to the
  // endpoint — which skipped the code-check refusal below entirely (the
  // fix-pass review's HIGH, slice 83). A value that fails the signature is
  // `false`/`null` here and no session there alike.
  const token = await ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret);
  const session = token
    ? await runtimeClient.session.findUnique({
        where: { token },
        select: {
          mfaVerifiedAt: true,
          userId: true,
          expiresAt: true,
          user: { select: { twoFactorEnabled: true } },
        },
      })
    : null;

  // ENROLLED BY EITHER WITNESS (security review, slice 83): the user's
  // flag, which sign-in and the step-up read, OR a verified row, which
  // `enable` reads when it recreates one. Asking only the row let a
  // password plant a factor on an account whose flag was still set — the
  // half-applied database recovery above, or a failure between the
  // plugin's two writes in `verify-totp`. For EVERY account: this read
  // was once limited to a SUPERADMIN, and that is what let a member's
  // factor be swapped. `verified` is NOT NULL, so a present row that is
  // not `false` is exactly what `enable` treats as enrolled. The row is
  // read only when the flag has not already answered.
  const enrolled = async (s: NonNullable<typeof session>): Promise<boolean> =>
    s.user.twoFactorEnabled ||
    ((
      await runtimeClient.twoFactor.findUnique({
        where: { userId: s.userId },
        select: { verified: true },
      })
    )?.verified ??
      false);

  if (!mutation) {
    // A code check. With no LIVE session Better Auth finishes a sign-in,
    // counting attempts per challenge and locking the account itself, so
    // there is nothing for this guard to add. "Live" is its own test: a
    // row by the signed token, expired only when `expiresAt < now`
    // (`getSession`) — the same comparison, made a moment earlier, so the
    // clock can only tip the endpoint toward sign-in mode, the safe one.
    if (!session || session.expiresAt.getTime() < Date.now()) return;
    const verdict = sessionVerifyVerdict({
      enrolled: await enrolled(session),
      hasStepUpIntent: hasStepUpIntent(),
    });
    if (verdict === "allow") return;
    if (verdict === "step_up_only") {
      throw new APIError("FORBIDDEN", {
        message: "Confirm your code through the step-up form.",
        code: "FACTOR_STEP_UP_ONLY",
      });
    }
    // Confirming a first enrolment: a daily cap per member, because nothing
    // else counts these attempts and a pending factor can sit for months
    // (./factor-policy; `auth.enrol_confirm` in src/ratelimit says why a
    // total and not a rate — the fix-pass review's low).
    // STRICT: the in-process floor holds with or without Upstash, because
    // without it nothing else on this path counts per account (Better
    // Auth's own limiter is per IP; the narrow review's low).
    if (await allowStrict("auth.enrol_confirm", session.userId)) return;
    throw new APIError("TOO_MANY_REQUESTS", {
      message: "Too many attempts. Try again later.",
      code: "FACTOR_CONFIRM_LIMIT",
    });
  }

  // Looked up only when the answer can matter — the reissue and freeze
  // branches never consult it, so those pay one query, not two or three.
  const hasVerifiedFactor =
    session && ctx.path === "/two-factor/enable" ? await enrolled(session) : false;

  const verdict = factorMutationVerdict({
    path: ctx.path,
    hasSession: Boolean(session),
    hasVerifiedFactor,
    mfaVerifiedAt: session?.mfaVerifiedAt ?? null,
    hasReissueIntent: hasReissueIntent(),
    hasReplaceIntent: hasReplaceIntent(),
    now: Date.now(),
  });

  switch (verdict) {
    case "allow":
      return;
    case "no_session":
      throw new APIError("UNAUTHORIZED", { message: "Sign in again." });
    case "needs_recent_factor":
      throw new APIError("FORBIDDEN", {
        message: "Verify your current authenticator code first.",
      });
    case "already_enrolled":
      throw new APIError("FORBIDDEN", {
        message: "A second factor is already enrolled and cannot be replaced from here.",
        code: "FACTOR_ALREADY_ENROLLED",
      });
    case "frozen":
      throw new APIError("FORBIDDEN", {
        message: "This account's second factor cannot be changed from here.",
      });
  }
}

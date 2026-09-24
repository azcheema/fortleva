import { hashPassword } from "better-auth/crypto";

import { platformAuditRow } from "@/audit/platform-record";
import { MEMBER_RESET_STORED_PREFIX } from "@/auth/recovery-policy";
import { RESET_IDENTIFIER_PREFIX } from "@/auth/reset-identifier";
import { lockTimeoutSetting, withPlatform } from "@/db";
import type { Prisma } from "@/generated/prisma/client";

import {
  normaliseOpsAddress,
  refuseOpsResetInput,
  refuseOpsResetTarget,
  type OpsResetOutcome,
  type OpsResetRefusal,
} from "./reset-ops-password-policy";

/**
 * **THE OPERATOR'S RESET OF A FORGOTTEN CONSOLE PASSWORD** (OPEN_QUESTIONS
 * C30e) — the only remedy there is: the console serves no reset (slice 58),
 * and the member plane's declines anybody with a `platformRole`, because one
 * `account` row serves both planes. Driven by `scripts/reset-ops-password.ts`;
 * the policy it applies is `./reset-ops-password-policy`.
 *
 * What it does is Better Auth's own `/reset-password` for a SUPERADMIN, done
 * by hand under `withPlatform` — and the same clean-up the member plane's
 * reset does (`src/auth/member-recovery.ts`, `afterMemberPasswordReset`):
 *
 *  - **the credential**: every `credential` account row of the user takes the
 *    new hash, or one is created (`accountId` = the user id) if there is none —
 *    the library's own two branches, in its own shape.
 *  - **EVERY session of the user ends**, on both planes: they share the
 *    `session` table. That is the library's `revokeSessionsOnPasswordReset` —
 *    and it shares that setting's one window: a sign-in whose password check
 *    read the OLD hash while this transaction was open can still land its
 *    session after the purge. The lock below is `FOR NO KEY UPDATE` so such a
 *    session's foreign-key check is not HELD until commit (a `FOR UPDATE`
 *    lock made that window the whole transaction — review finding); running
 *    the script again ends anything that slipped through.
 *  - **every sign-in in flight ends**: a pending two-factor challenge (`2fa-…`
 *    with the user id in `value`) was opened with the OLD password and would
 *    otherwise still complete into a session for its ten minutes. The
 *    challenge's `2fa-attempts-…` / `2fa-otp-…` companions carry a count or a
 *    code in `value`, not the user id, so they are not matched: orphaned, they
 *    open nothing and expire with the challenge's ten minutes.
 *  - **every reset link of the user dies**, in either stored form. The member
 *    plane mails none to a console principal and refuses one on redemption,
 *    but a control whose premise is "nothing else writes it" earns a second.
 *
 * And what it deliberately does NOT touch:
 *
 *  - **the second factor** — the `two_factor` row and `user.two_factor_enabled`.
 *    A forgotten password is not a lost authenticator; the console will ask
 *    for the same code as before. A lost factor has its own documented
 *    two-statement recovery (SECURITY.md §3.5), and folding it in here would
 *    turn "I forgot my password" into "the password alone opens the console".
 *  - **trusted devices** (`trust-device-…`). Neither they nor the factor open
 *    the account without the new password; RUNBOOK §8 ends them all when that
 *    is what is wanted.
 *  - **the address's confirmation** — an unconfirmed account is REFUSED, not
 *    confirmed: this is not a mailbox proof, and the console would not sign it
 *    in anyway.
 *
 * AUDIT: one `platform.password_changed` row — actor SYSTEM (an operator at a
 * shell authenticated to nothing the product knows), target the user,
 * metadata `{ via: "operator", …counts }`, never an address or a secret — in
 * the SAME transaction as the change, beside `withPlatform`'s own
 * `platform.system_job` row, which carries the operator's `--reason` and the
 * job name. (Not the same `created_at`, to the millisecond: Prisma 7 fills
 * `@default(now())` on the CLIENT, once per query, not from Postgres's
 * transaction clock.)
 *
 * A REFUSAL WRITES NOTHING. The input refusals are decided before anything
 * connects; the account refusals are decided inside the writing transaction,
 * which a refusal rolls back — the seam's own audit row with it, since
 * `withPlatform` writes that row only after `fn` returns.
 *
 * A DRY RUN is a READ-ONLY `withPlatform`, so it changes nothing — but like
 * every read through that seam it is audited, after commit, as a
 * `platform.system_job` row with `readOnly: true`. That row is the seam's rule
 * (TENANCY.md §12: every invocation is audited), not this job's choice.
 */

export const RESET_OPS_PASSWORD_JOB = "reset-ops-password";

export type ResetOpsPasswordInput = {
  readonly email: string;
  readonly password: string;
  readonly reason: string;
  readonly dryRun?: boolean;
};

/** Thrown inside the transaction to roll it back; never escapes this module. */
class OpsResetRefused extends Error {
  constructor(readonly refusal: OpsResetRefusal) {
    super(`operator password reset refused: ${refusal}`);
  }
}

/** A pending two-factor challenge of `userId` — never its attempt counter, never a trusted device. */
const challengesOf = (userId: string): Prisma.VerificationWhereInput => ({
  value: userId,
  identifier: { startsWith: "2fa-" },
});

/** Every reset link of `userId`, in either stored form (`src/auth/recovery-policy.ts` says why both). */
const resetLinksOf = (userId: string): Prisma.VerificationWhereInput => ({
  value: userId,
  OR: [
    { identifier: { startsWith: MEMBER_RESET_STORED_PREFIX } },
    { identifier: { startsWith: RESET_IDENTIFIER_PREFIX } },
  ],
});

/**
 * An interactive transaction of about nine sequential statements, run from an
 * operator's machine that may be a long way from the database — so a wider
 * budget than the seam's 5 s default, which it scales by the link factor.
 */
const TX_TIMEOUT_MS = 15_000;

export async function resetOpsPassword(input: ResetOpsPasswordInput): Promise<OpsResetOutcome> {
  const email = normaliseOpsAddress(input.email);
  const reason = input.reason.trim();
  const early = refuseOpsResetInput({ email, password: input.password, reason });
  if (early) return { ok: false, refusal: early };

  if (input.dryRun) {
    return withPlatform(
      { type: "system", job: RESET_OPS_PASSWORD_JOB },
      `operator password reset (dry run): ${reason}`,
      async (tx): Promise<OpsResetOutcome> => {
        // Sequential, never a Promise.all: legs of one interactive
        // transaction share its one connection (AGENTS.md, standing traps).
        const user = await tx.user.findUnique({
          where: { email },
          select: { id: true, email: true, platformRole: true, emailVerified: true, twoFactorEnabled: true },
        });
        const refusal = refuseOpsResetTarget(user);
        if (refusal || !user) return { ok: false, refusal: refusal ?? "no_such_user" };
        const credentials = await tx.account.count({ where: { userId: user.id, providerId: "credential" } });
        const sessionsEnded = await tx.session.count({ where: { userId: user.id } });
        const challengesCancelled = await tx.verification.count({ where: challengesOf(user.id) });
        const resetLinksRevoked = await tx.verification.count({ where: resetLinksOf(user.id) });
        return {
          ok: true,
          dryRun: true,
          userId: user.id,
          email: user.email,
          credential: credentials === 0 ? "created" : "replaced",
          sessionsEnded,
          challengesCancelled,
          resetLinksRevoked,
          secondFactorEnrolled: user.twoFactorEnabled,
        };
      },
      { readOnly: true, timeoutMs: TX_TIMEOUT_MS },
    );
  }

  // OUTSIDE the transaction: scrypt is deliberately slow, and every
  // millisecond inside is a millisecond of a held row lock. The same function
  // the instances use (neither overrides `password.hash`), so sign-in on
  // either plane verifies what this writes.
  const hash = await hashPassword(input.password);

  try {
    return await withPlatform(
      { type: "system", job: RESET_OPS_PASSWORD_JOB },
      `operator password reset: ${reason}`,
      async (tx): Promise<OpsResetOutcome> => {
        // LOCK, then re-read: the account refusals are decided on the row as
        // it is now, and nothing can change its role or confirmation between
        // the check and the write. NO KEY UPDATE — every write to the user row
        // takes at least that mode, while a session INSERT's foreign-key check
        // (KEY SHARE) is not blocked until commit. The wait is bounded: a
        // statement parked on a lock ignores the transaction budget.
        await tx.$queryRaw`SELECT set_config('lock_timeout', ${lockTimeoutSetting(5000)}, true)`;
        await tx.$queryRaw`SELECT 1 FROM "user" WHERE email = ${email} FOR NO KEY UPDATE`;
        const user = await tx.user.findUnique({
          where: { email },
          select: { id: true, email: true, platformRole: true, emailVerified: true, twoFactorEnabled: true },
        });
        const refusal = refuseOpsResetTarget(user);
        if (refusal || !user) throw new OpsResetRefused(refusal ?? "no_such_user");

        const replaced = await tx.account.updateMany({
          where: { userId: user.id, providerId: "credential" },
          data: { password: hash },
        });
        if (replaced.count === 0) {
          await tx.account.create({
            data: { userId: user.id, providerId: "credential", accountId: user.id, password: hash },
            select: { id: true },
          });
        }
        const sessions = await tx.session.deleteMany({ where: { userId: user.id } });
        const challenges = await tx.verification.deleteMany({ where: challengesOf(user.id) });
        const resetLinks = await tx.verification.deleteMany({ where: resetLinksOf(user.id) });

        // Written directly rather than through `recordPlatformEvent`, which
        // opens its own connection outside this transaction: the row must
        // commit or roll back WITH the change it describes.
        await tx.auditEvent.create({
          data: platformAuditRow({
            action: "platform.password_changed",
            actorUserId: null,
            targetType: "user",
            targetId: user.id,
            metadata: {
              via: "operator",
              sessionsEnded: sessions.count,
              challengesCancelled: challenges.count,
              resetLinksRevoked: resetLinks.count,
            },
          }),
          select: { id: true },
        });

        return {
          ok: true,
          dryRun: false,
          userId: user.id,
          email: user.email,
          credential: replaced.count === 0 ? "created" : "replaced",
          sessionsEnded: sessions.count,
          challengesCancelled: challenges.count,
          resetLinksRevoked: resetLinks.count,
          secondFactorEnrolled: user.twoFactorEnabled,
        };
      },
      { readOnly: false, timeoutMs: TX_TIMEOUT_MS },
    );
  } catch (error) {
    if (error instanceof OpsResetRefused) return { ok: false, refusal: error.refusal };
    throw error;
  }
}

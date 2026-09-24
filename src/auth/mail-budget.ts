/* eslint-disable no-restricted-imports -- the auth layer is the one
   sanctioned consumer of the raw client outside src/db (TENANCY.md §6.3);
   `auth_mail` is an AUTH-class table like `verification`. */
import { runtimeClient } from "@/db/client";
import { lockTimeoutSetting, txOptions } from "@/db";

import { AUTH_MAIL_WINDOW_MS, AUTH_MAILS_PER_HOUR } from "./recovery-policy";

/**
 * **THE PER-RECIPIENT CAP ON THE MEMBER PLANE'S AUTH MAIL** (C30) — SECURITY.md
 * §4's "3 / h per email", for the two mails a stranger can make this plane
 * send to somebody: a reset link (anyone who knows an address) and a fresh
 * confirmation link (anyone who knows an unconfirmed account's password —
 * which, in the pre-account-takeover case, is the stranger and not the owner).
 *
 * The per-IP limiters in front of both endpoints cannot do this job: ours
 * fails open until Upstash exists, Better Auth's is per process, and a flood
 * aimed at one inbox simply rotates addresses. A budget keyed on the
 * RECIPIENT and counted in Postgres holds against all of that, and it costs
 * nothing a caller can observe: both endpoints answer the same whether the
 * mail went or not.
 *
 * **COUNTED IN A LEDGER OF ITS OWN (`auth_mail`), NOT WHERE THE MAIL LIVES.**
 * A confirmation link is a JWT and writes no row; a reset link does write
 * one, into the `verification` table the trusted devices (one per device, for
 * thirty days) and any abandoned or in-flight two-factor challenges share
 * under the same user id — the portal's count-by-`value` would have refused a
 * reset to anybody with three trusted devices. (A COMPLETED two-factor
 * sign-in consumes its challenge; the migration's header says "signed in with
 * a second factor three times", which is true only of sign-ins abandoned at
 * the code screen — it is left as applied.) The ledger records ATTEMPTS, so a link that is used
 * or purged cannot refill the budget; the caller removes a row whose send
 * FAILED (`releaseAuthMail`), so three transport failures cannot lock a
 * person out of their own mail for the hour — the portal learned that one.
 *
 * **EXACT UNDER CONCURRENCY.** The reservation takes the USER row's lock
 * (`FOR NO KEY UPDATE`: it serialises reservations for one person while
 * leaving the foreign-key checks of their sessions and accounts — which take
 * `KEY SHARE` — unblocked), reads the database's clock in the same
 * statement, and only then counts and inserts. So a burst of simultaneous
 * requests mails exactly the first three, and the window is measured on one
 * clock: rows are stamped by Postgres, and a window computed from an app
 * instance's `Date.now()` would narrow or widen with that instance's drift
 * (`rank-lock.ts`'s `lockContactRequestBudget` says the same). A user row that
 * no longer exists yields no clock, and no mail.
 *
 * The wait is bounded: a statement blocked on a lock ignores the transaction
 * budget, and only `lock_timeout` ends it. A reservation that times out
 * throws, which the caller treats as a failed send.
 */

export type AuthMailKind = "PASSWORD_RESET" | "EMAIL_VERIFICATION";

/**
 * Long enough for any honest wait behind one other reservation or one
 * user-row write — scaled by the same link factor as every other lock bound
 * here (`lockTimeoutSetting`), because the holder is as far from the
 * database as we are (review finding: unscaled, a burst queued on one user
 * timed out across the Neon link).
 */
const LOCK_WAIT_MS = 2000;

/**
 * Reserve one mail of `kind` for `userId`: the ledger row's id when the send
 * may go ahead, null when the person has had `AUTH_MAILS_PER_HOUR` of that
 * kind in the last hour (or no longer exists). Rows older than the window are
 * pruned in the same transaction, so the table holds at most a few rows per
 * person and needs no sweep.
 */
export async function reserveAuthMail(userId: string, kind: AuthMailKind): Promise<string | null> {
  return runtimeClient.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('lock_timeout', ${lockTimeoutSetting(LOCK_WAIT_MS)}, true)`;
    const rows = await tx.$queryRaw<{ now: Date }[]>`
      SELECT now() AS now FROM "user" WHERE id = ${userId} FOR NO KEY UPDATE`;
    const now = rows[0]?.now;
    if (!now) return null;
    const since = new Date(now.getTime() - AUTH_MAIL_WINDOW_MS);
    await tx.authMail.deleteMany({ where: { userId, createdAt: { lte: since } } });
    const sent = await tx.authMail.count({ where: { userId, kind, createdAt: { gt: since } } });
    if (sent >= AUTH_MAILS_PER_HOUR) return null;
    const row = await tx.authMail.create({
      data: { userId, kind, createdAt: now },
      select: { id: true },
    });
    return row.id;
  }, txOptions());
}

/** Give a reserved slot back — for a send that failed, which no inbox received. */
export async function releaseAuthMail(id: string): Promise<void> {
  await runtimeClient.authMail.deleteMany({ where: { id } });
}

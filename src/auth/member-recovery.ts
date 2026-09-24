/* eslint-disable no-restricted-imports -- the auth layer is the one
   sanctioned consumer of the raw client outside src/db (TENANCY.md §6.3). */
import { absoluteUrl, appUrl } from "@/config";
import { runtimeClient } from "@/db/client";
import { safeNext } from "@/lib/safe-next";
import { send } from "@/mailer";

import { releaseAuthMail, reserveAuthMail } from "./mail-budget";
import {
  EMAIL_CONFIRMATION_TTL_SECONDS,
  MEMBER_RESET_STORED_PREFIX,
  MEMBER_RESET_TTL_SECONDS,
} from "./recovery-policy";
import { RESET_IDENTIFIER_PREFIX, storedResetIdentifierOf } from "./reset-identifier";

/**
 * **MEMBER ACCOUNT RECOVERY** (OPEN_QUESTIONS C30) — everything that decides
 * who is mailed a reset or confirmation link on the member plane, whether a
 * reset link still works, and what a successful reset cleans up. The two
 * reset screens drive Better Auth's own endpoints from the browser; the
 * endpoints answer anybody with curl whether or not a screen exists, so every
 * control lives HERE, on the instance's callbacks and hooks. (Confirming an
 * address is not the library's any more: `./member-screens`,
 * `confirmMemberEmail`.)
 *
 * It follows the portal's reset (`src/auth/portal.ts`, slice 57) in every
 * shape that carried over — the mail after the response, the link built on
 * the server, a hashed token, a per-recipient cap, a re-read before sending,
 * a failed send giving its slot back — and differs where the member plane
 * does:
 *
 *  1. **THE TABLE IS SHARED.** `verification` also holds two-factor
 *     challenges and trusted devices under the same user id, on BOTH the
 *     member and the platform planes. So a reset link is stored under a
 *     prefix of its own (`./reset-identifier`), every purge here names that
 *     prefix, and the cap counts a ledger of its own (`./mail-budget`).
 *  2. **A CONSOLE PRINCIPAL IS NOT RESET FROM HERE.** Both instances read one
 *     `user` table and one credential row, so a member-plane reset of the
 *     operator's address would set the CONSOLE password from a mailbox — the
 *     door slice 58 closed on the ops host, reopened one host over. Anyone
 *     with a `platformRole` is declined on request, refused on redemption and
 *     shown the dead-link page; their password is the operator script's
 *     (`scripts/reset-ops-password.ts`).
 *  3. **THE PERSON MAY NOT HAVE CONFIRMED THEIR ADDRESS**, and that is the
 *     case this flow exists for as much as the forgotten password: the owner
 *     of an address a stranger signed up first. A reset link proves control of
 *     the mailbox exactly as the confirmation link does, so a completed reset
 *     CONFIRMS the address too (`afterMemberPasswordReset`) — and it replaces
 *     the stranger's password and ends every session, theirs included.
 *
 * NO NAME IN EITHER MAIL, unlike the portal's. A member's name is whatever
 * was typed at sign-up — on a stranger's pre-registration, whatever the
 * STRANGER typed — so "Hello {name}" would put an attacker's sentence into a
 * mail sent from our domain to their target.
 */

/** A plausible reset token before anything is hashed or looked up (Better Auth mints 24 alphanumerics). */
const RESET_TOKEN_SHAPE = /^[A-Za-z0-9_-]{1,128}$/;

/** A console principal — anybody the platform plane would recognise. */
const isConsolePrincipal = (platformRole: unknown): boolean =>
  typeof platformRole === "string" && platformRole !== "";

/** Every reset link of `userId`, in either stored form — and nothing else in the table. */
const resetRowsOf = (userId: string) => ({
  value: userId,
  OR: [
    { identifier: { startsWith: MEMBER_RESET_STORED_PREFIX } },
    // The plain form the library would still redeem through its fallback,
    // were one ever written (no member-plane code path writes it).
    { identifier: { startsWith: RESET_IDENTIFIER_PREFIX } },
  ],
});

/**
 * The link in the reset mail — the new-password SCREEN, never Better Auth's
 * `/reset-password/:token` callback (which this plane does not serve), and
 * never a caller's `redirectTo`: nothing a request body carries reaches a mail.
 */
export const memberResetUrl = (token: string): string => absoluteUrl(`/reset-password/${token}`);

/**
 * The link in the confirmation mail — our CONFIRMATION PAGE, not Better
 * Auth's `/verify-email`, which this plane refuses. That endpoint confirms on
 * the link alone and on a bare GET, which is what a mail scanner does to every
 * link in a business inbox; the page confirms only when a person enters the
 * account's password and presses its button (`/confirm-email/[token]`,
 * `confirmMemberEmail`).
 */
export function confirmEmailUrl(token: string, next: string): string {
  const url = new URL(absoluteUrl(`/confirm-email/${token}`));
  if (next !== "/home") url.searchParams.set("next", next);
  return url.toString();
}

/**
 * Where the person was going — as a same-origin path, or `/home`. From
 * sign-up, it is the `callbackURL` the library folded into its own link. A
 * SIGN-IN sends none (the login form's docblock says why), so the library's
 * link says `/`, and for that case the `next` of the referring `/login` page
 * is used instead: an invitee whose first link lapsed signs in at
 * `/login?next=/invite/…`, and without this their fresh link would have led
 * them to an empty dashboard instead of the invitation (review finding).
 * Both go through the product's one redirect guard, and a referrer the
 * browser withheld simply falls back.
 */
export function nextOf(libraryUrl: string, referer: string | null = null): string {
  let requested: string | null = null;
  try {
    requested = new URL(libraryUrl).searchParams.get("callbackURL");
  } catch {
    requested = null;
  }
  const next = safeNext(requested, "/home");
  if (next !== "/" && next !== "/home") return next;
  try {
    const from = referer === null ? null : new URL(referer);
    if (from && from.origin === appUrl.origin && from.pathname === "/login") {
      const carried = safeNext(from.searchParams.get("next"), "/home");
      return carried === "/" ? "/home" : carried;
    }
  } catch {
    // An unreadable referrer is no referrer.
  }
  return "/home";
}

/**
 * THE RESET MAIL, AFTER THE RESPONSE (the instance hands it to
 * `afterResponse`; exported so the DB suite can await it). Better Auth writes
 * the row before calling back, so every decline removes the row it declined:
 * a link that was never mailed is a token nobody holds.
 *
 * Declines — each removes the row:
 *   1. a console principal (header, point 2);
 *   2. the account is gone, or no longer at the address the request named —
 *      for the portal's reason (a request that raced a change);
 *   3. `AUTH_MAILS_PER_HOUR` reset mails already went to this person this hour.
 * The first two are decided by a RE-READ of the user, not the library's
 * snapshot of it.
 * One outcome is not a decline: the row is already gone (used, or purged by a
 * reset that finished first) — nothing to send, nothing to remove. A send
 * that FAILS gives its slot back and removes its row, then rethrows.
 */
export async function deliverMemberReset(
  user: { id: string; email: string } & Record<string, unknown>,
  token: string,
): Promise<"sent" | "declined" | "gone"> {
  const identifier = storedResetIdentifierOf(token);
  const decline = async (): Promise<"declined"> => {
    await runtimeClient.verification.deleteMany({ where: { identifier } });
    return "declined";
  };

  const own = await runtimeClient.verification.findFirst({ where: { identifier }, select: { id: true } });
  if (!own) return "gone";
  // The RE-READ is the authority for every decline below, the console one
  // included: the library's snapshot is only what was true when the request
  // arrived, and a check of it beside this one could never be caught failing.
  const now = await runtimeClient.user.findUnique({
    where: { id: user.id },
    select: { email: true, platformRole: true },
  });
  if (!now || isConsolePrincipal(now.platformRole) || now.email !== user.email) return decline();

  let slot: string | null;
  try {
    slot = await reserveAuthMail(user.id, "PASSWORD_RESET");
  } catch (error) {
    await decline().catch(() => undefined);
    throw error;
  }
  if (!slot) {
    // The user id only: this line is world-readable in a CI log.
    console.warn(`[auth] reset mail declined: hourly cap reached for user ${user.id}`);
    return decline();
  }

  const minutes = Math.round(MEMBER_RESET_TTL_SECONDS / 60);
  try {
    await send({
      to: user.email,
      subject: "Reset your Fortleva password",
      text:
        `Hello,\n\n` +
        `Somebody asked to reset the password of the Fortleva account at this address.\n\n` +
        `Choose a new password: ${memberResetUrl(token)}\n\n` +
        `The link works once, for ${minutes} minutes. If you did not ask for this, ignore this email — your password has not changed.`,
    });
  } catch (error) {
    // The TRANSPORT error is the one worth rethrowing; a failing cleanup is
    // said separately rather than allowed to replace the cause.
    await Promise.all([releaseAuthMail(slot), decline()]).catch((cleanup: unknown) => {
      console.error(`[auth] unsent reset mail not cleaned up for user ${user.id}`, cleanup);
    });
    throw error;
  }
  return "sent";
}

/**
 * THE CONFIRMATION MAIL, AFTER THE RESPONSE — for sign-up (`sendOnSignUp`)
 * and, since C30, for a sign-in with the right password to an account whose
 * address is not confirmed yet (`sendOnSignIn`). The second is what ends the
 * dead end slice 58 recorded: a person whose one link expired can now get
 * another by doing the obvious thing, signing in.
 *
 * Declines (a JWT has no row to remove): the account is gone, already
 * confirmed, no longer at that address, or a console principal; or
 * `AUTH_MAILS_PER_HOUR` confirmation mails already went this hour — which is
 * the cap that stops a stranger who knows the password of an account they
 * pre-registered from filling its owner's inbox by signing in, the one caller
 * the library itself does not bound at all.
 *
 * `url` is the library's `/verify-email` link; only its `callbackURL` is used,
 * as where to send the person once they have confirmed and signed in, with
 * `referer` as the fallback `nextOf` explains.
 *
 * The WORDING does not say an account was "just created": a sign-in sends
 * this too, and a mail that read like the owner's own sign-up is exactly what
 * the pre-account takeover leaned on (review finding). It says what confirming
 * takes — the account's password — which the owner of a stranger's
 * registration does not have; the page then sends them to "Forgot your
 * password?".
 */
export async function deliverMemberConfirmation(
  user: { id: string; email: string },
  url: string,
  token: string,
  referer: string | null = null,
): Promise<"sent" | "declined"> {
  const now = await runtimeClient.user.findUnique({
    where: { id: user.id },
    select: { email: true, emailVerified: true, platformRole: true },
  });
  if (!now || now.emailVerified || now.email !== user.email || isConsolePrincipal(now.platformRole)) {
    return "declined";
  }
  const slot = await reserveAuthMail(user.id, "EMAIL_VERIFICATION");
  if (!slot) {
    console.warn(`[auth] confirmation mail declined: hourly cap reached for user ${user.id}`);
    return "declined";
  }

  const minutes = Math.round(EMAIL_CONFIRMATION_TTL_SECONDS / 60);
  try {
    await send({
      to: user.email,
      subject: "Confirm your email address for Fortleva",
      text:
        `Hello,\n\n` +
        `To finish setting up the Fortleva account at this address, confirm it here — you will need the password it was created with: ${confirmEmailUrl(token, nextOf(url, referer))}\n\n` +
        `The link works for ${minutes} minutes. If you did not create a Fortleva account, ignore this email: nobody can sign in to it until the address is confirmed with that password.`,
    });
  } catch (error) {
    await releaseAuthMail(slot).catch((cleanup: unknown) => {
      console.error(`[auth] unsent confirmation slot not released for user ${user.id}`, cleanup);
    });
    throw error;
  }
  return "sent";
}

/**
 * WHO A RESET LINK WOULD RESET, for the new-password screen: the address, and
 * whether a second factor will be asked for, when the link is live and its
 * account is not a console principal's; null for everything else — unknown,
 * expired, used, superseded — because the page renders one state for all.
 *
 * THE EXPIRY IS CHECKED HERE because the library's lookup does not check it
 * (only the consuming POST does), and a page built on it alone would draw the
 * form for a link the POST is certain to refuse.
 */
export async function memberResetHolder(
  token: string,
): Promise<{ email: string; twoFactor: boolean } | null> {
  if (!RESET_TOKEN_SHAPE.test(token)) return null;
  const row = await runtimeClient.verification.findFirst({
    where: { identifier: storedResetIdentifierOf(token) },
    orderBy: { createdAt: "desc" },
    select: { value: true, expiresAt: true },
  });
  if (!row || row.expiresAt < new Date()) return null;
  const user = await runtimeClient.user.findUnique({
    where: { id: row.value },
    select: { email: true, platformRole: true, twoFactorEnabled: true },
  });
  if (!user || isConsolePrincipal(user.platformRole)) return null;
  return { email: user.email, twoFactor: user.twoFactorEnabled };
}

/**
 * For the member instance's `hooks.before`: `/reset-password` for a CONSOLE
 * PRINCIPAL is refused with the library's own refusal. It BURNS every reset
 * link that person holds — in either stored form, because the library's
 * consume falls back to the plain one — and lets the library find nothing and
 * answer `INVALID_TOKEN`, byte-identical to an expired link, so no refusal
 * body is copied by hand. The request path declines to mail a console
 * principal, so a link can only exist here if something else wrote it; a
 * control whose premise is "nothing else writes it" earns a second one at the
 * point of use (the portal's `burnResetTokenOfInactiveContact`, for the same
 * reason).
 *
 * It throws only if the database does, which fails the reset closed.
 */
export async function refuseResetOfConsolePrincipal(ctx: {
  readonly path: string;
  readonly body?: unknown;
  readonly query?: unknown;
}): Promise<void> {
  if (ctx.path !== "/reset-password") return;
  const fromBody = (ctx.body as { token?: unknown } | undefined)?.token;
  const fromQuery = (ctx.query as { token?: unknown } | undefined)?.token;
  const token = typeof fromBody === "string" && fromBody !== "" ? fromBody : fromQuery;
  // ANY non-empty string, whatever its shape or length: the library consumes
  // `reset-password:<token>` for any string, so a shape filter here — the
  // first cut had one — let an oddly-shaped planted link through unchecked
  // (review finding). The lookup is two exact-match reads.
  if (typeof token !== "string" || token === "") return;
  const rows = await runtimeClient.verification.findMany({
    where: { identifier: { in: [storedResetIdentifierOf(token), `${RESET_IDENTIFIER_PREFIX}${token}`] } },
    select: { value: true },
  });
  for (const userId of new Set(rows.map((r) => r.value))) {
    const user = await runtimeClient.user.findUnique({ where: { id: userId }, select: { platformRole: true } });
    if (isConsolePrincipal(user?.platformRole)) {
      await runtimeClient.verification.deleteMany({ where: resetRowsOf(userId) });
    }
  }
}

/**
 * AFTER A SUCCESSFUL RESET, before the library ends the person's sessions:
 *
 *  - **every OTHER reset link dies.** The library consumes only the one used,
 *    so the older mails in the same inbox would each set the password again
 *    for the rest of their hour.
 *  - **every sign-in in flight dies**: a pending two-factor challenge (`2fa-…`)
 *    was opened with the OLD password, and for its ten minutes it would still
 *    complete into a session the reset was meant to prevent. Trusted devices
 *    are left alone — neither they nor the second factor open the account
 *    without the new password.
 *  - **the address is confirmed.** Whoever used the link read it in that
 *    mailbox, which is all a confirmation proves. This is what closes the
 *    pre-account takeover for its owner: a stranger's sign-up is replaced by
 *    the owner's password, confirmed, with the stranger signed out.
 *
 * It must never throw: the library calls it BEFORE it revokes the sessions,
 * so an exception here would leave alive every session the reset was meant
 * to end. Each step is caught on its own, so one failing cannot skip another.
 */
export async function afterMemberPasswordReset(userId: string): Promise<void> {
  try {
    await runtimeClient.verification.deleteMany({
      where: {
        value: userId,
        OR: [
          ...resetRowsOf(userId).OR,
          // `2fa-attempts-…` rows carry a count in `value`, not the user id,
          // so this matches the challenges and never their attempt counters.
          { identifier: { startsWith: "2fa-" } },
        ],
      },
    });
  } catch (error) {
    console.error(`[auth] reset links and challenges not purged for user ${userId}`, error);
  }
  try {
    await runtimeClient.user.updateMany({
      where: { id: userId, emailVerified: false },
      data: { emailVerified: true },
    });
  } catch (error) {
    console.error(`[auth] address not confirmed after reset for user ${userId}`, error);
  }
}

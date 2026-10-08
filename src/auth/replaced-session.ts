import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";

import { isFreshFactorPath } from "./audit-hooks";

/**
 * A NEW SIGN-IN ON A BROWSER ENDS THE PREVIOUS PERSON'S SIGN-IN THERE (Phase 5
 * slice 106; founder decision C74 (l)).
 *
 * Someone who closes a shared browser without signing out leaves a live
 * session row behind; a colleague who then signs in on that browser replaces
 * the cookie, so the old session can never be used from it again — but the row
 * stayed alive for up to a week, and the first person's phone notifications
 * (whose stop is the end of the device's sign-in, C74 (d)) kept showing to the
 * colleague (both reviews' low). So when a password sign-in SUCCEEDS on a
 * browser whose request still carried a member-plane session cookie of a
 * DIFFERENT person, that session is deleted, as Better Auth's own sign-out
 * deletes it (`internalAdapter.deleteSession`). No audit row: a sign-out writes
 * none either.
 *
 * ON AN ACCOUNT WITH A SECOND FACTOR TOO (the fix-pass review's medium): the
 * plugin runs BEFORE twoFactor (`src/auth/index.ts`), whose after-hook deletes
 * the password step's pending session, nulls `newSession` and expires the
 * browser's session cookie — so the next request (the code) carries no session
 * cookie at all, and only this hook, seeing the pending session, knows whose
 * correct password it was. The previous person's session is then unusable from
 * this browser whether or not the code is ever entered, so ending it there is
 * the same act. The fresh-factor paths stay matched as a belt: a code that
 * completes a sign-in over a still-present cookie of someone else.
 *
 * NEVER THE SAME PERSON: their own earlier session on this browser is theirs to
 * keep, and the step-up and re-sign-in paths stay exactly as they were.
 *
 * READ THE WAY THE LIBRARY READS IT (memory: a guard that re-derives what the
 * library sees must use the library's own reader): `ctx.getSignedCookie` with
 * this instance's session-cookie name and secret — sign-out's own call. An
 * after-hook's throw becomes the response (`audit-hooks.ts`'s `guarded` note),
 * so the whole body is caught and logged by name: a completed sign-in is never
 * turned into an error by this.
 *
 * Member instance only: the console's sessions are another plane, another
 * cookie and another secret.
 */

const SIGN_IN_PATH = "/sign-in/email";

export const replacedSessionPlugin = (): BetterAuthPlugin => ({
  id: "fortleva-replaced-session",
  hooks: {
    after: [
      {
        matcher: (ctx) => ctx.path === SIGN_IN_PATH || isFreshFactorPath(ctx.path),
        handler: createAuthMiddleware(async (ctx) => {
          try {
            const created = ctx.context.newSession;
            if (!created) return; // a pending second factor, or a refusal
            const previous = await ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret);
            if (!previous || previous === created.session.token) return;
            const found = await ctx.context.internalAdapter.findSession(previous);
            if (!found || found.session.userId === created.user.id) return;
            await ctx.context.internalAdapter.deleteSession(previous);
          } catch (e) {
            console.error("[auth] ending a replaced session failed", e instanceof Error ? e.name : typeof e);
          }
        }),
      },
    ],
  },
});

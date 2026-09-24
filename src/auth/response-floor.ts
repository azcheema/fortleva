/**
 * A MINIMUM RESPONSE TIME for the unauthenticated auth endpoints whose
 * timing would otherwise say who has an account. Two of them today:
 *
 *  - the PORTAL's `/request-password-reset` — would say who is a client;
 *  - the MEMBER plane's `/sign-up/email` — would say who is a member
 *    (slice 58). Its answer for an address already registered is a stand-in
 *    user the library never writes, while a new address costs two INSERTs;
 *    `src/auth/sign-up-answer.ts` makes the two BODIES and STATUSES alike,
 *    and this makes the two DURATIONS alike.
 *
 * **WHY A FLOOR AND NOT A BALANCED CODE PATH.** The endpoint's body and
 * status are the same for every address, but Better Auth's two branches do
 * different work: on the portal, an address that belongs to a contact (in
 * ANY status) writes a reset row, and one that does not looks up a dummy
 * token, falls back to the plain identifier, and sweeps expired rows. The
 * difference is a couple of database round trips, it depends on the library
 * version and on `verification.storeIdentifier`, and the first version of
 * the reset slice claimed — in a comment and in PLAN — that it had been
 * reduced to "one INSERT against one SELECT", which a fresh review measured
 * to be false, and made WORSE by that same slice's hashing. Counting another
 * library's queries is not a control. Making every answer take at least the
 * same wall time is: below the floor, both branches are indistinguishable
 * however many statements either issues.
 *
 * The mail itself is already off the clock on both endpoints (the portal's
 * `deliverPortalReset` and the member plane's verification mail both run
 * after the response, `src/auth/after-response.ts`); this covers what is
 * left.
 *
 * WHAT IT IS NOT: a floor hides differences smaller than itself. A branch
 * that ever takes longer than the floor leaks for that request — which is
 * why it is set far above what either branch should cost once the app and
 * its database sit in the same region (a handful of indexed statements, and
 * one password hash on BOTH sign-up branches), not tuned to the edge. That
 * cost is NOT MEASURED — there is no production deployment yet, and the dev
 * link is transatlantic — so measure both branches before anybody lowers
 * either floor. Network jitter between the caller and the server is the
 * caller's noise, not our signal.
 *
 * Pure, and free of server imports, so it is unit-tested with a fake clock.
 */

/** Long enough that neither branch comes near it; short enough not to feel slow. */
export const RESET_REQUEST_FLOOR_MS = 1000;

/**
 * The same reasoning, for a request a person makes once. Sign-up already
 * pays a password hash on both branches, so the floor mostly absorbs the
 * new address's two INSERTs.
 */
export const SIGN_UP_FLOOR_MS = 1000;

/**
 * Is this a POST to the endpoint `suffix` names? Matched loosely on purpose:
 * decoded, case-folded, trailing slashes ignored — a variant the router would
 * not route costs a second of the caller's own time, while a variant it DOES
 * route and this missed would be the oracle again. A path that cannot be
 * decoded gets the floor too.
 */
function isPostTo(request: Request, suffix: string): boolean {
  if (request.method.toUpperCase() !== "POST") return false;
  let path: string;
  try {
    path = decodeURIComponent(new URL(request.url).pathname);
  } catch {
    return true;
  }
  return path.replace(/\/+$/, "").toLowerCase().endsWith(suffix);
}

/** The portal's reset REQUEST (not the reset itself). */
export const isPortalResetRequest = (request: Request): boolean =>
  isPostTo(request, "/request-password-reset");

/** The member plane's sign-up. */
export const isSignUpRequest = (request: Request): boolean => isPostTo(request, "/sign-up/email");

/**
 * Wrap a route handler so that, for requests `applies` selects, the
 * response is released no earlier than `floorMs` after it arrived —
 * whether the handler returned or threw.
 */
export function withResponseFloor(
  handler: (request: Request) => Promise<Response>,
  applies: (request: Request) => boolean,
  floorMs: number,
  clock: {
    now: () => number;
    sleep: (ms: number) => Promise<void>;
  } = {
    now: () => performance.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  },
): (request: Request) => Promise<Response> {
  return async (request) => {
    if (!applies(request)) return handler(request);
    const started = clock.now();
    try {
      return await handler(request);
    } finally {
      const left = floorMs - (clock.now() - started);
      if (left > 0) await clock.sleep(left);
    }
  };
}

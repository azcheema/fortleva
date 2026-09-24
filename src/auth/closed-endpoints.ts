import { APIError } from "better-auth/api";

/**
 * **ENDPOINTS THE MEMBER AND PLATFORM PLANES DO NOT SERVE** (slice 58).
 *
 * Better Auth 1.6.26 mounts its base endpoints whatever it is configured with
 * (`getEndpoints` registers them unconditionally); configuration decides only
 * how each one answers. Several of the ones these two planes carried were
 * unauthenticated doors with no screen in front of them and no use behind
 * them, and "no screen" is not a control — the portal's reset slice (57) is
 * the record of that — so they are refused here, BY ENDPOINT, before the
 * library's handler runs.
 *
 * **DO NOT DROP AN ENTRY BECAUSE ITS FEATURE LOOKS UNCONFIGURED.** Removing
 * `sendResetPassword` makes `/request-password-reset` refuse, but
 * `/reset-password` checks nothing of the kind: it consumes any
 * `reset-password:` row it finds in the shared `verification` table and sets
 * the password. The list is the control.
 *
 * WHAT WAS WRONG WITH EACH, measured against 1.6.26:
 *
 *  - **`/request-password-reset`** answered anyone on both planes. It AWAITED
 *    the mail (a stopwatch that says who is a user, through a constant
 *    body), stored the live token verbatim in `verification`, capped nothing
 *    per recipient — and the link it mailed could not be used by a person:
 *    neither plane has a reset screen, and the library's callback with no
 *    `callbackURL` leads nowhere. On the PLATFORM plane it also mailed
 *    "reset your Fortleva platform password" to any MEMBER it was given, since
 *    both instances read one `user` table.
 *  - **`/reset-password`** consumes a link and sets the password;
 *    **`/reset-password/:token`** checks one and redirects with it. On EITHER
 *    plane, because both read one `verification` table, so a token minted on
 *    one could be spent on the other.
 *  - **`/send-verification-email`**, on the member plane, mailed any
 *    UNVERIFIED user to a stranger's order, and with no mail transport it
 *    rethrew the failure as a 500 for exactly those addresses — the
 *    enumeration oracle again, by a second door. Nothing in the product calls
 *    it: sign-up sends the one verification mail itself (`sendOnSignUp`). On
 *    the platform plane it refused already; it is listed so that stays true
 *    whatever that instance is later configured with.
 *  - **`/change-email`**, on the member plane, had no screen, and its
 *    confirmation callback was misnamed (`sendChangeEmailVerification`, which
 *    1.6.26 does not read), so the mail to the OLD address that is the point
 *    of the flow was never sent. Its `user.changeEmail` block is removed too.
 *  - **`/verify-email`**, on the PLATFORM plane only. Email-verification
 *    tokens are JWTs signed with the instance secret and carrying no plane
 *    claim, and the member and platform instances share `BETTER_AUTH_SECRET`
 *    — so a member-minted link verified on the console. A change-email link
 *    (the endpoint above) went further: the platform's `/verify-email` MINTED
 *    A PLATFORM SESSION for it and rewrote the address, with no password. The
 *    console has no verification flow at all — its principals are seeded
 *    verified — so it has no reason to accept one. (The member plane keeps
 *    its own: sign-up's link lands there. It refuses only change-email
 *    links — `refuseChangeEmailLink` below.)
 *
 * WHY A HOOK AND NOT `disabledPaths`. `disabledPaths` compares a concrete
 * pathname, so it cannot name the token route `/reset-password/:token` at
 * all, and it does not apply to `auth.api.*` calls from server code. A
 * before-hook sees `ctx.path`, the ENDPOINT's own declared path —
 * `"/reset-password/:token"`, not the token — on every route in, HTTP or not.
 *
 * WHAT IT DOES NOT TOUCH, and must not: sign-in, sign-out, the session, the
 * two-factor endpoints, `/change-password`, and — on the member plane —
 * `/sign-up/email` and `/verify-email`, which are the live sign-up flow.
 * `closed-endpoints.test.ts` pins both halves.
 *
 * Every refusal is the SAME refusal, whatever the body names, so it answers
 * nothing about anybody.
 */
export type ClosablePlane = "member" | "platform";

const RESET = ["/request-password-reset", "/reset-password", "/reset-password/:token"] as const;

export const CLOSED_ENDPOINTS: Readonly<Record<ClosablePlane, ReadonlySet<string>>> = {
  member: new Set<string>([...RESET, "/send-verification-email", "/change-email"]),
  platform: new Set<string>([...RESET, "/send-verification-email", "/verify-email"]),
};

export const isClosedEndpoint = (plane: ClosablePlane, path: string): boolean =>
  CLOSED_ENDPOINTS[plane].has(path);

/**
 * For an instance's `hooks.before`, called first: a closed endpoint costs
 * none of OUR work — no limiter round trip, no lookup. (The library's router
 * has already parsed the body and run its origin check by then; a hook
 * cannot run earlier than that.)
 */
export function refuseClosedEndpoint(ctx: { readonly path: string }, plane: ClosablePlane): void {
  if (isClosedEndpoint(plane, ctx.path)) throw new APIError("NOT_FOUND");
}

/**
 * **A CHANGE-EMAIL LINK IS REFUSED ON THE MEMBER PLANE'S `/verify-email`**
 * (the slice's fresh review). That endpoint stays open — sign-up's link lands
 * there — but it also honours links that carry `updateTo`, and for those it
 * CREATES A SESSION for the named user if none exists and rewrites their
 * address: no password, and no second factor, since the two-factor hook
 * matches only the sign-in paths. With `/change-email` refused, nothing on
 * this plane mints such a link any more — so the only one that could arrive
 * is one signed by whoever holds `BETTER_AUTH_SECRET`, and for that holder it
 * was a session for ANY member. Refusing the shape costs no real user
 * anything, and it turns a leaked secret from "sign in as anyone" into "sign
 * in as someone who has not verified yet" (RUNBOOK §5 says what to do then).
 *
 * **IT FAILS CLOSED, and the first version did not** (the fix review). A
 * sign-up link is `{email, iat, exp}` — `createEmailVerificationToken` with no
 * `updateTo` and no extra payload, and JSON drops the undefined — so a token
 * passes ONLY if its payload reads as exactly that kind of object. Anything
 * this decoder cannot read is refused rather than handed on: the claims are
 * decoded here with Node's `Buffer` and `JSON.parse`, while the library
 * verifies with jose's, and the two do not agree on everything. The one the
 * review found: a payload that begins with a UTF-8 byte-order mark makes
 * `JSON.parse` throw here, while jose's `TextDecoder` strips the mark and
 * reads the claims — so the first version, which let an unreadable token
 * through "for the library to refuse", let a validly signed change-email
 * link through to the branch that mints the session. Refusing what we cannot
 * read costs a real user nothing: every link the product mails parses.
 *
 * The claims are only DECODED, not verified. A token this passes carries no
 * `updateTo` and no `requestType` as far as either decoder can tell — both use
 * the same `JSON.parse`, and bytes jose rejects never reach the branch — and a
 * forged one of that shape is at worst a sign-up link, which is what the
 * library's own check (and the residual RUNBOOK §5 states) is for.
 */
export function isSignUpLink(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return false;
  try {
    const claims: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return (
      typeof claims === "object" &&
      claims !== null &&
      !Array.isArray(claims) &&
      !("updateTo" in claims) &&
      !("requestType" in claims)
    );
  } catch {
    return false;
  }
}

/**
 * For the member instance's `hooks.before`. A request with no token at all is
 * the library's to refuse, as it always was; any token that is not readably a
 * sign-up link is refused here.
 */
export function refuseChangeEmailLink(ctx: { readonly path: string; readonly query?: unknown }): void {
  if (ctx.path !== "/verify-email") return;
  const token = (ctx.query as { token?: unknown } | undefined)?.token;
  if (typeof token !== "string" || token === "") return;
  if (!isSignUpLink(token)) throw new APIError("NOT_FOUND");
}

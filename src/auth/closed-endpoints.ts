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
 *    (THE MEMBER PLANE'S FIRST TWO CAME OFF THIS LIST WITH C30 — see
 *    `CLOSED_ENDPOINTS` below for what was built before they did.)
 *  - **`/send-verification-email`**, on the member plane, mailed any
 *    UNVERIFIED user to a stranger's order, and with no mail transport it
 *    rethrew the failure as a 500 for exactly those addresses — the
 *    enumeration oracle again, by a second door. Nothing in the product calls
 *    it: sign-up sends the confirmation mail itself (`sendOnSignUp`), and
 *    since C30 so does a sign-in with the right password (`sendOnSignIn`) —
 *    the same job, for the one person who should be able to ask. On the
 *    platform plane it refused already; it is listed so that stays true
 *    whatever that instance is later configured with.
 *  - **`/change-email`**, on the member plane, had no screen, and its
 *    confirmation callback was misnamed (`sendChangeEmailVerification`, which
 *    1.6.26 does not read), so the mail to the OLD address that is the point
 *    of the flow was never sent. Its `user.changeEmail` block is removed too.
 *  - **`/verify-email`**, on the PLATFORM plane since slice 58. Email-
 *    verification tokens are JWTs signed with the instance secret and
 *    carrying no plane claim, and the member and platform instances share
 *    `BETTER_AUTH_SECRET` — so a member-minted link verified on the console.
 *    A change-email link (the endpoint above) went further: the platform's
 *    `/verify-email` MINTED A PLATFORM SESSION for it and rewrote the
 *    address, with no password. The console has no verification flow at all
 *    — its principals are seeded verified — so it has no reason to accept one.
 *  - **`/verify-email`**, on the MEMBER plane too since C30. It confirms an
 *    address on the link ALONE — and on a bare GET, which is what a mail
 *    scanner does to every link in a business inbox — while confirming a
 *    member's address now takes the link AND the account's password
 *    (`confirmMemberEmail`, `./member-screens`, the pre-account takeover's
 *    reason). The mail links to our confirmation page instead, whose server
 *    action does both checks. (Slice 58 had kept this endpoint open for
 *    sign-up and refused only change-email links on it, by decoding each
 *    token and failing closed; closing the endpoint makes that refusal moot,
 *    and it is gone.)
 *
 * WHY A HOOK AND NOT `disabledPaths`. `disabledPaths` compares a concrete
 * pathname, so it cannot name the token route `/reset-password/:token` at
 * all, and it does not apply to `auth.api.*` calls from server code. A
 * before-hook sees `ctx.path`, the ENDPOINT's own declared path —
 * `"/reset-password/:token"`, not the token — on every route in, HTTP or not.
 *
 * WHAT IT DOES NOT TOUCH, and must not: sign-in, sign-out, the session, the
 * two-factor endpoints, `/change-password`, and — on the member plane —
 * `/sign-up/email`, and `/request-password-reset` and `/reset-password`, the
 * live reset (C30).
 * `closed-endpoints.test.ts` pins both halves.
 *
 * Every refusal is the SAME refusal, whatever the body names, so it answers
 * nothing about anybody.
 */
export type ClosablePlane = "member" | "platform";

const RESET = ["/request-password-reset", "/reset-password", "/reset-password/:token"] as const;

/**
 * **THE MEMBER PLANE SERVES A RESET AGAIN (C30), AND THAT IS A DELIBERATE
 * REMOVAL FROM THIS LIST, NOT A LOOSENING OF IT.** `/request-password-reset`
 * and `/reset-password` came out together with everything slice 58 said a
 * re-opened reset owed — screens (`/reset-password`, `/reset-password/[token]`),
 * the mail after the response, a response floor, hashed tokens, a
 * per-recipient cap that leaves the two-factor rows alone, and a refusal for
 * any console principal on both the request and the redemption
 * (`./member-recovery`). `/reset-password/:token`, the library's GET callback,
 * STAYS here: the mailed link is our screen, so nothing uses it. And
 * `/verify-email` JOINED the member list with C30 (the bullet above): the
 * member plane confirms an address only through `confirmMemberEmail`, with the
 * link and the password.
 *
 * The member plane's `/reset-password` cannot spend a link minted anywhere
 * else: the platform plane issues none (its three stay closed), and the
 * portal's live in `contact_verification`.
 */
export const CLOSED_ENDPOINTS: Readonly<Record<ClosablePlane, ReadonlySet<string>>> = {
  member: new Set<string>(["/reset-password/:token", "/send-verification-email", "/change-email", "/verify-email"]),
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
 * **IS THIS READABLY A PLAIN SIGN-UP LINK?** — `{email, iat, exp}`, which is
 * what `createEmailVerificationToken` signs for sign-up and for sign-in's
 * re-send, with no `updateTo` and no extra payload (JSON drops the undefined).
 * Used by the confirmation page's holder (`./member-screens`), so a
 * change-email link — which names an address to move TO — can never be
 * turned into a confirmation.
 *
 * **IT FAILS CLOSED, and a version of it once did not** (slice 58's fix
 * review). The claims are decoded here with Node's `Buffer` and `JSON.parse`,
 * while Better Auth verifies with jose's, and the two do not agree on
 * everything: a payload that begins with a UTF-8 byte-order mark makes
 * `JSON.parse` throw here, while jose's `TextDecoder` strips the mark and
 * reads the claims — so a check that let an unreadable token through "for the
 * library to refuse" let a validly signed change-email link through. Anything
 * this decoder cannot read is refused: every link the product mails parses.
 *
 * The claims are only DECODED here; the holder VERIFIES the signature, the
 * expiry and the algorithm separately.
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

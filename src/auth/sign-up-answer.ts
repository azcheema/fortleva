import { APIError, isAPIError } from "better-auth/api";

/**
 * **THE MEMBER PLANE'S SIGN-UP GIVES EVERY ADDRESS THE SAME ANSWER** (slice 58).
 *
 * With `requireEmailVerification` on, Better Auth answers an address that is
 * already registered with a stand-in user it never writes — its anti-
 * enumeration branch — and a new address with the user it has just created.
 * Two ways that still told a stranger who was a member, both found by the
 * slice's fresh reviews after an earlier cut claimed they could not:
 *
 *  1. **THE BODY.** The stand-in echoes the caller's fields and carries an id
 *     from a different generator than the database row's. The first cut gave
 *     it a uuid v7 of our own; the review measured that Prisma's generator
 *     fixes a bit ours left random, so half of all stand-ins were still
 *     recognisable. Mimicking another library's id layout is the same mistake
 *     as counting its queries (`./response-floor`), so the fix is not a better
 *     mimic: **the answer carries no user at all.** `answerSignUpAlike`
 *     replaces every successful sign-up response with `SIGN_UP_ANSWER`. The
 *     sign-up page reads only whether there was an error; nothing in the
 *     product reads the user a sign-up returns.
 *  2. **THE STATUS.** The stand-in branch returns before it touches the body
 *     beyond the address and password; the new-address branch goes on to
 *     INSERT the name (and `image`, and any additional field that has no
 *     validator — `locale`), and then to `encodeURIComponent` the
 *     `callbackURL`. So any value that makes one of those steps throw was a
 *     422 or a 500 for a new address and a 200 for a registered one,
 *     silently. Three such values were found in two review rounds: a NUL byte
 *     in the name (Postgres `text` refuses it), a non-string `locale` (Prisma
 *     refuses it), and — after the second round's fix had claimed the rest of
 *     the body was safe — a lone UTF-16 surrogate in `callbackURL`, on which
 *     `encodeURIComponent` throws. `refuseUnsafeSignUp` refuses all of them in
 *     `hooks.before`, BEFORE the library branches: only the fields the page
 *     sends, every string among them well-formed, and a name of plain text.
 *
 * The third way, the DURATION, is the route's response floor.
 *
 * WHAT IS LEFT, stated rather than implied — each one creates an account for
 * the address and mails its owner, so none is silent or cheap:
 *   - sign an address up with a password of your choosing, then sign in with
 *     it: 403 "not verified" if it was new, 401 if not. Closing it means
 *     sign-in lying to every member who has not yet clicked their link;
 *   - send two sign-ups for one new address at once: the loser of the INSERT
 *     race answers 422.
 * Both, and the account a stranger's sign-up leaves waiting for its owner to
 * click, belong to the member-account-lifecycle decision, OPEN_QUESTIONS C30.
 */

/**
 * Every field the sign-up page sends, and `rememberMe`, which the library
 * reads. `image` and `locale` are refused because the library would INSERT
 * them untyped; the fields it declares `input: false` it defaults or refuses
 * itself on both branches, so the allowlist is not what stops those — it is
 * there so a field added to the schema tomorrow cannot reopen this.
 */
const SIGN_UP_FIELDS: ReadonlySet<string> = new Set(["name", "email", "password", "callbackURL", "rememberMe"]);

/** Far above any real name; bounded so a megabyte "name" is refused alike on both branches. */
export const MAX_NAME_LENGTH = 200;

/** C0 controls and DEL — NUL among them, which Postgres `text` refuses outright. */
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * A string with no lone surrogate. Tested with the very operation the
 * library performs on `callbackURL` — `encodeURIComponent` throws `URIError`
 * on exactly those — rather than a second opinion of what "well-formed" means.
 */
const wellFormed = (value: string): boolean => {
  try {
    encodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
};

/**
 * Would the NEW-address branch fail on this body where the registered one
 * would not? True for any field the page does not send, for any string field
 * that is not well-formed, and for a name the database or a reader should not
 * have to hold. What is left — types, the address's syntax, the password's
 * length, the origin of `callbackURL` — the library checks before it
 * branches, which refuses both kinds of address alike.
 */
export function signUpBodyProblem(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false; // the library's schema refuses it, alike
  for (const [key, value] of Object.entries(body)) {
    if (!SIGN_UP_FIELDS.has(key)) return true;
    if (typeof value === "string" && !wellFormed(value)) return true;
  }
  const name = (body as { name?: unknown }).name;
  return typeof name === "string" && (name.length > MAX_NAME_LENGTH || CONTROL.test(name));
}

/**
 * The refusal's code, which the sign-up page turns into its own words
 * (`signup.invalidInput`) — the message below is for API callers only.
 */
export const SIGN_UP_REFUSED = "INVALID_SIGN_UP";

/** For the member instance's `hooks.before`. */
export function refuseUnsafeSignUp(ctx: { readonly path: string; readonly body?: unknown }): void {
  if (ctx.path !== "/sign-up/email" || !signUpBodyProblem(ctx.body)) return;
  throw new APIError("BAD_REQUEST", {
    code: SIGN_UP_REFUSED,
    message: `Sign-up refused: send only name, email, password and callbackURL, as plain text, with a name of up to ${MAX_NAME_LENGTH} characters.`,
  });
}

/** What every successful sign-up answers: nobody is signed in, and nobody is named. */
export const SIGN_UP_ANSWER: { readonly token: null; readonly user: null } = Object.freeze({
  token: null,
  user: null,
});

/**
 * For the member instance's `hooks.after`. An after-hook that THROWS becomes
 * the response (Better Auth's `runAfterHooks` — the audit-hooks trap), so this
 * does nothing that can: one comparison and one constant. A fresh copy each
 * time, because an `auth.api` caller receives the object itself, not JSON.
 */
export function answerSignUpAlike<T>(ctx: {
  readonly path: string;
  readonly context: { readonly returned?: unknown };
  json: (body: { token: null; user: null }) => T;
}): T | undefined {
  if (ctx.path !== "/sign-up/email" || isAPIError(ctx.context.returned)) return undefined;
  return ctx.json({ ...SIGN_UP_ANSWER });
}

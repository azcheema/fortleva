/**
 * THE MEMBER PLANE'S ACCOUNT-RECOVERY NUMBERS (OPEN_QUESTIONS C30), in one
 * module that imports nothing — so the screens that quote them (a browser
 * bundle), the instance that enforces them, the operator's script and the
 * e2e seed all read the same literal rather than keeping copies that drift.
 *
 * Every number here is QUOTED somewhere a person reads it: the mails say how
 * long a link works, the screens say how many mails an hour there can be. A
 * sentence that says "an hour" over a value somebody later changes is a
 * promise nobody is keeping, so change the number here and the copy follows.
 */

/** How many mails of ONE kind one person can be sent in `AUTH_MAIL_WINDOW_MS`. */
export const AUTH_MAILS_PER_HOUR = 3;

/** The window the cap counts over. */
export const AUTH_MAIL_WINDOW_MS = 60 * 60 * 1000;

/** How long a member's reset link works. Better Auth's default too, stated because it is quoted. */
export const MEMBER_RESET_TTL_SECONDS = 60 * 60;

/** How long a confirmation link works — the JWT's own `exp`, Better Auth's default too. */
export const EMAIL_CONFIRMATION_TTL_SECONDS = 60 * 60;

/**
 * THE MEMBER PLANE'S MINIMUM PASSWORD LENGTH, now stated on the instance
 * rather than inherited (C30). `/signup` and `/account` have asked for twelve
 * since Phase 1 while the service accepted Better Auth's default of eight, a
 * gap `src/auth/portal.ts` records; the reset screen reads its bound from the
 * instance, so the gap would have become the reset's policy. Raising it
 * strands nobody: sign-in never checks a length, only the next set does.
 *
 * The console shares this credential (one `account` row serves both planes),
 * so the operator's script holds a console password to the same floor.
 */
export const MEMBER_MIN_PASSWORD_LENGTH = 12;

/**
 * THE STORED FORM OF A MEMBER RESET LINK'S IDENTIFIER begins with this, and
 * NOTHING ELSE in `verification` does. It is what lets the reset's own purge
 * and the operator's reach reset links WITHOUT also reaching the two-factor
 * challenges (`2fa-…`) and trusted devices (`trust-device-…`) that share the
 * table and the user id in `value`.
 *
 * **IT MUST NEVER BEGIN WITH `reset-password:`**, and the reason is a trap in
 * the library: lookup and consume try the hashed identifier AND then the raw
 * `reset-password:<token>` (`internal-adapter.mjs`, the plain fallback). A
 * stored form of `reset-password:<hash>` would therefore be redeemable by
 * anybody who could READ the table — present `<hash>` as the token and the
 * plain retry matches it — which is the leaked-table attack hashing exists
 * to close. `#` also keeps it clear of `LIKE`'s `%` and `_`.
 */
export const MEMBER_RESET_STORED_PREFIX = "pwreset#";

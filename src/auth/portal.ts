import { betterAuth } from "better-auth";
import { createAuthMiddleware, APIError } from "better-auth/api";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";

import { afterResponse } from "./after-response";
import { auditPlugin, passwordResetHookFor } from "./audit-hooks";
import { portalAuditSink } from "./portal-audit";

import { absoluteUrl, appUrl, portalAuthSecret, sessionCookieName } from "@/config";
import { portalAuthClient, withTenant } from "@/db";
import { send } from "@/mailer";

import { enforceAuthRateLimit } from "./rate-limit-hook";

/**
 * Portal Better Auth instance — the THIRD plane (SECURITY.md §3.3,
 * AUTHZ.md §8, decision #6). Its principal is a `Contact`, never a
 * `User`: a member and a contact sharing an email address are two
 * unrelated accounts, on purpose.
 *
 * WHAT MAKES IT A SEPARATE PLANE, in order of how much weight each
 * carries:
 *
 *  1. SEPARATE TABLES. `contact_session`/`contact_account` are not the
 *     member ones, so a member's session token cannot resolve here and
 *     a contact's cannot resolve there. This is the barrier that
 *     matters, and it is why `ContactSession` has no `plane` column —
 *     no other value is representable. Which is just as well, because
 *  2. THE COOKIE NAME IS NOT A BARRIER. better-call signs the cookie
 *     VALUE alone (`signCookieValue(value, secret)`); the name is not
 *     in the HMAC payload. The member and platform instances share one
 *     BETTER_AUTH_SECRET, so a member token replayed under
 *     `__Host-flv.platform` verifies its signature perfectly — and the
 *     same was true of this plane until `secret` below. Even now, do
 *     not weaken (1) on the theory that the secret covers it: (1) is
 *     what holds if the secret is ever unified again. See src/proxy.ts,
 *     which learned this the hard way on the ops plane.
 *  2b. A DISTINCT SECRET, because (1) protects only what is looked up
 *     in a table. Better Auth's email-verification artifact is a
 *     self-contained JWT carrying no plane claim, so a shared secret let
 *     one plane's token be redeemed on another — where `/verify-email`
 *     mints a session before any password is checked. See
 *     `portalAuthSecret` in src/config. (This paragraph used to say the
 *     PASSWORD-RESET artifact was a JWT too. In 1.6.26 it is not: a reset
 *     token is a row in `contact_verification`, so the table is what
 *     keeps it on this plane — the same barrier as (1). Corrected when
 *     the reset screens shipped, by a recon that read password.mjs.)
 *  3. A separate basePath and cookie prefix, which are hygiene: they
 *     keep the three instances' non-session cookies out of each
 *     other's way in one browser jar.
 *
 * THE DATABASE IS REACHED THROUGH `portalAuthClient`, NOT THE RAW
 * CLIENT, and that is the load-bearing difference from the other two
 * instances. `contact` is a tenant-scoped RLS table and sign-in happens
 * before any tenant is known; src/db/portal-identity.ts explains the
 * narrow admission that makes the lookup possible without handing this
 * plane either a blanket policy or a BYPASSRLS connection. Read that
 * file and migration 20260920210000 before changing anything here.
 */

/**
 * Contact columns this instance must know about to READ them back.
 * NOT decoration, and not optional: Better Auth builds its user object
 * by iterating its own table schema and copying only those keys
 * (@better-auth/core .../db/adapter/factory.mjs), so a column missing
 * here comes back `undefined` however full the row is. The platform
 * instance omitted this block entirely in 2026-09-09 and `platformRole`
 * was invisible, which denied every console session.
 *
 * Here the stakes are higher than an outage. `tenantId` and `clientId`
 * are what every portal read is scoped by; a session carrying
 * `undefined` for either is a session with no client scope. So
 * portalGateDecision() refuses such a session outright ("incomplete")
 * rather than letting it through, and portal.dbtest.ts asserts the
 * values really arrive.
 *
 * Every one is `input: false`: none may ever be set from a request
 * body. The database says the same thing independently — the BEFORE
 * UPDATE trigger in migration 20260920210000 makes tenancy, client,
 * profile and status immutable on the auth path.
 */
export const CONTACT_ADDITIONAL_FIELDS = {
  tenantId: { type: "string", required: true, input: false },
  clientId: { type: "string", required: true, input: false },
  portalProfile: { type: "string", required: false, input: false },
  portalStatus: { type: "string", required: false, input: false },
  locale: { type: "string", required: false, input: false },
} as const;

/**
 * The failure a contact sees for every sign-in refusal. One BODY for
 * "wrong password", "suspended" and "never invited" alike: the portal
 * must not answer "does this agency have a client with this address?".
 *
 * The first cut wrote the message by hand with a trailing full stop
 * and threw `new APIError(...)`, which carries no `code` — so this
 * refusal was byte-distinguishable from the library's own
 * `INVALID_EMAIL_OR_PASSWORD` (different message, and a `code` present
 * in one body and absent in the other) while the comment beside it
 * claimed they were indistinguishable. BOTH reviews caught it.
 *
 * It is spelled out here rather than imported because
 * `BASE_ERROR_CODES` is not re-exported by `better-auth` or
 * `better-auth/api` — only by `@better-auth/core/error`, a transitive
 * package this product does not depend on directly. A hand-copied
 * constant can drift when the library rewords its message, so
 * portal.dbtest.ts compares this refusal's body against a REAL
 * wrong-password response from the same instance and fails if they
 * ever differ. Copying is safe only because that test exists.
 */
export const SIGN_IN_REFUSED = {
  code: "INVALID_EMAIL_OR_PASSWORD",
  message: "Invalid email or password",
} as const;

// ─── PASSWORD RESET ────────────────────────────────────────────────────
//
// The portal's two reset screens (`/portal/reset-password` and
// `/portal/reset-password/[token]`) drive Better Auth's own endpoints from
// the browser. Everything that decides WHO gets a link, and whether a link
// still works, lives here — because the endpoints stay reachable to anyone
// with curl whether or not a screen exists, so a control that lived only on
// a screen would be a control on the polite callers.

/**
 * How long a reset link works. Better Auth's default is also an hour; it
 * is stated because both screens and the mail QUOTE it, and a sentence
 * that says "an hour" over a library default somebody later changes is a
 * promise nobody is keeping.
 */
export const RESET_TTL_SECONDS = 60 * 60;

/**
 * **HOW MANY RESET MAILS ONE CONTACT CAN BE SENT IN AN HOUR**, which is
 * the control that actually bounds what `/request-password-reset` can do to
 * a person. It is SECURITY.md §4's "3 / h per email", which was written
 * down as policy in Phase 0 and never built.
 *
 * The per-IP limits in front of the endpoint cannot do this job: ours
 * (`auth.credential_request`) fails open until Upstash exists, Better Auth's
 * built-in one is per process and per address, and an attacker who wants
 * to fill one client's inbox with "reset your password" from the agency's
 * own domain simply rotates addresses. A budget keyed on the RECIPIENT and
 * counted in Postgres holds against all of that, and it costs nothing an
 * attacker can observe: the endpoint's response is identical whether the
 * mail went or not.
 */
export const RESET_MAILS_PER_HOUR = 3;

/** Better Auth's identifier prefix for a reset row (password.mjs). */
const RESET_PREFIX = "reset-password:";

/**
 * A plausible token, before anything is hashed or looked up. Better Auth
 * mints 24 alphanumerics; the bound is looser on purpose — a future version
 * that lengthens its tokens must not strand every link in flight — and
 * exists only so a megabyte path segment is refused without work.
 */
const RESET_TOKEN_SHAPE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The link in the reset mail — the new-password SCREEN, not Better Auth's
 * `/reset-password/:token` callback. Building it here rather than handing
 * the library a `redirectTo` means no caller-supplied value ever reaches a
 * mail: `redirectTo` is a request-body field on an unauthenticated
 * endpoint, and it is validated only when the call arrives over HTTP.
 * The token rides in the path, exactly like `portalInviteUrl`'s.
 */
export const portalResetUrl = (token: string): string =>
  absoluteUrl(`/portal/reset-password/${token}`);

type ResetTokenRow = {
  readonly contactId: string;
  readonly email: string | null;
  readonly active: boolean;
};

/**
 * Resolve a reset token to its contact, or null for a token that is not
 * live. Read through the instance's own adapter so the lookup hashes the
 * token exactly as the write did (`verification.storeIdentifier` below).
 *
 * THE EXPIRY IS CHECKED HERE because `findVerificationValue` does not: it
 * returns the newest row for the identifier whatever its `expiresAt`
 * (better-auth/dist/db/internal-adapter.mjs — only the GET callback and the
 * consuming POST compare it), and a page built on it alone would draw the
 * form for a link the POST is certain to refuse.
 */
async function readResetToken(token: string): Promise<ResetTokenRow | null> {
  if (!RESET_TOKEN_SHAPE.test(token)) return null;
  const { internalAdapter } = await portalAuth.$context;
  const row = await internalAdapter.findVerificationValue(`${RESET_PREFIX}${token}`);
  if (!row || row.expiresAt < new Date()) return null;
  const contact = (await portalAuthClient.contact.findFirst({
    where: { id: row.value },
    select: { email: true, portalStatus: true },
  })) as { email?: string; portalStatus?: string } | null;
  return {
    contactId: row.value,
    email: contact?.email ?? null,
    active: contact?.portalStatus === "ACTIVE",
  };
}

/**
 * WHO A LINK WOULD RESET, for the new-password screen: the address, when
 * the link is live AND its contact may still sign in; null for everything
 * else. Every null is the same null — unknown, expired, used, paused,
 * ended — because the page renders one state for all of them.
 */
export async function portalResetHolder(token: string): Promise<{ email: string } | null> {
  const row = await readResetToken(token);
  return row?.active && row.email ? { email: row.email } : null;
}

/**
 * THE MAIL, AFTER THE RESPONSE. Exported so the DB suite can await it; the
 * instance never does (`afterResponse`, `./after-response` — which also
 * says why the durable `EmailOutbox` was rejected here: it would keep the
 * raw token in `email_outbox.params` until the drain ran, undoing the
 * hashing below).
 *
 * Better Auth writes the reset row BEFORE it calls `sendResetPassword`, and
 * then awaits whatever that returns. So until this slice, the time an
 * unauthenticated caller waited for `/request-password-reset` included a
 * mail-transport round trip exactly when the address was an ACTIVE contact
 * — and in a production build with no transport, `send()` threw, which the
 * library logged and swallowed only after the delay. The response body was
 * constant; a stopwatch was not. This function now runs after the response,
 * so neither the send nor anything it decides is on the clock.
 *
 * **THAT ALONE DOES NOT MAKE THE ENDPOINT CONSTANT-TIME**, and the first
 * version of this comment claimed it did. The library's found and not-found
 * branches still issue different statements — and the hashed storage below
 * WIDENED the gap, because a miss now also tries the legacy plain form. What
 * closes it is the response floor on the route (`src/app/api/portal-auth/
 * [...all]/route.ts`), which does not depend on counting anybody's queries.
 *
 * FOUR WAYS IT DECLINES, AND EACH ONE REMOVES THE ROW IT DECLINED. A row
 * whose link was never mailed is a token nobody holds, and leaving it would
 * let a flood of requests for a paused contact's address grow the table.
 *   1. The contact is not ACTIVE — the refusal this instance has made since
 *      the portal shipped (the header on `sendResetPassword` below).
 *   2. `RESET_MAILS_PER_HOUR` requests for this contact came BEFORE this one
 *      in the last hour — by creation order, not by whoever counts first, so
 *      a burst of overlapping requests still mails exactly the first three
 *      rather than racing each other into declining all of them (a review
 *      finding: the first cut counted every row, its own and later ones
 *      included). Counted by `value`, which is the contact id on every reset
 *      row and on nothing else in this table — email verification is a JWT
 *      and writes none — and the same key `setContactPortalAccess` purges by.
 *   3. The contact carries no tenant, which would be a Better Auth shape
 *      change. No tenant, no agency name, no mail.
 *   4. Read AGAIN, the contact is no longer ACTIVE, or no longer at the
 *      address the request was made for — the paragraph below.
 * One more outcome is not a decline: the row is already gone — used, purged
 * by a pause or an address change, or burned — so there is nothing to send
 * and nothing to remove. And a send that FAILS removes its row and rethrows.
 *
 * **IT READS THE CONTACT AGAIN BEFORE IT SENDS** (the fix review): `user`
 * is the row Better Auth read when the request ARRIVED, and a member can
 * change the contact's address between that read and the reset row being
 * written — after `updateContact`'s purge — which would mail a live link to
 * the address the member had just taken away. So the send goes only if the
 * contact is still ACTIVE at the SAME address. What remains is a window of a
 * member's own open transaction, not of a request.
 *
 * **AND A FAILED SEND REMOVES ITS ROW**, for the reason the declines do: a
 * link that never left is a token nobody holds, and left in place it would
 * count against the cap for its whole hour — three transport failures and
 * the person could not get a link at all until the hour turned, which is
 * the opposite of "they simply ask again". A task cut off mid-flight (the
 * non-durability `afterResponse` accepts) still leaves its row; that is the
 * residual, stated.
 */
export async function deliverPortalReset(
  user: { id: string; email: string; name: string } & Record<string, unknown>,
  token: string,
): Promise<"sent" | "declined" | "gone"> {
  const { internalAdapter } = await portalAuth.$context;
  const decline = async (): Promise<"declined"> => {
    await internalAdapter.deleteVerificationByIdentifier(`${RESET_PREFIX}${token}`);
    return "declined";
  };

  const tenantId = user["tenantId"];
  if (user["portalStatus"] !== "ACTIVE" || typeof tenantId !== "string" || tenantId === "") {
    return decline();
  }
  const own = await internalAdapter.findVerificationValue(`${RESET_PREFIX}${token}`);
  if (!own) return "gone";
  const now = (await portalAuthClient.contact.findFirst({
    where: { id: user.id },
    select: { email: true, portalStatus: true },
  })) as { email?: string; portalStatus?: string } | null;
  if (now?.portalStatus !== "ACTIVE" || now.email !== user.email) return decline();
  const earlier = await portalAuthClient.contactVerification.count({
    where: {
      value: user.id,
      createdAt: { gt: new Date(Date.now() - 60 * 60 * 1000) },
      // Strictly before this row; the id breaks a same-millisecond tie
      // (uuid v7 sorts by time), so two rows can never both count as first.
      OR: [{ createdAt: { lt: own.createdAt } }, { createdAt: own.createdAt, id: { lt: own.id } }],
    },
  });
  if (earlier >= RESET_MAILS_PER_HOUR) {
    // Structured and naming nobody: the contact id is enough for an
    // operator to find, and this line is world-readable in a CI log.
    console.warn(`[portal-auth] reset mail declined: hourly cap reached for contact ${user.id}`);
    return decline();
  }

  // The AGENCY'S name, because it is the one thing in this mail that makes
  // it trustworthy: a message saying "reset your password" from a product
  // name the recipient has never heard of is what phishing looks like. The
  // invitation names the agency for the same reason.
  const { name: tenantName } = await withTenant(tenantId, { type: "system" }, (tx) =>
    tx.tenant.findFirstOrThrow({ select: { name: true } }),
  );
  const minutes = Math.round(RESET_TTL_SECONDS / 60);
  try {
    await send({
      to: user.email,
    subject: `Reset your password for ${tenantName}'s client portal`,
    text:
      `Hello ${user.name},\n\n` +
      `Somebody asked to reset the password you use to sign in to ${tenantName}'s client portal.\n\n` +
      `Choose a new password: ${portalResetUrl(token)}\n\n` +
      `The link works once, for ${minutes} minutes. If you did not ask for this, ignore this email — your password has not changed.`,
    });
  } catch (error) {
    // The TRANSPORT error is the one worth rethrowing; if the database is
    // failing too, say so separately rather than let it replace the cause.
    await decline().catch((cleanup: unknown) => {
      console.error(`[portal-auth] unsent reset row not removed for contact ${user.id}`, cleanup);
    });
    throw error;
  }
  return "sent";
}

/**
 * THE REDEMPTION CHECKS WHO IT IS REDEEMING FOR, rather than trusting every
 * writer of `portal_status` to have purged the tokens.
 *
 * `/reset-password` is not status-gated in the library, and on an existing
 * credential it takes the UPDATE branch, which `contact_account_requires_
 * invite` (BEFORE INSERT) never sees. So until now the only thing between a
 * PAUSED contact and control of their own suspended credential was
 * `setContactPortalAccess` remembering to delete the token — and the first
 * version of that purge matched zero rows (PLAN §0, the invite slice's
 * security review). A control whose one prior implementation silently did
 * nothing earns a second, independent one.
 *
 * It BURNS the token rather than throwing, so the library's own
 * `consumeVerificationValue` then finds nothing and answers with its own
 * `INVALID_TOKEN` — byte-identical to an expired link by construction, with
 * no hand-copied error body to drift (the trap `SIGN_IN_REFUSED` records).
 *
 * **IT BURNS EVERY RESET ROW THE CONTACT HAS, by `value`, not just this
 * token by its identifier.** The first cut deleted by identifier, which the
 * adapter hashes — but lookup and consume both FALL BACK to the plain form,
 * so a link issued before hashing was switched on survived its own burn and
 * was then redeemed (review finding). A contact who may not sign in should
 * hold no live link at all, so deleting by contact is both the simpler rule
 * and the one with no second storage form to miss.
 */
async function burnResetTokenOfInactiveContact(ctx: {
  readonly body?: unknown;
  readonly query?: unknown;
}): Promise<void> {
  const fromBody = (ctx.body as { token?: unknown } | undefined)?.token;
  const fromQuery = (ctx.query as { token?: unknown } | undefined)?.token;
  const token = typeof fromBody === "string" && fromBody !== "" ? fromBody : fromQuery;
  if (typeof token !== "string" || token === "") return;
  const row = await readResetToken(token);
  if (!row || row.active) return;
  await portalAuthClient.contactVerification.deleteMany({ where: { value: row.contactId } });
}

/**
 * After a successful reset: every OTHER link the contact was sent this hour
 * dies too. Better Auth consumes only the one that was used, so without
 * this the older mails in the same inbox would each reset the password
 * again for the rest of their hour — a live credential-setting link sitting
 * in a mailbox after its owner has already acted on the newest one.
 *
 * It must never throw: Better Auth calls `onPasswordReset` BEFORE it
 * revokes the contact's sessions, so an exception here would leave every
 * session the reset was meant to end alive.
 */
async function purgeOtherResetTokens(contactId: string): Promise<void> {
  try {
    await portalAuthClient.contactVerification.deleteMany({ where: { value: contactId } });
  } catch (error) {
    console.error(`[portal-auth] reset tokens not purged for contact ${contactId}`, error);
  }
}

const auditPortalPasswordReset = passwordResetHookFor(portalAuditSink);

export const portalAuth = betterAuth({
  baseURL: appUrl.origin,
  /**
   * ITS OWN SECRET — and point 2 of the header explains why this is
   * not redundant with the table barrier. Sessions are safe because
   * they are rows in `contact_session`; email-verification tokens are
   * NOT, because they are self-contained JWTs that touch no table and
   * carry no plane claim. With a shared secret a token minted on
   * another plane verifies here, and `/verify-email` mints a session
   * before any password is checked. See `portalAuthSecret` in
   * src/config for the full reasoning and the derivation.
   */
  secret: portalAuthSecret,
  // The portal is served from the APP host under /portal (config's
  // planeForHost: "os.naxdor.com serves tenant + portal"), so it shares
  // an origin with the member plane and is separated by path, cookie
  // name and tables. src/proxy.ts host-scopes this basePath to the app
  // host exactly as it does the other two.
  basePath: "/api/portal-auth",
  database: prismaAdapter(portalAuthClient, { provider: "postgresql" }),
  // The four model mappings that make Better Auth speak to the portal
  // tables. `fields.userId → contactId` renames the FK, not the table.
  user: { modelName: "contact", additionalFields: CONTACT_ADDITIONAL_FIELDS },
  account: { modelName: "contactAccount", fields: { userId: "contactId" } },
  verification: {
    modelName: "contactVerification",
    /**
     * RESET TOKENS ARE STORED AS A SHA-256, NOT AS THEMSELVES — the rule the
     * invitation already follows ("raw tokens never touch the database",
     * `contact_invite`). Until the reset screens shipped this table held
     * each live link verbatim as `reset-password:<token>`, so anybody who
     * could READ it — a leaked backup, a read-only injection, an operator's
     * query history — could set the password of every client contact with
     * a reset in flight. The library hashes on write and on every lookup
     * (better-auth/dist/db/verification-token-storage.mjs); `value` stays
     * the contact id, which is what `setContactPortalAccess` purges by.
     *
     * Lookups fall back to the plain form, so a row written before this
     * line still resolves until it expires — an hour at most.
     */
    storeIdentifier: "hashed",
  },
  advanced: {
    database: { generateId: false }, // Prisma uuid(7) defaults generate ids
    // false is load-bearing, identically to the other two instances:
    // secure mode PREPENDS "__Secure-" to even a custom cookie name,
    // which would rename this to __Secure-__Host-flv.portal and break
    // both the proxy's cookie gate and the __Host- guarantee. Secure
    // comes from defaultCookieAttributes instead.
    useSecureCookies: false,
    // Plane-scoped prefix for every cookie Better Auth names itself.
    // Hygiene, not a control (see the header): three planes in one jar
    // must not collide on `better-auth.*`.
    cookiePrefix: "flv-portal",
    defaultCookieAttributes: { secure: true, httpOnly: true },
    cookies: {
      session_token: {
        name: sessionCookieName("portal"),
        // lax, like the member plane: a contact arrives from an emailed
        // link, which is a cross-site navigation.
        attributes: { sameSite: "lax", path: "/", secure: true, httpOnly: true },
      },
    },
  },
  emailAndPassword: {
    enabled: true,
    // INVITE-ONLY IS THE INVARIANT (AUTHZ.md §8, DATA_MODEL.md §6.4):
    // there is no self-signup path for contacts anywhere. This closes
    // the endpoint; `portalAuthClient` refuses a contact create; and
    // the database has no INSERT policy for the auth path. Three
    // independent noes, because a portal that can mint its own
    // principals is a portal that can mint one in someone else's
    // tenant.
    disableSignUp: true,
    requireEmailVerification: true,
    revokeSessionsOnPasswordReset: true,
    /**
     * STATED RATHER THAN INHERITED, and raised to the number the
     * product's own password forms have always asked for. Better Auth's
     * default is 8; `/signup` and the account's change-password form
     * both put `minLength={12}` on the input, so the member plane had a
     * UI that asked for twelve over a service that accepted eight (until
     * C30 stated twelve on that instance too, `./recovery-policy`). This
     * plane must not inherit that gap, for two reasons.
     *
     * First, `acceptContactInvite` reads THIS config and is the sole
     * path that ever sets a portal password for the first time — the
     * portal has no signup endpoint and must never get one — so the
     * number here is the only policy there is, and a form that asks for
     * twelve while the service takes eight is a policy nobody stated.
     *
     * Second, the blast radius is a client COMPANY: `portal_gate` is
     * client-scoped, so one weak password opens the whole shared list,
     * and these users are strangers to the tenant with no second factor
     * available to them (contact MFA is v2). The bar is higher here, not
     * lower.
     *
     * Raising it costs nothing today: no contact has ever held a portal
     * credential, so there is no existing password this could strand,
     * and `revokeSessionsOnPasswordReset` means a future raise would
     * only ever apply at the next set.
     */
    minPasswordLength: 12,
    /**
     * CONFIGURING THIS IS WHAT MAKES `/request-password-reset` ISSUE A
     * TOKEN — the endpoint is mounted either way in 1.6.26 and, without
     * this, only refuses — and that endpoint is unauthenticated. Better Auth's `/reset-password`
     * then CREATES a credential when none exists rather than requiring
     * one (better-auth/dist/api/routes/password.mjs), which made it a
     * fourth account-creation path around the three refusals above —
     * they all defend an INSERT into `contact`, and this writes
     * `contact_account`. A contact a member had merely RECORDED could
     * have set themselves a portal password, bypassing the invitation
     * entirely. The DATABASE now refuses that (trigger
     * `contact_account_requires_invite`, migration 20260920210000);
     * this guard stops the email that would start it.
     *
     * It refuses inside OUR function rather than in a `before` hook on
     * purpose: the endpoint's response is deliberately constant whether
     * or not the address matches anyone, and short-circuiting it with a
     * different status would turn that into an account-enumeration
     * oracle for every agency's client list. Declining to send changes
     * nothing an unauthenticated caller can observe.
     *
     * `portalStatus` is present because CONTACT_ADDITIONAL_FIELDS
     * declares it; if it ever reads `undefined`, this refuses too.
     *
     * **AND IT RETURNS BEFORE ANY OF THAT HAPPENS** (the reset screens'
     * slice): the whole decision and the send run in `deliverPortalReset`
     * after the response (`afterResponse`), so neither a mail-transport
     * round trip nor a transport failure is on the caller's clock. The
     * route's response floor does the rest; that function's header says
     * why both are needed. The `url` argument is ignored in favour of
     * `portalResetUrl`, whose header says why.
     */
    sendResetPassword: async ({ user, token }) => {
      // The contact id only in the log — never the address or the token.
      afterResponse(`[portal-auth] reset mail not sent for contact ${user.id}`, () =>
        deliverPortalReset(user as Parameters<typeof deliverPortalReset>[0], token),
      );
    },
    resetPasswordTokenExpiresIn: RESET_TTL_SECONDS,
    onPasswordReset: async ({ user }) => {
      // The purge first: it never throws, and it is the half a person
      // would notice missing. Both run before Better Auth revokes the
      // contact's sessions, which is why neither may throw.
      await purgeOtherResetTokens(user.id);
      await auditPortalPasswordReset({ user });
    },
  },
  emailVerification: {
    // Nothing signs up, so nothing is sent on signup.
    sendOnSignUp: false,
    /**
     * **IT SENDS NOTHING, ON PURPOSE** (found while building the reset
     * screens). A contact's address is verified by accepting an invitation
     * — the only mailbox-control proof this plane has — and `/verify-email`
     * on this instance fails by design (PLAN §0: it would need an email-
     * keyed write the auth path must never be given). So a verification
     * mail could only ever lead to an error page.
     *
     * And it was worse than useless. Better Auth's unauthenticated
     * `/send-verification-email` mails any UNVERIFIED user it finds — which
     * on this plane is every contact an agency has merely recorded, never
     * invited — so anyone with curl could have the agency's domain mail its
     * client list. In a production build with no transport the send threw,
     * and the library rethrows it after its 500 ms floor, so a recorded
     * contact's address answered 500 where every other address answered
     * 200: the enumeration oracle `/request-password-reset` was fixed for,
     * by a second door. Declining here keeps the endpoint's answer constant
     * and sends nothing to anybody.
     */
    sendVerificationEmail: async () => undefined,
  },
  session: {
    modelName: "contactSession",
    // Renames the FK only — `contact_session.contact_id`. The TABLE is
    // what separates the planes; this is just its column name.
    fields: { userId: "contactId" },
    // Shorter than the member plane's 7 days: a contact's device is
    // outside the tenant's control entirely.
    expiresIn: 60 * 60 * 24 * 2, // 2 days
    updateAge: 60 * 60 * 12,
  },
  databaseHooks: {
    session: {
      create: {
        /**
         * THE ADMISSION CHECK, and its position is deliberate. It runs
         * after Better Auth has verified the password, so refusing here
         * cannot be used to ask whether an address belongs to a contact
         * — a wrong password and a SUSPENDED contact are indistinguish-
         * able from outside. Checking in a `before` hook on
         * /sign-in/email would have been cheaper and would have turned
         * the portal into an account-enumeration oracle for every
         * client list in the product.
         *
         * It reads the row itself rather than trusting whatever the
         * endpoint happens to have parked in context: this hook runs
         * for EVERY path that mints a portal session, not only
         * credential sign-in, and the ones that do not carry a loaded
         * user are exactly the ones worth checking. A before-hook sees
         * Better Auth's LOGICAL field names — `userId` here, whatever
         * the column is called — because hooks run ahead of
         * transformInput (better-auth/dist/db/with-hooks.mjs).
         *
         * A missing row, a missing column and an unknown status all
         * land on the same refusal: nothing but the literal ACTIVE
         * opens the portal.
         */
        before: async (session) => {
          const contactId = (session as { userId?: unknown }).userId;
          const contact =
            typeof contactId === "string"
              ? await portalAuthClient.contact.findFirst({
                  where: { id: contactId },
                  select: { portalStatus: true },
                })
              : null;
          if ((contact as { portalStatus?: string } | null)?.portalStatus !== "ACTIVE") {
            throw APIError.from("UNAUTHORIZED", SIGN_IN_REFUSED);
          }
          return { data: session };
        },
      },
    },
  },
  hooks: {
    // The same limiter the other two planes use — one mechanism, three
    // callers, namespaced by plane so a shared egress IP cannot spend
    // another plane's budget. The portal is the most exposed sign-in
    // surface of the three (its users are outside every tenant), so it
    // must never be the one that goes without.
    //
    // guardFactorMutations is NOT called here, and the asymmetry is
    // deliberate rather than an omission: it guards the shared
    // `two_factor` table, and this instance registers no twoFactor
    // plugin, so no /two-factor/* endpoint exists on it to guard.
    // Contact MFA is v2 (DATA_MODEL.md §6.4, Pushback P5); the day it
    // lands, this line needs revisiting with it.
    before: createAuthMiddleware(async (ctx) => {
      await enforceAuthRateLimit(ctx, "portal");
      // After the limiter, so a refused request spends no lookup. The GET
      // callback `/reset-password/:token` has a different `ctx.path` and
      // changes nothing, so only the consuming POST is checked.
      if (ctx.path === "/reset-password") await burnResetTokenOfInactiveContact(ctx);
    }),
  },
  plugins: [
    // **THE AUTH AUDIT TRAIL, which AUTHZ §8 gated on the invite slice.**
    // Until a contact could be activated, a portal sink would have had
    // nothing to record; from the moment one can sign in, a tenant needs
    // `auth.login_succeeded` / `auth.login_failed` for their own clients
    // as much as for their staff. See `portal-audit.ts` for why it needs
    // no tenant lookup.
    auditPlugin(portalAuditSink),
    // No twoFactor (v2), no admin(), no passkey. Enable nothing unused
    // — and on the plane whose users are strangers to the tenant, the
    // bar for adding one is higher, not lower.
    nextCookies(), // must be last (Better Auth docs)
  ],
  onAPIError: {
    onError(error) {
      console.error("[portal-auth] API error", error);
    },
  },
  trustedOrigins: [appUrl.origin],
});

export type PortalAuthSession = typeof portalAuth.$Infer.Session;

/**
 * THE PASSWORD POLICY, READ FROM THE INSTANCE THAT ENFORCES IT.
 *
 * `acceptContactInvite` already takes its bounds from `password.config`
 * rather than from a literal, and the acceptance SCREEN must agree with
 * it exactly: a form that asks for a length the service then refuses is
 * a refusal the visitor cannot act on, and a form that asks for less is
 * a refusal they meet only after pressing the button. One accessor, two
 * readers — the page (which puts the numbers on the input) and the
 * action (which checks them before touching anything).
 */
export async function portalPasswordPolicy(): Promise<{
  readonly min: number;
  readonly max: number;
}> {
  const { minPasswordLength, maxPasswordLength } = (await portalAuth.$context).password.config;
  return { min: minPasswordLength, max: maxPasswordLength };
}

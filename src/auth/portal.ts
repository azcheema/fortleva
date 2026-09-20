import { betterAuth } from "better-auth";
import { createAuthMiddleware, APIError } from "better-auth/api";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";

import { appUrl, portalAuthSecret, sessionCookieName } from "@/config";
import { portalAuthClient } from "@/db";
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
 *     in a table. Better Auth's email-verification and password-reset
 *     artifacts are self-contained JWTs carrying no plane claim, so a
 *     shared secret let one plane's token be redeemed on another —
 *     where `/verify-email` mints a session before any password is
 *     checked. See `portalAuthSecret` in src/config.
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
  verification: { modelName: "contactVerification" },
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
     * CONFIGURING THIS IS WHAT MOUNTS `/request-password-reset`, and
     * that endpoint is unauthenticated. Better Auth's `/reset-password`
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
     */
    sendResetPassword: async ({ user, url }) => {
      if ((user as { portalStatus?: string }).portalStatus !== "ACTIVE") return;
      await send({
        to: user.email,
        subject: "Reset your client portal password",
        text: `Reset your portal password: ${url}\nIf you did not request this, ignore this email.`,
      });
    },
  },
  emailVerification: {
    // Nothing signs up, so nothing is sent on signup.
    sendOnSignUp: false,
    sendVerificationEmail: async ({ user, url }) => {
      await send({
        to: user.email,
        subject: "Verify your client portal email",
        text: `Verify your email address: ${url}`,
      });
    },
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
    }),
  },
  plugins: [
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

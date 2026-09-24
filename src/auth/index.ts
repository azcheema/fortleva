/* eslint-disable no-restricted-imports -- the auth layer is the one
   sanctioned consumer of the raw client outside src/db (TENANCY.md
   §6.3: AUTH-class tables are touched only by the auth service path;
   RLS portal_deny still governs them). */
import { betterAuth } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { twoFactor } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";

import { absoluteUrl, appUrl, sessionCookieName } from "@/config";
import { runtimeClient } from "@/db/client";

import { afterResponse } from "./after-response";
import { auditPlugin, memberAuditSink, memberDatabaseHooks, onPasswordResetHook } from "./audit-hooks";
import { refuseClosedEndpoint } from "./closed-endpoints";
import { guardFactorMutations } from "./factor-guard";
import {
  afterMemberPasswordReset,
  deliverMemberConfirmation,
  deliverMemberReset,
  refuseResetOfConsolePrincipal,
} from "./member-recovery";
import { enforceAuthRateLimit } from "./rate-limit-hook";
import {
  EMAIL_CONFIRMATION_TTL_SECONDS,
  MEMBER_MIN_PASSWORD_LENGTH,
  MEMBER_RESET_TTL_SECONDS,
} from "./recovery-policy";
import { RESET_IDENTIFIER_PREFIX, storedResetIdentifier } from "./reset-identifier";
import { answerSignUpAlike, refuseUnsafeSignUp } from "./sign-up-answer";

/**
 * Member-plane Better Auth instance (SECURITY.md §3): identity,
 * sessions, MFA, invitations acceptance. Better Auth owns identity and
 * sessions ONLY — authorization lives entirely in our schema behind
 * authorize() (ARC-04/05). The portal Contact instance is separate
 * (Phase 3, decision 6: distinct identities even with the same email).
 *
 * Plugins deliberately NOT enabled (DATA_MODEL.md §6.1): organization
 * (membership is ours), sso, scim, oidcProvider, deviceAuthorization —
 * enable nothing unused.
 */
/**
 * Session columns Better Auth must know about to READ them back and to
 * WRITE them: the adapter filters both directions by schema, so a column
 * that is only in Prisma is silently dropped (plane would never leave
 * MEMBER, mfaVerifiedAt would never be returned). input:false — never
 * settable from a client body; hooks set them server-side.
 */
/**
 * User columns beyond Better Auth's core set, declared to BOTH
 * instances. Declaring them is not decoration: Better Auth copies only
 * the keys present in an instance's own table schema out of the row
 * (@better-auth/core .../adapter/factory.mjs), so a field missing here
 * reads as `undefined` no matter what the database holds. The platform
 * instance omitted this block entirely until 2026-09-09 and
 * `platformRole` was invisible there — which denied every console
 * session. Shared so that cannot recur on one plane only.
 */
export const USER_ADDITIONAL_FIELDS = {
  locale: { type: "string", required: false },
  // Authoritative platform-plane flag (AUTHZ.md §9); the admin
  // plugin's `role` column is a mirror, never read by authorization.
  platformRole: { type: "string", required: false, input: false },
} as const;

export const SESSION_ADDITIONAL_FIELDS = {
  plane: { type: "string", required: false, input: false },
  // WRITTEN BEHIND BETTER AUTH'S BACK, by `./active-tenant.ts` straight
  // through Prisma (as `./step-up.ts` writes mfaVerifiedAt). That is only
  // safe while `session.cookieCache` and `secondaryStorage` stay OFF
  // below: with either on, `getSession` would serve a cached row and a
  // workspace switch would silently appear not to work until it expired.
  activeTenantId: { type: "string", required: false, input: false },
  // View-as-Contact's mode pointer (Phase 3 slice 5), written the same
  // way by `./view-as.ts` and carrying the same dependency on
  // `session.cookieCache` staying off.
  //
  // IT COST AN E2E RUN TO LEARN THAT THIS LINE IS NOT OPTIONAL, which
  // is the whole reason the paragraph above this block exists: the
  // adapter strips keys that are not declared here, so the column was
  // written, stored and read back as `undefined`, `/view-as` concluded
  // the member was not in the mode and redirected them home. Nothing
  // failed, nothing logged, and the page simply did not exist. The
  // identical failure that made `/ops` unreachable in 2026-09-09.
  //
  // `input: false` — no request body may ever set it. The only writer
  // is the audited server action, which is what makes the audit row a
  // complete record of who entered a client's view.
  viewAsContactId: { type: "string", required: false, input: false },
  // Last interactive second factor on this session (SECURITY.md §3.5);
  // stamped by memberDatabaseHooks + verifyStepUp(), read by
  // requireTenantContext() → authorize() for ✦ codes.
  mfaVerifiedAt: { type: "date", required: false, input: false },
} as const;

export const auth = betterAuth({
  baseURL: appUrl.origin,
  database: prismaAdapter(runtimeClient, { provider: "postgresql" }),
  advanced: {
    database: { generateId: false }, // Prisma uuid(7) defaults generate ids
    // false is deliberate and load-bearing: Better Auth prepends
    // "__Secure-" to even CUSTOM cookie names when secure mode is on,
    // which would silently rename the session cookie to
    // __Secure-__Host-flv.member and break the plane gate. The name
    // below already carries __Host- (browser-enforced Secure + Path=/
    // + no Domain — INV-D1 armor); the Secure attribute for every
    // cookie comes from defaultCookieAttributes instead.
    useSecureCookies: false,
    defaultCookieAttributes: { secure: true, httpOnly: true },
    cookies: {
      session_token: {
        name: sessionCookieName("member"),
        attributes: { sameSite: "lax", path: "/", secure: true, httpOnly: true },
      },
    },
  },
  // NO `changeEmail` BLOCK (slice 58). It ENABLED `/change-email` — which
  // 1.6.26 mounts either way, and which answers "disabled" without it — with
  // no screen anywhere in the product, and its confirmation callback was
  // named `sendChangeEmailVerification`, a key 1.6.26 does not read, so the
  // mail to the OLD address, the one thing that makes an address change
  // safe, was never sent. Its links were also accepted by the console's
  // `/verify-email`, which minted a PLATFORM session for them. Build the
  // flow with its screen, its old-address confirmation and its reset-link
  // purge, or not at all; `./closed-endpoints` refuses the path meanwhile —
  // and, since C30, this plane's `/verify-email` too, so no emailed link of
  // any kind is honoured here except through the confirmation page.
  user: { additionalFields: USER_ADDITIONAL_FIELDS },
  verification: {
    /**
     * RESET LINKS ARE STORED AS `pwreset#<sha256>`; EVERY OTHER ROW STAYS PLAIN
     * (C30, `./reset-identifier`). Hashed for the portal's reason — a reader
     * of this table must not be able to set a member's password — and under a
     * prefix of our own because the table is shared: the two-factor
     * challenges and trusted devices beside these rows carry the same user id,
     * and the built-in `"hashed"` form would have left a purge of "this
     * member's reset links" no way to say so. An OVERRIDE, not a table-wide
     * setting, so those rows keep the plain identifiers RUNBOOK §8's sign-out
     * statement matches on — and the platform instance, which shares the
     * table and serves no reset, is untouched.
     */
    storeIdentifier: {
      default: "plain",
      overrides: { [RESET_IDENTIFIER_PREFIX]: { hash: storedResetIdentifier } },
    },
  },
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    // Stated, not inherited — `./recovery-policy` says why it is twelve.
    minPasswordLength: MEMBER_MIN_PASSWORD_LENGTH,
    /**
     * **A MEMBER CAN RESET THEIR OWN PASSWORD** (C30) — re-opened after
     * slice 58 closed the screenless endpoint, now with the screens
     * (`/reset-password`, `/reset-password/[token]`) and the controls the
     * closed one lacked, all in `./member-recovery`:
     *
     *  - the mail goes AFTER the response (`afterResponse`): Better Auth
     *    awaits this callback on the found branch only, so a send on the
     *    response path was a stopwatch for who is a member. The route's
     *    response floor covers the library's own branch difference;
     *  - the link names our screen, never a caller's `redirectTo`;
     *  - the token is stored hashed (`verification` above);
     *  - three mails an hour per RECIPIENT, counted in Postgres
     *    (`./mail-budget`), keyed so the two-factor rows sharing the table
     *    neither count nor get purged;
     *  - a CONSOLE principal is declined here and refused on redemption: one
     *    credential row serves both planes, and the console's password is
     *    the operator script's to reset, not a mailbox's;
     *  - `/reset-password/:token`, the library's GET callback, stays refused
     *    (`./closed-endpoints`): the mailed link is our screen, so nothing
     *    uses it.
     *
     * The response is the library's constant one, for every address, whether
     * the mail went or not.
     */
    sendResetPassword: async ({ user, token }) => {
      // The user id only in the log — never the address or the token.
      afterResponse(`[auth] reset mail not sent for user ${user.id}`, () =>
        deliverMemberReset(user as Parameters<typeof deliverMemberReset>[0], token),
      );
    },
    resetPasswordTokenExpiresIn: MEMBER_RESET_TTL_SECONDS,
    revokeSessionsOnPasswordReset: true,
    onPasswordReset: async ({ user }) => {
      // The clean-up first — other links, sign-ins in flight, the address
      // confirmed — then the audit row. Both run BEFORE Better Auth revokes
      // the sessions, which is why neither may throw.
      await afterMemberPasswordReset(user.id);
      await onPasswordResetHook({ user });
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    /**
     * **A FRESH LINK FOR AN UNCONFIRMED MEMBER WHO SIGNS IN WITH THE RIGHT
     * PASSWORD** (C30). The library runs this only after the password has
     * matched, and answers 403 `EMAIL_NOT_VERIFIED` either way, which the
     * sign-in screen turns into "we have sent you a new link". It ends the
     * dead end slice 58 recorded — a person whose one link expired could get
     * no other — and it is capped per recipient, because the one caller the
     * library does not bound is a stranger who knows the password of an
     * account they pre-registered at somebody else's address.
     */
    sendOnSignIn: true,
    /**
     * **THE LIBRARY'S CONFIRMATION IS NOT USED ON THIS PLANE** (C30). With this
     * on, the owner of an address a stranger signed up first was signed in,
     * by their own click, to an account whose password the STRANGER had
     * chosen — a pre-account takeover. It is off, and `/verify-email` itself
     * is refused (`./closed-endpoints`): it confirms on the link alone, on a
     * bare GET a mail scanner performs. An address is confirmed only by the
     * confirmation PAGE's server action, which demands the link AND the
     * account's password (`confirmMemberEmail`, `./member-screens`) — so a
     * stranger's pre-registration can never be confirmed by either of the two
     * people involved alone, and its owner's way in is "Forgot your
     * password?", which replaces the stranger's password (`./member-recovery`).
     * Off as well as refused: belt and braces for the day the refusal moves.
     */
    autoSignInAfterVerification: false,
    expiresIn: EMAIL_CONFIRMATION_TTL_SECONDS,
    /**
     * THE MAIL GOES AFTER THE RESPONSE (slice 58, `./after-response`). Better
     * Auth awaits this callback, and sign-up calls it only for an address
     * that is NEW — so a transport round trip on the response said which
     * addresses were not yet members. The library's `url` is not mailed: the
     * link is our confirmation page (`deliverMemberConfirmation`).
     *
     * Two callers: sign-up (once per ADDRESS — a second sign-up for a
     * registered address takes the library's stand-in branch and sends
     * nothing) and sign-in (above). The unauthenticated re-send,
     * `/send-verification-email`, stays refused (`./closed-endpoints`): it
     * mailed any unverified user on a stranger's say-so, and sign-in does the
     * same job for the one person who should be able to — the one who knows
     * the password.
     */
    sendVerificationEmail: async ({ user, url, token }, request) => {
      // Read now: the task runs after the response. A sign-in carries no
      // `callbackURL` (the login form's docblock says why), so where the person
      // was going rides in the referring `/login?next=…` instead.
      const referer = request?.headers.get("referer") ?? null;
      afterResponse(`[auth] confirmation mail not sent for user ${user.id}`, () =>
        deliverMemberConfirmation(user, url, token, referer),
      );
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // rolling refresh daily
    additionalFields: SESSION_ADDITIONAL_FIELDS,
  },
  databaseHooks: memberDatabaseHooks,
  hooks: {
    // Per-IP limits on the credential endpoints (SECURITY.md §3.7) on
    // top of Better Auth's built-in limiter; no-op until Upstash env
    // exists (src/ratelimit). 429 before any handler runs. Moved to
    // ./rate-limit-hook on 2026-09-09 so the PLATFORM instance uses the
    // same function rather than a copy that can drift — it had none.
    //
    // The factor guard runs here TOO, and that is not belt-and-braces:
    // `TwoFactor.userId` is @unique, so a SUPERADMIN has ONE factor row
    // and this plane's /two-factor/disable deletes the very row the
    // console gate depends on. Guarding only the platform instance would
    // leave the weak plane able to strip the strong plane's credential.
    // See ./factor-guard.
    //
    // And FIRST, the endpoints this plane does not serve at all (slice 58
    // and C30, ./closed-endpoints): before the limiter, because they cost us
    // nothing.
    //
    // Sign-up's input is checked after the limiter and before the library
    // branches on whether the address exists (./sign-up-answer): input the
    // DATABASE would refuse was a 422 for a new address and a 200 for a
    // registered one.
    //
    // A reset link of a CONSOLE principal is burned before the library can
    // spend it (C30, ./member-recovery) — after the limiter, so a refused
    // request costs no lookup.
    before: createAuthMiddleware(async (ctx) => {
      refuseClosedEndpoint(ctx, "member");
      await enforceAuthRateLimit(ctx, "member");
      refuseUnsafeSignUp(ctx);
      await refuseResetOfConsolePrincipal(ctx);
      await guardFactorMutations(ctx, "member");
    }),
    // Every successful sign-up answers alike, so the body names nobody
    // (./sign-up-answer). Nothing in it can throw — an after-hook's throw
    // becomes the response (./audit-hooks, the guarded() note).
    after: createAuthMiddleware(async (ctx) => answerSignUpAlike(ctx)),
  },
  plugins: [
    twoFactor({
      issuer: "Fortleva",
      totpOptions: { digits: 6, period: 30 },
    }),
    // admin() REMOVED 2026-09-09, and it must not come back without the
    // controls below. It mounted /api/auth/admin/* on the MEMBER plane
    // — the plane with 7-day rolling, sameSite=lax sessions and no MFA
    // requirement — and both instances share one `account` row. So
    // `/admin/set-user-password`, guarded by nothing but a session
    // (`adminMiddleware`, not the library's own
    // `sensitiveSessionMiddleware`) and `hasPermission` on the admin
    // plugin's `role` column, could rewrite the SUPERADMIN's credential:
    // the WEAK plane's session rewriting the STRONG plane's password.
    // `/admin/impersonate-user` was mounted there too, minting sessions
    // that land with `plane` at its Prisma default of MEMBER while
    // nothing in src/ ever derives `actor.impersonated` from
    // `Session.impersonatedBy` — so authorize.ts's read-only
    // impersonation mask could never fire on them.
    //
    // Nothing in src/ reads `role`, `banned`, `banReason`, `banExpires`
    // or `Session.impersonatedBy`; the columns stay in the Prisma schema
    // and auth.dbtest.ts still asserts `impersonatedBy` is null through
    // Prisma. When impersonation is actually built, it needs the
    // read-only mask wired to a real actor flag, dual-identity audit
    // rows, and to live on the ops plane behind requirePlatformAdmin() —
    // not a plugin re-registered here.
    // After twoFactor on purpose: its after-hooks must observe the
    // FINAL newSession (null while a 2FA challenge is pending).
    auditPlugin(memberAuditSink),
    // passkey: moved to a separate package in better-auth 1.6.26; the
    // Passkey table is ready — wire @better-auth/passkey when enabled.
    nextCookies(), // must be last (Better Auth docs)
  ],
  onAPIError: {
    onError(error) {
      console.error("[auth] API error", error);
    },
  },
  trustedOrigins: [appUrl.origin],
});

export type AuthSession = typeof auth.$Infer.Session;

/** Deep-link helper for invitation acceptance emails (links, not data). */
export const inviteUrl = (token: string): string => absoluteUrl(`/invite/${token}`);

/**
 * The CLIENT PORTAL's acceptance link (Phase 3, the invite slice) — the
 * same helper for the other plane, and a separate export rather than a
 * parameter because the two prefixes are load-bearing: `/portal/*` is
 * what the proxy gates on the portal session cookie, so a contact
 * arriving at `/invite/…` would be sent to the MEMBER sign-in page.
 *
 * It is a link, never data. The token appears here and in the mail body
 * and nowhere else — the database holds only its sha256.
 */
export const portalInviteUrl = (token: string): string =>
  absoluteUrl(`/portal/invite/${token}`);

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
import { send } from "@/mailer";

import { auditPlugin, memberAuditSink, memberDatabaseHooks, onPasswordResetHook } from "./audit-hooks";
import { guardFactorMutations } from "./factor-guard";
import { enforceAuthRateLimit } from "./rate-limit-hook";

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
  user: {
    additionalFields: USER_ADDITIONAL_FIELDS,
    changeEmail: {
      enabled: true,
      sendChangeEmailVerification: async ({ newEmail, url }: { newEmail: string; url: string }) => {
        await send({
          to: newEmail,
          subject: "Confirm your new email address",
          text: `Confirm your new Fortleva email address: ${url}`,
        });
      },
    },
  },
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    revokeSessionsOnPasswordReset: true,
    onPasswordReset: onPasswordResetHook,
    sendResetPassword: async ({ user, url }) => {
      await send({
        to: user.email,
        subject: "Reset your Fortleva password",
        text: `Reset your password: ${url}\nIf you did not request this, ignore this email.`,
      });
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) => {
      await send({
        to: user.email,
        subject: "Verify your Fortleva email",
        text: `Verify your email address: ${url}`,
      });
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
    before: createAuthMiddleware(async (ctx) => {
      await enforceAuthRateLimit(ctx, "member");
      await guardFactorMutations(ctx, "member");
    }),
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

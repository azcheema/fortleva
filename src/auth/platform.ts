/* eslint-disable no-restricted-imports -- sanctioned auth-layer consumer
   of the raw client (TENANCY.md §6.3), same as src/auth/index.ts. */
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { createAuthMiddleware } from "better-auth/api";
import { twoFactor } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";

import { opsUrl, sessionCookieName } from "@/config";
import { runtimeClient } from "@/db/client";
import { send } from "@/mailer";

import { isFreshFactorPath, onPasswordResetHook } from "./audit-hooks";
import { guardFactorMutations } from "./factor-guard";
import { SESSION_ADDITIONAL_FIELDS, USER_ADDITIONAL_FIELDS } from "./index";
import { enforceAuthRateLimit } from "./rate-limit-hook";


/**
 * Platform-console Better Auth instance (SECURITY.md §2.2/§3.3):
 * SAME identity tables as the member instance, but its own cookie
 * namespace (__Host-flv.platform), its own basePath, and sessions
 * stamped plane=PLATFORM — the second structural barrier: a member
 * session presented on a platform route fails on the ROW, not just
 * the cookie name. Sign-in here is only useful to SUPERADMIN users;
 * requirePlatformAdmin() enforces that server-side.
 */
export const platformAuth = betterAuth({
  baseURL: opsUrl.origin,
  basePath: "/api/platform-auth",
  database: prismaAdapter(runtimeClient, { provider: "postgresql" }),
  advanced: {
    database: { generateId: false },
    // false is load-bearing — see src/auth/index.ts: secure mode would
    // rename the cookie to __Secure-__Host-flv.platform and break the
    // plane gate. Secure comes from defaultCookieAttributes.
    useSecureCookies: false,
    // PLANE-SCOPED PREFIX. Better Auth names every cookie it is not
    // explicitly given a name for as
    // `${cookiePrefix ?? "better-auth"}.${cookieName}`, and both
    // instances override `advanced.cookies` for session_token ONLY — so
    // before this line both named their two-factor CHALLENGE cookie
    // exactly `better-auth.two_factor`, at path "/", with no secure
    // prefix. In the single-host configuration that is one browser jar
    // and one name for two planes' challenges, and they overwrite each
    // other.
    //
    // BE PRECISE ABOUT WHAT IT DOES NOT DO, because an earlier version
    // of this comment overclaimed: a prefix does NOT make the two
    // namespaces cryptographically disjoint. better-call signs the
    // cookie VALUE only (`signCookieValue(value, secret)`) — the name is
    // not in the HMAC payload — and both instances share one
    // BETTER_AUTH_SECRET and one `verification` table, so a member-plane
    // challenge value still verifies when replayed under this name. What
    // actually closes that is src/proxy.ts refusing `/api/auth/*` on the
    // ops host, so no member challenge can be minted there at all. This
    // prefix is the hygiene half; the proxy is the control.
    //
    // It does NOT rename the session cookie: `advanced.cookies
    // .session_token.name` below is an explicit override and wins over
    // the prefix, so `__Host-flv.platform` and INV-D1 are untouched.
    cookiePrefix: "flv-ops",
    defaultCookieAttributes: { secure: true, httpOnly: true },
    cookies: {
      session_token: {
        name: sessionCookieName("platform"),
        attributes: {
          // Strict: the console has no legitimate cross-site entry.
          sameSite: "strict",
          path: "/",
          secure: true,
          httpOnly: true,
        },
      },
    },
  },
  // WITHOUT THIS THE CONSOLE IS UNREACHABLE, and it was.
  // Better Auth builds each model's output by iterating its OWN table
  // schema and copying only those keys
  // (@better-auth/core/dist/db/adapter/factory.mjs — `for (const key in
  // tableSchema)`), and that schema is core fields + plugin fields +
  // `options.user.additionalFields` (.../db/get-tables.mjs). This
  // instance declared no `user` block at all, so `platformRole` was
  // never copied off the row: `session.user.platformRole` came back
  // `undefined`, getPlatformSession() denied EVERY session at its
  // SUPERADMIN check, and /ops bounced to /ops/login forever — sign-in
  // succeeded, the console never opened. Shares the member instance's
  // declaration so the two planes cannot drift.
  user: { additionalFields: USER_ADDITIONAL_FIELDS },
  databaseHooks: {
    session: {
      create: {
        // plane stamp + the same step-up freshness rule as the member
        // instance (a fresh TOTP at sign-in counts; nothing else does).
        before: async (session, ctx) => ({
          data: {
            ...session,
            plane: "PLATFORM" as const,
            ...(isFreshFactorPath(ctx?.path) ? { mfaVerifiedAt: new Date() } : {}),
          },
        }),
      },
    },
  },
  emailAndPassword: {
    enabled: true,
    // SECURITY.md T6 claims "no public signup anywhere in v1" and the
    // control it names is that there is no surface to enumerate. There
    // was one: `enabled: true` mounts POST /sign-up/email on this
    // instance too, on the OPS host, where an account created by a
    // stranger would at least be a distinguishable
    // "email already registered" oracle against an invite-only product.
    // Platform principals are made by the seed (scripts/seed-naxdor.ts),
    // never by a request.
    disableSignUp: true,
    requireEmailVerification: true,
    // Both present on the member instance and both were missing here, on
    // the higher-privilege plane. Without the first, Better Auth leaves
    // every live PLATFORM session valid after a reset — stamp and all —
    // so the standard remedy for "my ops password leaked" would not
    // evict the attacker. Without the second, the reset writes no audit
    // row at all.
    revokeSessionsOnPasswordReset: true,
    onPasswordReset: onPasswordResetHook,
    sendResetPassword: async ({ user, url }) => {
      await send({
        to: user.email,
        subject: "Reset your Fortleva platform password",
        text: `Reset your password: ${url}`,
      });
    },
  },
  session: {
    expiresIn: 60 * 60 * 8, // 8h — console sessions are short
    updateAge: 60 * 60,
    additionalFields: SESSION_ADDITIONAL_FIELDS,
  },
  hooks: {
    // Two checks, in this order. The limiter is the same function the
    // member instance uses (./rate-limit-hook) rather than a second copy
    // that can drift; this instance had NO limiter at all until
    // 2026-09-09, which made the console the softest of the three
    // sign-in surfaces while SECURITY.md §3.7 presented it as the
    // hardest. The factor guard is the console-only rule, and it runs
    // after the limiter so a grinder pays the limiter first.
    before: createAuthMiddleware(async (ctx) => {
      await enforceAuthRateLimit(ctx, "platform");
      await guardFactorMutations(ctx, "platform");
    }),
  },
  // admin() IS DELIBERATELY ABSENT HERE. It mounts
  // /admin/impersonate-user and /admin/set-user-password, and mounting
  // those ON the console means the plane that reaches `app_platform`
  // (BYPASSRLS, cross-tenant) also carries the endpoints that hand out
  // other people's sessions and passwords. Nothing on this plane calls
  // them: the console is two pages, and `getPlatformSession` reads
  // `User.platformRole` and explicitly never the admin plugin's `role`
  // mirror. The member instance's registration is a separate question,
  // tracked with the impersonation work — do not add it back here to
  // make the two instances "symmetric": the asymmetry is the control.
  plugins: [twoFactor({ issuer: "Fortleva Ops" }), nextCookies()],
  trustedOrigins: [opsUrl.origin],
});

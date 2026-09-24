/* eslint-disable no-restricted-imports -- sanctioned auth-layer consumer
   of the raw client (TENANCY.md §6.3), same as src/auth/index.ts. */
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { createAuthMiddleware } from "better-auth/api";
import { twoFactor } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";

import { opsUrl, sessionCookieName } from "@/config";
import { runtimeClient } from "@/db/client";

import { auditPlugin, auditRowHooks, isFreshFactorPath, passwordResetHookFor } from "./audit-hooks";
import { platformAuditSink } from "./platform-audit-hooks";
import { refuseClosedEndpoint } from "./closed-endpoints";
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
    // `session.create` stays a LITERAL here rather than coming from a
    // shared factory: it writes `plane: "PLATFORM"`, the value
    // getPlatformSession() checks, so putting the console's admission
    // rule behind a parameter is how the operator gets locked out of the
    // only administrative plane. The user/account hooks below ARE shared
    // — they carry no plane semantics, only "what changed".
    ...auditRowHooks(platformAuditSink),
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
    // was one: with `enabled: true`, POST /sign-up/email — mounted on
    // every instance whatever the config — CREATED accounts on this
    // instance too, on the OPS host, where an account created by a
    // stranger would at least be a distinguishable
    // "email already registered" oracle against an invite-only product.
    // Platform principals are made by the seed (scripts/seed-naxdor.ts),
    // never by a request.
    disableSignUp: true,
    requireEmailVerification: true,
    /**
     * **THE CONSOLE HAS NO PASSWORD RESET** (slice 58). `sendResetPassword`
     * is gone and `./closed-endpoints` refuses the three reset endpoints.
     *
     * What it was: an unauthenticated `/request-password-reset` on the
     * most privileged host, answering for EVERY user in the shared `user`
     * table — members included, each mailed "reset your Fortleva platform
     * password" to a link that led nowhere, since no reset screen exists.
     * It awaited the send (a stopwatch for who has an account), stored the
     * token verbatim, and capped nothing per recipient. And it bought
     * nothing: a SUPERADMIN's credential is the SAME `account` row the
     * member plane uses, so resetting it here was never a separate
     * recovery path — only a second door to the same room. A leaked
     * password is changed at `/account` on the app plane
     * (`revokeOtherSessions: true`, which ends this plane's sessions too:
     * one `session` table), and the console still demands the factor of a
     * SUPERADMIN who has one. One who has NOT enrolled yet — or who has just
     * been returned to the ramp by SECURITY.md §3.5's recovery — enrols with
     * the password alone, the bounded window that section states; for them a
     * leaked password is the console, so enrol at once.
     *
     * The two settings below stay so that re-opening reset can never
     * forget them. Without the first, Better Auth leaves every live
     * PLATFORM session valid after a reset, stamp and all; without the
     * second, the reset writes no audit row.
     */
    revokeSessionsOnPasswordReset: true,
    onPasswordReset: passwordResetHookFor(platformAuditSink),
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
    //
    // Before both, the endpoints the console does not serve at all
    // (slice 58, ./closed-endpoints): password reset, and email
    // verification — whose links, signed with the secret this instance
    // shares with the member plane, the console used to accept.
    before: createAuthMiddleware(async (ctx) => {
      refuseClosedEndpoint(ctx, "platform");
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
  // auditPlugin AFTER twoFactor on purpose, same as the member instance:
  // its after-hooks must observe the FINAL newSession, which is null
  // while a 2FA challenge is pending and set only when sign-in really
  // completed. Listed before nextCookies, which only serialises cookies.
  plugins: [
    twoFactor({ issuer: "Fortleva Ops" }),
    auditPlugin(platformAuditSink),
    nextCookies(),
  ],
  trustedOrigins: [opsUrl.origin],
});

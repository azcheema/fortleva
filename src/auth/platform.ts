/* eslint-disable no-restricted-imports -- sanctioned auth-layer consumer
   of the raw client (TENANCY.md §6.3), same as src/auth/index.ts. */
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { admin, twoFactor } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";

import { opsUrl, sessionCookieName } from "@/config";
import { runtimeClient } from "@/db/client";
import { send } from "@/mailer";

import { isFreshFactorPath } from "./audit-hooks";
import { SESSION_ADDITIONAL_FIELDS } from "./index";

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
    requireEmailVerification: true,
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
  plugins: [twoFactor({ issuer: "Fortleva Ops" }), admin(), nextCookies()],
  trustedOrigins: [opsUrl.origin],
});

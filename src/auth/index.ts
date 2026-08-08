/* eslint-disable no-restricted-imports -- the auth layer is the one
   sanctioned consumer of the raw client outside src/db (TENANCY.md
   §6.3: AUTH-class tables are touched only by the auth service path;
   RLS portal_deny still governs them). */
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { admin, twoFactor } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";

import { absoluteUrl, appUrl, sessionCookieName } from "@/config";
import { runtimeClient } from "@/db/client";
import { send } from "@/mailer";

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
export const auth = betterAuth({
  baseURL: appUrl.origin,
  database: prismaAdapter(runtimeClient, { provider: "postgresql" }),
  advanced: {
    database: { generateId: false }, // Prisma uuid(7) defaults generate ids
    useSecureCookies: true,
    cookies: {
      session_token: {
        // INV-D1: __Host- prefix is browser-enforced armor — requires
        // Secure + Path=/ and REJECTS any Domain attribute.
        name: sessionCookieName("member"),
        attributes: { sameSite: "lax", path: "/", secure: true, httpOnly: true },
      },
    },
  },
  user: {
    additionalFields: {
      locale: { type: "string", required: false },
      // Authoritative platform-plane flag (AUTHZ.md §9); the admin
      // plugin's `role` column is a mirror, never read by authorization.
      platformRole: { type: "string", required: false, input: false },
    },
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
  },
  plugins: [
    twoFactor({
      issuer: "Fortleva",
      totpOptions: { digits: 6, period: 30 },
    }),
    admin(), // impersonation + ban machinery for the platform plane
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

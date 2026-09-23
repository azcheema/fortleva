"use client";

import { createAuthClient } from "better-auth/react";
import { twoFactorClient } from "better-auth/client/plugins";

/** Member-plane browser client (same-origin /api/auth). */
export const authClient = createAuthClient({
  plugins: [twoFactorClient()],
});

/** Platform-console browser client (same-origin /api/platform-auth). */
export const platformAuthClient = createAuthClient({
  basePath: "/api/platform-auth",
  plugins: [twoFactorClient()],
});

/**
 * Client-portal browser client (same-origin /api/portal-auth).
 *
 * **IT IS `contactAuthClient` AND NOT `portalAuthClient`, and the name
 * is load-bearing.** `portalAuthClient` is already taken, by the Prisma
 * client that reaches the portal IDENTITY tables (`src/db`, allowed in
 * `auth/portal.ts` and nowhere else, pinned twice — ESLint block A and
 * `src/db/import-boundary.test.ts`). Two different things must not share
 * that name: a browser module called `portalAuthClient` would read, to
 * anybody grepping, as the seam that must never leave the server, and
 * the boundary test fires on the name. `contactAuthClient` also says
 * whose credential it carries — a Contact is the portal principal
 * (AGENTS.md's vocabulary) — so do not "fix" it back.
 *
 * **NO `twoFactorClient()`, and the asymmetry is the point.** The portal
 * instance registers no `twoFactor` plugin — contact MFA is v2
 * (DATA_MODEL.md §6.4, Pushback P5) — so no `/two-factor/*` endpoint
 * exists on it, and a client plugin for endpoints that are not mounted
 * would offer the sign-in form a branch the server can never take.
 */
export const contactAuthClient = createAuthClient({
  basePath: "/api/portal-auth",
});

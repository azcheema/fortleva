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

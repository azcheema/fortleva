import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/generated/prisma/client";

import { whereInjection } from "./where-injection";

/**
 * MODULE-PRIVATE clients (TENANCY.md §3 one-seam rule): nothing outside
 * src/db may import this file — enforced by ESLint no-restricted-imports.
 * The only exported entry points to the database are withTenant() and
 * withPlatform() in with-tenant.ts.
 */

const runtimeUrl = () => {
  const url = process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL is not set");
  return url;
};

const platformUrl = () => {
  const url = process.env["PLATFORM_DATABASE_URL"];
  if (!url) throw new Error("PLATFORM_DATABASE_URL is not set");
  return url;
};

declare global {
  var __fortlevaRuntimeClient: ReturnType<typeof buildRuntimeClient> | undefined;
  var __fortlevaPlatformClient: PrismaClient | undefined;
}

const buildRuntimeClient = () =>
  new PrismaClient({
    adapter: new PrismaPg({ connectionString: runtimeUrl() }),
  }).$extends(whereInjection);

/** Pooled, app_runtime (no BYPASSRLS). All tenant/portal work. */
export const runtimeClient = (globalThis.__fortlevaRuntimeClient ??= buildRuntimeClient());

/** Pooled, app_platform (BYPASSRLS — deliberate, audited). Loaded only
 * by platform-plane code paths through withPlatform(). */
export const getPlatformClient = (): PrismaClient =>
  (globalThis.__fortlevaPlatformClient ??= new PrismaClient({
    adapter: new PrismaPg({ connectionString: platformUrl() }),
  }));

export type RuntimeClient = typeof runtimeClient;

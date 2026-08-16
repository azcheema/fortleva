/**
 * The ONLY public surface of the data layer (TENANCY.md §3, one-seam
 * rule). The base Prisma client is module-private; ESLint blocks
 * importing src/db/client or src/generated/prisma anywhere else.
 */
export { withTenant, withPlatform } from "./with-tenant";
export type { TenantDb, PlatformActor } from "./with-tenant";
export { withUser } from "./with-user";
export type { UserDb } from "./with-user";
export type { Principal, TenantContext } from "./context";
export { currentTenantId } from "./context";
export { MODEL_CLASSES, RLS_CLASSES, classOf, allClassifiedModels, tableNameOf } from "./model-registry";
export type { ModelClass, RlsClass } from "./model-registry";
export { nextCounter } from "./counters";

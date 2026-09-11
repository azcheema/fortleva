/**
 * The ONLY public surface of the data layer (TENANCY.md §3, one-seam
 * rule). The base Prisma client is module-private; ESLint blocks
 * importing src/db/client or src/generated/prisma anywhere else.
 */
export { withTenant, withPlatform } from "./with-tenant";
export type { TenantDb, PlatformActor } from "./with-tenant";
export { withUser } from "./with-user";
// The platform-plane audit writer. A FOURTH narrow entry point beside
// withTenant/withPlatform/withUser, and deliberately narrow: it is the
// only path that can write an audit row with tenant_id NULL without also
// writing withPlatform's self-describing invocation row. Only
// src/auth/platform-audit-hooks.ts may import it (pinned by
// src/db/import-boundary.test.ts).
export { recordPlatformEvent } from "./platform-audit";
export type { UserDb } from "./with-user";
export type { Principal, TenantContext } from "./context";
export { currentTenantId } from "./context";
export {
  MODEL_CLASSES,
  RLS_CLASSES,
  PORTAL_GATE_VARIANTS,
  PORTAL_ENABLED_FANOUT_TARGETS,
  classOf,
  allClassifiedModels,
  tableNameOf,
} from "./model-registry";
export type { ModelClass, RlsClass } from "./model-registry";
export { nextCounter } from "./counters";

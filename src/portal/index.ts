/**
 * The contact plane's authorization seam (AUTHZ.md §8). Portal
 * projections and brokered writes import from here; nothing reaches
 * past it.
 *
 * `context.ts` is deliberately NOT re-exported: it pulls in
 * `next/navigation` (it can redirect) and React's `cache`, so a test or
 * a job that only wants the policy would drag a request-scoped runtime
 * in with it. Route code imports `@/portal/context` by name.
 */
export { authorizePortal, withPortalRead } from "./authorize";
export type { PortalPrincipal, PortalScopeRef } from "./authorize";
export {
  PORTAL_CAPABILITIES,
  PORTAL_CAPABILITY_DEFS,
  PORTAL_MODULES,
  PORTAL_PROFILES,
  isPortalCapability,
  isPortalProfile,
  profileHolds,
} from "./capabilities";
export type { PortalCapability, PortalModule, PortalProfile } from "./capabilities";
export { resolvePortalModuleGates } from "./module-gates";
export {
  computePortalModuleGates,
  portalModuleVerdict,
  portalPrincipalVerdict,
} from "./policy";
export type { PortalModuleGates, PortalModuleGateState, PortalVerdict } from "./policy";

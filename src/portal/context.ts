import { cache } from "react";

import { requirePortalContact } from "@/auth/session";

import type { PortalPrincipal } from "./authorize";
import { resolvePortalModuleGates } from "./module-gates";

/**
 * The portal's `requireTenantContext()` — identity from the session,
 * module gates from the tenant, resolved once and reused.
 *
 * `requirePortalContact()` establishes WHO (and redirects to
 * /portal/login when the answer is nobody); this adds the gate state
 * that `authorizePortal()` cannot resolve for itself on this plane
 * (`module-gates.ts`). Call it first in every portal page AND in every
 * portal Server Action — a layout is not a boundary in Next, and a
 * Server Action never runs the layout of the page that rendered it.
 *
 * The gate read is memoised with React's request-scoped `cache`, never
 * `unstable_cache`: entitlements are read per request and never baked
 * into anything long-lived (AUTHZ.md §5 — revocation lag on a
 * cancel/downgrade is the failure mode that rule exists to prevent).
 */
const gatesFor = cache(resolvePortalModuleGates);

export type PortalContext = {
  readonly principal: PortalPrincipal;
  /**
   * The `contact_session` row this request rides on (Phase 3V slice 91):
   * the client's door to the logins shown to them is bound to it, so a
   * second device — or the same password signed in again — opens nothing
   * without its own mailed code. Only a session has one: a View-as
   * principal (`synthesise.ts`) has none, which is one of the two reasons
   * no logins page renders there.
   */
  readonly sessionId: string;
  readonly email: string;
  readonly name: string;
  readonly locale: string | null;
};

export async function requirePortalContext(): Promise<PortalContext> {
  const session = await requirePortalContact();
  // Every field below is declared in CONTACT_ADDITIONAL_FIELDS, and
  // `portalGateDecision` has already refused the session if `tenantId`
  // or `clientId` came back undefined — which is what a column missing
  // from that declaration looks like (src/auth/portal-gate.ts).
  const contact = session.user as {
    id: string;
    email: string;
    name: string;
    tenantId: string;
    clientId: string;
    locale?: string | null;
  };

  return {
    principal: {
      contactId: contact.id,
      tenantId: contact.tenantId,
      clientId: contact.clientId,
      gates: await gatesFor(contact.tenantId),
    },
    sessionId: session.session.id,
    email: contact.email,
    name: contact.name,
    locale: contact.locale ?? null,
  };
}

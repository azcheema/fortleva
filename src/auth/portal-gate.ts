/**
 * The portal admission rule, as PURE policy — the contact-plane twin of
 * ./platform-gate.ts, and in its own importless module for the same
 * reason: `./session` reaches `./index` and therefore `@/db/client`,
 * which throws without DATABASE_URL, so a policy that can only be
 * exercised against a database is one that gets tested rarely. Here it
 * is a plain function over plain values and src/auth/portal-gate.test.ts
 * pins the whole matrix with no connection, no cookie and no Better
 * Auth.
 *
 * This is NOT authorization. `authorizePortal()` (AUTHZ.md §8) decides
 * what a contact may do; this decides only whether the person holding
 * this cookie is a contact the portal will talk to at all. Behind both,
 * the RESTRICTIVE `portal_gate` RLS policies make internal rows
 * unreachable regardless (TENANCY.md §7.2).
 */

/**
 * Why the portal admits a request, or why it does not. A discriminated
 * result rather than a boolean, because the remedies differ: a
 * SUSPENDED contact needs to talk to their agency, an unverified one
 * needs a link, and `incomplete` is not a person's problem at all — it
 * is ours.
 */
export type PortalGate =
  | "no_session"
  | "incomplete"
  | "not_active"
  | "unverified"
  | "ok";

export interface PortalGateInput {
  /**
   * Optional like every other field, and for the same reason: absent
   * must DENY. A caller that forgets to pass it gets "no_session".
   */
  readonly hasSession?: boolean;
  /** Contact.portalStatus — only ACTIVE may hold a session. */
  readonly portalStatus?: string | null;
  readonly emailVerified?: boolean | null;
  /** The tenancy the session is scoped to; both are required to act. */
  readonly tenantId?: string | null;
  readonly clientId?: string | null;
}

/**
 * FAILS CLOSED at every step: anything not positively recognised is a
 * denial.
 *
 * `incomplete` is checked BEFORE the status and it is the whole reason
 * this verdict exists. Better Auth copies onto its session object only
 * the columns present in an instance's OWN declared table schema
 * (@better-auth/core .../db/adapter/factory.mjs), so a field left out
 * of `user.additionalFields` reads as `undefined` no matter what the
 * row holds. That exact mistake made the ops console unreachable in
 * 2026-09-09 — `platformRole` came back undefined and every session was
 * denied. Here the same slip would be far worse than an outage: with
 * `tenantId` or `clientId` undefined, a caller that treated the session
 * as usable would be running with no client scope at all, against a
 * `portal_gate` policy whose whole predicate is `client_id =
 * app.client_id`. So a session missing either of them is refused
 * loudly, and portal.dbtest.ts asserts the columns really arrive.
 *
 * `portalStatus` is compared to the literal ACTIVE rather than "not
 * revoked": NO_ACCESS, INVITED, SUSPENDED and REVOKED must all deny,
 * and so must a value this code has never heard of.
 */
export const portalGateDecision = (input: PortalGateInput): PortalGate => {
  if (!input.hasSession) return "no_session";
  if (!input.tenantId || !input.clientId) return "incomplete";
  if (!input.portalStatus) return "incomplete";
  if (input.portalStatus !== "ACTIVE") return "not_active";
  if (input.emailVerified !== true) return "unverified";
  return "ok";
};

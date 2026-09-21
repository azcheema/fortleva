import { currentPrincipal, currentTenantId, withTenant, type TenantDb } from "@/db";
import { deny } from "@/authz/errors";

import type { PortalCapability } from "./capabilities";
import { portalModuleVerdict, portalPrincipalVerdict, type PortalModuleGates } from "./policy";

/**
 * Transaction handles `withPortalRead` produced, and the contact row
 * already read inside each. Both are Weakly keyed on the Prisma
 * transaction client, so they live exactly as long as the transaction
 * does and hold nothing open.
 *
 * The first is an identity check, not a cache: it is what lets step 0
 * say "this handle is a contact transaction" rather than "some
 * enclosing scope was one".
 */
const CONTACT_TRANSACTIONS = new WeakSet<object>();
const CONTACT_ROW_BY_TX = new WeakMap<
  object,
  {
    tenantId: string;
    clientId: string;
    portalProfile: string;
    portalStatus: string;
    invitedAt: Date | null;
  }
>();

/**
 * `authorizePortal()` — gate 4 for the contact plane (AUTHZ.md §8), and
 * the seam every portal projection and every brokered write calls first.
 * It is to `src/modules/*\/portal.ts` what `requireAccess()` +
 * `assertInScope()` are to a member service.
 *
 * THE PIPELINE, in §8's own order:
 *
 *   0. the transaction is running under THIS contact's principal, so
 *      that every gate below is decided by the database and not by the
 *      caller's choice of principal;
 *   1. the contact row is reachable under THIS principal — the read is
 *      the check (below);
 *   2. it is ACTIVE and was invited, and its profile holds the
 *      capability                                     → policy.ts;
 *   3. the resource belongs to the contact's client and tenant;
 *   4. …and is CLIENT_VISIBLE on a portal-enabled project — 3 and 4 are
 *      one row read, because they are one RLS predicate;
 *   5. module gates 1–3                               → policy.ts.
 *
 * BEHIND ALL OF IT, THE DATABASE. Every read here runs under the
 * contact principal, so `portal_gate` ("client_id = app.client_id AND
 * visibility = 'CLIENT_VISIBLE' AND portal_enabled") has already
 * decided before this function's opinion matters. That is the point: a
 * bug in this file is a defence-in-depth failure, not a data breach.
 * The function exists so that a denial is CHEAP and TYPED — caught
 * before any projection runs, with a reason an audit row can carry —
 * not because it is the thing keeping a client out of another client's
 * data.
 *
 * Which is also why steps 3–4 are written as a row read and not as a
 * comparison. Comparing `project.clientId` to `principal.clientId` in
 * TypeScript would need the row first, and getting the row means
 * passing the very gate the comparison was meant to make. Asking the
 * database for the row and treating "no row" as NOT_FOUND makes the
 * policy the authority and the code a caller of it.
 */

/**
 * The resolved contact principal for one request. Built by
 * `requirePortalContext()`; never assembled from request parameters,
 * for the reason every server action derives its tenant from the
 * session (AGENTS.md).
 *
 * `gates` is carried rather than fetched per call because gates 1–3 are
 * a tenant-config read that cannot happen under this principal at all —
 * see `module-gates.ts`, which is the load-bearing comment of slice 2.
 *
 * IT IS CALLER-SUPPLIED DATA AND IS NOT BOUND TO `tenantId`, which is
 * the same shape — and the same answer — as `MemberActor.mfa` on the
 * member plane: AUTHZ.md §7.5 closes it with a rule ("only
 * `requireTenantContext()` should build actors for ✦ paths") rather
 * than a mechanism, because branding a type does not survive a spread.
 * Here the rule is: **only `requirePortalContext()` builds a
 * `PortalPrincipal`**, and it resolves `gatesFor(contact.tenantId)` from
 * the session it just validated, so the gates and the tenant cannot
 * disagree.
 *
 * A slice-3 review sharpened the hazard and it is worth carrying
 * forward: the risk is less "a route spoofs all-ok" than "a route
 * reuses a gates map resolved for ANOTHER tenant", which would let one
 * agency's entitlements decide another's. **View-as-Contact is the
 * slice that will first synthesise a principal outside
 * `requirePortalContext()`, and it must resolve the gates from the
 * viewed contact's tenant rather than carrying the member's.**
 */
export type PortalPrincipal = {
  readonly contactId: string;
  readonly tenantId: string;
  readonly clientId: string;
  readonly gates: PortalModuleGates;
};

/**
 * What the capability is being exercised ON. Omitted for a list query:
 * a list is bounded by `portal_gate` on every row it returns, so there
 * is no single resource to name and inventing one would be theatre.
 *
 * TWO KINDS TODAY, AND THAT IS THE WHOLE COVERAGE (code review,
 * 2026-09-20 — the pipeline comment above used to imply more). A
 * document, a `ProjectVersion`, a work item, a `TimeReport` or a comment
 * subject has no ref kind yet, so a caller either omits the ref —
 * authorizing nothing about the row — or passes `{kind:"project"}`,
 * which proves the project is portal-enabled and reachable and says
 * nothing about that row's own `visibility`. RLS still gates the read
 * that follows, so this is incomplete defence in depth rather than a
 * leak; the slice that introduces each resource kind owes its ref.
 */
export type PortalScopeRef =
  | { readonly kind: "client"; readonly clientId: string }
  | { readonly kind: "project"; readonly projectId: string };

/**
 * Throws `AuthzError` on every denial. NOT_FOUND for anything
 * out-of-scope — existence must not leak across the client boundary,
 * and on this plane "the client boundary" is the whole product.
 *
 * THESE REASONS ARE INTERNAL. They are for the audit row, the server log
 * and the test matrix; the portal's HTTP surface renders every one of
 * them identically, because a contact told NOT_ENTITLED has been told
 * something about their agency's commercial arrangements. Since slice 3
 * that is a call and not a rule: `portalReadOrNull()`
 * (`src/portal/render.ts`) is the single place a page turns any of these
 * into the one empty surface. Do not branch on `reason` in a route.
 */
export async function authorizePortal(
  tx: TenantDb,
  principal: PortalPrincipal,
  capability: PortalCapability,
  ref?: PortalScopeRef,
  opts?: {
    /**
     * Phase 8 only: proof that the continuity box is SEALED, which is
     * the precondition AUTHZ.md §5 puts on the continuity exemption.
     * Defaults to false, so the exemption does not apply until someone
     * establishes it. See `capabilities.ts`.
     */
    readonly continuityBoxSealed?: boolean;
  },
): Promise<void> {
  // 0. THE TRANSACTION IS THE CONTACT'S OWN. Without this, handing
  //    `authorizePortal` a system-principal `tx` would pass every gate
  //    below — a system principal satisfies every `portal_gate`, so the
  //    contact row, the project row and the visibility term would all
  //    come back regardless of who the contact is. The function would
  //    then be checking the contact's PROFILE against rows nobody
  //    checked the ownership of.
  //
  //    It is a refusal rather than a comment because the mistake is a
  //    plausible one: brokered writes legitimately run as `system`
  //    (AUTHZ.md §8), so that shape is always nearby on the clipboard.
  //    The rule is `withPortalRead` first, `authorizePortal` inside.
  //
  //    It also holds View-as-Contact (founder decision 1, 2026-09-20)
  //    to its own safety condition: a member viewing as a contact must
  //    enter a REAL contact transaction with the synthesised principal,
  //    not read under their own member session with a contact object
  //    passed alongside. That is what makes the pins' byte-identity
  //    claim true rather than approximately true.
  //    TWO CHECKS, BECAUSE THE AMBIENT CONTEXT IS NOT THE `tx`. Both
  //    reviews made the same point and it was fair: reading
  //    `currentPrincipal()` proves that an enclosing `withTenant` in
  //    this async context is this contact's, NOT that the handle passed
  //    as `tx` belongs to that transaction. A system `tx` captured in an
  //    outer scope and used inside a `withPortalRead` callback would
  //    have satisfied the ambient check while every read ran as
  //    `system`. `withPortalRead` therefore STAMPS the handle it hands
  //    out, and this refuses any handle it did not stamp — which makes
  //    the claim exact at the cost of a WeakSet lookup rather than a
  //    round trip. The ambient check stays as the second half: it is
  //    what catches a stamped handle from a DIFFERENT contact.
  const ambient = currentPrincipal();
  if (
    !CONTACT_TRANSACTIONS.has(tx) ||
    ambient?.type !== "contact" ||
    ambient.id !== principal.contactId ||
    ambient.clientId !== principal.clientId ||
    currentTenantId() !== principal.tenantId
  ) {
    deny("FORBIDDEN", "authorizePortal outside this contact's transaction");
  }

  // 1. The contact row, read under the contact principal. Three things
  //    at once: the row still exists (a deleted contact's live session
  //    dies here), the session's (tenant, client, contact) triple is
  //    coherent with the database, and — the reason it is a read rather
  //    than a session field — status and profile are CURRENT. Better
  //    Auth's session carries both, but a member who suspends a contact
  //    or demotes it from CONTACT_PRIMARY expects that to bite now, not
  //    at the next sign-in.
  //    Memoised PER TRANSACTION, not per call: the argument for
  //    re-reading is that a suspension must bite mid-session, and a
  //    transaction is the smallest unit over which the answer cannot
  //    change underneath the caller anyway. Without this, a projection
  //    that checks three capabilities paid three round trips on the
  //    plane `module-gates.ts` calls the one that can least afford them.
  const cached = CONTACT_ROW_BY_TX.get(tx);
  const me =
    cached ??
    (await tx.contact.findFirst({
      where: { id: principal.contactId },
      select: {
        tenantId: true,
        clientId: true,
        portalProfile: true,
        portalStatus: true,
        invitedAt: true,
      },
    }));
  if (me && !cached) CONTACT_ROW_BY_TX.set(tx, me);
  // `return deny(...)` rather than a bare call: `deny` returns `never`,
  // but TypeScript only narrows `me` past it when the call is in a
  // return position here.
  if (!me) return deny("NOT_FOUND", "contact not reachable under this principal");
  // Belt: under `portal_gate` a contact can only read contacts of
  // `app.client_id`, and `tenant_isolation` bounds the tenant, so this
  // can only fire if a GUC and the session disagree. That is exactly
  // when one wants it to fire.
  if (me.tenantId !== principal.tenantId || me.clientId !== principal.clientId) {
    deny("NOT_FOUND", "principal does not match the contact row");
  }

  // 2. Active, invited, and the capability is in the profile.
  const principalVerdict = portalPrincipalVerdict({
    capability,
    profile: me.portalProfile,
    portalStatus: me.portalStatus,
    invitedAt: me.invitedAt,
  });
  if (!principalVerdict.ok) deny(principalVerdict.reason, principalVerdict.detail);

  // 3 + 4. The resource, through the gate.
  if (ref?.kind === "project") {
    const row = await tx.project.findFirst({ where: { id: ref.projectId }, select: { id: true } });
    if (!row) deny("NOT_FOUND", "project");
  } else if (ref?.kind === "client") {
    if (ref.clientId !== principal.clientId) deny("NOT_FOUND", "client");
    const row = await tx.client.findFirst({ where: { id: ref.clientId }, select: { id: true } });
    if (!row) deny("NOT_FOUND", "client");
  }

  // 5. Gates 1–3 for every module this capability rides on.
  const moduleVerdict = portalModuleVerdict(capability, principal.gates, opts);
  if (!moduleVerdict.ok) deny(moduleVerdict.reason, moduleVerdict.detail);
}

/**
 * The read seam for everything a contact sees: one transaction under
 * the RLS-scoped CONTACT principal, never a system one.
 *
 * It exists as a named function so that the rule is a call, not a
 * convention. TENANCY.md §7.2 puts it plainly — "portal *reads* never
 * run under a system principal" — and the way that rule gets broken is
 * not by someone disagreeing with it, but by someone reaching for
 * `withTenant(tenantId, {type:'system'})` because it was the shape
 * already on the clipboard from a brokered write.
 *
 * Brokered WRITES deliberately do not get a twin here: they live in
 * `src/modules/*\/portal-writes.ts` (founder decision 2026-09-20), where
 * "this code runs as system" is a property of the filename.
 */
export async function withPortalRead<T>(
  principal: PortalPrincipal,
  fn: (tx: TenantDb) => Promise<T>,
): Promise<T> {
  return withTenant(
    principal.tenantId,
    { type: "contact", id: principal.contactId, clientId: principal.clientId },
    (tx) => {
      // The stamp step 0 checks. A WeakSet, so a finished transaction's
      // handle is collected with it and nothing here keeps a connection
      // or a row alive.
      CONTACT_TRANSACTIONS.add(tx);
      return fn(tx);
    },
  );
}

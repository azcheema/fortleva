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
 *      one row read, because they are one RLS predicate (and since slice
 *      74 the by-id probes also read the switch from the PROJECT, not
 *      only from the row's trigger-maintained copy — below);
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
 * The resolved contact principal for one request; never assembled from
 * request parameters, for the reason every server action derives its
 * tenant from the session (AGENTS.md).
 *
 * `gates` is carried rather than fetched per call because gates 1–3 are
 * a tenant-config read that cannot happen under this principal at all —
 * see `module-gates.ts`, which is the load-bearing comment of slice 2.
 *
 * IT IS CALLER-SUPPLIED DATA AND IS NOT BOUND TO `tenantId`, which is
 * the same shape — and the same answer — as `MemberActor.mfa` on the
 * member plane: a rule rather than a mechanism, because branding a type
 * does not survive a spread.
 *
 * **TWO BUILDERS, ONE PER PLANE, and that is the whole rule.**
 * `requirePortalContext()` (`./context.ts`) builds one from a contact
 * SESSION; `synthesiseContactPrincipal()` (`./synthesise.ts`) builds one
 * from a contact ROW a member has been authorised to look through.
 * Nothing else may, and `src/authz/portal-view-as.test.ts` asserts the
 * set by equality, so a third builder fails a test rather than reaching
 * a review.
 *
 * *(Corrected 2026-09-21, slice 5. This paragraph used to say "only
 * `requirePortalContext()` builds a `PortalPrincipal`" — a sentence
 * that stopped being true the moment slice 4 shipped the Portal tab's
 * preview, and stayed in the file for a slice. The repo's own recurring
 * finding: the documents disagree with the code.)*
 *
 * A slice-3 review sharpened the hazard and it is worth carrying
 * forward: the risk is less "a route spoofs all-ok" than "a route
 * reuses a gates map resolved for ANOTHER tenant", which would let one
 * agency's entitlements decide another's. **Slice 5 closed it with a
 * signature rather than a convention**: `synthesiseContactPrincipal`
 * takes no tenant id to resolve gates from — it reads
 * `contact.tenantId` off the row and resolves them from that, so a
 * caller holding the member's tenant cannot pass it even by accident.
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
 * THREE KINDS TODAY, AND THAT IS THE WHOLE COVERAGE (code review,
 * 2026-09-20 — the pipeline comment above used to imply more). A
 * document, a `ProjectVersion`, a `TimeReport` or a comment subject has
 * no ref kind yet, so a caller either omits the ref — authorizing
 * nothing about the row — or passes `{kind:"project"}`, which proves
 * the project is portal-enabled and reachable and says nothing about
 * that row's own `visibility`. RLS still gates the read that follows,
 * so this is incomplete defence in depth rather than a leak; the slice
 * that introduces each resource kind owes its ref.
 *
 * `work_item` PAID THAT DEBT IN SLICE 6c, and it is the strongest of
 * the three: `work_item`'s `portal_gate` carries the row's OWN
 * `visibility` term as well as the client and the portal switch, so a
 * ref that resolves has proved the contact may read that exact task —
 * not merely that its project is reachable.
 *
 * `document` PAID ITS DEBT WITH THE PORTAL FILES SLICE, and it is the
 * same strength: `document`'s `portal_gate` is the three-term form
 * (client, CLIENT_VISIBLE, `portal_enabled` — which the stamp trigger
 * sets TRUE for a client-level document with no project), so a ref that
 * resolves has proved the contact may read that exact file's row. What
 * it has NOT proved is anything about the file LAYER: `file_version`
 * and `file_object` carry `portal_deny`, and the download that follows
 * is brokered (`src/documents/portal-writes.ts`), which is the whole
 * reason the ref exists — the broker's system transaction must be
 * preceded by a proof the database made.
 */
export type PortalScopeRef =
  | { readonly kind: "client"; readonly clientId: string }
  | { readonly kind: "project"; readonly projectId: string }
  | { readonly kind: "work_item"; readonly workItemId: string }
  | { readonly kind: "document"; readonly documentId: string }
  /**
   * `project_version` PAID ITS DEBT WITH THE SIGN-OFF SLICE (2026-09-27).
   * Its `portal_gate` is the status-structural form — client match AND
   * `status = 'SHIPPED'` AND `portal_enabled` — so a ref that resolves
   * has proved the contact may read that exact shipped version, which
   * is the row the decision lands on.
   */
  | { readonly kind: "project_version"; readonly versionId: string };

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
  } else if (ref?.kind === "work_item") {
    // Under `portal_gate` this single probe decides four things at once
    // — the tenant, the client, the row's own CLIENT_VISIBLE, and the
    // project's portal switch (denormalised onto the row by trigger).
    // `id` alone is selected: whether the contact may act on this task
    // is the question, and every other column is the projection's
    // business, not this file's.
    //
    // AND THE SWITCH ONCE MORE, FROM THE PROJECT ITSELF (slice 74, C40).
    // The row's `portal_enabled` is a COPY, and until slice 74 a row
    // written while a DISABLE was in flight kept `true` after it. The
    // gate migration (20260928180000) closed that race; this relation
    // filter makes the by-id probes stop depending on the copy at all.
    // Under the contact principal it is a read of `project`, so
    // project's own `portal_gate` answers it — a switched-off project is
    // simply not there.
    const row = await tx.workItem.findFirst({
      where: { id: ref.workItemId, project: { portalEnabled: true } },
      select: { id: true },
    });
    if (!row) deny("NOT_FOUND", "work item");
  } else if (ref?.kind === "document") {
    // The same single probe: tenant, client, the row's own CLIENT_VISIBLE
    // and the project's switch are all `portal_gate`'s. The soft-delete
    // term is the projection's, not the policy's, and it is repeated
    // here so a deleted file cannot be downloaded by an id somebody kept.
    // The project term is restated as for a task (above); a client-level
    // file has no project and no switch.
    const row = await tx.document.findFirst({
      where: {
        id: ref.documentId,
        deletedAt: null,
        OR: [{ projectId: null }, { project: { portalEnabled: true } }],
      },
      select: { id: true },
    });
    if (!row) deny("NOT_FOUND", "document");
  } else if (ref?.kind === "project_version") {
    // Tenant, client, SHIPPED and the project's switch are all
    // `portal_gate`'s on this table (the status-structural form); there
    // is no soft delete on a version. The project term is restated as
    // for a task (above).
    const row = await tx.projectVersion.findFirst({
      where: { id: ref.versionId, project: { portalEnabled: true } },
      select: { id: true },
    });
    if (!row) deny("NOT_FOUND", "project version");
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

/**
 * THE CENSUS-WRITE SEAM — the one transaction shape in which a contact
 * WRITES under their own principal (Phase 3, the sign-off slice).
 *
 * TENANCY.md §7.2 enumerates the contact-writable census exactly: a
 * `Comment` INSERT, the approval columns of a `ProjectVersion` and of a
 * `Document`, the inbox flags on the contact's own `Notification` rows.
 * Those writes are NOT brokered — the whole point of a census entry is
 * that RLS, a named policy and a trigger decide them, so that the
 * database is the last line rather than the application's `where`. A
 * write through here therefore runs under the SAME principal as a read,
 * with the same stamp (`authorizePortal` inside it works exactly as it
 * does in a read), and every identifying term is the policy's before it
 * is the code's.
 *
 * It is a second name for the same transaction rather than a flag on
 * `withPortalRead`, for the reason the broker file has its own name:
 * "this transaction writes as the contact" must be greppable, and
 * `src/authz/portal-projections.test.ts` scans every file that says it.
 * What may be written through it is what the census test measures
 * (`src/portal/census.dbtest.ts`) — anything else is refused by the
 * database with 42501, which is the property the seam exists to lean on.
 * The audit row is written INSIDE it, under the contact
 * (`portal_audit_insert` admits a row describing the contact itself);
 * anything the agency must be told is emitted AFTER it, because a
 * contact may not insert a `notification` row.
 */
export async function withCensusWrite<T>(
  principal: PortalPrincipal,
  fn: (tx: TenantDb) => Promise<T>,
  opts?: { readonly lockTimeoutMs?: number },
): Promise<T> {
  return withTenant(
    principal.tenantId,
    { type: "contact", id: principal.contactId, clientId: principal.clientId },
    (tx) => {
      CONTACT_TRANSACTIONS.add(tx);
      return fn(tx);
    },
    opts,
  );
}

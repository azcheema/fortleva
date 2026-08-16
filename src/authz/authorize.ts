import type { TenantDb } from "@/db";

import { PERMISSIONS } from "./catalog";
import { AuthzError, deny } from "./errors";

/**
 * The authorization seam (AUTHZ.md §6): every member-plane check flows
 * through here. No call site touches authz tables or compares role
 * names — enforced by lint and review. Contacts have their own seam
 * (authorizePortal, Phase 3); platform has authorizePlatform.
 */

const KNOWN_CODES = new Set(PERMISSIONS.map((p) => p.code));
const PERMISSION_BY_CODE = new Map(PERMISSIONS.map((p) => [p.code, p]));

/**
 * Step-up ("sudo") window for ✦ codes (SECURITY.md §3.5/§3.6): a second
 * factor verified on THIS session within the window satisfies authorize();
 * older or absent ⇒ MFA_REQUIRED/step_up. Callers with a stricter window
 * (vault, continuity box) call requireRecentMfa() after requireAccess().
 */
export const STEP_UP_WINDOW_MINUTES = 15;

export type MfaState = {
  /** User.twoFactorEnabled — a TOTP factor is enrolled. */
  readonly enrolled: boolean;
  /** Session.mfaVerifiedAt — last interactive factor on this session. */
  readonly verifiedAt: Date | null;
};

export type MemberActor = {
  readonly memberId: string;
  /** Set during platform impersonation — restricts to view-class verbs. */
  readonly impersonated?: boolean;
  /**
   * MFA posture of the session (AUTHZ.md §7.5). Absent means "unknown"
   * and is treated as not enrolled — a ✦ code then denies; only
   * requireTenantContext() should build actors for ✦ paths.
   */
  readonly mfa?: MfaState;
};

const minutesSince = (at: Date, now: Date): number => (now.getTime() - at.getTime()) / 60_000;

/**
 * Sudo-window helper (AUTHZ.md §7.5, SECURITY.md §3.5): throws
 * MFA_REQUIRED unless the actor's session carries a second-factor
 * verification newer than `minutes`. Enrolment missing ⇒ "enrol";
 * stale/absent verification ⇒ "step_up". Pure and synchronous-safe;
 * async for call-site symmetry with authorize().
 */
export async function requireRecentMfa(
  actor: MemberActor,
  minutes: number,
  now: Date = new Date(),
): Promise<void> {
  if (!actor.mfa?.enrolled) deny("MFA_REQUIRED", "enrol");
  const at = actor.mfa?.verifiedAt;
  if (!at || minutesSince(at, now) > minutes) deny("MFA_REQUIRED", "step_up");
}

/**
 * Effective permission set = union across held roles, minus
 * TENANT_REVOKE tombstones (B3). Resolved per request from the DB —
 * never from a JWT (§7.6). Callers memoize per request.
 */
export async function effectivePermissions(
  tx: TenantDb,
  memberId: string,
): Promise<ReadonlySet<string>> {
  const rows = await tx.memberRole.findMany({
    where: { memberId, member: { status: "ACTIVE" } },
    select: {
      role: {
        select: {
          rolePermissions: {
            where: { source: { not: "TENANT_REVOKE" } },
            select: { permission: { select: { code: true } } },
          },
        },
      },
    },
  });
  const codes = new Set<string>();
  for (const row of rows) {
    for (const rp of row.role.rolePermissions) codes.add(rp.permission.code);
  }
  return codes;
}

/** View-class verbs an impersonating platform admin is limited to (§9). */
const VIEW_VERBS = new Set(["view", "view_all"]);

/**
 * Gate 4 for members: permission held? Fails CLOSED on unknown codes —
 * that is a config error, not a user error (AUTHZ.md §2).
 */
export async function authorize(
  tx: TenantDb,
  actor: MemberActor,
  code: string,
): Promise<void> {
  if (!KNOWN_CODES.has(code)) {
    console.error(`authorize: unknown permission code "${code}" — denying (config error)`);
    deny("FORBIDDEN", "unknown permission code");
  }
  if (actor.impersonated) {
    const verb = code.split(":")[1] ?? "";
    if (!VIEW_VERBS.has(verb)) {
      deny("FORBIDDEN", "impersonation is read-only");
    }
  }
  const held = await effectivePermissions(tx, actor.memberId);
  if (!held.has(code)) deny("FORBIDDEN");
  // ✦ codes (§7.5): permission held is necessary, not sufficient — the
  // session must carry an enrolled AND recent second factor. Checked
  // AFTER the permission so MFA_REQUIRED never leaks "would be allowed".
  if (PERMISSION_BY_CODE.get(code)?.requiresMfa) {
    await requireRecentMfa(actor, STEP_UP_WINDOW_MINUTES);
  }
}

export async function isAuthorized(
  tx: TenantDb,
  actor: MemberActor,
  code: string,
): Promise<boolean> {
  try {
    await authorize(tx, actor, code);
    return true;
  } catch (e) {
    if (e instanceof AuthzError) return false;
    throw e;
  }
}

// ── Resource scoping — the harder half (AUTHZ.md §4) ────────────────
//
// Roles answer WHAT a member may do; assignments answer ON WHICH
// clients/projects. Deny-default: zero MemberClient/MemberProject rows
// ⇒ empty scope; `client:view_all` is the only override. Two axes:
//   client  — MemberClient rows (direct) + the project→client LIFT from
//             MemberProject (the parent client's card only).
//   project — MemberProject rows + every project of a directly assigned
//             client (client assignment subsumes its projects).
// The lifted client ids are deliberately absent from project-scoped
// filters: that is what keeps a client's P2 invisible to a P1-only
// member. Out-of-scope ⇒ NOT_FOUND, never FORBIDDEN (existence must not
// leak across the client boundary).

export type ResourceScope = { kind: "all" } | { kind: "ids"; ids: readonly string[] };

export type ScopeResolution =
  | { readonly all: true }
  | {
      readonly all: false;
      /** MemberClient rows. */
      readonly directClientIds: readonly string[];
      /** Clients of MemberProject projects that are NOT directly assigned. */
      readonly liftedClientIds: readonly string[];
      /** MemberProject rows ∪ projects of directClientIds. */
      readonly projectIds: readonly string[];
    };

/**
 * One resolution of both axes (three indexed queries, all under RLS).
 * Callers inside one unit of work may reuse the result; it is NOT
 * cached across transactions — assignments change, and per-request
 * resolution is the §7.6 rule.
 */
export async function resolveScope(tx: TenantDb, actor: MemberActor): Promise<ScopeResolution> {
  const held = await effectivePermissions(tx, actor.memberId);
  if (held.has("client:view_all")) return { all: true };

  const [clientRows, projectRows] = await Promise.all([
    tx.memberClient.findMany({ where: { memberId: actor.memberId }, select: { clientId: true } }),
    tx.memberProject.findMany({
      where: { memberId: actor.memberId },
      select: { projectId: true, project: { select: { clientId: true } } },
    }),
  ]);
  const direct = new Set(clientRows.map((r) => r.clientId));
  const projects = new Set(projectRows.map((r) => r.projectId));
  const lifted = new Set<string>();
  for (const r of projectRows) {
    if (!direct.has(r.project.clientId)) lifted.add(r.project.clientId);
  }
  if (direct.size > 0) {
    const ofClients = await tx.project.findMany({
      where: { clientId: { in: [...direct] } },
      select: { id: true },
    });
    for (const p of ofClients) projects.add(p.id);
  }
  return {
    all: false,
    directClientIds: [...direct],
    liftedClientIds: [...lifted],
    projectIds: [...projects],
  };
}

export type ResourceAxis = "client" | "project";

/**
 * List-query scoping (AUTHZ.md §4). `'client'` = the Client table
 * itself (direct ∪ lifted — the freelancer sees the parent card);
 * `'project'` = MemberProject ∪ projects of directly assigned clients.
 * `all` only under client:view_all.
 */
export async function authorizedResourceIds(
  tx: TenantDb,
  actor: MemberActor,
  axis: ResourceAxis,
): Promise<ResourceScope> {
  const scope = await resolveScope(tx, actor);
  if (scope.all) return { kind: "all" };
  return axis === "client"
    ? { kind: "ids", ids: [...scope.directClientIds, ...scope.liftedClientIds] }
    : { kind: "ids", ids: scope.projectIds };
}

/** Thin wrapper kept for Phase-1 call sites: the client axis. */
export async function authorizedClientIds(
  tx: TenantDb,
  actor: MemberActor,
): Promise<ResourceScope> {
  return authorizedResourceIds(tx, actor, "client");
}

export type ScopeRef =
  /** A project row or anything hanging off it (milestones, versions,
   * project services/documents, work items, time entries…). */
  | { readonly projectId: string }
  /**
   * A client-scoped resource. Default = DIRECT assignment only (client-
   * level documents, assets, credentials — a P1-only member does not
   * reach the client's other client-level rows). `lifted: true` accepts
   * the project→client lift and is meant for the client CARD itself
   * (name, contacts) — AUTHZ.md §4 deny-matrix "E1 (MemberProject P1):
   * Acme card = name + contacts".
   */
  | { readonly clientId: string; readonly lifted?: boolean };

/**
 * Single-resource twin of scopeWhere (AUTHZ.md §4): resolves the
 * actor's scope inside the transaction and throws NOT_FOUND when the
 * target is outside it. Under client:view_all the target must still
 * exist in the tenant (RLS already bounds it) — the same NOT_FOUND, so
 * callers never learn which gate fired. Every module service calls it
 * after requireAccess and before mutating; cross-project moves call it
 * on both source and destination.
 */
export async function assertInScope(
  tx: TenantDb,
  actor: MemberActor,
  ref: ScopeRef,
): Promise<void> {
  const scope = await resolveScope(tx, actor);
  if ("projectId" in ref) {
    if (scope.all) {
      const row = await tx.project.findFirst({ where: { id: ref.projectId }, select: { id: true } });
      if (!row) deny("NOT_FOUND");
      return;
    }
    if (!scope.projectIds.includes(ref.projectId)) deny("NOT_FOUND");
    return;
  }
  if (scope.all) {
    const row = await tx.client.findFirst({ where: { id: ref.clientId }, select: { id: true } });
    if (!row) deny("NOT_FOUND");
    return;
  }
  const ok =
    scope.directClientIds.includes(ref.clientId) ||
    (ref.lifted === true && scope.liftedClientIds.includes(ref.clientId));
  if (!ok) deny("NOT_FOUND");
}

type InFilter = { in: string[] };
export type ScopeWhere<CF extends string, PF extends string> =
  | Record<never, never>
  | { [K in CF]: InFilter }
  | { OR: Array<{ [K in CF]: InFilter } | { [K in PF]: InFilter }> };

export type ScopeWhereOptions<CF extends string, PF extends string> = {
  /** The row's client column ("clientId"; "id" for the Client table). */
  readonly clientField: CF;
  /** The row's project column when the table is project-scoped. */
  readonly projectField?: PF;
  /**
   * Accept the project→client lift on the client term. Only for the
   * Client table (`clientField: "id"`) and its card-level children
   * (Contact); never for content rows.
   */
  readonly lifted?: boolean;
};

/**
 * The Prisma `where` fragment every list query composes in (AUTHZ.md
 * §4): `{}` under client:view_all; `{ clientField: { in: direct } }` for
 * client-scoped tables; `{ OR: [ { clientField: { in: direct } },
 * { projectField: { in: projectIds } } ] }` for project-scoped tables —
 * the lifted client ids are absent there by design (P2 stays invisible
 * to a P1-only member). Spread it or AND it: `where: { ...scope, … }`.
 * With zero assignments the `in` lists are empty ⇒ zero rows.
 */
export async function scopeWhere<CF extends string, PF extends string = never>(
  tx: TenantDb,
  actor: MemberActor,
  opts: ScopeWhereOptions<CF, PF>,
): Promise<ScopeWhere<CF, PF>> {
  const scope = await resolveScope(tx, actor);
  if (scope.all) return {};
  const clientIds = opts.lifted
    ? [...scope.directClientIds, ...scope.liftedClientIds]
    : scope.directClientIds;
  const clientTerm = { [opts.clientField]: { in: [...clientIds] } } as { [K in CF]: InFilter };
  if (opts.projectField === undefined) return clientTerm;
  const projectTerm = { [opts.projectField]: { in: [...scope.projectIds] } } as {
    [K in PF]: InFilter;
  };
  return { OR: [clientTerm, projectTerm] };
}

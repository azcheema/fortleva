import { resolveScope, type MemberActor, type ScopeResolution } from "@/authz/authorize";
import { deny } from "@/authz/errors";
import type { TenantDb } from "@/db";

/**
 * WHICH CREDENTIALS A MEMBER CAN REACH (AUTHZ.md §4; C49).
 *
 * A credential hangs off one of three anchors, and each has its own rule:
 *   - a PROJECT (`projectId` set): the project axis — MemberProject, or a
 *     direct assignment to the project's client;
 *   - a CLIENT only (`projectId` NULL): DIRECT client assignment only — a
 *     member of one of the client's projects does not reach the client's
 *     client-level logins (AUTHZ.md §4's "client-level documents, assets,
 *     credentials");
 *   - NOTHING (`clientId` NULL) — the agency's own login (the registrar,
 *     the agency's hosting): only a member whose scope is the WHOLE tenant
 *     (`client:view_all`, seeded on owners, managers and admins). Founder
 *     decision C49, 2026-10-01, taken with the recommendation: employees
 *     see the logins of the clients they work on, never the agency's own.
 *
 * Out of scope is NOT_FOUND, never FORBIDDEN, so a credential id answers
 * the same whether it is out of reach or does not exist. RLS stays tenant
 * + client + visibility; this is the service-side half, and the dbtest
 * pins it on real rows.
 */

export type CredentialAnchor = { readonly clientId: string | null; readonly projectId: string | null };

/** True when `scope` reaches `anchor` (a pure check over a resolved scope). */
export function anchorInScope(scope: ScopeResolution, anchor: CredentialAnchor): boolean {
  if (scope.all) return true;
  if (anchor.projectId !== null) return scope.projectIds.includes(anchor.projectId);
  if (anchor.clientId !== null) return scope.directClientIds.includes(anchor.clientId);
  return false; // the agency's own: tenant-wide scope only (C49)
}

export async function assertCredentialInScope(
  tx: TenantDb,
  actor: MemberActor,
  anchor: CredentialAnchor,
): Promise<ScopeResolution> {
  const scope = await resolveScope(tx, actor);
  if (!anchorInScope(scope, anchor)) deny("NOT_FOUND");
  return scope;
}

/**
 * The list query's `where` fragment — the same three rules as a filter.
 * `{}` under tenant-wide scope. Otherwise a credential is listed when its
 * project is one of the member's, OR it is a client-level row of a
 * directly assigned client. A NULL client matches neither term, which is
 * what keeps the agency's own logins out of a scoped member's list.
 */
export function credentialScopeWhere(scope: ScopeResolution) {
  if (scope.all) return {};
  return {
    OR: [
      { projectId: { in: [...scope.projectIds] } },
      { projectId: null, clientId: { in: [...scope.directClientIds] } },
    ],
  };
}

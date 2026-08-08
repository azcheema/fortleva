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

export type MemberActor = {
  readonly memberId: string;
  /** Set during platform impersonation — restricts to view-class verbs. */
  readonly impersonated?: boolean;
};

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

export type ResourceScope = { kind: "all" } | { kind: "ids"; ids: readonly string[] };

/**
 * List-query scoping (AUTHZ.md §4): deny-default — zero assignments
 * means an empty scope; client:view_all is the only override. The
 * MemberClient/MemberProject tables land in Phase 2 with their parent
 * entities; until then only the override path can widen the scope,
 * which is exactly deny-default.
 */
export async function authorizedClientIds(
  tx: TenantDb,
  actor: MemberActor,
): Promise<ResourceScope> {
  const held = await effectivePermissions(tx, actor.memberId);
  if (held.has("client:view_all")) return { kind: "all" };
  // Phase 2: union of MemberClient rows + project→client lift.
  return { kind: "ids", ids: [] };
}

import type { Prisma } from "@/generated/prisma/client";
import { withTenant, type TenantDb } from "@/db";
import { effectivePermissions, type MemberActor } from "@/authz/authorize";
import { AuthzError } from "@/authz/errors";
import { record } from "@/audit/record";

import { missingFrom } from "./subset";

/**
 * Escalation guards (AUTHZ.md §7.1–§7.3) shared by role assignment and
 * role editing. Every guard is a transactional application invariant:
 * it runs INSIDE the mutation's transaction, after the row lock taken by
 * bumpPermissionsVersion(), so two concurrent "remove the other owner"
 * requests serialize on the tenant row and the second one sees the
 * first one's effect.
 *
 * A denied escalation is audited (authz.escalation_denied, §7.7). The
 * mutation transaction rolls back on deny, so the audit row is written
 * by runGuarded() in a fresh transaction after the rollback.
 */

/** FORBIDDEN with an audit payload; runGuarded() persists it. */
export class EscalationDenied extends AuthzError {
  constructor(
    detail: string,
    readonly audit: { rule: string; targetType?: string; targetId?: string; codes?: string[] },
  ) {
    super("FORBIDDEN", detail);
    this.name = "EscalationDenied";
  }
}

const trimCodes = (codes: readonly string[]): string[] => codes.slice(0, 10);

/**
 * Run a guarded mutation as `actor` inside withTenant(); on
 * EscalationDenied, record authz.escalation_denied in its own
 * transaction, then rethrow (still an AuthzError/FORBIDDEN to callers).
 */
export async function runGuarded<T>(
  tenantId: string,
  actor: MemberActor,
  fn: (tx: TenantDb) => Promise<T>,
): Promise<T> {
  const principal = { type: "member", id: actor.memberId } as const;
  try {
    return await withTenant(tenantId, principal, fn);
  } catch (e) {
    if (e instanceof EscalationDenied) {
      await withTenant(tenantId, principal, (tx) =>
        record(tx, {
          action: "authz.escalation_denied",
          targetType: e.audit.targetType,
          targetId: e.audit.targetId,
          metadata: {
            rule: e.audit.rule,
            detail: e.detail ?? null,
            ...(e.audit.codes ? { codes: trimCodes(e.audit.codes) } : {}),
          } satisfies Prisma.InputJsonValue,
        }),
      );
    }
    throw e;
  }
}

/**
 * Bump Tenant.permissionsVersion (§7.6) — call it FIRST in every
 * Role/RolePermission/MemberRole mutation: the UPDATE takes the tenant
 * row lock, serializing authz mutations per tenant so the guards below
 * read a consistent state.
 */
export async function bumpPermissionsVersion(tx: TenantDb, tenantId: string): Promise<void> {
  await tx.tenant.update({
    where: { id: tenantId },
    data: { permissionsVersion: { increment: 1 } },
  });
}

/** Effective (non-tombstoned) codes of one role. */
export async function roleEffectiveCodes(tx: TenantDb, roleId: string): Promise<Set<string>> {
  const rows = await tx.rolePermission.findMany({
    where: { roleId, source: { not: "TENANT_REVOKE" } },
    select: { permission: { select: { code: true } } },
  });
  return new Set(rows.map((r) => r.permission.code));
}

/**
 * Grant-subset rule (§7.1 rule 1 & 2): every code in `codes` must be in
 * the actor's effective set. `rule` names the guard for the audit row.
 */
export async function assertActorHoldsAll(
  tx: TenantDb,
  actor: MemberActor,
  codes: Iterable<string>,
  ctx: { rule: string; targetType: string; targetId: string; detail: string },
): Promise<void> {
  const actorSet = await effectivePermissions(tx, actor.memberId);
  const missing = missingFrom(actorSet, codes);
  if (missing.length > 0) {
    throw new EscalationDenied(`${ctx.detail}: ${missing[0]}${missing.length > 1 ? ` (+${missing.length - 1})` : ""}`, {
      rule: ctx.rule,
      targetType: ctx.targetType,
      targetId: ctx.targetId,
      codes: missing,
    });
  }
}

/** The system owner role (templateKey='owner') of the current tenant. */
export async function ownerRoleId(tx: TenantDb): Promise<string> {
  const role = await tx.role.findFirst({
    where: { isSystem: true, templateKey: "owner" },
    select: { id: true },
  });
  if (!role) throw new Error("tenant has no owner system role — provisioning invariant broken");
  return role.id;
}

/** ACTIVE members holding the owner system role, excluding `exceptMemberId`. */
export async function activeOwnerHoldersExcept(
  tx: TenantDb,
  exceptMemberId: string,
): Promise<number> {
  const roleId = await ownerRoleId(tx);
  return tx.memberRole.count({
    where: { roleId, memberId: { not: exceptMemberId }, member: { status: "ACTIVE" } },
  });
}

/**
 * Last-owner invariant (§7.3): deny if removing `memberId` from the
 * ACTIVE owner-holder set would leave zero. Call only when the mutation
 * actually removes the member from that set (role removal of the owner
 * role, suspension of an owner holder).
 */
export async function assertNotLastOwner(
  tx: TenantDb,
  memberId: string,
  ctx: { rule: string; targetType: string; targetId: string },
): Promise<void> {
  const others = await activeOwnerHoldersExcept(tx, memberId);
  if (others === 0) {
    throw new EscalationDenied("cannot remove the last active owner", ctx);
  }
}

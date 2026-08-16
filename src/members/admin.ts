import { withTenant, type TenantDb } from "@/db";
import type { MemberActor } from "@/authz/authorize";
import { AuthzError, deny } from "@/authz/errors";
import { requireAccess } from "@/entitlements/resolver";
import { record } from "@/audit/record";

import {
  EscalationDenied,
  activeOwnerHoldersExcept,
  assertActorHoldsAll,
  assertNotLastOwner,
  bumpPermissionsVersion,
  ownerRoleId,
  roleEffectiveCodes,
  runGuarded,
} from "./guards";

/**
 * Member administration (AUTHZ.md §7.1, §7.3): role assignment under the
 * escalation guards, suspend / reactivate under the last-owner
 * invariant, invite revocation. There is no hard removal: MemberStatus is
 * ACTIVE | SUSPENDED (DATA_MODEL.md §6.1) — "remove" is suspension, and
 * the audit trail is member.suspended / member.reactivated.
 */

const loadMember = async (tx: TenantDb, memberId: string) => {
  const m = await tx.member.findFirst({
    where: { id: memberId },
    select: { id: true, status: true },
  });
  if (!m) throw new AuthzError("NOT_FOUND", "unknown member");
  return m;
};

const loadRole = async (tx: TenantDb, roleId: string) => {
  const r = await tx.role.findFirst({
    where: { id: roleId },
    select: { id: true, name: true, isSystem: true, templateKey: true },
  });
  if (!r) throw new AuthzError("NOT_FOUND", "unknown role");
  return r;
};

/** Precondition: member:manage_roles authorised, tenant row locked. */
async function assignRoleInTx(
  tx: TenantDb,
  tenantId: string,
  actor: MemberActor,
  memberId: string,
  roleId: string,
): Promise<boolean> {
  const role = await loadRole(tx, roleId);
  const codes = await roleEffectiveCodes(tx, roleId);
  const self = memberId === actor.memberId;
  // Grant-subset (§7.1 rule 1) — and, when the target is the actor,
  // no-self-escalation (rule 3): same math, distinct audit rule.
  await assertActorHoldsAll(tx, actor, codes, {
    rule: self ? "no_self_escalation" : "grant_subset",
    targetType: "Member",
    targetId: memberId,
    detail: self
      ? `cannot assign yourself "${role.name}" - you do not hold`
      : `cannot assign "${role.name}" - you do not hold`,
  });
  const existing = await tx.memberRole.findFirst({
    where: { memberId, roleId },
    select: { roleId: true },
  });
  if (existing) return false;
  await tx.memberRole.create({
    data: { tenantId, memberId, roleId, assignedById: actor.memberId },
  });
  await record(tx, {
    action: "member.role_assigned",
    targetType: "Member",
    targetId: memberId,
    metadata: { roleId, roleName: role.name },
  });
  return true;
}

/** Precondition: member:manage_roles authorised, tenant row locked. */
async function removeRoleInTx(
  tx: TenantDb,
  actor: MemberActor,
  memberId: string,
  roleId: string,
): Promise<boolean> {
  const role = await loadRole(tx, roleId);
  const existing = await tx.memberRole.findFirst({
    where: { memberId, roleId },
    select: { tenantId: true },
  });
  if (!existing) return false;
  // Revoking a role = un-granting its set: subset rule applies (§7.1).
  const codes = await roleEffectiveCodes(tx, roleId);
  await assertActorHoldsAll(tx, actor, codes, {
    rule: "grant_subset",
    targetType: "Member",
    targetId: memberId,
    detail: `cannot revoke "${role.name}" - you do not hold`,
  });
  if (role.isSystem && role.templateKey === "owner") {
    const member = await loadMember(tx, memberId);
    if (member.status === "ACTIVE") {
      await assertNotLastOwner(tx, memberId, {
        rule: "last_owner",
        targetType: "Member",
        targetId: memberId,
      });
    }
  }
  await tx.memberRole.delete({
    where: { tenantId_memberId_roleId: { tenantId: existing.tenantId, memberId, roleId } },
  });
  await record(tx, {
    action: "member.role_removed",
    targetType: "Member",
    targetId: memberId,
    metadata: { roleId, roleName: role.name },
  });
  return true;
}

/** member:manage_roles ✦ — add one role to a member. */
export async function assignRole(input: {
  tenantId: string;
  actor: MemberActor;
  memberId: string;
  roleId: string;
}): Promise<{ changed: boolean }> {
  return runGuarded(input.tenantId, input.actor, async (tx) => {
    await requireAccess(tx, input.tenantId, input.actor, "member:manage_roles");
    await bumpPermissionsVersion(tx, input.tenantId);
    await loadMember(tx, input.memberId);
    const changed = await assignRoleInTx(tx, input.tenantId, input.actor, input.memberId, input.roleId);
    return { changed };
  });
}

/** member:manage_roles ✦ — remove one role from a member (last-owner-guarded). */
export async function removeRole(input: {
  tenantId: string;
  actor: MemberActor;
  memberId: string;
  roleId: string;
}): Promise<{ changed: boolean }> {
  return runGuarded(input.tenantId, input.actor, async (tx) => {
    await requireAccess(tx, input.tenantId, input.actor, "member:manage_roles");
    await bumpPermissionsVersion(tx, input.tenantId);
    await loadMember(tx, input.memberId);
    const changed = await removeRoleInTx(tx, input.actor, input.memberId, input.roleId);
    return { changed };
  });
}

/**
 * member:manage_roles ✦ — make the member's role set exactly `roleIds`
 * (the /members roles editor). Each add and each removal runs the full
 * guard set; the whole diff is one transaction.
 */
export async function setMemberRoles(input: {
  tenantId: string;
  actor: MemberActor;
  memberId: string;
  roleIds: readonly string[];
}): Promise<{ added: string[]; removed: string[] }> {
  return runGuarded(input.tenantId, input.actor, async (tx) => {
    await requireAccess(tx, input.tenantId, input.actor, "member:manage_roles");
    await bumpPermissionsVersion(tx, input.tenantId);
    await loadMember(tx, input.memberId);
    const current = new Set(
      (
        await tx.memberRole.findMany({
          where: { memberId: input.memberId },
          select: { roleId: true },
        })
      ).map((r) => r.roleId),
    );
    const wanted = new Set(input.roleIds);
    const added: string[] = [];
    const removed: string[] = [];
    // Additions first: the last-owner invariant counts OTHER holders, so
    // order is irrelevant to it, and a member swapping roles is never
    // momentarily role-less.
    for (const roleId of wanted) {
      if (!current.has(roleId) && (await assignRoleInTx(tx, input.tenantId, input.actor, input.memberId, roleId))) {
        added.push(roleId);
      }
    }
    for (const roleId of current) {
      if (!wanted.has(roleId) && (await removeRoleInTx(tx, input.actor, input.memberId, roleId))) {
        removed.push(roleId);
      }
    }
    return { added, removed };
  });
}

/** member:remove — status → SUSPENDED (roles kept), last-owner-guarded. */
export async function suspendMember(input: {
  tenantId: string;
  actor: MemberActor;
  memberId: string;
}): Promise<void> {
  await runGuarded(input.tenantId, input.actor, async (tx) => {
    await requireAccess(tx, input.tenantId, input.actor, "member:remove");
    await bumpPermissionsVersion(tx, input.tenantId);
    if (input.memberId === input.actor.memberId) deny("FORBIDDEN", "you cannot suspend yourself");
    const member = await loadMember(tx, input.memberId);
    if (member.status === "SUSPENDED") return;
    const owner = await ownerRoleId(tx);
    const holdsOwner = await tx.memberRole.findFirst({
      where: { memberId: input.memberId, roleId: owner },
      select: { roleId: true },
    });
    if (holdsOwner) {
      await assertNotLastOwner(tx, input.memberId, {
        rule: "last_owner",
        targetType: "Member",
        targetId: input.memberId,
      });
    }
    await tx.member.update({
      where: { id: input.memberId },
      data: { status: "SUSPENDED", suspendedAt: new Date() },
    });
    await record(tx, {
      action: "member.suspended",
      targetType: "Member",
      targetId: input.memberId,
    });
  });
}

/**
 * member:remove — status → ACTIVE. Undoes a suspension; the roles it
 * restores were assigned under the guards already, so only member:remove
 * is required (grant-subset attaches to member:manage_roles, §7.1).
 */
export async function reactivateMember(input: {
  tenantId: string;
  actor: MemberActor;
  memberId: string;
}): Promise<void> {
  await withTenant(input.tenantId, { type: "member", id: input.actor.memberId }, async (tx) => {
    await requireAccess(tx, input.tenantId, input.actor, "member:remove");
    await bumpPermissionsVersion(tx, input.tenantId);
    const member = await loadMember(tx, input.memberId);
    if (member.status === "ACTIVE") return;
    await tx.member.update({
      where: { id: input.memberId },
      data: { status: "ACTIVE", suspendedAt: null },
    });
    await record(tx, {
      action: "member.reactivated",
      targetType: "Member",
      targetId: input.memberId,
    });
  });
}

/** member:invite — a PENDING invitation becomes REVOKED. */
export async function revokeInvite(input: {
  tenantId: string;
  actor: MemberActor;
  inviteId: string;
}): Promise<void> {
  await withTenant(input.tenantId, { type: "member", id: input.actor.memberId }, async (tx) => {
    await requireAccess(tx, input.tenantId, input.actor, "member:invite");
    const invite = await tx.memberInvite.findFirst({
      where: { id: input.inviteId },
      select: { id: true, status: true, email: true },
    });
    if (!invite) throw new AuthzError("NOT_FOUND", "unknown invitation");
    if (invite.status !== "PENDING") deny("FORBIDDEN", `invitation is ${invite.status}`);
    await tx.memberInvite.update({
      where: { id: invite.id },
      data: { status: "REVOKED" },
    });
    await record(tx, {
      action: "member.invite_revoked",
      targetType: "MemberInvite",
      targetId: invite.id,
      metadata: { email: invite.email },
    });
  });
}

/** Number of ACTIVE owner-role holders other than `memberId` (for UI hints). */
export const otherActiveOwners = activeOwnerHoldersExcept;
export { EscalationDenied };

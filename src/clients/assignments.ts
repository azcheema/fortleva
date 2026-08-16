import { record } from "@/audit/record";
import { assertInScope, type MemberActor } from "@/authz/authorize";
import { AuthzError } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";

/**
 * Member ↔ client / project assignments (AUTHZ.md §4, decision #5).
 * The recipe (PLAN.md §2 / members): withTenant → requireAccess →
 * assertInScope → mutate → record, one transaction. The actor must be
 * able to reach the target client/project themselves (assertInScope ⇒
 * NOT_FOUND otherwise): holding client:manage_assignments does not let
 * a manager assign people to a client they cannot see. Idempotent:
 * assigning twice / unassigning a missing row returns changed:false
 * and writes no audit row.
 */

export type AssignmentInput = {
  readonly tenantId: string;
  /** From requireTenantContext() — never from form params. */
  readonly actor: MemberActor;
  readonly memberId: string;
};

const principalOf = (actor: MemberActor) => ({ type: "member", id: actor.memberId }) as const;

const loadActiveMember = async (tx: TenantDb, memberId: string) => {
  const m = await tx.member.findFirst({ where: { id: memberId }, select: { id: true, status: true } });
  if (!m) throw new AuthzError("NOT_FOUND", "unknown member");
  return m;
};

/** client:manage_assignments — MemberClient row (scope over the client and all its projects). */
export async function assignMemberToClient(
  input: AssignmentInput & { readonly clientId: string },
): Promise<{ changed: boolean }> {
  return withTenant(input.tenantId, principalOf(input.actor), async (tx) => {
    await requireAccess(tx, input.tenantId, input.actor, "client:manage_assignments");
    await assertInScope(tx, input.actor, { clientId: input.clientId, lifted: false });
    await loadActiveMember(tx, input.memberId);
    const existing = await tx.memberClient.findFirst({
      where: { memberId: input.memberId, clientId: input.clientId },
      select: { clientId: true },
    });
    if (existing) return { changed: false };
    await tx.memberClient.create({
      data: {
        tenantId: input.tenantId,
        memberId: input.memberId,
        clientId: input.clientId,
        assignedById: input.actor.memberId,
      },
    });
    await record(tx, {
      action: "assignment.client_added",
      targetType: "Client",
      targetId: input.clientId,
      metadata: { memberId: input.memberId },
    });
    return { changed: true };
  });
}

/** client:manage_assignments — remove a MemberClient row. */
export async function unassignMemberFromClient(
  input: AssignmentInput & { readonly clientId: string },
): Promise<{ changed: boolean }> {
  return withTenant(input.tenantId, principalOf(input.actor), async (tx) => {
    await requireAccess(tx, input.tenantId, input.actor, "client:manage_assignments");
    await assertInScope(tx, input.actor, { clientId: input.clientId, lifted: false });
    const deleted = await tx.memberClient.deleteMany({
      where: { memberId: input.memberId, clientId: input.clientId },
    });
    if (deleted.count === 0) return { changed: false };
    await record(tx, {
      action: "assignment.client_removed",
      targetType: "Client",
      targetId: input.clientId,
      metadata: { memberId: input.memberId },
    });
    return { changed: true };
  });
}

/** project:manage_assignments — MemberProject row (that project + the parent client's card). */
export async function assignMemberToProject(
  input: AssignmentInput & { readonly projectId: string },
): Promise<{ changed: boolean }> {
  return withTenant(input.tenantId, principalOf(input.actor), async (tx) => {
    await requireAccess(tx, input.tenantId, input.actor, "project:manage_assignments");
    await assertInScope(tx, input.actor, { projectId: input.projectId });
    await loadActiveMember(tx, input.memberId);
    const existing = await tx.memberProject.findFirst({
      where: { memberId: input.memberId, projectId: input.projectId },
      select: { projectId: true },
    });
    if (existing) return { changed: false };
    await tx.memberProject.create({
      data: {
        tenantId: input.tenantId,
        memberId: input.memberId,
        projectId: input.projectId,
        assignedById: input.actor.memberId,
      },
    });
    await record(tx, {
      action: "assignment.project_added",
      targetType: "Project",
      targetId: input.projectId,
      metadata: { memberId: input.memberId },
    });
    return { changed: true };
  });
}

/** project:manage_assignments — remove a MemberProject row. */
export async function unassignMemberFromProject(
  input: AssignmentInput & { readonly projectId: string },
): Promise<{ changed: boolean }> {
  return withTenant(input.tenantId, principalOf(input.actor), async (tx) => {
    await requireAccess(tx, input.tenantId, input.actor, "project:manage_assignments");
    await assertInScope(tx, input.actor, { projectId: input.projectId });
    const deleted = await tx.memberProject.deleteMany({
      where: { memberId: input.memberId, projectId: input.projectId },
    });
    if (deleted.count === 0) return { changed: false };
    await record(tx, {
      action: "assignment.project_removed",
      targetType: "Project",
      targetId: input.projectId,
      metadata: { memberId: input.memberId },
    });
    return { changed: true };
  });
}

/** Read helpers for the Team / assignments UI (caller composes scopeWhere / requireAccess). */
export async function listClientAssignments(
  tx: TenantDb,
  clientId: string,
): Promise<{ memberId: string; assignedById: string | null; createdAt: Date }[]> {
  return tx.memberClient.findMany({
    where: { clientId },
    select: { memberId: true, assignedById: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
}

export async function listProjectAssignments(
  tx: TenantDb,
  projectId: string,
): Promise<{ memberId: string; assignedById: string | null; createdAt: Date }[]> {
  return tx.memberProject.findMany({
    where: { projectId },
    select: { memberId: true, assignedById: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
}

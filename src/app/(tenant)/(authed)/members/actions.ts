"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { createInvite } from "@/members/invites";
import {
  reactivateMember,
  revokeInvite,
  setMemberRoles,
  suspendMember,
} from "@/members/admin";
import { requireTenantContext } from "@/members/tenant-context";
import { AuthzError } from "@/authz/errors";
import { handleAuthzRedirect } from "@/authz/redirects";

const inviteSchema = z.object({
  email: z.email(),
  roleIds: z.array(z.string()).min(1, "pick at least one role"),
});

export type InviteFormState = { ok: boolean; message: string } | null;

export async function inviteMemberAction(
  _prev: InviteFormState,
  formData: FormData,
): Promise<InviteFormState> {
  const { membership, actor } = await requireTenantContext();

  const parsed = inviteSchema.safeParse({
    email: formData.get("email"),
    roleIds: formData.getAll("roleIds").map(String),
  });
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "invalid input" };
  }

  try {
    await createInvite({
      tenantId: membership.tenantId,
      actor,
      email: parsed.data.email,
      roleIds: parsed.data.roleIds,
    });
  } catch (e) {
    // MFA_REQUIRED (deferred denial, AUTHZ.md §7.5) becomes navigation to
    // step-up / enrolment; every other denial is shown inline.
    handleAuthzRedirect(e, "/members");
    if (e instanceof AuthzError) {
      return { ok: false, message: e.message };
    }
    throw e;
  }

  revalidatePath("/members");
  return { ok: true, message: `Invitation sent to ${parsed.data.email}` };
}

/** Shared state shape for the per-member admin forms. */
export type AdminFormState = { ok: boolean; message: string } | null;

const uuid = z.uuid();

/**
 * Runs an admin mutation with the standard denial handling: MFA_REQUIRED
 * → step-up/enrolment redirect (member:manage_roles is ✦, the first real
 * ✦ path in the UI); other AuthzErrors → inline message; anything else
 * rethrows.
 */
async function runAdmin(fn: () => Promise<string>): Promise<AdminFormState> {
  try {
    const message = await fn();
    revalidatePath("/members");
    return { ok: true, message };
  } catch (e) {
    handleAuthzRedirect(e, "/members");
    if (e instanceof AuthzError) return { ok: false, message: e.message };
    throw e;
  }
}

export async function setMemberRolesAction(
  _prev: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  const { membership, actor } = await requireTenantContext();
  const memberId = uuid.safeParse(formData.get("memberId"));
  const roleIds = z.array(uuid).safeParse(formData.getAll("roleIds").map(String));
  if (!memberId.success || !roleIds.success) return { ok: false, message: "invalid input" };
  return runAdmin(async () => {
    const r = await setMemberRoles({
      tenantId: membership.tenantId,
      actor,
      memberId: memberId.data,
      roleIds: roleIds.data,
    });
    const n = r.added.length + r.removed.length;
    return n === 0 ? "No changes" : `Roles updated (${r.added.length} added, ${r.removed.length} removed)`;
  });
}

export async function setMemberStatusAction(
  _prev: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  const { membership, actor } = await requireTenantContext();
  const memberId = uuid.safeParse(formData.get("memberId"));
  const op = formData.get("op");
  if (!memberId.success || (op !== "suspend" && op !== "reactivate")) {
    return { ok: false, message: "invalid input" };
  }
  return runAdmin(async () => {
    if (op === "suspend") {
      await suspendMember({ tenantId: membership.tenantId, actor, memberId: memberId.data });
      return "Member suspended";
    }
    await reactivateMember({ tenantId: membership.tenantId, actor, memberId: memberId.data });
    return "Member reactivated";
  });
}

export async function revokeInviteAction(
  _prev: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  const { membership, actor } = await requireTenantContext();
  const inviteId = uuid.safeParse(formData.get("inviteId"));
  if (!inviteId.success) return { ok: false, message: "invalid input" };
  return runAdmin(async () => {
    await revokeInvite({ tenantId: membership.tenantId, actor, inviteId: inviteId.data });
    return "Invitation revoked";
  });
}

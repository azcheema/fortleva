"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
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
  roleIds: z.array(z.string()).min(1),
});

export type InviteFormState = { ok: boolean; message: string } | null;

export async function inviteMemberAction(
  _prev: InviteFormState,
  formData: FormData,
): Promise<InviteFormState> {
  const { membership, actor } = await requireTenantContext();
  const t = await getTranslations("members");
  const tCommon = await getTranslations("common");

  const parsed = inviteSchema.safeParse({
    email: formData.get("email"),
    roleIds: formData.getAll("roleIds").map(String),
  });
  if (!parsed.success) {
    const roleIssue = parsed.error.issues.some((i) => i.path[0] === "roleIds");
    return { ok: false, message: roleIssue ? t("invite.pickRole") : tCommon("invalidInput") };
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
  return { ok: true, message: t("invite.sent", { email: parsed.data.email }) };
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
  const t = await getTranslations("members");
  const tCommon = await getTranslations("common");
  const memberId = uuid.safeParse(formData.get("memberId"));
  const roleIds = z.array(uuid).safeParse(formData.getAll("roleIds").map(String));
  if (!memberId.success || !roleIds.success) return { ok: false, message: tCommon("invalidInput") };
  return runAdmin(async () => {
    const r = await setMemberRoles({
      tenantId: membership.tenantId,
      actor,
      memberId: memberId.data,
      roleIds: roleIds.data,
    });
    const n = r.added.length + r.removed.length;
    return n === 0
      ? t("roles.noChanges")
      : t("roles.updated", { added: r.added.length, removed: r.removed.length });
  });
}

export async function setMemberStatusAction(
  _prev: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  const { membership, actor } = await requireTenantContext();
  const t = await getTranslations("members");
  const tCommon = await getTranslations("common");
  const memberId = uuid.safeParse(formData.get("memberId"));
  const op = formData.get("op");
  if (!memberId.success || (op !== "suspend" && op !== "reactivate")) {
    return { ok: false, message: tCommon("invalidInput") };
  }
  return runAdmin(async () => {
    if (op === "suspend") {
      await suspendMember({ tenantId: membership.tenantId, actor, memberId: memberId.data });
      return t("status.suspended");
    }
    await reactivateMember({ tenantId: membership.tenantId, actor, memberId: memberId.data });
    return t("status.reactivated");
  });
}

export async function revokeInviteAction(
  _prev: AdminFormState,
  formData: FormData,
): Promise<AdminFormState> {
  const { membership, actor } = await requireTenantContext();
  const t = await getTranslations("members");
  const tCommon = await getTranslations("common");
  const inviteId = uuid.safeParse(formData.get("inviteId"));
  if (!inviteId.success) return { ok: false, message: tCommon("invalidInput") };
  return runAdmin(async () => {
    await revokeInvite({ tenantId: membership.tenantId, actor, inviteId: inviteId.data });
    return t("pending.revoked");
  });
}

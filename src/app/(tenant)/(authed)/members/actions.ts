"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { createInvite } from "@/members/invites";
import { requireTenantContext } from "@/members/tenant-context";
import { AuthzError } from "@/authz/errors";

const inviteSchema = z.object({
  email: z.email(),
  roleIds: z.array(z.string()).min(1, "pick at least one role"),
});

export type InviteFormState = { ok: boolean; message: string } | null;

export async function inviteMemberAction(
  _prev: InviteFormState,
  formData: FormData,
): Promise<InviteFormState> {
  const { membership } = await requireTenantContext();

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
      actorMemberId: membership.memberId,
      email: parsed.data.email,
      roleIds: parsed.data.roleIds,
    });
  } catch (e) {
    if (e instanceof AuthzError) {
      return { ok: false, message: e.message };
    }
    throw e;
  }

  revalidatePath("/members");
  return { ok: true, message: `Invitation sent to ${parsed.data.email}` };
}

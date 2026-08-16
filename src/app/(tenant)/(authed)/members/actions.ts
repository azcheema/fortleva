"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { createInvite } from "@/members/invites";
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

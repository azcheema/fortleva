"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { ROLE_TEMPLATES, type TemplateKey } from "@/authz/catalog";
import { AuthzError } from "@/authz/errors";
import { handleAuthzRedirect } from "@/authz/redirects";
import { createRole, deleteRole, setRolePermissions } from "@/members/roles";
import { requireTenantContext } from "@/members/tenant-context";

export type RoleFormState = { ok: boolean; message: string } | null;

const PATH = "/settings/roles";
const uuid = z.uuid();
const templateKeys = ROLE_TEMPLATES.map((t) => t.templateKey) as [TemplateKey, ...TemplateKey[]];

/** MFA_REQUIRED → step-up/enrolment redirect (role:edit is ✦); other denials inline. */
async function run(fn: () => Promise<string>): Promise<RoleFormState> {
  try {
    const message = await fn();
    revalidatePath(PATH);
    return { ok: true, message };
  } catch (e) {
    handleAuthzRedirect(e, PATH);
    if (e instanceof AuthzError) return { ok: false, message: e.message };
    throw e;
  }
}

const createSchema = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(200).optional(),
  templateKey: z.union([z.literal(""), z.enum(templateKeys)]),
});

export async function createRoleAction(
  _prev: RoleFormState,
  formData: FormData,
): Promise<RoleFormState> {
  const { membership, actor } = await requireTenantContext();
  const parsed = createSchema.safeParse({
    name: formData.get("name"),
    description: formData.get("description") ?? undefined,
    templateKey: formData.get("templateKey") ?? "",
  });
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "invalid input" };
  }
  return run(async () => {
    await createRole({
      tenantId: membership.tenantId,
      actor,
      name: parsed.data.name,
      description: parsed.data.description,
      templateKey: parsed.data.templateKey || null,
    });
    return `Role "${parsed.data.name}" created`;
  });
}

export async function setRolePermissionsAction(
  _prev: RoleFormState,
  formData: FormData,
): Promise<RoleFormState> {
  const { membership, actor } = await requireTenantContext();
  const roleId = uuid.safeParse(formData.get("roleId"));
  const codes = z.array(z.string().max(80)).safeParse(formData.getAll("codes").map(String));
  if (!roleId.success || !codes.success) return { ok: false, message: "invalid input" };
  return run(async () => {
    const r = await setRolePermissions({
      tenantId: membership.tenantId,
      actor,
      roleId: roleId.data,
      codes: codes.data,
    });
    const n = r.granted.length + r.revoked.length;
    return n === 0
      ? "No changes"
      : `Permissions updated (${r.granted.length} granted, ${r.revoked.length} revoked)`;
  });
}

export async function deleteRoleAction(
  _prev: RoleFormState,
  formData: FormData,
): Promise<RoleFormState> {
  const { membership, actor } = await requireTenantContext();
  const roleId = uuid.safeParse(formData.get("roleId"));
  if (!roleId.success) return { ok: false, message: "invalid input" };
  return run(async () => {
    await deleteRole({ tenantId: membership.tenantId, actor, roleId: roleId.data });
    return "Role deleted";
  });
}

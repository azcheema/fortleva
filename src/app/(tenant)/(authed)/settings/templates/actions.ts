"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { z } from "zod";

import { field, runForm, type FormResult } from "@/lib/server-actions";
import { requireTenantContext } from "@/members/tenant-context";
// Off the barrel on purpose: the templates are one feature's service.
import { deleteTemplate, renameTemplate } from "@/modules/work/templates/service";

/**
 * Server actions for /settings/templates (slice 124, C100 (b)): rename and
 * delete — `project_template:manage`, each audited by its service in the
 * same transaction. Thin: parse → service → revalidate. Tenant and member
 * come from the session, never from the form.
 */

const PATH = "/settings/templates";
const uuid = z.uuid();

const ctxOf = async () => {
  const { membership, actor } = await requireTenantContext();
  return { tenantId: membership.tenantId, actor };
};

// The New project forms list the templates by name.
function revalidate(): void {
  revalidatePath(PATH);
  revalidatePath("/projects");
}

/** AutoForm: the name cell. */
export async function renameTemplateAction(formData: FormData): Promise<FormResult> {
  const t = await getTranslations("settings.templates");
  const tCommon = await getTranslations("common");
  const id = uuid.safeParse(field(formData, "id"));
  const name = field(formData, "name");
  if (!id.success || name === null) return { ok: false, message: tCommon("invalidInput") };
  const ctx = await ctxOf();
  const r = await runForm(PATH, async () => {
    await renameTemplate(ctx, id.data, name);
    return t("renamed");
  });
  if (r.ok) revalidate();
  return r;
}

export async function deleteTemplateAction(raw: { id: string }): Promise<FormResult> {
  const t = await getTranslations("settings.templates");
  const tCommon = await getTranslations("common");
  const parsed = z.object({ id: uuid }).safeParse(raw);
  if (!parsed.success) return { ok: false, message: tCommon("invalidInput") };
  const ctx = await ctxOf();
  const r = await runForm(PATH, async () => {
    await deleteTemplate(ctx, parsed.data.id);
    return t("deleted");
  });
  if (r.ok) revalidate();
  return r;
}

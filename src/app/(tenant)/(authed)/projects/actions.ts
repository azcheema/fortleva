"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { z } from "zod";

import { field, runForm, type FormResult } from "@/lib/server-actions";
import { requireTenantContext } from "@/members/tenant-context";
import { createProject } from "@/projects/service";

/** Inline create on /projects: client + key + name. */
export async function createProjectAction(
  _prev: FormResult | null,
  formData: FormData,
): Promise<FormResult> {
  const { membership, actor } = await requireTenantContext();
  const t = await getTranslations("projects.create");
  const tCommon = await getTranslations("common");
  const clientId = z.uuid().safeParse(formData.get("clientId"));
  if (!clientId.success) return { ok: false, message: tCommon("invalidInput") };
  const r = await runForm("/projects", async () => {
    const created = await createProject(
      { tenantId: membership.tenantId, actor },
      {
        clientId: clientId.data,
        key: field(formData, "key") ?? "",
        name: field(formData, "name") ?? "",
      },
    );
    return t("created", { key: created.key });
  });
  if (r.ok) {
    revalidatePath("/projects");
    revalidatePath(`/clients/${clientId.data}`, "layout");
  }
  return r;
}

"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { z } from "zod";

import { field, runAction, runForm, type ActionResult, type FormResult } from "@/lib/server-actions";
import { requireTenantContext } from "@/members/tenant-context";
import { createProject, listProjects } from "@/projects/service";

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

/** A project the member can aim the global `C` at. */
export type QuickCreateProject = { id: string; key: string; name: string; clientName: string };

/**
 * The projects the shell's quick create offers (UI.md rule 2: "`C`
 * anywhere… project if inside one, else asks project first via
 * picker").
 *
 * Read on OPEN rather than rendered into the shell, the same trade
 * `pickerOptionsAction` makes: the list is only wanted once a member
 * presses the key, and shipping it on every page of the product would
 * put every project name the member can see into every HTML response.
 *
 * It is `listProjects` verbatim — the same scoped, `project:view`-gated,
 * archived-excluding read the /projects page draws — flattened out of
 * its client groups and carrying the client's name, because two clients
 * routinely have a "Website" and the picker has to be answerable.
 * Creation itself is gated where it always is, in `createItem`: this
 * list decides what the picker can OFFER, never what may be written.
 */
export async function quickCreateProjectsAction(): Promise<ActionResult<QuickCreateProject[]>> {
  const { membership, actor } = await requireTenantContext();
  return runAction("/projects", async () => {
    const groups = await listProjects({ tenantId: membership.tenantId, actor });
    return groups.flatMap((g) =>
      g.projects.map((p) => ({
        id: p.id,
        key: p.key,
        name: p.name,
        clientName: g.clientName,
      })),
    );
  });
}

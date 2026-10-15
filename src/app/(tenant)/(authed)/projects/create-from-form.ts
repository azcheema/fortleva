import { getTranslations } from "next-intl/server";
import { z } from "zod";

import type { MemberActor } from "@/authz/authorize";
import { fail } from "@/lib/domain-error";
import { field, strictDateField } from "@/lib/server-actions";
// Off the barrel on purpose: the templates are one feature's service.
import { createProjectFromTemplate } from "@/modules/work/templates/service";
import { createProject } from "@/projects/service";

/**
 * The two New project forms' one body (the /projects row and a client's
 * Projects tab): a project, or — when the form chose a template (slice 124,
 * C100) — a project with that template's stages, milestones and tasks,
 * counted from the form's Start date. Runs inside `runForm`: a refusal is a
 * DomainError the caller turns into a sentence. Tenant and member come from
 * the caller's `requireTenantContext()`, never from the form.
 */
export async function createProjectFromForm(
  ctx: { tenantId: string; actor: MemberActor },
  clientId: string,
  formData: FormData,
): Promise<string> {
  const t = await getTranslations("projects.create");
  const key = field(formData, "key") ?? "";
  const name = field(formData, "name") ?? "";
  const templateId = field(formData, "templateId") ?? "";
  if (templateId === "") {
    const created = await createProject(ctx, { clientId, key, name });
    return t("created", { key: created.key });
  }
  if (!z.uuid().safeParse(templateId).success) fail("INVALID_INPUT", "template id");
  // A template's dates are counted from this day, so it is required while a
  // template is chosen — strictly a real day, and within the years every
  // other date field holds (a five-digit year is a typo, never a plan).
  const start = strictDateField(formData, "startDate");
  if (!start || start.getUTCFullYear() < 2000 || start.getUTCFullYear() > 2199) fail("INVALID_INPUT", "start date");
  const made = await createProjectFromTemplate(ctx, { clientId, key, name, templateId, startDate: start! });
  return t("createdFromTemplate", { key: made.key, tasks: made.tasks, milestones: made.milestones });
}

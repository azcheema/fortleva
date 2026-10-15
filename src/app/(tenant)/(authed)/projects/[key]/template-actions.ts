"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { z } from "zod";

import { DomainError, fail } from "@/lib/domain-error";
import { runAction, runForm, type ActionResult, type FormResult } from "@/lib/server-actions";
import type { TemplateSaveSummary } from "@/lib/template-rules";
import { requireTenantContext } from "@/members/tenant-context";
// Off the barrel on purpose: the templates are one feature's service.
import { readTemplateSaveSummary, saveProjectAsTemplate } from "@/modules/work/templates/service";

/**
 * "Save as template" on a project's Overview (slice 124, C100 (b)).
 * `project_template:manage` and the project in the member's scope — the
 * service's gates; the project id here is never trusted for either.
 */

const uuid = z.uuid();

const ctxOf = async () => {
  const { membership, actor } = await requireTenantContext();
  return { tenantId: membership.tenantId, actor };
};

/** What the dialog says before anything is written — read when it opens, never rendered into every Overview. */
export async function templateSaveSummaryAction(projectId: unknown): Promise<ActionResult<TemplateSaveSummary>> {
  const id = uuid.safeParse(projectId);
  const ctx = await ctxOf();
  return runAction("/projects", async () => {
    if (!id.success) fail("INVALID_INPUT", "project id");
    return readTemplateSaveSummary(ctx, id.data!);
  });
}

const saveSchema = z.object({
  projectId: uuid,
  key: z.string().regex(/^[A-Z][A-Z0-9]{0,7}$/),
  name: z.string().max(1000),
  replace: z.boolean(),
});

/**
 * A refusal says WHICH when it is "that name is taken" (`nameTaken`), so the
 * dialog can offer Replace even when its own lower-casing did not see the
 * clash — Postgres's fold decides, and a browser's locale-aware one can differ
 * (a Turkish dotless i; the code review's LOW).
 */
export async function saveProjectAsTemplateAction(raw: unknown): Promise<FormResult & { nameTaken?: boolean }> {
  const t = await getTranslations("projects.template");
  const tCommon = await getTranslations("common");
  const parsed = saveSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: tCommon("invalidInput") };
  const ctx = await ctxOf();
  let nameTaken = false;
  const r = await runForm(`/projects/${parsed.data.key}`, async () => {
    try {
      const saved = await saveProjectAsTemplate(ctx, {
        projectId: parsed.data.projectId,
        name: parsed.data.name,
        replace: parsed.data.replace,
      });
      return t(saved.replaced ? "replaced" : "saved", { name: saved.name });
    } catch (e) {
      if (e instanceof DomainError && e.code === "TEMPLATE_NAME_TAKEN") nameTaken = true;
      throw e;
    }
  });
  if (r.ok) {
    revalidatePath("/settings/templates");
    revalidatePath("/projects");
    return r;
  }
  return { ...r, nameTaken };
}

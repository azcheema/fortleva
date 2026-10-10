"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";

import { isUuid } from "@/db/context";
import { runAction, runForm, type ActionResult, type FormResult } from "@/lib/server-actions";
import { requireTenantContext } from "@/members/tenant-context";
import {
  createContractTemplate,
  deleteContractTemplate,
  updateContractTemplate,
  type TemplateSaved,
} from "@/modules/contracts";

/**
 * Server actions for Settings → Contract templates (Phase 4 slice 112; C84
 * (g)). Tenant and actor from the session; `src/modules/contracts/templates.ts`
 * asks for `contract:manage_templates` and audits.
 */

const PATH = "/settings/contracts";

const ctxOf = async () => {
  const { membership, actor } = await requireTenantContext();
  return { tenantId: membership.tenantId, actor };
};

const invalid = async (): Promise<{ ok: false; message: string }> => {
  const tCommon = await getTranslations("common");
  return { ok: false, message: tCommon("invalidInput") };
};

/** Create (no id) or save (an id) — the editor's one button. */
export async function saveContractTemplateAction(id: unknown, input: unknown): Promise<ActionResult<TemplateSaved>> {
  if (id !== null && (typeof id !== "string" || !isUuid(id))) return invalid();
  if (typeof input !== "object" || input === null) return invalid();
  const { name, body } = input as Record<string, unknown>;
  if (typeof name !== "string") return invalid();
  const ctx = await ctxOf();
  const r = await runAction(PATH, () =>
    id === null ? createContractTemplate(ctx, { name, body: body ?? null }) : updateContractTemplate(ctx, id as string, { name, body: body ?? null }),
  );
  if (r.ok) {
    revalidatePath(PATH, "layout");
    revalidatePath("/contracts");
  }
  return r;
}

export async function deleteContractTemplateAction(id: unknown): Promise<FormResult> {
  if (typeof id !== "string" || !isUuid(id)) return invalid();
  const ctx = await ctxOf();
  const t = await getTranslations("contracts.templates");
  const r = await runForm(PATH, async () => {
    await deleteContractTemplate(ctx, id);
    return t("deleted");
  });
  if (r.ok) {
    revalidatePath(PATH, "layout");
    revalidatePath("/contracts");
  }
  return r;
}

"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { z } from "zod";

import { field, runAction, runForm, type ActionResult, type FormResult } from "@/lib/server-actions";
import { requireTenantContext } from "@/members/tenant-context";
import {
  createUpdateTemplate,
  deleteUpdateTemplate,
  setDefaultUpdateTemplate,
  updateUpdateTemplate,
} from "@/modules/work";

/**
 * Server actions for /settings/updates (Phase 5 slice 105; founder decision
 * C73 (c), (d), (g)): the workspace's progress-update layouts. Thin: parse →
 * service (`settings:edit`, audited in one transaction) → revalidate. Tenant
 * and member come from the session, never from the input; the headings and
 * numbers are validated by the service against the one set of rules
 * (`update-layout.ts`).
 */

const PATH = "/settings/updates";
const uuid = z.uuid();

const ctxOf = async () => {
  const { membership, actor } = await requireTenantContext();
  return { tenantId: membership.tenantId, actor };
};

/** The layout dialog: a new layout (`id` null) or an edit — name, headings, numbers in one save. */
export async function saveUpdateLayoutAction(input: {
  id: string | null;
  name: string;
  sections: unknown;
  metrics: unknown;
}): Promise<ActionResult<{ id: string; name: string }>> {
  const tCommon = await getTranslations("common");
  if (input.id !== null && !uuid.safeParse(input.id).success) return { ok: false, message: tCommon("invalidInput") };
  const ctx = await ctxOf();
  const r = await runAction(PATH, () =>
    input.id === null
      ? createUpdateTemplate(ctx, { name: input.name, sections: input.sections, metrics: input.metrics })
      : updateUpdateTemplate(ctx, input.id, { name: input.name, sections: input.sections, metrics: input.metrics }),
  );
  if (r.ok) revalidatePath(PATH);
  return r;
}

/** Row menu: delete — its projects go back to the default (the question said how many). */
export async function deleteUpdateLayoutAction(raw: { id: string }): Promise<FormResult> {
  const t = await getTranslations("settings.updates");
  const tCommon = await getTranslations("common");
  const id = uuid.safeParse(raw.id);
  if (!id.success) return { ok: false, message: tCommon("invalidInput") };
  const ctx = await ctxOf();
  const r = await runForm(PATH, async () => {
    await deleteUpdateTemplate(ctx, id.data);
    return t("deleted");
  });
  if (r.ok) revalidatePath(PATH);
  return r;
}

/** Row menu: "Make default" — one click, reversible from the select above the list. */
export async function makeDefaultUpdateLayoutAction(raw: { id: string }): Promise<FormResult> {
  const t = await getTranslations("settings.updates");
  const tCommon = await getTranslations("common");
  const id = uuid.safeParse(raw.id);
  if (!id.success) return { ok: false, message: tCommon("invalidInput") };
  const ctx = await ctxOf();
  const r = await runForm(PATH, async () => {
    await setDefaultUpdateTemplate(ctx, id.data);
    return t("defaultChanged");
  });
  if (r.ok) revalidatePath(PATH);
  return r;
}

/** AutoForm: the "Default layout" select — "" is Fortleva standard. */
export async function setDefaultUpdateLayoutAction(formData: FormData): Promise<FormResult> {
  const t = await getTranslations("settings.updates");
  const tCommon = await getTranslations("common");
  const raw = field(formData, "defaultLayoutId") ?? "";
  const id = raw === "" ? null : uuid.safeParse(raw).success ? raw : undefined;
  if (id === undefined) return { ok: false, message: tCommon("invalidInput") };
  const ctx = await ctxOf();
  const r = await runForm(PATH, async () => {
    await setDefaultUpdateTemplate(ctx, id);
    return t("defaultChanged");
  });
  if (r.ok) revalidatePath(PATH);
  return r;
}

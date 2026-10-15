"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { z } from "zod";

import { LABEL_COLORS } from "@/lib/label-colors";
import { field, has, runForm, type FormResult } from "@/lib/server-actions";
import { requireTenantContext } from "@/members/tenant-context";
import { createLabel, deleteLabel, mergeLabel, renameLabel, setLabelColor, type WorkCtx } from "@/modules/work";

/**
 * Server actions for /settings/labels (slice 123, C99 (b)): create, rename,
 * colour, delete, merge — `label:manage`, each audited by its service in
 * the same transaction. Thin: parse → service → revalidate. Tenant and
 * member come from the session, never from the form.
 */

const PATH = "/settings/labels";
const uuid = z.uuid();
/** "" is "no colour" — the select's first option. */
const colorField = z.union([z.enum(LABEL_COLORS), z.literal("")]).transform((v) => (v === "" ? null : v));

const ctxOf = async (): Promise<WorkCtx> => {
  const { membership, actor } = await requireTenantContext();
  return { tenantId: membership.tenantId, actor };
};

// The chips on every board and backlog wear a label's name and colour.
function revalidate(): void {
  revalidatePath(PATH);
  revalidatePath("/projects/[key]", "layout");
}

export type LabelFormState = FormResult | null;

/** useActionState: the create form under the table. */
export async function createLabelAction(_prev: LabelFormState, formData: FormData): Promise<LabelFormState> {
  const t = await getTranslations("settings.labels");
  const tCommon = await getTranslations("common");
  const name = field(formData, "name");
  const color = colorField.safeParse(field(formData, "color") ?? "");
  if (name === null || !color.success) return { ok: false, message: tCommon("invalidInput") };
  const ctx = await ctxOf();
  const r = await runForm(PATH, async () => {
    const { label } = await createLabel(ctx, { name, color: color.data });
    return t("added", { name: label.name });
  });
  if (r.ok) revalidate();
  return r;
}

/** AutoForm (one per cell): the name, or the colour. Only the field present is written. */
export async function updateLabelAction(formData: FormData): Promise<FormResult> {
  const t = await getTranslations("settings.labels");
  const tCommon = await getTranslations("common");
  const id = uuid.safeParse(field(formData, "id"));
  if (!id.success) return { ok: false, message: tCommon("invalidInput") };
  const ctx = await ctxOf();
  if (has(formData, "name")) {
    const name = field(formData, "name") ?? "";
    const r = await runForm(PATH, async () => {
      await renameLabel(ctx, id.data, name);
      return t("renamed");
    });
    if (r.ok) revalidate();
    return r;
  }
  const color = colorField.safeParse(field(formData, "color") ?? "");
  if (!color.success) return { ok: false, message: tCommon("invalidInput") };
  const r = await runForm(PATH, async () => {
    await setLabelColor(ctx, id.data, color.data);
    return t("colorChanged");
  });
  if (r.ok) revalidate();
  return r;
}

export async function deleteLabelAction(raw: { id: string }): Promise<FormResult> {
  const t = await getTranslations("settings.labels");
  const tCommon = await getTranslations("common");
  const parsed = z.object({ id: uuid }).safeParse(raw);
  if (!parsed.success) return { ok: false, message: tCommon("invalidInput") };
  const ctx = await ctxOf();
  const r = await runForm(PATH, async () => {
    await deleteLabel(ctx, parsed.data.id);
    return t("deleted");
  });
  if (r.ok) revalidate();
  return r;
}

export async function mergeLabelAction(raw: { fromId: string; intoId: string }): Promise<FormResult> {
  const t = await getTranslations("settings.labels");
  const tCommon = await getTranslations("common");
  const parsed = z.object({ fromId: uuid, intoId: uuid }).safeParse(raw);
  if (!parsed.success || parsed.data.fromId === parsed.data.intoId) return { ok: false, message: tCommon("invalidInput") };
  const ctx = await ctxOf();
  const r = await runForm(PATH, async () => {
    const { tasks } = await mergeLabel(ctx, parsed.data.fromId, parsed.data.intoId);
    return t("merged", { count: tasks });
  });
  if (r.ok) revalidate();
  return r;
}

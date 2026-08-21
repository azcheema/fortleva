"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { z } from "zod";

import { LOCALES } from "@/i18n/config";
import { field, has, runForm, type FormResult } from "@/lib/server-actions";
import { requireTenantContext } from "@/members/tenant-context";
import { createWorkType, publishNotice, setWorkTypeArchived, updateWorkType, type TimeCtx } from "@/modules/time";

/**
 * Server actions for /settings/time (PLAN.md 2T screens; SECURITY.md
 * §9.7.5; DATA_MODEL.md §6.15 D5): publish a new staff-notice version
 * (settings:edit — every member re-acknowledges) and manage the
 * tenant's work types (work_type:manage). Thin: parse → service
 * (authorizes + audits in one transaction) → revalidate. Tenant and
 * member come from the session, never from the form.
 */

const PATH = "/settings/time";
const uuid = z.uuid();

const ctxOf = async (): Promise<TimeCtx> => {
  const { membership, actor } = await requireTenantContext();
  return { tenantId: membership.tenantId, actor };
};

export type TimeSettingsFormState = { ok: boolean; message: string } | null;

const noticeText = z.object({
  locale: z.enum(LOCALES),
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(20_000),
});

/** useActionState: publish version N+1 in every locale at once. */
export async function publishNoticeAction(_prev: TimeSettingsFormState, formData: FormData): Promise<TimeSettingsFormState> {
  const t = await getTranslations("settings.time.notice.publish");
  const tCommon = await getTranslations("common");
  const texts = LOCALES.map((locale) => ({
    locale,
    title: field(formData, `title.${locale}`) ?? "",
    body: field(formData, `body.${locale}`) ?? "",
  }));
  const parsed = z.array(noticeText).min(1).safeParse(texts);
  if (!parsed.success) return { ok: false, message: tCommon("invalidInput") };
  const ctx = await ctxOf();
  const r = await runForm(PATH, async () => {
    const { version } = await publishNotice(ctx, { texts: parsed.data });
    return t("published", { version });
  });
  if (r.ok) {
    revalidatePath(PATH);
    revalidatePath("/time");
  }
  return r;
}

const billableOf = (raw: string | null): boolean | null | undefined => {
  switch (raw) {
    case "yes":
      return true;
    case "no":
      return false;
    case "inherit":
      return null;
    default:
      return undefined;
  }
};

/** useActionState: add a work type. */
export async function createWorkTypeAction(_prev: TimeSettingsFormState, formData: FormData): Promise<TimeSettingsFormState> {
  const t = await getTranslations("settings.time.workTypes");
  const tCommon = await getTranslations("common");
  const parsed = z.object({ name: z.string().trim().min(1).max(80) }).safeParse({ name: field(formData, "name") });
  if (!parsed.success) return { ok: false, message: tCommon("invalidInput") };
  const defaultBillable = billableOf(field(formData, "defaultBillable")) ?? null;
  const ctx = await ctxOf();
  const r = await runForm(PATH, async () => {
    const row = await createWorkType(ctx, { name: parsed.data.name, defaultBillable });
    return t("add.added", { name: row.name });
  });
  if (r.ok) {
    revalidatePath(PATH);
    revalidatePath("/time");
  }
  return r;
}

/** AutoForm (one per row): rename / default-billable. Only fields present are written. */
export async function updateWorkTypeAction(formData: FormData): Promise<FormResult> {
  const t = await getTranslations("settings.time.workTypes");
  const tCommon = await getTranslations("common");
  const id = uuid.safeParse(field(formData, "id"));
  if (!id.success) return { ok: false, message: tCommon("invalidInput") };
  const patch: { name?: string; defaultBillable?: boolean | null } = {};
  if (has(formData, "name")) patch.name = (field(formData, "name") ?? "").trim();
  if (has(formData, "defaultBillable")) {
    const b = billableOf(field(formData, "defaultBillable"));
    if (b === undefined) return { ok: false, message: tCommon("invalidInput") };
    patch.defaultBillable = b;
  }
  const ctx = await ctxOf();
  const r = await runForm(PATH, async () => {
    await updateWorkType(ctx, id.data, patch);
    return t("updated");
  });
  if (r.ok) {
    revalidatePath(PATH);
    revalidatePath("/time");
  }
  return r;
}

export async function setWorkTypeArchivedAction(raw: { id: string; archived: boolean }): Promise<FormResult> {
  const t = await getTranslations("settings.time.workTypes");
  const tCommon = await getTranslations("common");
  const parsed = z.object({ id: uuid, archived: z.boolean() }).safeParse(raw);
  if (!parsed.success) return { ok: false, message: tCommon("invalidInput") };
  const ctx = await ctxOf();
  const r = await runForm(PATH, async () => {
    await setWorkTypeArchived(ctx, parsed.data.id, parsed.data.archived);
    return parsed.data.archived ? t("archivedToast") : t("restored");
  });
  if (r.ok) {
    revalidatePath(PATH);
    revalidatePath("/time");
  }
  return r;
}

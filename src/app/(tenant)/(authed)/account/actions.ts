"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { z } from "zod";

import { auth } from "@/auth";
import { requireMemberSession } from "@/auth/session";
import { LOCALES } from "@/i18n/config";
import { runForm, type FormResult } from "@/lib/server-actions";
import { setOwnTimezone } from "@/members/profile";
import { requireTenantContext } from "@/members/tenant-context";
import { TIMEZONES } from "@/preferences/config";

export type LocaleFormState = { ok: boolean; message: string } | null;

const schema = z.object({
  locale: z.union([z.literal(""), z.enum(LOCALES)]),
});

/**
 * Persist the member's UI language on their global identity
 * (User.locale — first step of locale resolution, UI.md §8). "" clears
 * the preference so the workspace default applies again. The user is
 * the session's, never a form parameter. Goes through Better Auth's
 * updateUser so the session cache sees the new value at once.
 */
export async function setLocaleAction(
  _prev: LocaleFormState,
  formData: FormData,
): Promise<LocaleFormState> {
  await requireMemberSession();
  const t = await getTranslations("account.language");
  const parsed = schema.safeParse({ locale: formData.get("locale") ?? "" });
  if (!parsed.success) return { ok: false, message: t("failed") };

  try {
    await auth.api.updateUser({
      headers: await headers(),
      body: { locale: parsed.data.locale === "" ? null : parsed.data.locale },
    });
  } catch {
    return { ok: false, message: t("failed") };
  }
  revalidatePath("/", "layout");
  return { ok: true, message: t("saved") };
}

/** Palette "Switch language": same write, no form. */
export async function switchLocaleAction(locale: string): Promise<void> {
  await requireMemberSession();
  const parsed = z.enum(LOCALES).safeParse(locale);
  if (!parsed.success) return;
  await auth.api.updateUser({ headers: await headers(), body: { locale: parsed.data } });
  revalidatePath("/", "layout");
}

const timezoneSchema = z.object({
  timezone: z.union([z.literal(""), z.enum(TIMEZONES)]),
});

/**
 * Member.timezone for the active membership ("" clears it so the
 * workspace `ui.timezone` preference applies again). Own row only — the
 * member id comes from the session's active membership.
 */
export async function setTimezoneAction(
  _prev: FormResult | null,
  formData: FormData,
): Promise<FormResult> {
  const { membership, actor } = await requireTenantContext();
  const t = await getTranslations("account.timezone");
  const parsed = timezoneSchema.safeParse({ timezone: formData.get("timezone") ?? "" });
  if (!parsed.success) return { ok: false, message: t("failed") };
  const r = await runForm("/account", async () => {
    await setOwnTimezone(
      { tenantId: membership.tenantId, actor },
      parsed.data.timezone === "" ? null : parsed.data.timezone,
    );
    return t("saved");
  });
  if (r.ok) revalidatePath("/", "layout");
  return r;
}

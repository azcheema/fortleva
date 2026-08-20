"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { z } from "zod";

import { LOCALES } from "@/i18n/config";
import { field, has, runForm, type FormResult } from "@/lib/server-actions";
import { requireTenantContext } from "@/members/tenant-context";
import {
  CURRENCIES,
  DURATION_STYLES,
  setModuleEnabled,
  TIMEZONES,
  TOGGLEABLE_MODULES,
  updatePreferences,
  WEEK_STARTS,
  type PreferencePatch,
  type ToggleableModule,
} from "@/preferences/service";

/**
 * Server actions for /settings/preferences. Tenant + actor come from
 * the session; the service authorizes (settings:edit /
 * settings:manage_modules ✦) and audits in one transaction. The
 * AutoForm posts the whole general form; only fields present are
 * written, and the service skips unchanged values.
 */

const PATH = "/settings/preferences";

const ctxOf = async () => {
  const { membership, actor } = await requireTenantContext();
  return { tenantId: membership.tenantId, actor };
};

const pick = <T extends string>(fd: FormData, name: string, allowed: readonly T[]): T | undefined => {
  if (!has(fd, name)) return undefined;
  const v = field(fd, name);
  return (allowed as readonly string[]).includes(v ?? "") ? (v as T) : undefined;
};

export async function updatePreferencesAction(formData: FormData): Promise<FormResult> {
  const ctx = await ctxOf();
  const tCommon = await getTranslations("common");
  const patch: PreferencePatch = {
    defaultLocale: pick(formData, "defaultLocale", LOCALES),
    timezone: pick(formData, "timezone", TIMEZONES),
    weekStart: pick(formData, "weekStart", WEEK_STARTS),
    durationStyle: pick(formData, "durationStyle", DURATION_STYLES),
    currencyDefault: pick(formData, "currencyDefault", CURRENCIES),
  };
  // Checkbox: the form carries a hidden marker so "unchecked" is a real value.
  if (has(formData, "showIsoWeekMarker")) patch.showIsoWeek = has(formData, "showIsoWeek");
  // 2T time knobs (same marker convention; numbers are whole hours).
  const time: NonNullable<PreferencePatch["time"]> = {};
  for (const k of ["shiftsEnabled", "allowOverlap", "allowAdhocEntries", "allowEntriesWithoutItem"] as const) {
    if (has(formData, `time.${k}Marker`)) time[k] = has(formData, `time.${k}`);
  }
  for (const k of ["autoStopHours", "nudgeHours", "shiftAutoStopHours"] as const) {
    const raw = field(formData, `time.${k}`);
    if (raw !== null && raw.trim() !== "") {
      const n = Number(raw);
      if (Number.isInteger(n)) time[k] = n;
    }
  }
  if (Object.keys(time).length > 0) patch.time = time;
  const r = await runForm(PATH, async () => {
    await updatePreferences(ctx, patch);
    return tCommon("saved");
  });
  if (r.ok) revalidatePath("/", "layout");
  return r;
}

const moduleSchema = z.object({ module: z.string(), enabled: z.boolean() });

export async function setModuleEnabledAction(raw: {
  module: string;
  enabled: boolean;
}): Promise<FormResult> {
  const parsed = moduleSchema.safeParse(raw);
  const tCommon = await getTranslations("common");
  if (!parsed.success || !(TOGGLEABLE_MODULES as readonly string[]).includes(parsed.data.module)) {
    return { ok: false, message: tCommon("invalidInput") };
  }
  const ctx = await ctxOf();
  const r = await runForm(PATH, async () => {
    await setModuleEnabled(ctx, parsed.data.module as ToggleableModule, parsed.data.enabled);
    return tCommon("saved");
  });
  if (r.ok) revalidatePath("/", "layout");
  return r;
}

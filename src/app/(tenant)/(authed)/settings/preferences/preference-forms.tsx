"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { AutoForm } from "@/components/auto-form";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { LOCALES } from "@/i18n/config";
import {
  CURRENCIES,
  DURATION_STYLES,
  TIMEZONES,
  TOGGLEABLE_MODULES,
  WEEK_STARTS,
  type TenantPreferences,
  type ToggleableModule,
} from "@/preferences/config";

import { setModuleEnabledAction, updatePreferencesAction } from "./actions";

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** General preferences: every field auto-saves on change (UI.md §5.10). Read-only without settings:edit. */
export function GeneralPreferencesForm({
  prefs,
  editable,
}: {
  prefs: TenantPreferences;
  editable: boolean;
}) {
  const t = useTranslations("settings.preferences");
  const tCommon = useTranslations("common");
  const ro = !editable;
  return (
    <AutoForm action={updatePreferencesAction} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <Field id="p-locale" label={t("locale")} hint={t("localeHint")}>
        <NativeSelect id="p-locale" name="defaultLocale" defaultValue={prefs.defaultLocale} disabled={ro}>
          {LOCALES.map((l) => (
            <option key={l} value={l}>
              {tCommon(`languageName.${l}`)}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field id="p-tz" label={t("timezone")} hint={t("timezoneHint")}>
        <NativeSelect id="p-tz" name="timezone" defaultValue={prefs.timezone} disabled={ro}>
          {TIMEZONES.map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field id="p-week" label={t("weekStart")}>
        <NativeSelect id="p-week" name="weekStart" defaultValue={prefs.weekStart} disabled={ro}>
          {WEEK_STARTS.map((w) => (
            <option key={w} value={w}>
              {t(`weekStarts.${w}`)}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field id="p-duration" label={t("durationStyle")} hint={t("durationStyleHint")}>
        <NativeSelect id="p-duration" name="durationStyle" defaultValue={prefs.durationStyle} disabled={ro}>
          {DURATION_STYLES.map((d) => (
            <option key={d} value={d}>
              {t(`durationStyles.${d}`)}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field id="p-currency" label={t("currency")} hint={t("currencyHint")}>
        <NativeSelect id="p-currency" name="currencyDefault" defaultValue={prefs.currencyDefault} disabled={ro}>
          {CURRENCIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <div className="flex items-center gap-2 self-end pb-1">
        <input type="hidden" name="showIsoWeekMarker" value="1" />
        {/* Native checkbox: fires a real change event for the auto-saving form. */}
        <input
          id="p-iso"
          type="checkbox"
          name="showIsoWeek"
          defaultChecked={prefs.showIsoWeek}
          disabled={ro}
          className="size-4 rounded border-input accent-primary"
        />
        <Label htmlFor="p-iso" className="font-normal">
          {t("showIsoWeek")}
        </Label>
      </div>
    </AutoForm>
  );
}

/** Module toggles (settings:manage_modules ✦): a Switch per entitlement module; commits on change. */
export function ModuleToggles({
  prefs,
  entitled,
  canManage,
}: {
  prefs: TenantPreferences;
  /** Plan-level entitlement per module (gate 2) — shown, not editable here. */
  entitled: Record<ToggleableModule, boolean>;
  canManage: boolean;
}) {
  const t = useTranslations("settings.preferences");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState(prefs.modules);

  const flip = (module: ToggleableModule, enabled: boolean) => {
    setState((s) => ({ ...s, [module]: enabled }));
    startTransition(async () => {
      const r = await setModuleEnabledAction({ module, enabled });
      if (!r.ok) {
        setState((s) => ({ ...s, [module]: !enabled }));
        toast.error(r.message);
        return;
      }
      toast.success(r.message);
      router.refresh();
    });
  };

  return (
    <ul className="divide-y divide-border">
      {TOGGLEABLE_MODULES.map((m) => (
        <li key={m} className="flex items-center justify-between gap-4 py-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Label htmlFor={`mod-${m}`} className="font-medium">
                {t(`modules.${m}`)}
              </Label>
              {!entitled[m] ? <Badge variant="outline">{t("notInPlan")}</Badge> : null}
            </div>
            <p className="text-xs text-muted-foreground">{t(`moduleHints.${m}`)}</p>
          </div>
          <Switch
            id={`mod-${m}`}
            checked={state[m]}
            disabled={!canManage || pending}
            onCheckedChange={(v) => flip(m, v)}
          />
        </li>
      ))}
    </ul>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { AutoForm } from "@/components/auto-form";
import { Field } from "@/components/semantic";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { NativeCheckbox } from "@/components/ui/native-checkbox";
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

/**
 * Language, time zone and the week — the settings that change how
 * every date on every page reads. Each field auto-saves on change
 * (UI.md §5.10); the action writes only the fields the form carries,
 * which is what lets the page split into two cards without either half
 * clobbering the other.
 */
export function RegionalPreferencesForm({
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
    // items-start, not stretch: a two-line hint under one field used to
    // stretch its neighbour and push the next row's label off the rail.
    <AutoForm
      action={updatePreferencesAction}
      className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2"
    >
      <Field htmlFor="p-locale" label={t("locale")} hint={t("localeHint")}>
        <NativeSelect
          id="p-locale"
          name="defaultLocale"
          defaultValue={prefs.defaultLocale}
          disabled={ro}
        >
          {LOCALES.map((l) => (
            <option key={l} value={l}>
              {tCommon(`languageName.${l}`)}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field htmlFor="p-tz" label={t("timezone")} hint={t("timezoneHint")}>
        <NativeSelect id="p-tz" name="timezone" defaultValue={prefs.timezone} disabled={ro}>
          {TIMEZONES.map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </NativeSelect>
      </Field>
      {/* ISO weeks are a property OF the week setting, so they live under
          it rather than floating in the column beside it. */}
      <div className="flex flex-col gap-3">
        <Field htmlFor="p-week" label={t("weekStart")} hint={t("weekStartHint")}>
          <NativeSelect id="p-week" name="weekStart" defaultValue={prefs.weekStart} disabled={ro}>
            {WEEK_STARTS.map((w) => (
              <option key={w} value={w}>
                {t(`weekStarts.${w}`)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <div className="flex items-center gap-2">
          <input type="hidden" name="showIsoWeekMarker" value="1" />
          {/* Native, not Radix: <AutoForm> saves on a real change event. */}
          <NativeCheckbox
            id="p-iso"
            name="showIsoWeek"
            defaultChecked={prefs.showIsoWeek}
            disabled={ro}
          />
          <Label htmlFor="p-iso" className="font-normal">
            {t("showIsoWeek")}
          </Label>
        </div>
      </div>
    </AutoForm>
  );
}

/** How hours and money are written. Same auto-save contract as above. */
export function FormatPreferencesForm({
  prefs,
  editable,
}: {
  prefs: TenantPreferences;
  editable: boolean;
}) {
  const t = useTranslations("settings.preferences");
  const ro = !editable;
  return (
    <AutoForm
      action={updatePreferencesAction}
      className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2"
    >
      <Field htmlFor="p-duration" label={t("durationStyle")} hint={t("durationStyleHint")}>
        <NativeSelect
          id="p-duration"
          name="durationStyle"
          defaultValue={prefs.durationStyle}
          disabled={ro}
          className="num"
        >
          {DURATION_STYLES.map((d) => (
            <option key={d} value={d}>
              {t(`durationStyles.${d}`)}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field htmlFor="p-currency" label={t("currency")} hint={t("currencyHint")}>
        <NativeSelect
          id="p-currency"
          name="currencyDefault"
          defaultValue={prefs.currencyDefault}
          disabled={ro}
        >
          {CURRENCIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </NativeSelect>
      </Field>
    </AutoForm>
  );
}

/**
 * Module toggles (settings:manage_modules ✦): one row per module, each
 * a label, a one-line consequence, and a switch. A module the plan
 * does not include keeps its row — hiding it would leave the reader
 * wondering whether it exists — but wears "Not in plan", so the two
 * reasons a module is off (this workspace's choice, the plan) are
 * never confused. The switch itself stays as it was: the entitlement
 * gate is enforced server-side, not by dimming a control.
 */
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
    <ul className="flex flex-col divide-y divide-border">
      {TOGGLEABLE_MODULES.map((m) => (
        <li key={m} className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <Label htmlFor={`mod-${m}`} className="font-medium">
                {t(`modules.${m}`)}
              </Label>
              {!entitled[m] ? <Badge variant="outline">{t("notInPlan")}</Badge> : null}
            </div>
            <p id={`mod-${m}-hint`} className="text-xs text-muted-foreground">
              {t(`moduleHints.${m}`)}
            </p>
          </div>
          {/* Neutral track, not the brand fill: eight switches all on is a
              vertical --primary stripe carrying no information, and the
              brand accent has exactly three jobs (UI.md §10.2), none of
              them "a row of settings that are all in their default
              state". The thumb's position is the signal. */}
          <Switch
            id={`mod-${m}`}
            aria-describedby={`mod-${m}-hint`}
            checked={state[m]}
            disabled={!canManage || pending}
            onCheckedChange={(v) => flip(m, v)}
            className="mt-1 data-checked:bg-(--tone-neutral-line)"
          />
        </li>
      ))}
    </ul>
  );
}

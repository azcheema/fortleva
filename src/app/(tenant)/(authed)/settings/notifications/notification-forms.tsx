"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { AutoForm } from "@/components/auto-form";
import { Callout, Field } from "@/components/semantic";
import { Label } from "@/components/ui/label";
import { NativeCheckbox } from "@/components/ui/native-checkbox";
import { NativeSelect } from "@/components/ui/native-select";
import { EMAIL_LEVELS } from "@/notify/catalog";
import type { MemberNotificationPreferences } from "@/notify/preferences";

import { updateNotificationPreferencesAction } from "./actions";

/**
 * The member's own notification settings. Auto-saves per field
 * (`AutoForm`, UI.md §5.10 — no Save buttons), and each card posts only
 * its own fields, so the two halves cannot clobber each other.
 *
 * ONLY WIRED SETTINGS APPEAR HERE. `NotificationPreference` also holds
 * `inAppLevel`, a digest cadence, a digest hour and weekday, quiet
 * hours and a timezone; digests are Phase 5 and nothing reads them, so
 * rendering them would be a page of controls that change nothing.
 * `notify/preferences.ts` carries the same list and the reason for each.
 */
export function EmailLevelForm({ prefs }: { prefs: MemberNotificationPreferences }) {
  const t = useTranslations("settings.notifications");
  return (
    <AutoForm action={updateNotificationPreferencesAction}>
      <Field htmlFor="n-email-level" label={t("email.label")} hint={t("email.hint")}>
        <NativeSelect id="n-email-level" name="emailLevel" defaultValue={prefs.emailLevel}>
          {EMAIL_LEVELS.map((level) => (
            <option key={level} value={level}>
              {t(`email.levels.${level}` as "email.levels.ALL")}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <p className="mt-3 text-xs text-muted-foreground">{t("email.inAppNote")}</p>
    </AutoForm>
  );
}

/**
 * The 2T weekly self-reminder (D6). One checkbox, self-addressed,
 * opt-in.
 *
 * NATIVE, NOT THE RADIX `Switch`: `<AutoForm>` saves on a real change
 * event, which is the note `TimePreferencesForm` already carries — a
 * Radix switch inside one looks right and never saves.
 *
 * The hidden companion field is what makes the checkbox's ABSENCE
 * meaningful: the form posts everything, an unchecked box sends
 * nothing, and a server action that read a missing field as "off" would
 * silence a setting the member never touched. The marker says "this
 * form owns the box", so absent then legitimately means off — the same
 * hazard UI.md §5.11 records for `InlineEdit`.
 */
export function WeeklyReminderForm({ prefs }: { prefs: MemberNotificationPreferences }) {
  const t = useTranslations("settings.notifications");
  // Mirrored so the "email is off" warning appears on the click rather
  // than one server round trip later. The checkbox stays uncontrolled —
  // this state only decides whether the note is shown.
  const [on, setOn] = useState(prefs.weeklyTimeReminder);
  return (
    <AutoForm action={updateNotificationPreferencesAction}>
      <input type="hidden" name="weeklyTimeReminderPresent" value="1" />
      <div className="flex items-start gap-2">
        <NativeCheckbox
          id="n-weekly"
          name="weeklyTimeReminder"
          defaultChecked={prefs.weeklyTimeReminder}
          onChange={(e) => setOn(e.currentTarget.checked)}
          aria-describedby="n-weekly-hint"
          className="mt-0.5"
        />
        <div className="flex min-w-0 flex-col">
          <Label htmlFor="n-weekly">{t("weekly.label")}</Label>
          <span id="n-weekly-hint" className="text-xs text-muted-foreground">
            {t("weekly.hint")}
          </span>
        </div>
      </div>
      {on && prefs.emailLevel === "NONE" ? (
        <div className="mt-3">
          {/* Not an error — the member's own two settings disagree, and
              the one that says "no email" wins. Saying so beats a
              reminder that silently never arrives. */}
          <Callout tone="caution">{t("weekly.emailOff")}</Callout>
        </div>
      ) : null}
    </AutoForm>
  );
}

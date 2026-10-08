"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

import { AutoForm } from "@/components/auto-form";
import { Callout, Field } from "@/components/semantic";
import { Label } from "@/components/ui/label";
import { NativeCheckbox } from "@/components/ui/native-checkbox";
import { NativeSelect } from "@/components/ui/native-select";
import { EMAIL_LEVELS } from "@/notify/catalog";
import { DIGEST_CADENCES } from "@/notify/digest";
import type { MemberNotificationPreferences } from "@/notify/preferences";
import { DEFAULT_QUIET_FROM, DEFAULT_QUIET_TO, summaryInQuietTime } from "@/notify/quiet-hours";

import { updateNotificationPreferencesAction } from "./actions";

/**
 * The member's own notification settings. Auto-saves per field
 * (`AutoForm`, UI.md §5.10 — no Save buttons), and each card posts only
 * its own fields, so the two halves cannot clobber each other.
 *
 * ONLY WIRED SETTINGS APPEAR HERE. `NotificationPreference` also holds
 * `inAppLevel` and a timezone, which nothing on this page sets, so
 * rendering them would be controls that change nothing (the summary's
 * cadence, hour and weekday are read since Phase 5 slice 100, quiet hours
 * since slice 105, and are here). `notify/preferences.ts` carries the same
 * list and the reason for each.
 */
export function EmailLevelForm({ prefs }: { prefs: MemberNotificationPreferences }) {
  const t = useTranslations("settings.notifications");
  return (
    <AutoForm action={updateNotificationPreferencesAction}>
      <Field htmlFor="n-email-level" label={t("email.label")} hint={t("email.hint")}>
        <NativeSelect id="n-email-level" name="emailLevel" defaultValue={prefs.emailLevel}>
          {EMAIL_LEVELS.map((level) => (
            <option key={level} value={level}>
              {t(`email.levels.${level}`)}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <p className="mt-3 text-xs text-muted-foreground">{t("email.inAppNote")}</p>
    </AutoForm>
  );
}

/** 00:00 … 23:00 — a 24-hour clock reads the same in both languages. */
const HOURS = Array.from({ length: 24 }, (_, h) => ({ value: h, label: `${String(h).padStart(2, "0")}:00` }));
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

/**
 * The SUMMARY EMAIL (Phase 5 slice 100; founder decision C68 (b), (e)): how
 * often, at what hour of the member's own day, and on what weekday when
 * weekly. Native selects inside the `AutoForm`, like the email level above.
 *
 * The weekday select is RENDERED only while "every week" is chosen, and that
 * is what keeps the auto-save honest: `AutoForm` posts every field the form
 * holds, so a hidden-but-present weekday would be re-saved on every change of
 * the hour. Absent, the action leaves it as it was. `cadence` is mirrored only
 * to decide that — the selects stay uncontrolled (the React 19 form-reset
 * trap does not bite an `AutoForm`, which never uses `<form action>`).
 */
export function SummaryForm({
  prefs,
  zone,
}: {
  prefs: MemberNotificationPreferences;
  /** The zone the hour is read in — the member's own, else the workspace's. */
  zone: string;
}) {
  const t = useTranslations("settings.notifications.summary");
  const [cadence, setCadence] = useState(prefs.digestCadence);
  return (
    <AutoForm action={updateNotificationPreferencesAction}>
      <div className="flex flex-col gap-4">
        <Field htmlFor="n-summary-cadence" label={t("cadenceLabel")} hint={t("nothingNew")}>
          <NativeSelect
            id="n-summary-cadence"
            name="digestCadence"
            defaultValue={prefs.digestCadence}
            onChange={(e) => setCadence(e.currentTarget.value as typeof cadence)}
          >
            {DIGEST_CADENCES.map((c) => (
              <option key={c} value={c}>
                {t(`cadence.${c}`)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        {cadence !== "NONE" ? (
          <div className="flex flex-wrap gap-4">
            {cadence === "WEEKLY" ? (
              <Field htmlFor="n-summary-weekday" label={t("weekdayLabel")}>
                <NativeSelect id="n-summary-weekday" name="digestWeekday" defaultValue={String(prefs.digestWeekday)}>
                  {WEEKDAYS.map((d) => (
                    <option key={d} value={d}>
                      {t(`weekdays.${d}`)}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            ) : null}
            <Field htmlFor="n-summary-hour" label={t("hourLabel")} hint={t("zoneHint", { zone })}>
              <NativeSelect id="n-summary-hour" name="digestHour" defaultValue={String(prefs.digestHour)}>
                {HOURS.map((h) => (
                  <option key={h.value} value={h.value}>
                    {h.label}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </div>
        ) : null}
      </div>
      {cadence !== "NONE" && prefs.emailLevel === "NONE" ? (
        <div className="mt-3">
          {/* The weekly reminder's precedent: the member's own two settings
              disagree, and the one that says "no email" wins. */}
          <Callout tone="caution">{t("emailOff")}</Callout>
        </div>
      ) : null}
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

/**
 * QUIET HOURS (Phase 5 slice 105; founder decision C73 (e), (f)): hours of the
 * member's own day — and, ticked, the whole weekend — in which work emails
 * wait. One `AutoForm`, native controls, two hidden markers (the weekly
 * reminder's pattern: an unticked box posts nothing, so the marker is what
 * makes its absence mean "off").
 *
 * WHAT EACH CHANGE POSTS, because `AutoForm` builds its FormData in the
 * CAPTURE phase, before this component's own `onChange` re-renders:
 *   - ticking the box posts the box alone — the hour selects are not on the
 *     page yet — and the service keeps the saved hours, else 19:00–07:00,
 *     which are exactly what the selects then open on;
 *   - unticking it posts the box's absence AND both selects, still on the
 *     page — the action reads that as OFF and ignores them (the design
 *     review's M1);
 *   - a select posts both hours. The hour the other select holds is DISABLED
 *     in it, so the same hour twice cannot be chosen (the server refuses it
 *     too, `QUIET_HOURS_SAME`).
 */
export function QuietHoursForm({
  prefs,
  zone,
}: {
  prefs: MemberNotificationPreferences;
  /** The zone the hours are read in — the member's own, else the workspace's. */
  zone: string;
}) {
  const t = useTranslations("settings.notifications.quiet");
  const [on, setOn] = useState(prefs.quietHoursFrom !== null);
  const [from, setFrom] = useState(prefs.quietHoursFrom ?? DEFAULT_QUIET_FROM);
  const [to, setTo] = useState(prefs.quietHoursTo ?? DEFAULT_QUIET_TO);
  const [weekends, setWeekends] = useState(prefs.quietWeekends);
  const summaryInside = summaryInQuietTime(
    { from: on ? from : null, to: on ? to : null, weekends },
    prefs.digestCadence,
    prefs.digestHour,
    prefs.digestWeekday,
  );
  const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00`;
  return (
    <AutoForm action={updateNotificationPreferencesAction}>
      <input type="hidden" name="quietHoursPresent" value="1" />
      <input type="hidden" name="quietWeekendsPresent" value="1" />
      <div className="flex flex-col gap-4">
        <div className="flex items-start gap-2">
          <NativeCheckbox
            id="n-quiet"
            name="quietHours"
            defaultChecked={on}
            onChange={(e) => {
              const checked = e.currentTarget.checked;
              setOn(checked);
              // The selects open on what the server is saving right now: the
              // saved hours, else 19:00–07:00 — never hours this page still
              // remembers from before they were switched off (off saves none).
              if (checked) {
                setFrom(prefs.quietHoursFrom ?? DEFAULT_QUIET_FROM);
                setTo(prefs.quietHoursTo ?? DEFAULT_QUIET_TO);
              }
            }}
            className="mt-0.5"
            data-testid="quiet-hours"
          />
          <Label htmlFor="n-quiet">{t("toggle")}</Label>
        </div>
        {on ? (
          <div className="flex flex-wrap gap-4">
            <Field htmlFor="n-quiet-from" label={t("fromLabel")}>
              <NativeSelect
                id="n-quiet-from"
                name="quietHoursFrom"
                defaultValue={String(from)}
                onChange={(e) => setFrom(Number(e.currentTarget.value))}
                data-testid="quiet-from"
              >
                {HOURS.map((h) => (
                  <option key={h.value} value={h.value} disabled={h.value === to}>
                    {h.label}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field htmlFor="n-quiet-to" label={t("toLabel")} hint={t("zoneHint", { zone })}>
              <NativeSelect
                id="n-quiet-to"
                name="quietHoursTo"
                defaultValue={String(to)}
                onChange={(e) => setTo(Number(e.currentTarget.value))}
                data-testid="quiet-to"
              >
                {HOURS.map((h) => (
                  <option key={h.value} value={h.value} disabled={h.value === from}>
                    {h.label}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </div>
        ) : null}
        <div className="flex items-start gap-2">
          <NativeCheckbox
            id="n-quiet-weekends"
            name="quietWeekends"
            defaultChecked={prefs.quietWeekends}
            onChange={(e) => setWeekends(e.currentTarget.checked)}
            className="mt-0.5"
            data-testid="quiet-weekends"
          />
          <Label htmlFor="n-quiet-weekends">{t("weekends")}</Label>
        </div>
        <p className="text-xs text-muted-foreground">{t("note")}</p>
      </div>
      {summaryInside ? (
        <div className="mt-3">
          <Callout tone="caution">{t("summaryInside", { hour: hourLabel(prefs.digestHour) })}</Callout>
        </div>
      ) : null}
    </AutoForm>
  );
}

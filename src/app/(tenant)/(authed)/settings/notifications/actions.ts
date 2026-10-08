"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";

import { field, has, runForm, type FormResult } from "@/lib/server-actions";
import { requireTenantContext } from "@/members/tenant-context";
import { isEmailLevel } from "@/notify/catalog";
import { isDigestCadence } from "@/notify/digest";
import { isDigestHour, isDigestWeekday, updateOwnPreferences } from "@/notify/preferences";
import { isQuietHour } from "@/notify/quiet-hours";

/** A whole number from the form, or null — never NaN, never "". */
const numberField = (fd: FormData, name: string): number | null => {
  const raw = field(fd, name);
  if (raw === null || !/^\d{1,2}$/.test(raw)) return null;
  return Number(raw);
};

/**
 * `/settings/notifications` — the member's own notification settings.
 *
 * The form auto-saves per field (`AutoForm`, UI.md §5.10), so each
 * action writes ONLY the fields its FormData carries: `has()` guards
 * every read, because `<AutoForm>` posts the whole form and an absent
 * field must mean "unchanged", never "off". That is the same hazard
 * `InlineEdit` records in UI.md §5.11 — a checkbox is exactly where it
 * bites, since an unchecked box sends nothing at all.
 */
export async function updateNotificationPreferencesAction(
  formData: FormData,
): Promise<FormResult> {
  const { membership, actor } = await requireTenantContext();
  const t = await getTranslations("common");
  const level = field(formData, "emailLevel");
  const pushLevel = field(formData, "pushLevel");
  const cadence = field(formData, "digestCadence");
  const hour = numberField(formData, "digestHour");
  const weekday = numberField(formData, "digestWeekday");
  const quietFrom = numberField(formData, "quietHoursFrom");
  const quietTo = numberField(formData, "quietHoursTo");
  return runForm("/settings/notifications", async () => {
    await updateOwnPreferences(
      { tenantId: membership.tenantId, actor },
      {
        ...(isEmailLevel(level) ? { emailLevel: level } : {}),
        // The phone's own level (slice 106, C74 (b)): the same four steps.
        ...(isEmailLevel(pushLevel) ? { pushLevel } : {}),
        // The summary (slice 100). Each only when the form carried it and it
        // is in range: the weekday select exists only while "every week" is
        // chosen, and an absent field means "unchanged".
        ...(isDigestCadence(cadence) ? { digestCadence: cadence } : {}),
        ...(isDigestHour(hour) ? { digestHour: hour } : {}),
        ...(isDigestWeekday(weekday) ? { digestWeekday: weekday } : {}),
        // The checkbox's presence in the form is what makes its ABSENCE
        // meaningful: a hidden companion field marks that this form owns
        // the switch, so an unchecked box reads as false rather than as
        // "not submitted".
        ...(has(formData, "weeklyTimeReminderPresent")
          ? { weeklyTimeReminder: field(formData, "weeklyTimeReminder") === "on" }
          : {}),
        // Quiet hours (slice 105, C73 (f)), the same marker pattern. UNTICKED
        // IS OFF, whatever hours the form also carried: at the change that
        // switches them off the two selects are still on the page and post
        // their values, which must not switch them straight back on (the
        // design review's M1). Ticked with no hours — the change that
        // switches them on, before the selects exist — keeps the saved hours,
        // else 19:00–07:00 (the service's rule).
        ...(has(formData, "quietHoursPresent")
          ? {
              quietHours:
                field(formData, "quietHours") === "on"
                  ? { ...(isQuietHour(quietFrom) ? { from: quietFrom } : {}), ...(isQuietHour(quietTo) ? { to: quietTo } : {}) }
                  : null,
            }
          : {}),
        ...(has(formData, "quietWeekendsPresent") ? { quietWeekends: field(formData, "quietWeekends") === "on" } : {}),
      },
    );
    revalidatePath("/settings/notifications");
    return t("saved");
  });
}

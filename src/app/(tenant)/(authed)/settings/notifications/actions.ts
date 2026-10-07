"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";

import { field, has, runForm, type FormResult } from "@/lib/server-actions";
import { requireTenantContext } from "@/members/tenant-context";
import { isEmailLevel } from "@/notify/catalog";
import { isDigestCadence } from "@/notify/digest";
import { isDigestHour, isDigestWeekday, updateOwnPreferences } from "@/notify/preferences";

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
  const cadence = field(formData, "digestCadence");
  const hour = numberField(formData, "digestHour");
  const weekday = numberField(formData, "digestWeekday");
  return runForm("/settings/notifications", async () => {
    await updateOwnPreferences(
      { tenantId: membership.tenantId, actor },
      {
        ...(isEmailLevel(level) ? { emailLevel: level } : {}),
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
      },
    );
    revalidatePath("/settings/notifications");
    return t("saved");
  });
}

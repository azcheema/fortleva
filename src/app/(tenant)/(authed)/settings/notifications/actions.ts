"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";

import { field, has, runForm, type FormResult } from "@/lib/server-actions";
import { requireTenantContext } from "@/members/tenant-context";
import { isEmailLevel } from "@/notify/catalog";
import { updateOwnPreferences } from "@/notify/preferences";

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
  return runForm("/settings/notifications", async () => {
    await updateOwnPreferences(
      { tenantId: membership.tenantId, actor },
      {
        ...(isEmailLevel(level) ? { emailLevel: level } : {}),
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

"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { z } from "zod";

import { dateColumn, isoDateOf } from "@/lib/duration";
import { runAction, type ActionResult } from "@/lib/server-actions";
import { isIsoDate } from "@/lib/week";
import { requireTenantContext } from "@/members/tenant-context";
import { updateItemFields } from "@/modules/work";
import { PROJECT_KEY_RE } from "@/projects/service";

/**
 * The calendar's one verb (slice 128; founder decision C105 (d) — design
 * §3.4): move a task's due date to another day, from a drag or from "Move
 * to…". `updateItemFields` decides everything — `work_item:edit`, the task's
 * scope, a deleted task is NOT_FOUND — and writes the routine history row
 * (AGENTS.md's carve-out for that function's fields; no audit).
 *
 * Tenant and member come from `requireTenantContext()`, never from the form.
 * The MFA step-up returns to `/calendar`, a FIXED path — never one built from
 * input, so this is no open redirect. The project key is used only to
 * revalidate that project's board and backlog, and is held to the projects
 * service's own shape first.
 */

const MoveTask = z
  .object({
    itemId: z.uuid(),
    projectKey: z.string().regex(PROJECT_KEY_RE),
    targetDate: z.string().refine((s) => isIsoDate(s)),
  })
  .strict();

export type CalendarMoved = { readonly dueOn: string | null; readonly changed: boolean };

export async function moveCalendarTaskAction(input: z.input<typeof MoveTask>): Promise<ActionResult<CalendarMoved>> {
  const { membership, actor } = await requireTenantContext();
  const ctx = { tenantId: membership.tenantId, actor };
  const parsed = MoveTask.safeParse(input);
  if (!parsed.success) return { ok: false, message: (await getTranslations("calendar"))("moveFailed") };
  const { itemId, projectKey, targetDate } = parsed.data;
  const r = await runAction("/calendar", async () => {
    const c = await updateItemFields(ctx, itemId, { targetDate: dateColumn(targetDate) });
    return { dueOn: c.targetDate ? isoDateOf(c.targetDate) : null, changed: c.changed };
  });
  if (r.ok && r.value.changed) {
    revalidatePath("/calendar");
    revalidatePath(`/projects/${projectKey}/backlog`);
    revalidatePath(`/projects/${projectKey}/board`);
  }
  return r;
}

"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { z } from "zod";

import { AuthzError } from "@/authz/errors";
import { resolveTimeZone } from "@/i18n/resolve";
import { addSeconds, localDateString, startOfLocalDay } from "@/lib/duration";
import { field, runAction, runForm, type ActionResult, type FormResult } from "@/lib/server-actions";
import { isIsoDate } from "@/lib/week";
import { requireTenantContext } from "@/members/tenant-context";
import {
  acknowledgeNotice,
  clockIn,
  clockOut,
  continueEntry,
  copyWeek,
  createEntry,
  deleteEntry,
  getCurrentTimerOnce,
  startBreak,
  startTimer,
  stopBreak,
  stopTimer,
  undoStart,
  updateEntry,
  updateShift,
  type TimeCtx,
} from "@/modules/time";
import { listItems } from "@/modules/work";
import { listServices } from "@/services/service";

import { labelOf } from "./label";

/**
 * Server actions for the time module's member surfaces (/time, the timer
 * pill). Thin: parse → service (which authorizes, locks, audits in one
 * transaction) → revalidate. Tenant and member come from the session,
 * never from the form. Every mutation returns a typed result the client
 * toasts — a failure must never look like a revert (PLAN.md trap).
 */

const PATH = "/time";
const uuid = z.uuid();
const isoDate = z.string().refine(isIsoDate); // @/lib/week: shape AND a real date within 1970–2100

const ctxOf = async (): Promise<TimeCtx> => {
  const { membership, actor } = await requireTenantContext();
  return { tenantId: membership.tenantId, actor };
};

/** What the header pill needs — serialisable, no Date objects. */
export type TimerPillState = {
  running: { id: string; label: string; projectKey: string | null; startedAt: string } | null;
  serverNow: string;
  nudge: boolean;
  noticeRequired: boolean;
};

export async function getTimerStateAction(): Promise<TimerPillState | null> {
  try {
    const ctx = await ctxOf();
    // Once per request: the layout (pill) and /home (strip) share this snapshot.
    const c = await getCurrentTimerOnce(ctx.tenantId, ctx.actor.memberId, Boolean(ctx.actor.impersonated));
    return {
      running: c.running
        ? {
            id: c.running.id,
            label: labelOf(c.running),
            projectKey: c.running.project?.key ?? null,
            startedAt: c.running.startedAt.toISOString(),
          }
        : null,
      serverNow: c.serverNow.toISOString(),
      nudge: c.nudge,
      noticeRequired: c.noticeRequired,
    };
  } catch (e) {
    if (e instanceof AuthzError) return null; // no time:track / module off ⇒ no pill
    throw e;
  }
}

const targetSchema = z.object({
  projectId: uuid.nullable().optional(),
  workItemId: uuid.nullable().optional(),
  serviceId: uuid.nullable().optional(),
  workTypeId: uuid.nullable().optional(),
  description: z.string().max(1000).nullable().optional(),
  billable: z.boolean().nullable().optional(),
});
export type TargetInput = z.infer<typeof targetSchema>;

const revalidate = () => {
  revalidatePath(PATH);
  revalidatePath("/", "layout");
};

export async function startTimerAction(
  raw: TargetInput,
): Promise<ActionResult<{ startedId: string; stoppedId: string | null; stoppedLabel: string | null }>> {
  const parsed = targetSchema.safeParse(raw);
  const tCommon = await getTranslations("common");
  if (!parsed.success) return { ok: false, message: tCommon("invalidInput") };
  const ctx = await ctxOf();
  const r = await runAction(PATH, async () => {
    const { started, stopped } = await startTimer(ctx, parsed.data);
    return { startedId: started.id, stoppedId: stopped?.id ?? null, stoppedLabel: stopped ? labelOf(stopped) : null };
  });
  if (r.ok) revalidate();
  return r;
}

export async function stopTimerAction(
  patch?: { description?: string | null },
): Promise<ActionResult<{ entryId: string; durationSeconds: number }>> {
  const ctx = await ctxOf();
  const r = await runAction(PATH, async () => {
    const e = await stopTimer(ctx, patch ? { description: patch.description?.slice(0, 1000) ?? null } : undefined);
    return { entryId: e.id, durationSeconds: e.durationSeconds ?? 0 };
  });
  if (r.ok) revalidate();
  return r;
}

export async function continueEntryAction(
  entryId: string,
): Promise<ActionResult<{ startedId: string; stoppedId: string | null; stoppedLabel: string | null }>> {
  const tCommon = await getTranslations("common");
  const id = uuid.safeParse(entryId);
  if (!id.success) return { ok: false, message: tCommon("invalidInput") };
  const ctx = await ctxOf();
  const r = await runAction(PATH, async () => {
    const { started, stopped } = await continueEntry(ctx, id.data);
    return { startedId: started.id, stoppedId: stopped?.id ?? null, stoppedLabel: stopped ? labelOf(stopped) : null };
  });
  if (r.ok) revalidate();
  return r;
}

export async function undoStartAction(input: { startedId: string; resumeId: string }): Promise<FormResult> {
  const t = await getTranslations("time");
  const tCommon = await getTranslations("common");
  const parsed = z.object({ startedId: uuid, resumeId: uuid }).safeParse(input);
  if (!parsed.success) return { ok: false, message: tCommon("invalidInput") };
  const ctx = await ctxOf();
  const r = await runForm(PATH, async () => {
    await undoStart(ctx, parsed.data);
    return t("toasts.undone");
  });
  if (r.ok) revalidate();
  return r;
}

export async function clockInAction(): Promise<FormResult> {
  const t = await getTranslations("time");
  const ctx = await ctxOf();
  const r = await runForm(PATH, async () => {
    await clockIn(ctx);
    return t("toasts.clockedIn");
  });
  if (r.ok) revalidate();
  return r;
}

export async function clockOutAction(): Promise<ActionResult<{ stoppedTimerId: string | null; workedSeconds: number }>> {
  const ctx = await ctxOf();
  const r = await runAction(PATH, async () => {
    const { shift, stoppedTimer } = await clockOut(ctx);
    return { stoppedTimerId: stoppedTimer?.id ?? null, workedSeconds: shift.workedSeconds ?? 0 };
  });
  if (r.ok) revalidate();
  return r;
}

export async function startBreakAction(): Promise<ActionResult<{ stoppedTimerId: string | null }>> {
  const ctx = await ctxOf();
  const r = await runAction(PATH, async () => {
    const { stoppedTimer } = await startBreak(ctx);
    return { stoppedTimerId: stoppedTimer?.id ?? null };
  });
  if (r.ok) revalidate();
  return r;
}

export async function stopBreakAction(): Promise<FormResult> {
  const t = await getTranslations("time");
  const ctx = await ctxOf();
  const r = await runForm(PATH, async () => {
    await stopBreak(ctx);
    return t("toasts.breakEnded");
  });
  if (r.ok) revalidate();
  return r;
}

export async function acknowledgeNoticeAction(noticeId: string): Promise<FormResult> {
  const t = await getTranslations("time");
  const tCommon = await getTranslations("common");
  const id = uuid.safeParse(noticeId);
  if (!id.success) return { ok: false, message: tCommon("invalidInput") };
  const ctx = await ctxOf();
  const r = await runForm(PATH, async () => {
    await acknowledgeNotice(ctx, id.data);
    return t("notice.acknowledged");
  });
  if (r.ok) revalidate();
  return r;
}

/** Picker options for a project: its open tasks and the client's active agreements. */
export async function pickerOptionsAction(
  projectId: string,
  clientId: string,
): Promise<ActionResult<{ items: { id: string; label: string }[]; services: { id: string; name: string }[] }>> {
  const tCommon = await getTranslations("common");
  const p = uuid.safeParse(projectId);
  const c = uuid.safeParse(clientId);
  if (!p.success || !c.success) return { ok: false, message: tCommon("invalidInput") };
  const ctx = await ctxOf();
  return runAction(PATH, async () => {
    const [list, services] = await Promise.all([
      listItems(ctx, p.data),
      listServices(ctx, { clientId: c.data }),
    ]);
    return {
      items: list.items
        .filter((i) => i.stateCategory !== "DONE" && i.stateCategory !== "CANCELLED" && !i.archivedAt)
        .map((i) => ({ id: i.id, label: `${i.number} · ${i.title}` })),
      services: services
        .filter((s) => s.status === "ACTIVE" && (s.projectId === null || s.projectId === p.data))
        .map((s) => ({ id: s.id, name: s.name })),
    };
  });
}

const hhmm = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** The "New entry" form: a duration on a date, or a start + end on a date. */
export async function createEntryAction(formData: FormData): Promise<FormResult> {
  const t = await getTranslations("time");
  const tCommon = await getTranslations("common");
  const ctx = await ctxOf();
  const date = field(formData, "date");
  if (!isIsoDate(date)) return { ok: false, message: tCommon("invalidInput") };
  const target = {
    projectId: field(formData, "projectId") || null,
    workItemId: field(formData, "workItemId") || null,
    serviceId: field(formData, "serviceId") || null,
    workTypeId: field(formData, "workTypeId") || null,
    description: field(formData, "description") || null,
    // Tri-state like the quick start: "" ⇒ null ⇒ the work type's / project's
    // default decides (resolveTarget); "1" / "0" ⇒ an explicit choice.
    billable: field(formData, "billable") === "1" ? true : field(formData, "billable") === "0" ? false : null,
  };
  for (const k of ["projectId", "workItemId", "serviceId", "workTypeId"] as const) {
    if (target[k] !== null && !uuid.safeParse(target[k]).success) return { ok: false, message: tCommon("invalidInput") };
  }
  const duration = (field(formData, "duration") ?? "").trim();
  const start = (field(formData, "start") ?? "").trim();
  const end = (field(formData, "end") ?? "").trim();
  const timeZone = await resolveTimeZone();
  const r = await runForm(PATH, async () => {
    // A half-filled pair is a time error, not a silent fall-through to
    // the duration path (the clock the member typed would be dropped).
    if ((start && !end) || (!start && end)) throw new Error("INVALID_TIME");
    if (start && end) {
      const ms = hhmm.exec(start);
      const me = hhmm.exec(end);
      if (!ms || !me) throw new Error("INVALID_TIME");
      const dayStart = startOfLocalDay(date, timeZone);
      const startedAt = addSeconds(dayStart, Number(ms[1]) * 3600 + Number(ms[2]) * 60);
      let stoppedAt = addSeconds(dayStart, Number(me[1]) * 3600 + Number(me[2]) * 60);
      if (stoppedAt <= startedAt) stoppedAt = addSeconds(stoppedAt, 24 * 3600); // past midnight
      await createEntry(ctx, { ...target, startedAt, stoppedAt });
    } else {
      await createEntry(ctx, { ...target, durationText: duration, localDate: date });
    }
    return t("toasts.entryCreated");
  }).catch((e: unknown) =>
    e instanceof Error && e.message === "INVALID_TIME" ? { ok: false as const, message: t("errors.invalidTime") } : Promise.reject(e),
  );
  if (r.ok) revalidate();
  return r;
}

/**
 * Copy last week's rows into the grid week containing `weekFrom` (the
 * viewed week) — empty durations by default; the sum only on the explicit
 * "copy with durations". The service snaps `weekFrom` to the tenant's
 * week start and decides what "last week" is; the client names no range.
 */
export async function copyLastWeekAction(input: {
  weekFrom: string;
  withDurations: boolean;
}): Promise<ActionResult<{ created: number; alreadyPresent: number; unusable: number }>> {
  const tCommon = await getTranslations("common");
  const parsed = z.object({ weekFrom: isoDate, withDurations: z.boolean() }).safeParse(input);
  if (!parsed.success) return { ok: false, message: tCommon("invalidInput") };
  const ctx = await ctxOf();
  const r = await runAction(PATH, () => copyWeek(ctx, parsed.data));
  if (r.ok) revalidate();
  return r;
}

/**
 * Only the fields the grid edits inline. Server-action arguments are
 * client-supplied: a move (projectId / workItemId / start / end) is not
 * admitted here — it would need its own UI and its own scope story.
 */
const entryPatchSchema = z
  .object({
    durationText: z.string().max(40).optional(),
    description: z.string().max(1000).nullable().optional(),
    billable: z.boolean().optional(),
    serviceId: uuid.nullable().optional(),
    workTypeId: uuid.nullable().optional(),
  })
  .strict();

export async function updateEntryAction(
  entryId: string,
  patch: { durationText?: string; description?: string | null; billable?: boolean; serviceId?: string | null; workTypeId?: string | null },
): Promise<FormResult> {
  const t = await getTranslations("time");
  const tCommon = await getTranslations("common");
  const id = uuid.safeParse(entryId);
  const parsed = entryPatchSchema.safeParse(patch);
  if (!id.success || !parsed.success) return { ok: false, message: tCommon("invalidInput") };
  const ctx = await ctxOf();
  const r = await runForm(PATH, async () => {
    await updateEntry(ctx, id.data, parsed.data);
    return t("toasts.saved");
  });
  if (r.ok) revalidate();
  return r;
}

export async function deleteEntryAction(entryId: string): Promise<FormResult> {
  const t = await getTranslations("time");
  const tCommon = await getTranslations("common");
  const id = uuid.safeParse(entryId);
  if (!id.success) return { ok: false, message: tCommon("invalidInput") };
  const ctx = await ctxOf();
  const r = await runForm(PATH, async () => {
    await deleteEntry(ctx, id.data);
    return t("toasts.entryDeleted");
  });
  if (r.ok) revalidate();
  return r;
}

/** Confirm a provisional (auto-stopped) shift as-is, or with a corrected end. */
export async function confirmShiftAction(shiftId: string, stoppedAtIso?: string): Promise<FormResult> {
  const t = await getTranslations("time");
  const tCommon = await getTranslations("common");
  const id = uuid.safeParse(shiftId);
  if (!id.success) return { ok: false, message: tCommon("invalidInput") };
  const stoppedAt = stoppedAtIso ? new Date(stoppedAtIso) : undefined;
  if (stoppedAt && Number.isNaN(stoppedAt.getTime())) return { ok: false, message: tCommon("invalidInput") };
  const ctx = await ctxOf();
  const r = await runForm(PATH, async () => {
    await updateShift(ctx, id.data, stoppedAt ? { stoppedAt } : {});
    return t("toasts.shiftConfirmed");
  });
  if (r.ok) revalidate();
  return r;
}

/** Today's local date for the member (used by forms as the default). */
export async function todayAction(): Promise<string> {
  return localDateString(new Date(), await resolveTimeZone());
}

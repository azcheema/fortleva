import { record } from "@/audit/record";
import { resolveScope, type MemberActor, type ScopeResolution } from "@/authz/authorize";
import { withTenant, type TenantDb } from "@/db";
import { accessibleCodes } from "@/entitlements/resolver";
import { dateColumn, isoDateOf, localDateString, localHourInstant } from "@/lib/duration";
import { addDays } from "@/lib/week";
import { DIGEST_SENDING_TENANT_STATUSES } from "@/notify/digest";
import { emit } from "@/notify/emit";
import { readPreferences } from "@/preferences/service";

import {
  UPDATE_REMINDER_HOUR,
  UPDATE_REMINDER_LAST_HOUR,
  isUpdateWeekday,
  reminderSlotOn,
  reminderStepOn,
  scheduleInputOf,
  updateScheduleAt,
  type ScheduledProject,
  type UpdateScheduleStatus,
} from "./update-schedule";

/**
 * PROGRESS-UPDATE REMINDERS (Phase 5 slice 102; founder decision C70; PLAN
 * Phase 5 "`ProjectUpdateSchedule` … +1/+2 working-day reminders"). Run per
 * tenant by `src/jobs/update-reminders.ts`, which found the tenant under the
 * audited platform seam; everything here runs under THIS tenant's SYSTEM
 * principal, RLS live.
 *
 * WHAT IS SENT. For each ACTIVE project with a cadence whose update is due
 * today or late (`update-schedule.ts` decides, in the workspace's zone):
 * `project_update.due` — on the round's day (step 0) and on the next two
 * working days (1, 2), each between 09:00 and 17:00 workspace time, never on
 * a weekend; and, while it stays missing, a new round on every later
 * scheduled day (C70 (e)). A run outside those hours, or that missed a day,
 * sends nothing for it: each reminder belongs to one day.
 *
 * WHO HEARS (C70 (a), (f)): the project's LEAD, if they can publish —
 * ACTIVE, holding `project_update:publish` AND `project_update:view` on all
 * four gates as THEMSELVES (`accessibleCodes`, so a module switched off, the
 * plan or a kill-switch closes it), and reaching the project by scope;
 * otherwise everyone ASSIGNED to the project (MemberProject) who passes the
 * same checks. Only a publish clears the reminder, so a reminder never goes
 * to someone who could not finish the job; `:view` because the mail's link
 * is the Updates tab (C34: never a page that would refuse them). Nobody ⇒
 * nothing is sent and nothing is recorded, so the reminder still goes that
 * day if somebody becomes able to hear it.
 *
 * ONE TRANSACTION PER REMINDER: the project re-read and its whole state
 * recomputed — status, cadence, day, `since`, the portal switch, the newest
 * counting post — and the round and step compared with the plan's; then the
 * dedupe row (`project_update_reminder_sent`, ON CONFLICT DO NOTHING — a
 * conflict is "already sent", which also settles two runs racing), the
 * inbox rows and mails (`notify.emit`) and `project_update.reminder_sent`,
 * committed together or not at all. A post published since the plan, a
 * changed day, a paused project — each sends nothing.
 *
 * A WORKSPACE THAT IS NOT SENDING — suspended, being offboarded, closed —
 * is reminded of nothing (one suspended in the seconds between a plan and
 * its send can still get that run's inbox rows — accepted, the fix-pass
 * review's low) (the code and security reviews' medium: with C70
 * (e) a reminder repeats every due day, so a closed workspace would be
 * mailed for ever). The job's discovery leaves such tenants out; `plan`
 * checks again in the tenant's own transaction — the digests' rule.
 *
 * Reads in SEQUENCE on each transaction (AGENTS.md's `Promise.all` trap).
 * Nothing here names a project in a mail: `params` carries the project's
 * key (for the link), the step and whether it is late — never a name
 * (`notify.emit`'s rule).
 */

const SYSTEM = { type: "system" } as const;

/** What a receiver must hold, on all four gates, as themselves. */
const RECEIVER_CODES = ["project_update:publish", "project_update:view"] as const;

/** Dedupe rows are swept this long after their day — long past any step that could still need them. */
export const UPDATE_REMINDER_SWEEP_DAYS = 60;

const projectSelect = {
  id: true,
  key: true,
  clientId: true,
  status: true,
  archivedAt: true,
  portalEnabled: true,
  leadMemberId: true,
  updateCadence: true,
  updateWeekday: true,
  updateScheduleSince: true,
} as const;

type ProjectRow = ScheduledProject & {
  readonly id: string;
  readonly key: string;
  readonly clientId: string;
  readonly portalEnabled: boolean;
  readonly leadMemberId: string | null;
};

/**
 * The newest post that counts for a project's schedule: PUBLISHED (never an
 * archived or retracted one — it was taken back), and while the client
 * portal is ON, one the client can see (C70 (g)).
 */
export async function lastCountingPostAt(
  tx: TenantDb,
  tenantId: string,
  projectId: string,
  portalEnabled: boolean,
): Promise<Date | null> {
  const row = await tx.projectUpdate.findFirst({
    where: { tenantId, projectId, status: "PUBLISHED", ...(portalEnabled ? { visibility: "CLIENT_VISIBLE" } : {}) },
    select: { publishedAt: true },
    orderBy: [{ publishedAt: "desc" }, { seq: "desc" }],
  });
  return row?.publishedAt ?? null;
}

/**
 * Where a project's schedule stands at `now` — the project page's header
 * badge and the Updates tab's line, from the same rule the job sends by.
 * The caller has already read the project in scope; `now` is a parameter so
 * a test can stand on a due or late day.
 */
export async function readUpdateSchedule(
  tx: TenantDb,
  tenantId: string,
  project: ScheduledProject & { readonly id: string; readonly portalEnabled: boolean },
  now: Date = new Date(),
): Promise<UpdateScheduleStatus | null> {
  // Nothing to read for a project with no schedule: no cadence, or not ACTIVE.
  if (project.updateCadence === "NONE" || project.status !== "ACTIVE" || project.archivedAt !== null) return null;
  const prefs = await readPreferences(tx, tenantId);
  const last = await lastCountingPostAt(tx, tenantId, project.id, project.portalEnabled);
  return updateScheduleAt(scheduleInputOf(project, last, prefs.timezone), now);
}

/** The reminder a project is owed at `now`, or null — the plan's and the send's one answer. */
function owedAt(
  project: ProjectRow,
  last: Date | null,
  timeZone: string,
  now: Date,
): { readonly dueOn: string; readonly slot: string; readonly step: number } | null {
  const status = updateScheduleAt(scheduleInputOf(project, last, timeZone), now);
  if (status === null || status.state === "scheduled") return null;
  if (project.updateCadence === "NONE" || !isUpdateWeekday(project.updateWeekday)) return null;
  const today = localDateString(now, timeZone);
  const slot = reminderSlotOn(project.updateCadence, project.updateWeekday, status.dueOn, today);
  if (slot === null) return null;
  const step = reminderStepOn(slot, today);
  return step === null ? null : { dueOn: status.dueOn, slot, step };
}

type Owed = {
  readonly project: ProjectRow;
  readonly dueOn: string;
  readonly slot: string;
  readonly step: number;
};

type Plan = {
  readonly timeZone: string;
  readonly owed: readonly Owed[];
  readonly active: ReadonlySet<string>;
  readonly assigned: ReadonlyMap<string, readonly string[]>;
};

async function plan(tx: TenantDb, tenantId: string, now: Date): Promise<Plan> {
  const prefs = await readPreferences(tx, tenantId);
  const timeZone = prefs.timezone;
  const today = localDateString(now, timeZone);
  await tx.projectUpdateReminderSent.deleteMany({
    where: { tenantId, dueOn: { lt: dateColumn(addDays(today, -UPDATE_REMINDER_SWEEP_DAYS)) } },
  });
  const empty: Plan = { timeZone, owed: [], active: new Set(), assigned: new Map() };
  const tenant = await tx.tenant.findFirst({ where: { id: tenantId }, select: { status: true } });
  if (!tenant || !(DIGEST_SENDING_TENANT_STATUSES as readonly string[]).includes(tenant.status)) return empty;
  // The day's sending hours, in the workspace's zone: a 23:00 "due today"
  // helps nobody, and the next run on the next working day has its own step.
  if (now < localHourInstant(today, UPDATE_REMINDER_HOUR, timeZone)) return empty;
  if (now >= localHourInstant(today, UPDATE_REMINDER_LAST_HOUR, timeZone)) return empty;

  const projects: ProjectRow[] = await tx.project.findMany({
    where: { tenantId, status: "ACTIVE", archivedAt: null, updateCadence: { not: "NONE" } },
    select: projectSelect,
    orderBy: { id: "asc" },
  });
  if (projects.length === 0) return empty;
  const ids = projects.map((p) => p.id);
  // The newest post per project, twice: any published one, and the newest the
  // client can see — which one counts depends on the project's portal (C70 (g)).
  const anyPost = await tx.projectUpdate.groupBy({
    by: ["projectId"],
    where: { tenantId, projectId: { in: ids }, status: "PUBLISHED" },
    _max: { publishedAt: true },
  });
  const sharedPost = await tx.projectUpdate.groupBy({
    by: ["projectId"],
    where: { tenantId, projectId: { in: ids }, status: "PUBLISHED", visibility: "CLIENT_VISIBLE" },
    _max: { publishedAt: true },
  });
  const lastAny = new Map(anyPost.map((r) => [r.projectId, r._max.publishedAt]));
  const lastShared = new Map(sharedPost.map((r) => [r.projectId, r._max.publishedAt]));
  const sent = new Set(
    (
      await tx.projectUpdateReminderSent.findMany({
        where: { tenantId, projectId: { in: ids }, dueOn: { gte: dateColumn(addDays(today, -7)) } },
        select: { projectId: true, dueOn: true, step: true },
      })
    ).map((r) => `${r.projectId}|${isoDateOf(r.dueOn)}|${r.step}`),
  );

  const owed: Owed[] = [];
  for (const p of projects) {
    const last = (p.portalEnabled ? lastShared.get(p.id) : lastAny.get(p.id)) ?? null;
    const o = owedAt(p, last, timeZone, now);
    if (o && !sent.has(`${p.id}|${o.slot}|${o.step}`)) owed.push({ project: p, ...o });
  }
  if (owed.length === 0) return empty;

  const active = await tx.member.findMany({ where: { tenantId, status: "ACTIVE" }, select: { id: true } });
  const rows = await tx.memberProject.findMany({
    where: { tenantId, projectId: { in: owed.map((o) => o.project.id) } },
    select: { memberId: true, projectId: true },
    orderBy: { memberId: "asc" },
  });
  const assigned = new Map<string, string[]>();
  for (const r of rows) assigned.set(r.projectId, [...(assigned.get(r.projectId) ?? []), r.memberId]);
  return { timeZone, owed, active: new Set(active.map((m) => m.id)), assigned };
}

type Who = { readonly codes: ReadonlySet<string>; readonly scope: ScopeResolution };

/**
 * A member's codes (all four gates) and scope, resolved AS THAT MEMBER in a
 * short read of its own, once per run. None of `RECEIVER_CODES` is a ✦ code,
 * so the actor carries no factor.
 */
function whoResolver(tenantId: string): (memberId: string) => Promise<Who> {
  const memo = new Map<string, Who>();
  return async (memberId) => {
    const known = memo.get(memberId);
    if (known) return known;
    const actor: MemberActor = { memberId };
    const who = await withTenant(tenantId, SYSTEM, async (tx) => {
      const codes = await accessibleCodes(tx, tenantId, actor, RECEIVER_CODES);
      const scope = await resolveScope(tx, actor);
      return { codes, scope };
    });
    memo.set(memberId, who);
    return who;
  };
}

/** C70 (a), (f): the lead if they can publish, else the project's people who can. */
async function receiversOf(o: Owed, p: Plan, who: (id: string) => Promise<Who>): Promise<string[]> {
  const can = async (memberId: string) => {
    if (!p.active.has(memberId)) return false;
    const w = await who(memberId);
    return (
      RECEIVER_CODES.every((c) => w.codes.has(c)) && (w.scope.all || w.scope.projectIds.includes(o.project.id))
    );
  };
  const lead = o.project.leadMemberId;
  if (lead && (await can(lead))) return [lead];
  const out: string[] = [];
  // In turn: each `who` may open a transaction of its own.
  for (const memberId of new Set(p.assigned.get(o.project.id) ?? [])) {
    if (await can(memberId)) out.push(memberId);
  }
  return out;
}

/** Send one reminder; true when it went out. */
async function send(tenantId: string, o: Owed, timeZone: string, chosen: readonly string[], now: Date): Promise<boolean> {
  return withTenant(tenantId, SYSTEM, async (tx) => {
    // The project as it stands NOW, its whole state recomputed: still owed
    // THIS round's THIS step, with the receivers' lead unchanged.
    const project: ProjectRow | null = await tx.project.findFirst({
      where: { tenantId, id: o.project.id },
      select: projectSelect,
    });
    if (!project || project.leadMemberId !== o.project.leadMemberId) return false;
    const last = await lastCountingPostAt(tx, tenantId, project.id, project.portalEnabled);
    const still = owedAt(project, last, timeZone, now);
    if (!still || still.slot !== o.slot || still.step !== o.step || still.dueOn !== o.dueOn) return false;
    // The receivers chosen a moment ago, still ACTIVE now (the security
    // review's low: one suspended in between is not mailed). Their codes and
    // scope are not re-resolved here; the inbox row they read names nothing
    // they can no longer see.
    const receivers = (
      await tx.member.findMany({
        where: { tenantId, id: { in: [...chosen] }, status: "ACTIVE" },
        select: { id: true },
        orderBy: { id: "asc" },
      })
    ).map((m) => m.id);
    if (receivers.length === 0) return false;

    const { count } = await tx.projectUpdateReminderSent.createMany({
      data: [{ tenantId, projectId: project.id, dueOn: dateColumn(o.slot), step: o.step }],
      skipDuplicates: true,
    });
    if (count === 0) return false; // already sent — a concurrent run got there first
    await emit(tx, tenantId, {
      kind: "project_update.due",
      entity: { type: "Project", id: project.id },
      clientId: project.clientId,
      projectId: project.id,
      memberIds: receivers,
      // The key for the link; the step and whether the update is late, for
      // the mail's wording (a later round's first reminder is late too — the
      // code review's low) — no name.
      params: { projectKey: project.key, step: String(o.step), late: o.slot !== o.dueOn || o.step > 0 ? "1" : "0" },
      dedupeKey: `project_update.due:${project.id}:${o.slot}:${o.step}`,
    });
    await record(tx, {
      action: "project_update.reminder_sent",
      targetType: "Project",
      targetId: project.id,
      metadata: { dueOn: o.dueOn, round: o.slot, step: o.step, receivers: receivers.length },
    });
    return true;
  });
}

export type UpdateReminderRun = {
  /** Reminders sent (one per project per step, however many receivers). */
  readonly sent: number;
  /** Owed reminders nobody could hear (no lead or project member who can publish). */
  readonly unheard: number;
};

/**
 * The per-tenant body of the job. Idempotent: run it as often as you like —
 * each reminder goes once (its dedupe row) and only on its own day.
 *
 * `beforeSend` is a TEST SEAM and nothing else: the dbtest changes the world
 * between the plan and a send (a post published, a receiver suspended, the
 * day changed) to prove the send's re-check. The job never passes it.
 */
export async function sendUpdateReminders(
  tenantId: string,
  now: Date = new Date(),
  opts: { readonly beforeSend?: (projectId: string) => Promise<void> } = {},
): Promise<UpdateReminderRun> {
  const p = await withTenant(tenantId, SYSTEM, (tx) => plan(tx, tenantId, now));
  const who = whoResolver(tenantId);
  let sent = 0;
  let unheard = 0;
  for (const o of p.owed) {
    const receivers = await receiversOf(o, p, who);
    if (receivers.length === 0) {
      unheard += 1;
      continue;
    }
    if (opts.beforeSend) await opts.beforeSend(o.project.id);
    if (await send(tenantId, o, p.timeZone, receivers, now)) sent += 1;
  }
  return { sent, unheard };
}

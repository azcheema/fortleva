import { record } from "@/audit/record";
import { resolveScope, type MemberActor } from "@/authz/authorize";
import { withTenant, type TenantDb } from "@/db";
import { accessibleCodes, moduleOpenUnderSystem } from "@/entitlements/resolver";
import { DomainError } from "@/lib/domain-error";
import { emit } from "@/notify/emit";

import { guarded } from "./db-errors";
import { UPDATE_SCHEDULE_LATE_MS, readUpdateBody } from "./update-body";
import {
  freezePublish,
  linesOfPost,
  preparePublish,
  privateNamesIn,
  projectSelect,
  type UpdateVisibility,
} from "./updates";

/**
 * SCHEDULED PROGRESS UPDATES GO OUT (slice 135; founder decision C112 —
 * design docs/research/2026-10-18-slice-135-scheduled-updates-design.md §4).
 * Run by the hourly job (`src/jobs/scheduled-updates.ts`) for one workspace:
 * every DRAFT whose hour has come is published as the member who scheduled
 * it, to the audience they chose, with the numbers counted NOW (C112 (b)) —
 * the same `preparePublish` / `freezePublish` pair the member's Publish runs.
 *
 * AS THE SCHEDULER, NOT AS THE JOB'S FAVOUR. The job writes under the
 * workspace's SYSTEM principal (no job runs as a member), so what the post
 * may hold is resolved AS the scheduler inside it — the update reminders'
 * precedent: still ACTIVE, still holding `project_update:publish` on all four
 * gates, the project still in their scope; and the figures their codes let
 * them freeze, never cost (`rate:view_cost` is ✦ and needs a fresh factor no
 * job has). Checked in the reading transaction AND again in the writing one.
 *
 * A REFUSAL IS FINAL FOR THAT SCHEDULE: it is cleared (the draft stays, now
 * editable), audited `project_update.schedule_failed` as SYSTEM with its
 * reason, and the scheduler — while active — is told in the inbox (C112 (d)):
 *   - `not_allowed`   — not active, the verb gone, or the project out of
 *                       scope;
 *   - `archived`      — the project is archived;
 *   - `empty`         — nothing to publish (the lock makes this a belt);
 *   - `private_named` — a post for the CLIENT that names, as a whole line,
 *                       work that is now private: the dialog's warning
 *                       (`privateWorkNamed`, slice 102) asked again at the
 *                       moment it would go out, since nobody is there to
 *                       heed it (the security review);
 *   - `late`          — more than `UPDATE_SCHEDULE_LATE_MS` past its hour: a
 *                       run that did not happen for a day must not send last
 *                       week's post today.
 * A workspace whose work module is CLOSED is skipped, not refused: its posts
 * wait (the repeating tasks' precedent) — and are refused as late once a day
 * has passed. Anything else — an error — leaves the schedule for the next run. A post
 * unscheduled, moved or published in between is a zero-row write by the
 * compare-and-set (`updated_at` + `scheduled_for` + DRAFT), so two runs
 * racing on one post publish it once.
 */

const SYSTEM = { type: "system" } as const;

/** The scheduler's codes, resolved AS THEM: the verb, and the figures a scheduled post may freeze — never cost. */
const SCHEDULER_CODES = ["project_update:publish", "time:view_team", "budget:view", "rate:view_bill"] as const;

/** At most this many posts a workspace a run, oldest hour first; the rest go next run. */
const PER_RUN_MAX = 50;

export type ScheduleRefusal = "not_allowed" | "archived" | "empty" | "private_named" | "late";

type Due = {
  readonly id: string;
  readonly projectId: string;
  readonly clientId: string;
  readonly updatedAt: Date;
  readonly scheduledFor: Date;
  readonly scheduledBy: string;
  readonly visibility: UpdateVisibility;
};

export type ScheduledRun = {
  considered: number;
  published: number;
  refused: number;
  failed: number;
  outOfTime: boolean;
};

export async function publishScheduledUpdates(
  tenantId: string,
  now: Date = new Date(),
  opts: { readonly deadline?: number } = {},
): Promise<ScheduledRun> {
  const due = await withTenant(tenantId, SYSTEM, async (tx) => {
    // A closed work module: nothing is refused, everything waits (the code
    // review's L4 — refusing would clear every schedule in the workspace).
    if (!(await moduleOpenUnderSystem(tx, tenantId, "work"))) return [];
    return tx.projectUpdate.findMany({
      where: { tenantId, status: "DRAFT", scheduledFor: { lte: now } },
      select: { id: true },
      orderBy: [{ scheduledFor: "asc" }, { id: "asc" }],
      take: PER_RUN_MAX,
    });
  });
  const out: ScheduledRun = { considered: 0, published: 0, refused: 0, failed: 0, outOfTime: false };
  for (const { id } of due) {
    if (opts.deadline !== undefined && Date.now() >= opts.deadline) {
      out.outOfTime = true; // the rest go next run
      break;
    }
    out.considered += 1;
    try {
      const r = await publishOne(tenantId, id, now);
      if (r === "published") out.published += 1;
      else if (r === "refused") out.refused += 1;
    } catch (e) {
      out.failed += 1;
      const code = typeof e === "object" && e !== null && "code" in e ? ` (${String((e as { code: unknown }).code)})` : "";
      console.error(`scheduled-updates: update ${id} failed: ${e instanceof Error ? e.name : typeof e}${code}`);
    }
  }
  return out;
}

/**
 * The scheduler's figure codes while they may STILL publish this project's
 * posts — active, the verb on all four gates, the project in their scope —
 * else null. Resolved AS THEM, in sequence (AGENTS.md: a per-code check is
 * never a leg).
 */
async function asScheduler(
  tx: TenantDb,
  tenantId: string,
  memberId: string,
  projectId: string,
): Promise<ReadonlySet<string> | null> {
  // ACTIVE is the whole test: a person taken off the workspace is SUSPENDED.
  // `user.banned` is a dead column — the admin plugin that writes it is not
  // mounted, and nothing reads it (src/auth/index.ts), so nobody is banned.
  const member = await tx.member.findFirst({ where: { tenantId, id: memberId, status: "ACTIVE" }, select: { id: true } });
  if (!member) return null;
  const actor: MemberActor = { memberId };
  const held = await accessibleCodes(tx, tenantId, actor, [...SCHEDULER_CODES]);
  if (!held.has("project_update:publish")) return null;
  const scope = await resolveScope(tx, actor);
  if (!scope.all && !scope.projectIds.includes(projectId)) return null;
  return held;
}

async function publishOne(tenantId: string, id: string, now: Date): Promise<"published" | "refused" | "skipped"> {
  // ── 1. Still due? And what may it freeze, as the scheduler? ────────
  const step = await withTenant(tenantId, SYSTEM, async (tx) => {
    const row = await tx.projectUpdate.findFirst({
      where: { tenantId, id, status: "DRAFT", scheduledFor: { lte: now } },
      select: {
        id: true,
        projectId: true,
        clientId: true,
        updatedAt: true,
        scheduledFor: true,
        scheduledByMemberId: true,
        scheduledVisibility: true,
      },
    });
    if (!row?.scheduledFor || !row.scheduledByMemberId || !row.scheduledVisibility) return null;
    const due: Due = {
      id: row.id,
      projectId: row.projectId,
      clientId: row.clientId,
      updatedAt: row.updatedAt,
      scheduledFor: row.scheduledFor,
      scheduledBy: row.scheduledByMemberId,
      visibility: row.scheduledVisibility,
    };
    const refuse = (reason: ScheduleRefusal) => ({ kind: "refuse" as const, due, reason });
    if (now.getTime() - due.scheduledFor.getTime() > UPDATE_SCHEDULE_LATE_MS) return refuse("late");
    const project = await tx.project.findFirst({ where: { tenantId, id: due.projectId }, select: projectSelect });
    if (!project) return null;
    if (project.archivedAt) return refuse("archived");
    const held = await asScheduler(tx, tenantId, due.scheduledBy, project.id);
    if (!held) return refuse("not_allowed");
    if (due.visibility === "CLIENT_VISIBLE") {
      const post = await tx.projectUpdate.findFirstOrThrow({
        where: { tenantId, id: due.id },
        select: { title: true, body: true },
      });
      const named = await privateNamesIn(tx, tenantId, project.id, linesOfPost(post.title, readUpdateBody(post.body)));
      if (named.length > 0) return refuse("private_named");
    }
    try {
      return { kind: "ready" as const, due, prep: await preparePublish(tx, tenantId, row, project, held) };
    } catch (e) {
      if (e instanceof DomainError && e.code === "UPDATE_EMPTY") return refuse("empty");
      throw e;
    }
  });
  if (step === null) return "skipped";
  if (step.kind === "refuse") return (await refuseSchedule(tenantId, step.due, step.reason)) ? "refused" : "skipped";

  // ── 2. Freeze, as SYSTEM, in the scheduler's name ──────────────────
  const { due, prep } = step;
  let outcome: "published" | "not_allowed";
  try {
    outcome = await withTenant(tenantId, SYSTEM, async (tx) =>
      guarded(async () => {
        // Once more where it writes: a scheduler removed in the seconds
        // since publishes nothing.
        if (!(await asScheduler(tx, tenantId, due.scheduledBy, due.projectId))) return "not_allowed" as const;
        await freezePublish(tx, tenantId, due.id, prep, null, {
          visibility: due.visibility,
          publisherMemberId: due.scheduledBy,
          scheduledFor: due.scheduledFor,
        });
        return "published" as const;
      }),
    );
  } catch (e) {
    // Unscheduled, moved or published in between — not this run's any more.
    if (e instanceof DomainError && e.code === "UPDATE_CHANGED") return "skipped";
    throw e;
  }
  if (outcome === "not_allowed") return (await refuseSchedule(tenantId, due, "not_allowed")) ? "refused" : "skipped";
  return "published";
}

/** Clear a refused schedule, record why, tell its scheduler (C112 (d)). False when it was no longer this schedule. */
async function refuseSchedule(tenantId: string, due: Due, reason: ScheduleRefusal): Promise<boolean> {
  return withTenant(tenantId, SYSTEM, async (tx) => {
    const cleared = await tx.projectUpdate.updateMany({
      where: { tenantId, id: due.id, status: "DRAFT", scheduledFor: due.scheduledFor, updatedAt: due.updatedAt },
      data: { scheduledFor: null, scheduledByMemberId: null, scheduledVisibility: null },
    });
    if (cleared.count !== 1) return false;
    await record(tx, {
      action: "project_update.schedule_failed",
      targetType: "ProjectUpdate",
      targetId: due.id,
      metadata: {
        projectId: due.projectId,
        reason,
        scheduledFor: due.scheduledFor.toISOString(),
        scheduledBy: due.scheduledBy,
      },
    });
    const active = await tx.member.findFirst({
      where: { tenantId, id: due.scheduledBy, status: "ACTIVE" },
      select: { id: true },
    });
    if (active) {
      await emit(tx, tenantId, {
        kind: "project_update.schedule_failed",
        // The PROJECT, as the update reminders' rows: named under the
        // reader's own `project:view` and scope, linked to its Updates tab
        // under `project_update:view` (src/notify/inbox.ts).
        entity: { type: "Project", id: due.projectId },
        clientId: due.clientId,
        projectId: due.projectId,
        receivers: new Map([[due.scheduledBy, "REQUESTER"]]),
        params: { reason },
        dedupeKey: `project_update.schedule_failed:${due.id}:${due.scheduledFor.toISOString()}`,
      });
    }
    return true;
  });
}

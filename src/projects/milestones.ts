import { record } from "@/audit/record";
import { assertInScope, type MemberActor } from "@/authz/authorize";
import { deny } from "@/authz/errors";
import { clean } from "@/clients/service";
import { withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import type { MilestoneStatus, Visibility } from "@/generated/prisma/enums";
import { fail, isDeadlock, isUniqueViolation } from "@/lib/domain-error";
import { newId } from "@/lib/ids";
import { rankBetween } from "@/lib/rank";

import type { ProjectCtx } from "./service";

/**
 * Milestones — the agency "phase" unit (DATA_MODEL.md §6.5). Ordered by
 * `rank` (fractional-indexing, text COLLATE "C", unique per project);
 * the client never sends a rank — only a neighbour (UI.md §7.1). All
 * writes: project:manage_versions, scope-checked on the project,
 * audited milestone.*; visibility defaults INTERNAL and rides the
 * portal_enabled fan-out (trigger).
 */

const principalOf = (ctx: ProjectCtx) =>
  ({ type: "member", id: ctx.actor.memberId }) as const;

const PERMISSION = "project:manage_versions";

async function loadMilestone(tx: TenantDb, actor: MemberActor, milestoneId: string) {
  const m = await tx.milestone.findFirst({ where: { id: milestoneId } });
  if (!m) deny("NOT_FOUND");
  await assertInScope(tx, actor, { projectId: m!.projectId });
  return m!;
}

/**
 * THE PROJECT'S MILESTONE QUEUE, and then its ranks in rank order.
 *
 * WHAT WENT WRONG (CI run 35440299558, the dbtest that races four
 * reorders — a test whose name says they "serialise on the neighbour
 * lock", which is exactly what they were not doing). This was a single
 * `SELECT id, rank … ORDER BY rank FOR UPDATE`, and a statement locks
 * rows in the order it sorts them: `rank` is the column a reorder
 * UPDATES, so two concurrent movers could sort the same rows
 * differently, take the same locks in the opposite order and deadlock.
 * Postgres detected the cycle and aborted one of them. Nothing about it
 * was new and nothing about it was the harness — two members dragging
 * milestones in the same project at the same moment would have met it.
 *
 * THE FIX IS THE ONE THIS CODEBASE ALREADY SETTLED ON FOR WORK ITEMS
 * (`modules/work/rank-lock.ts`, ARC-17): an advisory TRANSACTION lock
 * that every writer of a rank takes before its first row lock, so no
 * two of them ever hold rows at once. Milestones never had one — they
 * relied on the row locks alone, which the work-item header says in as
 * many words is not enough: under READ COMMITTED a row lock does not
 * refresh the statement snapshot, so two "bottom" writers can mint the
 * same key. That is the collision `retryOnRankCollision` was papering
 * over. A SEPARATE key namespace from the work-item queue, deliberately:
 * sharing it would make a task move block a milestone reorder for no
 * reason.
 *
 * It lives HERE rather than at the two call sites because both of them
 * — create and reorder — need it before their first row lock, and a
 * queue lock a caller can forget is a queue lock that will be forgotten.
 * `loadMilestone` above reads unlocked, so the order holds.
 *
 * The read keeps two more properties, both free now that it is a CTE.
 * The LOCK is ordered by `id`, which cannot be updated, so even a writer
 * outside this queue takes these rows in the same order; and the join
 * returns exactly the rows the CTE locked, where a second, unlocked
 * SELECT would take its own READ COMMITTED snapshot and could hand back
 * a milestone inserted in between — a phantom in the neighbour
 * arithmetic.
 *
 * Runs under RLS — the tenant filter is the policy's, the project
 * filter ours.
 */
async function lockedRanks(
  tx: TenantDb,
  projectId: string,
): Promise<{ id: string; rank: string }[]> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`milestone_rank:${projectId}`}))`;
  return tx.$queryRaw<{ id: string; rank: string }[]>`
    WITH locked AS (
      SELECT id FROM milestone WHERE project_id = ${projectId} ORDER BY id FOR UPDATE
    )
    SELECT m.id, m.rank FROM milestone m JOIN locked l ON l.id = m.id ORDER BY m.rank`;
}

const RANK_RETRIES = 3;

/**
 * A unique collision on (tenantId, projectId, rank) aborts the Postgres
 * transaction, so the retry wraps the WHOLE unit of work: re-open, re-lock,
 * re-read neighbours, recompute. Small jitter so two writers desynchronise.
 *
 * A DEADLOCK IS RETRIED TOO, and for the same reason the collision is:
 * Postgres has already aborted this transaction and undone its work, so
 * there is no state to repair and nothing a member could be told that
 * would help. `lockedRanks` above removes the cycle these two writers
 * used to make between themselves; this catches one made through any
 * other table they both touch. Before CI run 35440299558 the predicate
 * was P2002 alone and a deadlock was rethrown as a 500.
 */
async function retryOnRankCollision<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const retryable = isUniqueViolation(e) || isDeadlock(e);
      if (!retryable || attempt + 1 >= RANK_RETRIES) throw e;
      await new Promise((r) => setTimeout(r, 5 + Math.random() * 20));
    }
  }
}

export type MilestoneInput = {
  projectId: string;
  name: string;
  description?: string | null;
  dueAt?: Date | null;
  visibility?: Visibility;
};

/** Appends at the bottom of the project's timeline. */
export async function createMilestone(
  ctx: ProjectCtx,
  input: MilestoneInput,
): Promise<{ id: string }> {
  const name = clean(input.name);
  if (!name) fail("NAME_REQUIRED");
  const id = newId();
  await retryOnRankCollision(() => withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, PERMISSION);
    await assertInScope(tx, ctx.actor, { projectId: input.projectId });
    const project = await tx.project.findFirst({
      where: { id: input.projectId },
      select: { clientId: true, status: true },
    });
    if (!project) deny("NOT_FOUND");
    if (project!.status === "ARCHIVED") fail("ARCHIVED");
    const ranks = await lockedRanks(tx, input.projectId);
    const rank = rankBetween(ranks.at(-1)?.rank ?? null, null);
    await tx.milestone.create({
      data: {
        id,
        tenantId: ctx.tenantId,
        clientId: project!.clientId,
        projectId: input.projectId,
        name: name!,
        description: clean(input.description),
        dueAt: input.dueAt ?? null,
        visibility: input.visibility ?? "INTERNAL",
        rank,
      },
    });
    await record(tx, {
      action: "milestone.created",
      targetType: "Milestone",
      targetId: id,
      metadata: { projectId: input.projectId, visibility: input.visibility ?? "INTERNAL" },
    });
  }));
  return { id };
}

export type MilestonePatch = Partial<{
  name: string;
  description: string | null;
  dueAt: Date | null;
  visibility: Visibility;
}>;

export async function updateMilestone(
  ctx: ProjectCtx,
  milestoneId: string,
  patch: MilestonePatch,
): Promise<{ changed: string[] }> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, PERMISSION);
    const m = await loadMilestone(tx, ctx.actor, milestoneId);
    const data: Record<string, unknown> = {};
    const changed: string[] = [];
    if ("name" in patch) {
      const name = clean(patch.name);
      if (!name) fail("NAME_REQUIRED");
      if (name !== m.name) {
        data.name = name;
        changed.push("name");
      }
    }
    if ("description" in patch && clean(patch.description) !== m.description) {
      data.description = clean(patch.description);
      changed.push("description");
    }
    if ("dueAt" in patch) {
      const v = patch.dueAt ?? null;
      const same = (v === null && m.dueAt === null) || (!!v && !!m.dueAt && v.getTime() === m.dueAt.getTime());
      if (!same) {
        data.dueAt = v;
        changed.push("dueAt");
      }
    }
    if (patch.visibility && patch.visibility !== m.visibility) {
      data.visibility = patch.visibility;
      changed.push("visibility");
    }
    if (changed.length === 0) return { changed };
    await tx.milestone.update({ where: { id: milestoneId }, data });
    await record(tx, {
      action: "milestone.updated",
      targetType: "Milestone",
      targetId: milestoneId,
      metadata: {
        projectId: m.projectId,
        fields: changed,
        ...(changed.includes("visibility") ? { from: m.visibility, to: patch.visibility } : {}),
      },
    });
    return { changed };
  });
}

/** DONE stamps completedAt and audits milestone.completed; anything else milestone.updated. */
export async function setMilestoneStatus(
  ctx: ProjectCtx,
  milestoneId: string,
  status: MilestoneStatus,
): Promise<{ changed: boolean }> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, PERMISSION);
    const m = await loadMilestone(tx, ctx.actor, milestoneId);
    if (m.status === status) return { changed: false };
    await tx.milestone.update({
      where: { id: milestoneId },
      data: { status, completedAt: status === "DONE" ? new Date() : null },
    });
    await record(tx, {
      action: status === "DONE" ? "milestone.completed" : "milestone.updated",
      targetType: "Milestone",
      targetId: milestoneId,
      metadata: { projectId: m.projectId, from: m.status, to: status },
    });
    return { changed: true };
  });
}

export const completeMilestone = (ctx: ProjectCtx, milestoneId: string) =>
  setMilestoneStatus(ctx, milestoneId, "DONE");
export const cancelMilestone = (ctx: ProjectCtx, milestoneId: string) =>
  setMilestoneStatus(ctx, milestoneId, "CANCELLED");

export type ReorderTarget =
  | { position: "top" }
  | { position: "bottom" }
  | { afterId: string }
  | { beforeId: string };

/**
 * Move a milestone within its project. Neighbours are read under FOR
 * UPDATE, the rank computed between them, and a unique collision (a
 * concurrent writer landed on the same key) retried against the
 * refreshed neighbours. The caller never sees or sends a rank.
 */
export async function reorderMilestone(
  ctx: ProjectCtx,
  milestoneId: string,
  target: ReorderTarget,
): Promise<{ changed: boolean }> {
  return retryOnRankCollision(() => withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, PERMISSION);
    const m = await loadMilestone(tx, ctx.actor, milestoneId);
    // `loadMilestone` read UNLOCKED and before the queue lock, so by the
    // time this transaction owns the ranks its copy of `m.rank` may name
    // a position this milestone has already left — another mover can
    // have run to completion during the wait. Take the rank from the
    // LOCKED read instead, which is the only one nothing can change
    // underneath us, and which `rank-lock.ts` already states as the rule
    // ("THE ONE ORDER": re-read after every wait). Before this the no-op
    // test below compared the stale value and could answer `changed:
    // false` to a move that had not happened, dropping it silently and
    // snapping the row back on the next read (review). The fallback is
    // unreachable — the row was just found and no path deletes a
    // milestone — and is there so a future one cannot crash here.
    const locked = await lockedRanks(tx, m.projectId);
    const currentRank = locked.find((r) => r.id === milestoneId)?.rank ?? m.rank;
    const ranks = locked.filter((r) => r.id !== milestoneId);
    let before: string | null;
    let after: string | null;
    if ("position" in target) {
      if (target.position === "top") {
        before = null;
        after = ranks[0]?.rank ?? null;
      } else {
        before = ranks.at(-1)?.rank ?? null;
        after = null;
      }
    } else {
      const anchorId = "afterId" in target ? target.afterId : target.beforeId;
      const i = ranks.findIndex((r) => r.id === anchorId);
      if (i < 0) fail("INVALID_INPUT", "anchor milestone not in this project");
      if ("afterId" in target) {
        before = ranks[i]!.rank;
        after = ranks[i + 1]?.rank ?? null;
      } else {
        before = ranks[i - 1]?.rank ?? null;
        after = ranks[i]!.rank;
      }
    }
    // Already between the same neighbours — nothing to write.
    if ((before === null || before < currentRank) && (after === null || currentRank < after)) {
      return { changed: false };
    }
    const rank = rankBetween(before, after);
    await tx.milestone.update({ where: { id: milestoneId }, data: { rank } });
    await record(tx, {
      action: "milestone.updated",
      targetType: "Milestone",
      targetId: milestoneId,
      metadata: { projectId: m.projectId, fields: ["rank"] },
    });
    return { changed: true };
  }));
}

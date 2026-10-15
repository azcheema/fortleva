import { randomUUID } from "node:crypto";

import { record, recordMany } from "@/audit/record";
import { assertInScope } from "@/authz/authorize";
import { deny } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { fail } from "@/lib/domain-error";
import type { StateSeedKey } from "@/lib/enum-map";
import { rankBetween } from "@/lib/rank";
import {
  MAX_STAGE_REMOVE_TASKS,
  canAddStage,
  checkStageName,
  defaultHeir,
  defaultRefusal,
  insertIndex,
  moveIndex,
  removalRefusal,
  removalTargets,
  setIsValid,
  type StageCategory,
  type StageKind,
} from "@/lib/stage-rules";

import { writeActivityMany } from "./activity";
import { guarded } from "./db-errors";
import { lockProjectRanks, lockProjectStages } from "./rank-lock";
import {
  PRESET_NAME,
  builtInPreset,
  namesDistinctToDb,
  parsePreset,
  readWorkspaceStages,
  type PresetStage,
} from "./stage-preset";
import { ensureProjectStates, principalOf, type WorkCtx } from "./states";

/**
 * THE STAGE EDITORS (slice 123, founder decision C99 (a) — design doc
 * §3–§6): the workspace's default set (Settings → Stages) and a project's
 * own (its Stages page). Both under `workflow:manage`, both audited
 * `workflow.changed` — a stage is the shape of everybody's board, and
 * nothing about changing it is routine. The audit carries kinds and ids,
 * NEVER a stage's name (the state-change rule: categories, never names).
 *
 * The rules are `@/lib/stage-rules`, shared with the pages so a menu never
 * offers what this file refuses; every write here re-checks them against
 * the rows as they are UNDER THE LOCK, never as the page saw them.
 */

export type StageChange = "renamed" | "added" | "moved" | "removed" | "default" | "approval" | "restored";

// ── The workspace default ───────────────────────────────────────────

/** What Settings → Stages draws. */
export type WorkspaceStages = { stages: PresetStage[]; custom: boolean };

export async function getWorkspaceStages(ctx: WorkCtx): Promise<WorkspaceStages> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "workflow:manage");
    return readWorkspaceStages(tx, ctx.tenantId);
  });
}

/**
 * Every workspace-default edit, in ONE statement that makes-or-locks the
 * row: `INSERT … ON CONFLICT DO UPDATE … RETURNING` inserts the built-in
 * set on the FIRST change, or locks the existing row — waiting out a
 * concurrent edit or Restore, then answering with the row as it is now. A
 * select after an insert-or-nothing could find the row deleted by a
 * Restore that committed in between, and threw (the code review's LOW).
 * Two members' edits therefore run one after the other on the list as the
 * other left it. A stored row that no longer parses is edited as the
 * built-in set (and so replaced by a valid one), never trusted.
 *
 * NO-OPS write and audit nothing (choosing the stage that already carries
 * the mark, an approval switch already in that position) — and a no-op
 * that made the row just now takes it away again, so the page does not
 * start saying "your own set" for a change that changed nothing.
 *
 * NAMES ARE CHECKED WITH THE DATABASE'S OWN FOLD before they are stored
 * (`namesDistinctToDb`): JavaScript's lower-casing and Postgres's
 * `lower()` disagree on a few letters (a final sigma, a dotted I), and a
 * pair only Postgres calls alike would pass here and then fail every new
 * project's first seed on `workflow_state_name_ci_key` (both reviews'
 * LOW). `readWorkspaceStages` checks the same way, so an old row like that
 * reads as the built-in set.
 */
async function editPreset(
  ctx: WorkCtx,
  change: StageChange,
  mutate: (list: PresetStage[]) => PresetStage[],
  meta: (current: PresetStage[]) => Record<string, string | boolean> = () => ({}),
): Promise<WorkspaceStages> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "workflow:manage");
      const [row] = await tx.$queryRaw<{ id: string; states: unknown; inserted: boolean }[]>`
        INSERT INTO workflow_preset (id, tenant_id, name, states, is_default, created_at, updated_at)
        VALUES (${randomUUID()}, ${ctx.tenantId}, ${PRESET_NAME}, ${JSON.stringify(builtInPreset())}::jsonb, true, now(), now())
        ON CONFLICT (tenant_id, name) DO UPDATE SET name = EXCLUDED.name
        RETURNING id, states, (xmax = 0) AS inserted`;
      if (!row) throw new Error("workflow_preset upsert returned no row");
      // As `readWorkspaceStages` reads it — the database's fold included — so
      // a stored set the page shows as the built-in one is edited as the
      // built-in one, never as a pair of alike names every edit would then
      // be refused for (the fix review's NIT).
      const parsed = parsePreset(row.states);
      const current = parsed && (await namesDistinctToDb(tx, parsed)) ? parsed : builtInPreset();
      const next = mutate(current);
      if (JSON.stringify(next) === JSON.stringify(current)) {
        if (row.inserted) await tx.workflowPreset.deleteMany({ where: { tenantId: ctx.tenantId, id: row.id } });
        // "Your own set" only for a stored row that reads as one — an invalid
        // one is kept but reads as the built-in set, as the page shows it.
        return { stages: current, custom: !row.inserted && current === parsed };
      }
      // The belt: an editor action that produced a set the rules refuse is
      // a bug in this file, never a state to store.
      if (!setIsValid(asLike(next))) fail("INVALID_INPUT", "stage set breaks the rules");
      if (!(await namesDistinctToDb(tx, next))) fail("STAGE_NAME_TAKEN");
      await tx.workflowPreset.update({ where: { id: row.id }, data: { states: next }, select: { id: true } });
      await record(tx, {
        action: "workflow.changed",
        targetType: "WorkflowPreset",
        targetId: row.id,
        // Which entry and what about it — never its name (the state-change
        // rule). The security review's NIT: "approval" alone did not say
        // which stage, or whether the gate went on or off.
        metadata: { scope: "workspace", change, ...meta(current) },
      });
      return { stages: next, custom: true };
    }),
  );
}

const asLike = (list: readonly PresetStage[]) => list.map((s) => ({ ...s, id: s.key }));

/** The checked name, or the refusal thrown — one shape for all four callers. */
const nameOrFail = (r: ReturnType<typeof checkStageName>): string => (r.ok ? r.name : fail(r.code));

function presetEntry(list: PresetStage[], key: string): PresetStage {
  return list.find((s) => s.key === key) ?? fail("INVALID_INPUT", "no such stage");
}

/** What a workspace audit row says about the entry it touched. */
const entryMeta = (list: PresetStage[], key: string): Record<string, string> => {
  const entry = list.find((s) => s.key === key);
  return entry ? { key, category: entry.category } : { key };
};

export function renameWorkspaceStage(ctx: WorkCtx, key: string, name: string): Promise<WorkspaceStages> {
  return editPreset(
    ctx,
    "renamed",
    (list) => {
      const self = presetEntry(list, key);
      const checked = nameOrFail(checkStageName(name, asLike(list), key));
      return list.map((s) => (s === self ? { ...s, name: checked } : s));
    },
    (current) => entryMeta(current, key),
  );
}

export function addWorkspaceStage(ctx: WorkCtx, input: { name: string; kind: StageKind }): Promise<WorkspaceStages> {
  const key = randomUUID();
  return editPreset(ctx, "added", (list) => {
    if (!canAddStage(asLike(list))) fail("STAGE_LIMIT");
    const checked = nameOrFail(checkStageName(input.name, asLike(list), null));
    const at = insertIndex(asLike(list), input.kind);
    const entry: PresetStage = {
      key,
      name: checked,
      seedKey: null,
      category: input.kind,
      isDefault: false,
      // The seeded Done's rule: a new Done stage is gated until a member
      // with workflow:manage says otherwise (design §3.5).
      requiresApproval: input.kind === "DONE",
    };
    return [...list.slice(0, at), entry, ...list.slice(at)];
  }, () => ({ key, category: input.kind }));
}

export function moveWorkspaceStage(ctx: WorkCtx, key: string, dir: "up" | "down"): Promise<WorkspaceStages> {
  return editPreset(ctx, "moved", (list) => {
    const self = presetEntry(list, key);
    const at = moveIndex(asLike(list), key, dir);
    if (at === null) fail("INVALID_INPUT", "already at the end of its kind");
    const rest = list.filter((s) => s !== self);
    return [...rest.slice(0, at!), self, ...rest.slice(at!)];
  }, (current) => ({ ...entryMeta(current, key), dir }));
}

export function removeWorkspaceStage(ctx: WorkCtx, key: string): Promise<WorkspaceStages> {
  return editPreset(ctx, "removed", (list) => {
    const self = presetEntry(list, key);
    // The workspace default holds no tasks, so the counts are zero; the
    // kind rules are the project's.
    const refusal = removalRefusal(asLike(list), key, 0);
    if (refusal) fail(refusal);
    const rest = list.filter((s) => s !== self);
    if (!self.isDefault) return rest;
    // The mark moves to the first other stage of its kind that may carry
    // it (`removalRefusal` refused a removal that left it nowhere).
    const heir = defaultHeir(asLike(list), key, null)!;
    return rest.map((s) => (s.key === heir.key ? { ...s, isDefault: true } : s));
  }, (current) => entryMeta(current, key));
}

export function setWorkspaceDefaultStage(ctx: WorkCtx, key: string): Promise<WorkspaceStages> {
  return editPreset(ctx, "default", (list) => {
    const self = presetEntry(list, key);
    const refusal = defaultRefusal(self);
    if (refusal) fail(refusal);
    return list.map((s) => ({ ...s, isDefault: s.key === key }));
  }, (current) => entryMeta(current, key));
}

export function setWorkspaceStageApproval(ctx: WorkCtx, key: string, on: boolean): Promise<WorkspaceStages> {
  return editPreset(ctx, "approval", (list) => {
    const self = presetEntry(list, key);
    // Where new tasks start is never gated (`canStartHere`).
    if (on && self.isDefault) fail("STAGE_DEFAULT_GATED");
    return list.map((s) => (s.key === key ? { ...s, requiresApproval: on } : s));
  }, (current) => ({ ...entryMeta(current, key), on }));
}

/** Back to Fortleva's built-in set: the row goes. Projects made afterwards get the original stages; no project changes. */
export async function restoreWorkspaceStages(ctx: WorkCtx): Promise<WorkspaceStages> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "workflow:manage");
    const row = await tx.workflowPreset.findFirst({
      where: { tenantId: ctx.tenantId, name: PRESET_NAME },
      select: { id: true },
    });
    // By id and counted, so a second Restore racing the first deletes
    // nothing and audits nothing rather than throwing.
    const gone = row ? await tx.workflowPreset.deleteMany({ where: { tenantId: ctx.tenantId, id: row.id } }) : null;
    if (row && gone && gone.count > 0) {
      await record(tx, {
        action: "workflow.changed",
        targetType: "WorkflowPreset",
        targetId: row.id,
        metadata: { scope: "workspace", change: "restored" },
      });
    }
    return { stages: builtInPreset(), custom: false };
  });
}

// ── A project's own ─────────────────────────────────────────────────

/** One row of a project's Stages page. `tasks` counts tasks on the board and in the archive — not the bin. */
export type ProjectStageRow = {
  id: string;
  name: string | null;
  seedKey: StateSeedKey | null;
  category: StageCategory;
  isDefault: boolean;
  requiresApproval: boolean;
  tasks: number;
};

const stateSelect = {
  id: true,
  name: true,
  seedKey: true,
  category: true,
  isDefault: true,
  requiresApproval: true,
  rank: true,
} as const;

type StateLine = { id: string; name: string | null; seedKey: StateSeedKey | null; category: StageCategory; isDefault: boolean; requiresApproval: boolean; rank: string };

async function readStates(tx: TenantDb, tenantId: string, projectId: string): Promise<StateLine[]> {
  return tx.workflowState.findMany({
    where: { tenantId, projectId },
    orderBy: { rank: "asc" },
    select: stateSelect,
  });
}

/**
 * A project's stages, TRIAGE left out, with their task counts — the
 * Stages page. Under `workflow:manage` and the project's scope (a
 * member who cannot reach the project is told it does not exist).
 */
export async function getProjectStages(
  ctx: WorkCtx,
  projectId: string,
): Promise<{ stages: ProjectStageRow[]; archived: boolean }> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "workflow:manage");
    await assertInScope(tx, ctx.actor, { projectId });
    const project = await tx.project.findFirst({
      where: { tenantId: ctx.tenantId, id: projectId },
      select: { status: true },
    });
    if (!project) deny("NOT_FOUND");
    await ensureProjectStates(tx, ctx.tenantId, projectId);
    const states = (await readStates(tx, ctx.tenantId, projectId)).filter((s) => s.category !== "TRIAGE");
    const counts = await tx.workItem.groupBy({
      by: ["stateId"],
      where: { tenantId: ctx.tenantId, projectId, deletedAt: null },
      _count: { _all: true },
    });
    const byState = new Map(counts.map((c) => [c.stateId, c._count._all]));
    return {
      stages: states.map((s) => ({
        id: s.id,
        name: s.name,
        seedKey: s.seedKey,
        category: s.category,
        isDefault: s.isDefault,
        requiresApproval: s.requiresApproval,
        tasks: byState.get(s.id) ?? 0,
      })),
      archived: project!.status === "ARCHIVED",
    };
  });
}

/**
 * Every project-stage edit's prologue, in THE ONE ORDER (design §6): the
 * gates, the scope, a live project, the lazy seed (which takes the stage
 * key itself only on a FIRST seed), then the project's stage key — the
 * editors' mutex — and the rows read again under it.
 */
async function editProject<T>(
  ctx: WorkCtx,
  projectId: string,
  body: (tx: TenantDb, states: StateLine[]) => Promise<T>,
  opts?: { timeoutMs?: number },
): Promise<T> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "workflow:manage");
      await assertInScope(tx, ctx.actor, { projectId });
      const project = await tx.project.findFirst({
        where: { tenantId: ctx.tenantId, id: projectId },
        select: { status: true },
      });
      if (!project) deny("NOT_FOUND");
      if (project!.status === "ARCHIVED") fail("ARCHIVED");
      await ensureProjectStates(tx, ctx.tenantId, projectId);
      await lockProjectStages(tx, projectId);
      return body(tx, await readStates(tx, ctx.tenantId, projectId));
    }),
    opts,
  );
}

function stateOf(states: StateLine[], stateId: string): StateLine {
  const s = states.find((x) => x.id === stateId);
  // TRIAGE is fixed: it is not addressable here at all, as absent as a
  // state of another project.
  if (!s || s.category === "TRIAGE") deny("NOT_FOUND");
  return s!;
}

async function auditProject(
  tx: TenantDb,
  projectId: string,
  state: { id: string; category: StageCategory },
  change: StageChange,
  extra?: Record<string, number | string>,
): Promise<void> {
  await record(tx, {
    action: "workflow.changed",
    targetType: "WorkflowState",
    targetId: state.id,
    metadata: { scope: "project", projectId, change, category: state.category, ...extra },
  });
}

export function renameProjectStage(ctx: WorkCtx, projectId: string, stateId: string, name: string): Promise<void> {
  return editProject(ctx, projectId, async (tx, states) => {
    const self = stateOf(states, stateId);
    const checked = nameOrFail(checkStageName(name, states, self.id));
    if (self.name === checked) return;
    await tx.workflowState.update({ where: { id: self.id }, data: { name: checked }, select: { id: true } });
    await auditProject(tx, projectId, self, "renamed");
  });
}

export function addProjectStage(
  ctx: WorkCtx,
  projectId: string,
  input: { name: string; kind: StageKind },
): Promise<{ id: string }> {
  return editProject(ctx, projectId, async (tx, states) => {
    if (!canAddStage(states)) fail("STAGE_LIMIT");
    const checked = nameOrFail(checkStageName(input.name, states, null));
    const at = insertIndex(states, input.kind);
    const rank = rankBetween(states[at - 1]?.rank ?? null, states[at]?.rank ?? null);
    const made = await tx.workflowState.create({
      data: {
        tenantId: ctx.tenantId,
        projectId,
        name: checked,
        seedKey: null,
        category: input.kind,
        rank,
        isDefault: false,
        isHidden: false,
        requiresApproval: input.kind === "DONE",
      },
      select: { id: true, category: true },
    });
    await auditProject(tx, projectId, made, "added");
    return { id: made.id };
  });
}

export function moveProjectStage(ctx: WorkCtx, projectId: string, stateId: string, dir: "up" | "down"): Promise<void> {
  return editProject(ctx, projectId, async (tx, states) => {
    const self = stateOf(states, stateId);
    const at = moveIndex(states, self.id, dir);
    if (at === null) fail("INVALID_INPUT", "already at the end of its kind");
    const rest = states.filter((s) => s.id !== self.id);
    const rank = rankBetween(rest[at! - 1]?.rank ?? null, rest[at!]?.rank ?? null);
    await tx.workflowState.update({ where: { id: self.id }, data: { rank }, select: { id: true } });
    await auditProject(tx, projectId, self, "moved");
  });
}

export function setProjectDefaultStage(ctx: WorkCtx, projectId: string, stateId: string): Promise<void> {
  return editProject(ctx, projectId, async (tx, states) => {
    const self = stateOf(states, stateId);
    if (self.isDefault) return;
    // Backlog or To do, and never gated (`canStartHere`): a new task is
    // put STRAIGHT into the default, past the state machine's approval
    // check (the security review's LOW; the database holds it too).
    const refusal = defaultRefusal(self);
    if (refusal) fail(refusal);
    // The old mark FIRST: the one-default index refuses two.
    await tx.workflowState.updateMany({
      where: { tenantId: ctx.tenantId, projectId, isDefault: true },
      data: { isDefault: false },
    });
    await tx.workflowState.update({ where: { id: self.id }, data: { isDefault: true }, select: { id: true } });
    await auditProject(tx, projectId, self, "default");
  });
}

export function setProjectStageApproval(ctx: WorkCtx, projectId: string, stateId: string, on: boolean): Promise<void> {
  return editProject(ctx, projectId, async (tx, states) => {
    const self = stateOf(states, stateId);
    if (self.requiresApproval === on) return;
    // Where new tasks start is never gated — choose another stage for new
    // tasks first (`canStartHere`; the database holds the pair too).
    if (on && self.isDefault) fail("STAGE_DEFAULT_GATED");
    await tx.workflowState.update({ where: { id: self.id }, data: { requiresApproval: on }, select: { id: true } });
    await auditProject(tx, projectId, self, "approval", { on: on ? "on" : "off" });
  });
}

/**
 * Removing a stage, its tasks moved into `targetId` — another stage of
 * the SAME kind (design §3.3). A same-kind move changes no category, so
 * nothing a client is shown, no started/completed stamp, no triage or
 * request rule; that is what lets it be one set UPDATE rather than the
 * state machine run once per task.
 *
 * EVERY task moved — the bin's too, which still point at the stage and
 * which the database refuses to orphan — gets an INTERNAL history row (a
 * within-category move — `forceInternal`, `transitionState`'s rule) and a
 * `work_item.state_changed` audit row in the transition's own shape, so
 * "state is never routine" holds per task and a task brought back from
 * the bin keeps its trail (the security review's NIT).
 *
 * LOCKS, after the stage key: THE RANK QUEUE, because this writes many of
 * the project's task rows and every such writer queues first
 * (rank-lock.ts) — without it a subtask create holding its parent (in
 * this stage) and inserting into this stage as the default, while this
 * UPDATE waited on that parent, was a cycle. Then the removed stage's row
 * `FOR UPDATE`, so no task can ENTER it from here on: a single-task move
 * into it waits, then finds it gone and is told so (`STAGE_GONE`). Then a
 * COUNT, so the bound is checked before a single task row is read. Then
 * the stage's tasks themselves, `FOR NO KEY UPDATE`: a read that waits
 * for a writer holding one and re-checks it, so the set narrated is
 * exactly the set moved — a plain read before the wait narrated a task a
 * colleague had just moved elsewhere (the code review's MEDIUM;
 * `changeState`'s own lesson). No new cycle: a mover INTO the stage holds
 * a row this read does not match, and a mover OUT holds only its own row
 * and waits on nothing this transaction holds. The target is never
 * locked beyond the UPDATE's own key-share — locking every stage was the
 * first idea, and it deadlocked against a bulk change holding a task and
 * waiting on its target's foreign key.
 *
 * A MINUTE'S BUDGET, as the bulk edits have: up to 2 000 rows moved, each
 * firing the state-sync and search-feed triggers, plus a history row and
 * an audit row each (the code review's MEDIUM — the default five seconds
 * was never measured near the bound).
 */
export function removeProjectStage(
  ctx: WorkCtx,
  projectId: string,
  stateId: string,
  targetId: string | null,
): Promise<{ moved: number }> {
  return editProject(
    ctx,
    projectId,
    async (tx, states) => {
      const self = stateOf(states, stateId);
      await lockProjectRanks(tx, projectId);
      await tx.$queryRaw`SELECT 1 FROM workflow_state WHERE tenant_id = ${ctx.tenantId} AND id = ${self.id} FOR UPDATE`;
      const total = await tx.workItem.count({ where: { tenantId: ctx.tenantId, projectId, stateId: self.id } });
      if (total > MAX_STAGE_REMOVE_TASKS) fail("STAGE_TOO_FULL");
      const inStage = await tx.$queryRaw<
        {
          id: string;
          client_id: string;
          project_id: string;
          visibility: "INTERNAL" | "CLIENT_VISIBLE";
          deleted_at: Date | null;
          state_category: string;
        }[]
      >`
        SELECT id, client_id, project_id, visibility::text AS visibility, deleted_at, state_category::text AS state_category
        FROM work_item
        WHERE tenant_id = ${ctx.tenantId} AND project_id = ${projectId} AND state_id = ${self.id}
        ORDER BY id
        FOR NO KEY UPDATE`;
      const binned = inStage.filter((i) => i.deleted_at !== null).length;
      const refusal = removalRefusal(states, self.id, inStage.length, binned);
      if (refusal) fail(refusal);
      // The member's pick, which must be another stage of the same kind —
      // required when anything is moved (the bin's tasks count: they point
      // at the stage too, though the page's count leaves them out, which is
      // why the page always sends a pick when one exists).
      const target = removalTargets(states, self.id).find((s) => s.id === targetId) ?? null;
      if (inStage.length > 0 && !target) fail("INVALID_INPUT", "target must be another stage of the same kind");
      // Where the mark goes when this was the default: with the tasks when
      // their stage may carry it, else the first other stage of the kind
      // that may (`defaultHeir` — never a gated one; `removalRefusal`
      // refused a default with nowhere to go).
      const heir = self.isDefault ? defaultHeir(states, self.id, target?.id ?? null) : null;
      if (self.isDefault && !heir) fail("STAGE_IS_DEFAULT");

      if (inStage.length > 0) {
        const ids = inStage.map((i) => i.id);
        await tx.workItem.updateMany({
          where: { tenantId: ctx.tenantId, projectId, id: { in: ids }, stateId: self.id },
          data: { stateId: target!.id },
        });
        const items = inStage.map((i) => ({
          id: i.id,
          clientId: i.client_id,
          projectId: i.project_id,
          visibility: i.visibility,
          stateCategory: i.state_category,
        }));
        await writeActivityMany(
          tx,
          ctx,
          items.map((item) => ({
            item,
            change: {
              field: "stateCategory",
              oldValue: item.stateCategory,
              newValue: item.stateCategory,
              oldRef: self.id,
              newRef: target!.id,
              forceInternal: true,
            },
          })),
        );
        await recordMany(
          tx,
          items.map((item) => ({
            action: "work_item.state_changed" as const,
            targetType: "WorkItem",
            targetId: item.id,
            metadata: { from: item.stateCategory, to: item.stateCategory, projectId },
          })),
        );
      }
      // The mark moves (same kind, so still Backlog or To do, and never to
      // a gated stage — the database's two CHECKs agree). Clearing it on
      // the removed row first keeps the one-default index satisfied.
      if (heir) {
        await tx.workflowState.update({ where: { id: self.id }, data: { isDefault: false }, select: { id: true } });
        await tx.workflowState.update({ where: { id: heir.id }, data: { isDefault: true }, select: { id: true } });
      }
      await tx.workflowState.delete({ where: { id: self.id }, select: { id: true } });
      await auditProject(tx, projectId, self, "removed", {
        movedTasks: inStage.length,
        binnedTasks: binned,
        ...(inStage.length > 0 && target ? { into: target.id } : {}),
        ...(heir ? { defaultTo: heir.id } : {}),
      });
      // What the page told the member: tasks on the board and in the
      // archive, not the bin.
      return { moved: inStage.length - binned };
    },
    { timeoutMs: 60_000 },
  );
}

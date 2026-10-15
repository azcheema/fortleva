import { record, recordMany, type AuditInput } from "@/audit/record";
import { assertInScope, isAuthorized, scopeWhere } from "@/authz/authorize";
import { deny } from "@/authz/errors";
import { lockCounter, nextCounters, withTenant, type TenantDb } from "@/db";
import { hasAccess, requireAccess } from "@/entitlements/resolver";
import { DomainError, fail } from "@/lib/domain-error";
import { todayIn } from "@/lib/due-date";
import { localDateColumn } from "@/lib/duration";
import { newId } from "@/lib/ids";
import { isLabelColor } from "@/lib/label-colors";
import { ranksBetween } from "@/lib/rank";
import { retryOnDeadlock } from "@/lib/retry";
import { normalizeDescription, type NormalizedDescription } from "@/lib/rich-text/normalize";
import { singleLineName } from "@/lib/single-line-name";
import { TRIAGE_STAGE } from "@/lib/stage-rules";
import { templateName, type TemplateSaveSummary } from "@/lib/template-rules";
import { MAX_LABEL_NAME_LENGTH } from "@/lib/work-view";
import { readPreferences } from "@/preferences/service";
import { insertProject, type ProjectCreateInput } from "@/projects/service";

import { writeActivityMany } from "../activity";
import { guarded } from "../db-errors";
import { lockProjectRanks, lockProjectStages } from "../rank-lock";
import { namesDistinctToDb, type PresetStage } from "../stage-preset";
import { ensureProjectStates, principalOf, type WorkCtx } from "../states";
import {
  buildDefinition,
  dayAfter,
  definitionBytes,
  parseDefinition,
  takeTasks,
  TEMPLATE_MAX_BYTES,
  TEMPLATE_MAX_LABELS,
  TEMPLATE_MAX_MILESTONE_DESCRIPTION,
  TEMPLATE_MAX_MILESTONE_NAME,
  TEMPLATE_MAX_MILESTONES,
  TEMPLATE_MAX_TASKS,
  type ParsedTemplate,
  type SourceTask,
  type SourceTaskHead,
} from "./definition";

/**
 * PROJECT TEMPLATES (slice 124; founder decision C100;
 * docs/research/2026-10-16-slice-124-project-templates-design.md).
 *
 *   · "Save as template" on a project (`saveProjectAsTemplate`) and
 *     Settings → Templates (`listTemplates`, `renameTemplate`,
 *     `deleteTemplate`) — `project_template:manage` (owners, managers,
 *     admins). Saving is scoped to a project the member reaches.
 *   · New project from a template (`createProjectFromTemplate`) — the
 *     codes making each part by hand asks: `project:create` with the client
 *     directly in scope, `work_item:create` + `work_item:edit` (the import's
 *     pair: tasks are made AND given a stage, labels, an estimate and
 *     dates), `project:manage_versions` when it has milestones, and
 *     `label:manage` only to make a label again. No new permission code.
 *
 * Every gate is awaited in sequence, never a batch leg
 * (`authz-batches.test.ts`); every read inside a transaction too (the
 * `Promise.all` trap). Everything a template makes is born PRIVATE.
 */

const MANAGE = "project_template:manage";
const DESCRIPTION_CHUNK = 100;

const nameOf = (raw: string): string => {
  const checked = templateName(raw);
  if (!checked.ok) fail(checked.code, "template name");
  return (checked as { name: string }).name;
};

/**
 * The template the workspace calls by this name, whatever its case — by
 * Postgres's own `lower()`, the fold the unique index decides with (never
 * Prisma's insensitive `equals`, which compiles to an unescaped ILIKE where
 * `_` is a wildcard: the layouts' L1). `lock` takes it FOR UPDATE.
 */
async function templateNamed(
  tx: TenantDb,
  tenantId: string,
  name: string,
  opts: { exceptId?: string; lock?: boolean } = {},
): Promise<{ id: string; name: string } | null> {
  const rows = opts.lock
    ? await tx.$queryRaw<{ id: string; name: string }[]>`
        SELECT id, name FROM project_template
        WHERE tenant_id = ${tenantId} AND lower(name) = lower(${name}) AND id IS DISTINCT FROM ${opts.exceptId ?? null}
        LIMIT 1 FOR UPDATE`
    : await tx.$queryRaw<{ id: string; name: string }[]>`
        SELECT id, name FROM project_template
        WHERE tenant_id = ${tenantId} AND lower(name) = lower(${name}) AND id IS DISTINCT FROM ${opts.exceptId ?? null}
        LIMIT 1`;
  return rows[0] ?? null;
}

// ── Reading a project for a template ────────────────────────────────

type ProjectRead = {
  heads: SourceTaskHead[];
  taken: string[];
  milestones: { id: string; name: string; description: string | null; status: SourceTaskStatus; dueAt: Date | null }[];
  anchor: Date;
  anchorIsStart: boolean;
};
type SourceTaskStatus = "PLANNED" | "IN_PROGRESS" | "PAUSED" | "DONE" | "CANCELLED";

/** The gate, the project and what a template would take — no description read yet. */
async function readProject(tx: TenantDb, ctx: WorkCtx, projectId: string): Promise<ProjectRead> {
  await requireAccess(tx, ctx.tenantId, ctx.actor, MANAGE);
  // A template is the project's tasks, word for word: whoever saves one must
  // be able to read them (the security review's NIT — a custom role may hold
  // the manage code without the task view).
  await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:view");
  await assertInScope(tx, ctx.actor, { projectId });
  const project = await tx.project.findFirst({
    where: { tenantId: ctx.tenantId, id: projectId },
    select: { startDate: true, createdAt: true },
  });
  if (!project) deny("NOT_FOUND");
  // THE ANCHOR (design §4): the project's start; without one, the day it
  // was made in the workspace's zone — a date column's UTC midnight either way.
  let anchor: Date;
  let anchorIsStart = true;
  if (project!.startDate) {
    anchor = localDateColumn(project!.startDate, "UTC");
  } else {
    const prefs = await readPreferences(tx, ctx.tenantId);
    anchor = localDateColumn(project!.createdAt, prefs.timezone);
    anchorIsStart = false;
  }
  const milestones = await tx.milestone.findMany({
    where: { tenantId: ctx.tenantId, projectId },
    orderBy: { rank: "asc" },
    select: { id: true, name: true, description: true, status: true, dueAt: true },
  });
  const heads = await tx.workItem.findMany({
    where: { tenantId: ctx.tenantId, projectId },
    orderBy: { rank: "asc" },
    select: {
      id: true,
      parentId: true,
      depth: true,
      type: true,
      kind: true,
      stateCategory: true,
      archivedAt: true,
      deletedAt: true,
    },
  });
  return { heads, taken: takeTasks(heads), milestones, anchor, anchorIsStart };
}

export type { TemplateSaveSummary };

/** project_template:manage — what the Save dialog says before anything is written. */
export async function readTemplateSaveSummary(ctx: WorkCtx, projectId: string): Promise<TemplateSaveSummary> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    const read = await readProject(tx, ctx, projectId);
    const names = await tx.projectTemplate.findMany({
      where: { tenantId: ctx.tenantId },
      select: { name: true },
      orderBy: { name: "asc" },
    });
    const milestones = read.milestones.filter((m) => m.status !== "CANCELLED").length;
    return {
      tasks: read.taken.length,
      milestones,
      anchor: read.anchor.toISOString().slice(0, 10),
      anchorIsStart: read.anchorIsStart,
      names: names.map((n) => n.name),
      tooLarge: read.taken.length > TEMPLATE_MAX_TASKS || milestones > TEMPLATE_MAX_MILESTONES,
    };
  });
}

/**
 * project_template:manage — "Save as template" (design §4). The project's
 * stages, its milestones (not a cancelled one) and the tasks `takeTasks`
 * chooses, with their descriptions (checklists unticked), labels,
 * estimates, subtasks, starting stages and dates as days from the anchor.
 *
 * A name the workspace already uses (ignoring case) is refused unless
 * `replace` — then that template's document is overwritten, under its row
 * lock, and keeps its stored name.
 */
export async function saveProjectAsTemplate(
  ctx: WorkCtx,
  input: { projectId: string; name: string; replace: boolean },
): Promise<{ id: string; name: string; tasks: number; milestones: number; replaced: boolean }> {
  const name = nameOf(input.name);
  return withTenant(
    ctx.tenantId,
    principalOf(ctx),
    async (tx) =>
      guarded(async () => {
        const read = await readProject(tx, ctx, input.projectId);
        // The cheap refusals first, before a description is read.
        const liveMilestones = read.milestones.filter((m) => m.status !== "CANCELLED");
        if (
          read.taken.length > TEMPLATE_MAX_TASKS ||
          liveMilestones.length > TEMPLATE_MAX_MILESTONES ||
          liveMilestones.some(
            (m) => m.name.length > TEMPLATE_MAX_MILESTONE_NAME || (m.description?.length ?? 0) > TEMPLATE_MAX_MILESTONE_DESCRIPTION,
          )
        ) {
          fail("TEMPLATE_TOO_LARGE", "tasks or milestones");
        }
        // The stages, seeded first if the project was never opened (before
        // anything else is locked — THE ONE ORDER's first key).
        await ensureProjectStates(tx, ctx.tenantId, input.projectId);
        const stages = await tx.workflowState.findMany({
          where: { tenantId: ctx.tenantId, projectId: input.projectId },
          orderBy: { rank: "asc" },
          select: { id: true, name: true, seedKey: true, category: true, isDefault: true, requiresApproval: true },
        });
        // The descriptions' size, measured by Postgres BEFORE any is read:
        // a project of large documents is refused without moving them.
        const [size] = await tx.$queryRaw<{ bytes: bigint | null }[]>`
          SELECT sum(octet_length(description::text)) AS bytes FROM work_item
          WHERE tenant_id = ${ctx.tenantId} AND id = ANY(${read.taken}::text[])`;
        if (Number(size?.bytes ?? 0) > TEMPLATE_MAX_BYTES) fail("TEMPLATE_TOO_LARGE", "descriptions");
        const tasks = await readTakenTasks(tx, ctx.tenantId, read);
        const labelIds = [...new Set(tasks.flatMap((t) => t.labelIds))];
        const labels =
          labelIds.length === 0
            ? []
            : await tx.label.findMany({
                where: { tenantId: ctx.tenantId, id: { in: labelIds } },
                select: { id: true, name: true, color: true },
                orderBy: [{ name: "asc" }, { id: "asc" }],
              });
        const definition = buildDefinition({ stages, milestones: read.milestones, labels, tasks, anchor: read.anchor });
        if (!definition) fail("TEMPLATE_INVALID", "the project's stages");
        if (definition!.tasks.length === 0 && definition!.milestones.length === 0) fail("TEMPLATE_EMPTY");
        // Past what a template holds: refused with a sentence, never stored
        // unusable (both reviews' MEDIUM/LOW; the milestones were refused above).
        if (definition!.labels.length > TEMPLATE_MAX_LABELS || definitionBytes(definition!) > TEMPLATE_MAX_BYTES) {
          fail("TEMPLATE_TOO_LARGE", "document");
        }
        // …and the document must read back as the plan applying it will see:
        // one function decides what a template is, on both sides.
        if (!parseDefinition(definition)) fail("TEMPLATE_INVALID", "built document");
        const counts = { tasks: definition!.tasks.length, milestones: definition!.milestones.length };

        const existing = await templateNamed(tx, ctx.tenantId, name, { lock: true });
        if (existing && !input.replace) fail("TEMPLATE_NAME_TAKEN");
        if (existing) {
          await tx.projectTemplate.update({
            where: { id: existing.id },
            data: {
              definition: definition as object,
              taskCount: counts.tasks,
              milestoneCount: counts.milestones,
              savedAt: new Date(),
              sourceProjectId: input.projectId,
            },
            select: { id: true },
          });
          await record(tx, {
            action: "project_template.replaced",
            targetType: "ProjectTemplate",
            targetId: existing.id,
            metadata: { name: existing.name, projectId: input.projectId, ...counts },
          });
          return { id: existing.id, name: existing.name, ...counts, replaced: true };
        }
        const id = newId();
        await tx.projectTemplate.create({
          data: {
            id,
            tenantId: ctx.tenantId,
            name,
            definition: definition as object,
            taskCount: counts.tasks,
            milestoneCount: counts.milestones,
            sourceProjectId: input.projectId,
            createdByMemberId: ctx.actor.memberId,
          },
          select: { id: true },
        });
        await record(tx, {
          action: "project_template.created",
          targetType: "ProjectTemplate",
          targetId: id,
          metadata: { name, projectId: input.projectId, ...counts },
        });
        return { id, name, ...counts, replaced: false };
      }),
    { timeoutMs: 60_000 },
  );
}

/** The taken tasks' fields and labels, then their descriptions a chunk at a time — in rank order. */
async function readTakenTasks(tx: TenantDb, tenantId: string, read: ProjectRead): Promise<SourceTask[]> {
  if (read.taken.length === 0) return [];
  const rows = await tx.workItem.findMany({
    where: { tenantId, id: { in: read.taken } },
    select: {
      id: true,
      title: true,
      stateId: true,
      estimateMinutes: true,
      startDate: true,
      targetDate: true,
      milestoneId: true,
    },
  });
  const joins = await tx.workItemLabel.findMany({
    where: { tenantId, workItemId: { in: read.taken } },
    select: { workItemId: true, labelId: true },
  });
  const descriptions = new Map<string, unknown>();
  for (let i = 0; i < read.taken.length; i += DESCRIPTION_CHUNK) {
    const chunk = await tx.workItem.findMany({
      where: { tenantId, id: { in: read.taken.slice(i, i + DESCRIPTION_CHUNK) } },
      select: { id: true, description: true },
    });
    for (const c of chunk) descriptions.set(c.id, c.description);
  }
  const head = new Map(read.heads.map((h) => [h.id, h]));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const labelsOf = new Map<string, string[]>();
  for (const j of joins) labelsOf.set(j.workItemId, [...(labelsOf.get(j.workItemId) ?? []), j.labelId]);
  return read.taken.map((id) => {
    const h = head.get(id)!;
    const r = byId.get(id)!;
    return {
      ...h,
      kind: h.kind === "BUG" ? "BUG" : "TASK",
      title: r.title,
      stateId: r.stateId,
      estimateMinutes: r.estimateMinutes,
      startDate: r.startDate,
      targetDate: r.targetDate,
      milestoneId: r.milestoneId,
      labelIds: labelsOf.get(id) ?? [],
      description: descriptions.get(id) ?? null,
    };
  });
}

// ── Settings → Templates ────────────────────────────────────────────

export type TemplateRow = {
  id: string;
  name: string;
  tasks: number;
  milestones: number;
  savedAt: Date;
  /** The project it was last saved from, when that still exists and the member reaches it. */
  source: { key: string; name: string } | null;
};

type CountedRow = { id: string; name: string; saved_at: Date; source_project_id: string | null; tasks: number; milestones: number };

/**
 * The workspace's templates with their sizes — the two count columns,
 * written with each document, so no document is read into the page (the
 * pre-apply review's NIT). Ordered by Postgres's fold, as the index decides.
 */
async function countedTemplates(tx: TenantDb, tenantId: string): Promise<CountedRow[]> {
  return tx.$queryRaw<CountedRow[]>`
    SELECT id, name, saved_at, source_project_id, task_count AS tasks, milestone_count AS milestones
    FROM project_template
    WHERE tenant_id = ${tenantId}
    ORDER BY lower(name), id`;
}

/** project_template:manage — the Settings page's list. */
export async function listTemplates(ctx: WorkCtx): Promise<TemplateRow[]> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, MANAGE);
    const rows = await countedTemplates(tx, ctx.tenantId);
    const sourceIds = [...new Set(rows.map((r) => r.source_project_id).filter((s): s is string => s !== null))];
    // A source project the member does not reach is not named (AUTHZ §4).
    const scope = sourceIds.length === 0 ? null : await scopeWhere(tx, ctx.actor, { clientField: "clientId", projectField: "id" });
    const sources =
      scope === null
        ? []
        : await tx.project.findMany({
            where: { AND: [{ tenantId: ctx.tenantId, id: { in: sourceIds } }, scope] },
            select: { id: true, key: true, name: true },
          });
    const sourceOf = new Map(sources.map((s) => [s.id, { key: s.key, name: s.name }]));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      tasks: Number(r.tasks),
      milestones: Number(r.milestones),
      savedAt: r.saved_at,
      source: r.source_project_id === null ? null : (sourceOf.get(r.source_project_id) ?? null),
    }));
  });
}

/** project_template:manage — rename; the database decides "taken" ignoring case. */
export async function renameTemplate(ctx: WorkCtx, id: string, rawName: string): Promise<{ name: string; changed: boolean }> {
  const name = nameOf(rawName);
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, MANAGE);
      const [row] = await tx.$queryRaw<{ name: string }[]>`
        SELECT name FROM project_template WHERE tenant_id = ${ctx.tenantId} AND id = ${id} FOR UPDATE`;
      if (!row) deny("NOT_FOUND");
      if (row!.name === name) return { name, changed: false };
      if (await templateNamed(tx, ctx.tenantId, name, { exceptId: id })) fail("TEMPLATE_NAME_TAKEN");
      await tx.projectTemplate.update({ where: { id }, data: { name }, select: { id: true } });
      await record(tx, {
        action: "project_template.renamed",
        targetType: "ProjectTemplate",
        targetId: id,
        metadata: { from: row!.name, to: name },
      });
      return { name, changed: true };
    }),
  );
}

/** project_template:manage — delete. Projects made from it keep everything; nothing points at a template. */
export async function deleteTemplate(ctx: WorkCtx, id: string): Promise<void> {
  await withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, MANAGE);
    const [row] = await tx.$queryRaw<{ name: string }[]>`
      SELECT name FROM project_template WHERE tenant_id = ${ctx.tenantId} AND id = ${id} FOR UPDATE`;
    if (!row) deny("NOT_FOUND");
    await tx.projectTemplate.delete({ where: { id }, select: { id: true } });
    await record(tx, {
      action: "project_template.deleted",
      targetType: "ProjectTemplate",
      targetId: id,
      metadata: { name: row!.name },
    });
  });
}

// ── New project from a template ─────────────────────────────────────

export type TemplateChoice = { id: string; name: string; tasks: number; milestones: number };

/**
 * The templates a New project form offers — exactly the ones applying would
 * let this member use: `project:create`, `work_item:create` and
 * `work_item:edit` (all four gates each, in sequence), and a template with
 * milestones only to a member who may make milestones (both reviews' LOW).
 * Nobody else is offered any. With them, TODAY in the workspace's zone,
 * where the form's Start date begins. The counts are columns: a document is
 * parsed only when it is used — a template whose document no longer parses
 * is still listed, and refused with a sentence when chosen.
 */
export async function listTemplateChoices(ctx: WorkCtx): Promise<{ choices: TemplateChoice[]; today: string }> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    const prefs = await readPreferences(tx, ctx.tenantId);
    const today = todayIn(prefs.timezone);
    for (const code of ["project:create", "work_item:create", "work_item:edit"]) {
      if (!(await hasAccess(tx, ctx.tenantId, ctx.actor, code))) return { choices: [], today };
    }
    const milestones = await hasAccess(tx, ctx.tenantId, ctx.actor, "project:manage_versions");
    const rows = await countedTemplates(tx, ctx.tenantId);
    const choices = rows
      .filter((r) => Number(r.tasks) + Number(r.milestones) > 0)
      .filter((r) => milestones || Number(r.milestones) === 0)
      .map((r) => ({ id: r.id, name: r.name, tasks: Number(r.tasks), milestones: Number(r.milestones) }));
    return { choices, today };
  });
}

type StageMade = { id: string; category: PresetStage["category"]; isDefault: boolean };
type ActivityChange = Parameters<typeof writeActivityMany>[2][number]["change"];

/**
 * A project from a template (design §6) — ONE transaction: the project,
 * its stages (the template's, not the workspace default), its milestones,
 * its tasks and their labels commit together or not at all. Everything is
 * born private; nobody is told (no task has an assignee).
 */
export async function createProjectFromTemplate(
  ctx: WorkCtx,
  input: Omit<ProjectCreateInput, "startDate" | "status"> & { templateId: string; startDate: Date },
): Promise<{ id: string; key: string; tasks: number; milestones: number }> {
  // A deadlock is retried, as the rank writers' are: Postgres has undone the
  // loser whole (the label index is the one place two applies can meet).
  return retryOnDeadlock(() =>
    withTenant(ctx.tenantId, principalOf(ctx), (tx) => guarded(() => applyTemplate(tx, ctx, input)), { timeoutMs: 60_000 }),
  );
}

/** `createProjectFromTemplate`'s one transaction. */
async function applyTemplate(
  tx: TenantDb,
  ctx: WorkCtx,
  input: Omit<ProjectCreateInput, "startDate" | "status"> & { templateId: string; startDate: Date },
): Promise<{ id: string; key: string; tasks: number; milestones: number }> {
  // Every code BEFORE the template is read or anything written — so a
  // member who may not make projects learns nothing of the templates.
  // `insertProject` asks `project:create` again with the client's
  // scope, first among its own (a repeat, never a gap).
  await requireAccess(tx, ctx.tenantId, ctx.actor, "project:create");
  await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:create");
  await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:edit");
  const template = await tx.projectTemplate.findFirst({
    where: { tenantId: ctx.tenantId, id: input.templateId },
    select: { id: true, name: true, definition: true },
  });
  if (!template) deny("NOT_FOUND");
  const plan = parseDefinition(template!.definition);
  if (!plan) fail("TEMPLATE_INVALID", "definition");
  if (plan!.milestones.length > 0) await requireAccess(tx, ctx.tenantId, ctx.actor, "project:manage_versions");
  // Every description through the one gate, before any write.
  const docs = plan!.tasks.map((t) => templateDoc(t.description));
  if (!(await namesDistinctToDb(tx, plan!.stages))) fail("TEMPLATE_INVALID", "stage names");

  const project = await insertProject(tx, ctx, {
    clientId: input.clientId,
    key: input.key,
    name: input.name,
    type: input.type,
    scopeSummary: input.scopeSummary,
    startDate: dayAfter(input.startDate, 0),
  });
  const projectId = project.id;
  const start = dayAfter(input.startDate, 0);

  // THE ONE ORDER (rank-lock.ts): the stage key, the counter, the rank
  // queue, rows. Nothing else can see this project until it commits,
  // so none of them waits; they are taken so the order holds anyway.
  await lockProjectStages(tx, projectId);
  const stages = await seedStages(tx, ctx.tenantId, projectId, plan!.stages);

  const milestoneIds = await makeMilestones(tx, ctx, projectId, input.clientId, plan!, start);
  const labelIds = await resolveLabels(tx, ctx, plan!);
  const tasks = await makeTasks(tx, ctx, {
    projectId,
    clientId: input.clientId,
    templateId: template!.id,
    plan: plan!,
    docs,
    stages,
    milestoneIds,
    labelIds,
    start,
  });

  await record(tx, {
    action: "project_template.applied",
    targetType: "ProjectTemplate",
    targetId: template!.id,
    metadata: { name: template!.name, projectId, tasks, milestones: milestoneIds.size },
  });
  return { id: projectId, key: project.key, tasks, milestones: milestoneIds.size };
}

/** A template task's description through `normalizeDescription`; a refusal refuses the template. */
function templateDoc(doc: unknown): NormalizedDescription | null {
  if (doc === null || doc === undefined) return null;
  try {
    const n = normalizeDescription(doc);
    return n.doc === null ? null : n;
  } catch (e) {
    if (e instanceof DomainError) fail("TEMPLATE_INVALID", "a description");
    throw e;
  }
}

/** The template's stages and Triage, in order — `ensureProjectStates`' write with the template's set. */
async function seedStages(
  tx: TenantDb,
  tenantId: string,
  projectId: string,
  stages: readonly PresetStage[],
): Promise<Map<string, StageMade>> {
  const shape = [...stages.map((s) => ({ ...s, id: newId() })), { ...TRIAGE_STAGE, key: "", name: null, id: newId() }];
  const ranks = ranksBetween(null, null, shape.length);
  await tx.workflowState.createMany({
    data: shape.map((s, i) => ({
      id: s.id,
      tenantId,
      projectId,
      name: s.name,
      seedKey: s.seedKey,
      category: s.category,
      rank: ranks[i]!,
      isDefault: s.isDefault,
      isHidden: s.category === "TRIAGE",
      requiresApproval: s.requiresApproval,
    })),
  });
  return new Map(
    shape.filter((s) => s.category !== "TRIAGE").map((s) => [s.key, { id: s.id, category: s.category as PresetStage["category"], isDefault: s.isDefault }]),
  );
}

/** The milestones, PLANNED and PRIVATE, due `start + dueDay`. Returns template key → new id. */
async function makeMilestones(
  tx: TenantDb,
  ctx: WorkCtx,
  projectId: string,
  clientId: string,
  plan: ParsedTemplate,
  start: Date,
): Promise<Map<string, string>> {
  const made = new Map<string, string>();
  if (plan.milestones.length === 0) return made;
  // The project's milestone queue (`milestones.ts`), before its rows — the
  // order every milestone writer keeps.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`milestone_rank:${projectId}`}))`;
  const ranks = ranksBetween(null, null, plan.milestones.length);
  const rows = plan.milestones.map((m, i) => {
    const id = newId();
    made.set(m.key, id);
    return {
      id,
      tenantId: ctx.tenantId,
      clientId,
      projectId,
      name: m.name,
      description: m.description,
      dueAt: m.dueDay === null ? null : dayAfter(start, m.dueDay),
      rank: ranks[i]!,
      status: "PLANNED" as const,
      // THE WORST-BUG DEFAULT, written out rather than left to the column.
      visibility: "INTERNAL" as const,
    };
  });
  await tx.milestone.createMany({ data: rows });
  await recordMany(
    tx,
    rows.map((r) => ({
      action: "milestone.created",
      targetType: "Milestone",
      targetId: r.id,
      metadata: { projectId, visibility: "INTERNAL" },
    })),
  );
  return made;
}

/**
 * The template's labels → this workspace's (design §6.6): the same label
 * if it still exists, else one of the same name (Postgres's `lower()`),
 * else — for a member holding `label:manage` — made again with its colour,
 * as the picker's "Create" would (audited `label.created`); else left off.
 * Returns template key → label id.
 */
async function resolveLabels(tx: TenantDb, ctx: WorkCtx, plan: ParsedTemplate): Promise<Map<string, string>> {
  const byKey = new Map<string, string>();
  if (plan.labels.length === 0) return byKey;
  const live = await tx.label.findMany({
    where: { tenantId: ctx.tenantId, projectId: null, id: { in: plan.labels.map((l) => l.id) } },
    select: { id: true },
  });
  const liveIds = new Set(live.map((l) => l.id));
  for (const l of plan.labels) if (liveIds.has(l.id)) byKey.set(l.key, l.id);
  // A stored name is never trusted either: the label rule, or it is left off.
  const wanted = plan.labels
    .filter((l) => !byKey.has(l.key))
    .flatMap((l) => {
      const checked = singleLineName(l.name, MAX_LABEL_NAME_LENGTH);
      return checked.ok ? [{ key: l.key, name: checked.name, color: isLabelColor(l.color) ? l.color : null }] : [];
    });
  if (wanted.length === 0) return byKey;
  const byName = async () => {
    const rows = await tx.$queryRaw<{ wanted: string; id: string }[]>`
      SELECT w.n AS wanted, l.id FROM unnest(${wanted.map((w) => w.name)}::text[]) AS w(n)
      JOIN label l ON l.tenant_id = ${ctx.tenantId} AND l.project_id IS NULL AND lower(l.name) = lower(w.n)`;
    const found = new Map(rows.map((r) => [r.wanted, r.id]));
    for (const w of wanted) {
      const id = found.get(w.name);
      if (id !== undefined && !byKey.has(w.key)) byKey.set(w.key, id);
    }
  };
  await byName();
  const missing = wanted.filter((w) => !byKey.has(w.key));
  if (missing.length > 0 && (await isAuthorized(tx, ctx.actor, "label:manage"))) {
    // SORTED by the folded name — the order the workspace's name index keys
    // on — and skipping duplicates, the import's rule: two members making
    // overlapping names in opposite orders would otherwise deadlock on that
    // index (the code review's LOW), and a label made meanwhile is found below.
    const fold = (n: string) => n.toLowerCase();
    const fresh = [...new Map(missing.map((w) => [fold(w.name), w])).values()].sort((a, b) =>
      fold(a.name) < fold(b.name) ? -1 : fold(a.name) > fold(b.name) ? 1 : 0,
    );
    const made = await tx.label.createManyAndReturn({
      data: fresh.map((w) => ({ tenantId: ctx.tenantId, projectId: null, name: w.name, color: w.color })),
      skipDuplicates: true,
      select: { id: true, name: true },
    });
    await recordMany(
      tx,
      made.map((l) => ({ action: "label.created", targetType: "Label", targetId: l.id, metadata: { name: l.name } }) as const),
    );
    await byName();
  }
  return byKey;
}

/**
 * The tasks (design §6.7): numbered 1…n and ranked in the template's
 * order, inserted a LEVEL at a time so the tree trigger always finds the
 * parent the statement before wrote. Every one PRIVATE, `IN_APP`, in its
 * starting stage (Backlog or To do: no stamps), with its history rows and
 * audits as the import writes them.
 */
async function makeTasks(
  tx: TenantDb,
  ctx: WorkCtx,
  input: {
    projectId: string;
    clientId: string;
    templateId: string;
    plan: ParsedTemplate;
    docs: readonly (NormalizedDescription | null)[];
    stages: ReadonlyMap<string, StageMade>;
    milestoneIds: ReadonlyMap<string, string>;
    labelIds: ReadonlyMap<string, string>;
    start: Date;
  },
): Promise<number> {
  const { plan, projectId } = input;
  const n = plan.tasks.length;
  if (n === 0) return 0;
  await lockCounter(tx, `work_item:${projectId}`);
  await lockProjectRanks(tx, projectId);
  const numbers = await nextCounters(tx, `work_item:${projectId}`, n);
  const ranks = ranksBetween(null, null, n);
  const defaultStage = [...input.stages.values()].find((s) => s.isDefault)!;
  const idOf = new Map(plan.tasks.map((t) => [t.key, newId()]));
  const made = plan.tasks.map((t, i) => {
    const stage = input.stages.get(t.stage)!;
    const doc = input.docs[i] ?? null;
    return {
      depth: t.depth,
      stage,
      number: numbers[i]!,
      data: {
        id: idOf.get(t.key)!,
        tenantId: ctx.tenantId,
        clientId: input.clientId,
        projectId,
        number: numbers[i]!,
        type: t.type,
        kind: t.kind,
        title: t.title,
        ...(doc === null
          ? {}
          : {
              description: doc.doc as object,
              descriptionText: doc.text,
              checklistTotal: doc.checklistTotal,
              checklistDone: doc.checklistDone,
            }),
        stateId: stage.id,
        stateCategory: stage.category,
        parentId: t.parent === null ? null : idOf.get(t.parent)!,
        rootId: idOf.get(t.key)!, // parent_guard derives the real root/depth
        rank: ranks[i]!,
        milestoneId: t.milestone === null ? null : (input.milestoneIds.get(t.milestone) ?? null),
        estimateMinutes: t.estimateMinutes,
        startDate: t.startDay === null ? null : dayAfter(input.start, t.startDay),
        targetDate: t.targetDay === null ? null : dayAfter(input.start, t.targetDay),
        // THE WORST-BUG DEFAULT, written out rather than left to the column.
        visibility: "INTERNAL" as const,
        source: "IN_APP" as const,
        createdByMemberId: ctx.actor.memberId,
      },
      labels: t.labels.map((k) => input.labelIds.get(k)).filter((id): id is string => id !== undefined),
    };
  });
  for (const level of [0, 1, 2] as const) {
    const rows = made.filter((m) => m.depth === level).map((m) => m.data);
    if (rows.length > 0) await tx.workItem.createMany({ data: rows });
  }
  const labelRows = made.flatMap((m) => [...new Set(m.labels)].map((labelId) => ({ tenantId: ctx.tenantId, workItemId: m.data.id, labelId })));
  if (labelRows.length > 0) await tx.workItemLabel.createMany({ data: labelRows, skipDuplicates: true });

  const ref = (m: (typeof made)[number]) => ({ id: m.data.id, clientId: input.clientId, projectId, visibility: "INTERNAL" as const });
  // History: `created` for each, and a birth into a stage other than where
  // new tasks start gets the row `createItem` + `transitionState(birth)`
  // writes — INTERNAL, since a birth is no change a client saw.
  const history: { item: ReturnType<typeof ref>; change: ActivityChange }[] = [
    ...made.map((m) => ({ item: ref(m), change: { field: "created", forceInternal: true } as ActivityChange })),
    ...made
      .filter((m) => m.stage.id !== defaultStage.id)
      .map((m) => ({
        item: ref(m),
        change: {
          field: "stateCategory",
          oldValue: defaultStage.category,
          newValue: m.stage.category,
          oldRef: defaultStage.id,
          newRef: m.stage.id,
          forceInternal: true,
        } as ActivityChange,
      })),
  ];
  await writeActivityMany(tx, ctx, history);
  const audits: AuditInput[] = [];
  for (const m of made) {
    audits.push({
      action: "work_item.created",
      targetType: "WorkItem",
      targetId: m.data.id,
      metadata: { number: m.number, projectId, type: m.data.type, visibility: "INTERNAL", templateId: input.templateId },
    });
    if (m.stage.id !== defaultStage.id) {
      audits.push({
        action: "work_item.state_changed",
        targetType: "WorkItem",
        targetId: m.data.id,
        metadata: { from: defaultStage.category, to: m.stage.category, projectId },
      });
    }
  }
  await recordMany(tx, audits);
  return n;
}

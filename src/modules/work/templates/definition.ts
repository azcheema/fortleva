import { z } from "zod";

import { MAX_ESTIMATE_MINUTES } from "@/lib/duration";
import { STATE_SEED_KEYS } from "@/lib/enum-map";
import { DomainError } from "@/lib/domain-error";
import { normalizeDescription } from "@/lib/rich-text/normalize";
import { canStartHere, editableStages, STAGE_KINDS, type StageCategory } from "@/lib/stage-rules";
import { MAX_TITLE_LENGTH } from "@/lib/work-view";

import { parsePreset, type PresetStage } from "../stage-preset";

/**
 * A PROJECT TEMPLATE'S DOCUMENT (slice 124, founder decision C100;
 * docs/research/2026-10-16-slice-124-project-templates-design.md §3–§4).
 *
 * Pure: no database, no clock. Two directions —
 *   · `takeTasks` + `buildDefinition`: a project's rows → the document
 *     "Save as template" stores;
 *   · `parseDefinition`: a stored document → a checked plan, or null.
 *
 * NEVER TRUSTED. The column is only ever written by `buildDefinition`, but
 * it is parsed on every use, the workflow preset's rule: a document that
 * fails — an old shape, a hand-edited row — cannot be applied
 * (`TEMPLATE_INVALID`), and every description passes `normalizeDescription`
 * again when a project is made from it.
 */

export const TEMPLATE_DOC_VERSION = 1;
export const TEMPLATE_MAX_TASKS = 1000;
export const TEMPLATE_MAX_MILESTONES = 100;
export const TEMPLATE_MAX_LABELS = 500;
/** Labels on one task in a template — far past any real task; it bounds the joins one apply writes (the security review's NIT). */
export const TEMPLATE_MAX_TASK_LABELS = 50;
/**
 * A milestone's name and description as a template holds them. Nothing
 * upstream bounds either (the services only trim), so these are wide — wider
 * than anyone types — and the document's own size cap is what governs; a
 * save past them is refused as too large rather than stored unusable (both
 * reviews' MEDIUM/LOW).
 */
export const TEMPLATE_MAX_MILESTONE_NAME = 2000;
export const TEMPLATE_MAX_MILESTONE_DESCRIPTION = 100_000;
/**
 * The document's size as `JSON.stringify` writes it. The database's CHECK
 * (`project_template_definition_size`) measures Postgres's own text form,
 * which puts a space after every `:` and `,` — about a fifth longer for
 * this shape — so its bound is 4 MiB and this one is 3 MiB: the service
 * refuses first, with a sentence, and the CHECK is only the belt.
 */
export const TEMPLATE_MAX_BYTES = 3 * 1024 * 1024;
/** A date at most ten years either side of the anchor. */
export const TEMPLATE_MAX_DAY_OFFSET = 3650;

const DAY_MS = 86_400_000;

// ── The stored shape ────────────────────────────────────────────────

const key = (prefix: "s" | "m" | "l" | "t") => z.string().regex(new RegExp(`^${prefix}[0-9]{1,4}$`));
const dayOffset = z.number().int().min(-TEMPLATE_MAX_DAY_OFFSET).max(TEMPLATE_MAX_DAY_OFFSET).nullable();
const EDITABLE_SEED_KEYS = STATE_SEED_KEYS.filter((k) => k !== "TRIAGE") as [string, ...string[]];

const stageSchema = z
  .object({
    key: key("s"),
    name: z.string().max(200).nullable(),
    seedKey: z.enum(EDITABLE_SEED_KEYS).nullable(),
    category: z.enum(STAGE_KINDS),
    isDefault: z.boolean(),
    requiresApproval: z.boolean(),
  })
  .strict();

const milestoneSchema = z
  .object({
    key: key("m"),
    name: z.string().min(1).max(TEMPLATE_MAX_MILESTONE_NAME),
    description: z.string().max(TEMPLATE_MAX_MILESTONE_DESCRIPTION).nullable(),
    dueDay: dayOffset,
  })
  .strict();

const labelSchema = z
  .object({
    key: key("l"),
    id: z.string().min(1).max(64),
    name: z.string().min(1).max(200),
    color: z.string().max(32).nullable(),
  })
  .strict();

const taskSchema = z
  .object({
    key: key("t"),
    parent: key("t").nullable(),
    type: z.enum(["EPIC", "TASK", "SUBTASK"]),
    kind: z.enum(["TASK", "BUG"]),
    title: z.string().min(1).max(MAX_TITLE_LENGTH),
    // A ProseMirror document — checked by `normalizeDescription` when it is
    // used, never by this schema (the gate is one function, `normalize.ts`).
    description: z.unknown(),
    estimateMinutes: z.number().int().min(0).max(MAX_ESTIMATE_MINUTES).nullable(),
    stage: key("s"),
    milestone: key("m").nullable(),
    labels: z.array(key("l")).max(TEMPLATE_MAX_TASK_LABELS),
    startDay: dayOffset,
    targetDay: dayOffset,
  })
  .strict();

const definitionSchema = z
  .object({
    v: z.literal(TEMPLATE_DOC_VERSION),
    stages: z.array(stageSchema).max(40),
    milestones: z.array(milestoneSchema).max(TEMPLATE_MAX_MILESTONES),
    labels: z.array(labelSchema).max(TEMPLATE_MAX_LABELS),
    tasks: z.array(taskSchema).max(TEMPLATE_MAX_TASKS),
  })
  .strict();

export type TemplateDefinition = z.infer<typeof definitionSchema>;
export type TemplateTask = TemplateDefinition["tasks"][number];
export type TemplateMilestone = TemplateDefinition["milestones"][number];
export type TemplateLabel = TemplateDefinition["labels"][number];

/** A task as `parseDefinition` hands it on: its level (0–2) worked out from its parent chain. */
export type PlannedTask = TemplateTask & { depth: 0 | 1 | 2 };

export type ParsedTemplate = {
  stages: PresetStage[];
  milestones: TemplateMilestone[];
  labels: TemplateLabel[];
  /** In the template's order — the board order the new ranks follow. */
  tasks: PlannedTask[];
};

const LEVEL = { EPIC: 0, TASK: 1, SUBTASK: 2 } as const;

/**
 * A stored document as a plan, or null. Beyond the shape: every key is
 * unique in its list and every reference names one that exists; a task's
 * stage is one new tasks may start in (Backlog or To do, never gated — the
 * create puts a task straight there, past the state machine); a parent is
 * of a strictly higher level and the tree is at most three levels deep —
 * the tree trigger's rules (`work_item_parent_guard` and the type CHECKs),
 * checked here so a bad document is refused before anything is written.
 */
export function parseDefinition(value: unknown): ParsedTemplate | null {
  const parsed = definitionSchema.safeParse(value);
  if (!parsed.success) return null;
  const d = parsed.data;
  const stages = parsePreset(d.stages);
  if (!stages) return null;
  const stageByKey = new Map(stages.map((s) => [s.key, s]));
  const unique = (keys: string[]) => new Set(keys).size === keys.length;
  if (!unique(d.milestones.map((m) => m.key)) || !unique(d.labels.map((l) => l.key)) || !unique(d.tasks.map((t) => t.key))) {
    return null;
  }
  const milestoneKeys = new Set(d.milestones.map((m) => m.key));
  const labelKeys = new Set(d.labels.map((l) => l.key));
  const taskByKey = new Map(d.tasks.map((t) => [t.key, t]));
  const depthOf = new Map<string, 0 | 1 | 2>();
  const depth = (t: TemplateTask, seen: number): 0 | 1 | 2 | null => {
    const known = depthOf.get(t.key);
    if (known !== undefined) return known;
    if (seen > 3) return null; // a cycle, or deeper than the tree allows
    let mine: number;
    if (t.parent === null) {
      mine = 0;
    } else {
      const parent = taskByKey.get(t.parent);
      if (!parent || LEVEL[parent.type] >= LEVEL[t.type]) return null;
      const up = depth(parent, seen + 1);
      if (up === null) return null;
      mine = up + 1;
    }
    // The type CHECKs: an Epic is a root, a Task at most one level down, a
    // Subtask never a root; nothing below the third level.
    if (mine > 2 || (t.type === "EPIC" && mine !== 0) || (t.type === "TASK" && mine > 1) || (t.type === "SUBTASK" && mine < 1)) {
      return null;
    }
    depthOf.set(t.key, mine as 0 | 1 | 2);
    return mine as 0 | 1 | 2;
  };
  const tasks: PlannedTask[] = [];
  for (const t of d.tasks) {
    const stage = stageByKey.get(t.stage);
    if (!stage || !canStartHere(stage)) return null;
    if (t.milestone !== null && !milestoneKeys.has(t.milestone)) return null;
    if (!t.labels.every((l) => labelKeys.has(l)) || !unique(t.labels)) return null;
    const level = depth(t, 0);
    if (level === null) return null;
    tasks.push({ ...t, depth: level });
  }
  return { stages, milestones: d.milestones, labels: d.labels, tasks };
}

// ── From a project ──────────────────────────────────────────────────

/** A project's stage as `saveProjectAsTemplate` reads it, in rank order (Triage included or not — it is left out). */
export type SourceStage = {
  id: string;
  name: string | null;
  seedKey: PresetStage["seedKey"] | "TRIAGE" | null;
  category: StageCategory;
  isDefault: boolean;
  requiresApproval: boolean;
};

export type SourceMilestone = {
  id: string;
  name: string;
  description: string | null;
  status: "PLANNED" | "IN_PROGRESS" | "PAUSED" | "DONE" | "CANCELLED";
  dueAt: Date | null;
};

export type SourceLabel = { id: string; name: string; color: string | null };

/** A project's task as the selection reads it — no description (that is read only for the tasks taken). */
export type SourceTaskHead = {
  id: string;
  parentId: string | null;
  depth: number;
  type: "EPIC" | "TASK" | "SUBTASK";
  kind: "TASK" | "BUG" | "REQUEST";
  stateCategory: StageCategory;
  archivedAt: Date | null;
  deletedAt: Date | null;
};

export type SourceTask = Omit<SourceTaskHead, "kind"> & {
  kind: "TASK" | "BUG";
  title: string;
  stateId: string;
  estimateMinutes: number | null;
  startDate: Date | null;
  targetDate: Date | null;
  milestoneId: string | null;
  labelIds: string[];
  description: unknown;
};

/**
 * WHICH TASKS A TEMPLATE TAKES (design §4), from the project's tasks in
 * rank order: every live one — except a deleted or archived task, a
 * client's request (their own words, never the agency's plan), and one in
 * Triage or Cancelled; a task whose parent is left out goes with it, and
 * so do its own children. Returns the ids, in the order given.
 */
export function takeTasks(rows: readonly SourceTaskHead[]): string[] {
  const own = (r: SourceTaskHead) =>
    r.deletedAt === null &&
    r.archivedAt === null &&
    r.kind !== "REQUEST" &&
    r.stateCategory !== "TRIAGE" &&
    r.stateCategory !== "CANCELLED";
  const byId = new Map(rows.map((r) => [r.id, r]));
  const taken = new Set<string>();
  // Parents before children: a level at a time (depth is the tree trigger's).
  for (const level of [0, 1, 2]) {
    for (const r of rows) {
      if (r.depth !== level || !own(r)) continue;
      if (r.parentId !== null && !(byId.has(r.parentId) && taken.has(r.parentId))) continue;
      taken.add(r.id);
    }
  }
  return rows.filter((r) => taken.has(r.id)).map((r) => r.id);
}

/** Whole days from `anchor` (UTC midnight) to `date`'s UTC day — a date column is UTC midnight. */
export function dayOffsetFrom(anchor: Date, date: Date): number {
  const day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const from = Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate());
  return Math.round((day - from) / DAY_MS);
}

/** `start` + `days`, as a date column's UTC midnight. */
export const dayAfter = (start: Date, days: number): Date =>
  new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()) + days * DAY_MS);

const clampOffset = (n: number): number | null =>
  Math.abs(n) <= TEMPLATE_MAX_DAY_OFFSET ? n : null;

/**
 * Every checkbox UNTICKED: a template is the beginning of a project. A
 * fresh object tree — the stored document is never mutated in place.
 */
export function untickChecklists(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(untickChecklists);
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) out[k] = untickChecklists(v);
  if (out["type"] === "taskItem") {
    const attrs = out["attrs"];
    out["attrs"] = { ...(attrs !== null && typeof attrs === "object" ? attrs : {}), checked: false };
  }
  return out;
}

/** A stored description, unticked and through the one gate — or null when it says nothing or will not pass. */
function templateDescription(doc: unknown): unknown {
  if (doc === null || doc === undefined) return null;
  try {
    return normalizeDescription(untickChecklists(doc)).doc;
  } catch (e) {
    if (!(e instanceof DomainError)) throw e;
    return null;
  }
}

/**
 * THE DOCUMENT "Save as template" stores (design §4), from a project's
 * rows. `tasks` are the ones `takeTasks` chose, in rank order, with their
 * descriptions; `anchor` is the day dates are counted from (the project's
 * start, or the day it was made).
 *
 *   · Stages: the project's own, Triage left out, keys s0…
 *   · A task's STARTING stage: its own when new tasks may start there
 *     (Backlog or To do, not gated); otherwise where the project's new
 *     tasks start — one in progress or done starts fresh.
 *   · Milestones: all but a cancelled one; a task whose milestone was
 *     cancelled keeps none.
 *   · Labels: only those a taken task wears, with the id, name and colour
 *     of the moment.
 *   · Dates as day offsets; one more than ten years from the anchor is
 *     dropped rather than refused.
 *
 * Returns null when the project's stages are not a set a new project can
 * be seeded with (an old anomaly the stage editor would not let anyone
 * make) — the caller refuses with TEMPLATE_INVALID.
 */
export function buildDefinition(input: {
  stages: readonly SourceStage[];
  milestones: readonly SourceMilestone[];
  labels: readonly SourceLabel[];
  tasks: readonly SourceTask[];
  anchor: Date;
}): TemplateDefinition | null {
  const stageRows = editableStages(input.stages.map((s) => ({ ...s, seedKey: s.seedKey === "TRIAGE" ? null : s.seedKey })));
  const stages = stageRows.map((s, i) => ({
    key: `s${i}`,
    name: s.name,
    seedKey: s.seedKey as PresetStage["seedKey"],
    category: s.category as PresetStage["category"],
    isDefault: s.isDefault,
    requiresApproval: s.requiresApproval,
  }));
  if (!parsePreset(stages)) return null;
  const stageKey = new Map(stageRows.map((s, i) => [s.id, stages[i]!]));
  const start = stages.find((s) => s.isDefault)!;

  const milestoneRows = input.milestones.filter((m) => m.status !== "CANCELLED");
  const milestoneKey = new Map(milestoneRows.map((m, i) => [m.id, `m${i}`]));
  const milestones = milestoneRows.map((m, i) => ({
    key: `m${i}`,
    name: m.name,
    description: m.description,
    dueDay: m.dueAt === null ? null : clampOffset(dayOffsetFrom(input.anchor, m.dueAt)),
  }));

  // Labels in the order given (the caller reads them by name), and a task's
  // own in that same order — so the keys never depend on how a join was read.
  // A task keeps its first 50 in that order, and only labels a task KEEPS
  // enter the document (the fix review's LOW: one past a task's 50 would
  // otherwise count against the 500 and be made again with nothing wearing it).
  const kept = new Map(
    input.tasks.map((t) => {
      const mine = new Set(t.labelIds);
      return [t.id, input.labels.filter((l) => mine.has(l.id)).slice(0, TEMPLATE_MAX_TASK_LABELS).map((l) => l.id)];
    }),
  );
  const worn = new Set([...kept.values()].flat());
  const labelRows = input.labels.filter((l) => worn.has(l.id));
  const labelKey = new Map(labelRows.map((l, i) => [l.id, `l${i}`]));
  const labels = labelRows.map((l, i) => ({ key: `l${i}`, id: l.id, name: l.name, color: l.color }));

  const taskKey = new Map(input.tasks.map((t, i) => [t.id, `t${i}`]));
  const tasks = input.tasks.map((t, i) => {
    const own = stageKey.get(t.stateId);
    const stage = own && canStartHere(own) ? own : start;
    return {
      key: `t${i}`,
      parent: t.parentId === null ? null : (taskKey.get(t.parentId) ?? null),
      type: t.type,
      kind: t.kind,
      title: t.title,
      description: templateDescription(t.description),
      estimateMinutes: t.estimateMinutes,
      stage: stage.key,
      milestone: t.milestoneId === null ? null : (milestoneKey.get(t.milestoneId) ?? null),
      labels: (kept.get(t.id) ?? []).map((id) => labelKey.get(id)!),
      startDay: t.startDate === null ? null : clampOffset(dayOffsetFrom(input.anchor, t.startDate)),
      targetDay: t.targetDate === null ? null : clampOffset(dayOffsetFrom(input.anchor, t.targetDate)),
    };
  });
  return { v: TEMPLATE_DOC_VERSION, stages, milestones, labels, tasks };
}

/** The document's size as the service measures it (design §3). */
export const definitionBytes = (d: TemplateDefinition): number => Buffer.byteLength(JSON.stringify(d), "utf8");

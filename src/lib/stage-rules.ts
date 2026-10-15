import type { StateSeedKey } from "./enum-map";
import { singleLineName } from "./single-line-name";

/**
 * THE STAGE RULES (slice 123, founder decision C99 (a) — design doc §3):
 * ONE set for both editors, the workspace default (Settings → Stages,
 * stored in `workflow_preset`) and a project's own (`workflow_state`).
 * Pure and RSC-safe, no directive: the services decide with it and the
 * pages draw with it, so the menu can never offer what the server refuses.
 *
 * Everything works on an ORDERED list — a project's states by `rank`, the
 * preset's entries in array order — and answers in list positions. The
 * project service turns a position into a rank between its neighbours;
 * the preset service splices.
 */

/** The kinds a member can put a stage in, in board order. TRIAGE is fixed, hidden and never listed. */
export const STAGE_KINDS = ["BACKLOG", "TODO", "IN_PROGRESS", "DONE", "CANCELLED"] as const;
export type StageKind = (typeof STAGE_KINDS)[number];
/** Every category a row can carry — the Prisma enum's members, spelled here so client code can use it. */
export type StageCategory = StageKind | "TRIAGE";

/** Stages per project (or in the workspace default), TRIAGE not counted. A board column each. */
export const MAX_STAGES = 20;
/** The label bound (`MAX_LABEL_NAME_LENGTH`), for the same reason: a name is a column header. */
export const MAX_STAGE_NAME_LENGTH = 40;
/** A removal moves its tasks in one transaction; past this, "move some first". */
export const MAX_STAGE_REMOVE_TASKS = 2000;

/**
 * Fortleva's built-in set (DATA_MODEL §6.14): what a project gets while the
 * workspace has no default of its own. Moved here from `states.ts` so the
 * Settings page can draw it before anyone has changed it.
 *
 * "In review" is a tenant-named state in the IN_PROGRESS category (the
 * category set is pinned closed; the portal reads categories only). Done
 * carries the approval gate: entering it needs work_item:approve on top of
 * work_item:edit (2W-R). Seeded states carry NO name: a NULL name means
 * "still wearing its default" and renders through i18n in the VIEWER's
 * language; the first rename makes it plain tenant text forever.
 */
export const BUILT_IN_STAGES = [
  { seedKey: "BACKLOG", category: "BACKLOG", isDefault: false, isHidden: false, requiresApproval: false },
  { seedKey: "TODO", category: "TODO", isDefault: true, isHidden: false, requiresApproval: false },
  { seedKey: "IN_PROGRESS", category: "IN_PROGRESS", isDefault: false, isHidden: false, requiresApproval: false },
  { seedKey: "IN_REVIEW", category: "IN_PROGRESS", isDefault: false, isHidden: false, requiresApproval: false },
  { seedKey: "DONE", category: "DONE", isDefault: false, isHidden: false, requiresApproval: true },
  { seedKey: "CANCELLED", category: "CANCELLED", isDefault: false, isHidden: false, requiresApproval: false },
] as const satisfies readonly {
  seedKey: StateSeedKey;
  category: StageKind;
  isDefault: boolean;
  isHidden: boolean;
  requiresApproval: boolean;
}[];

/** TRIAGE, appended LAST to every set a project is seeded with — shown only when it has items. */
export const TRIAGE_STAGE = {
  seedKey: "TRIAGE",
  category: "TRIAGE",
  isDefault: false,
  isHidden: true,
  requiresApproval: false,
} as const;

/** What the rules read off a stage. `id` is a state id or a preset entry's key. */
export type StageLike = {
  readonly id: string;
  readonly name: string | null;
  readonly seedKey: StateSeedKey | null;
  readonly category: StageCategory;
  readonly isDefault: boolean;
  readonly requiresApproval: boolean;
};

export type StageRefusal =
  | "NAME_REQUIRED"
  | "INVALID_INPUT"
  | "STAGE_NAME_TAKEN"
  | "STAGE_LIMIT"
  | "STAGE_LAST_OF_KIND"
  | "STAGE_NOT_EMPTY"
  | "STAGE_IN_BIN"
  | "STAGE_DEFAULT_KIND"
  | "STAGE_DEFAULT_GATED"
  | "STAGE_IS_DEFAULT"
  | "STAGE_TOO_FULL";

/** A kind's place in the board order; TRIAGE sorts after every editable kind. */
export const kindIndex = (category: StageCategory): number =>
  category === "TRIAGE" ? STAGE_KINDS.length : STAGE_KINDS.indexOf(category);

export const isStageKind = (v: unknown): v is StageKind =>
  typeof v === "string" && (STAGE_KINDS as readonly string[]).includes(v);

/** The stages a member sees and edits — TRIAGE is never one of them. */
export const editableStages = <S extends StageLike>(list: readonly S[]): S[] =>
  list.filter((s) => s.category !== "TRIAGE");

/** "New tasks start here" may sit only where a task can sensibly be born: Backlog or To do. */
export const defaultKindAllowed = (category: StageCategory): boolean =>
  category === "BACKLOG" || category === "TODO";

/**
 * Whether new tasks may start in this stage: the right kind AND not gated
 * (the security review's LOW). A new task is put STRAIGHT into the
 * default by `createItem` and the import, never through the state
 * machine, so a "needs approval" default would let anyone who may create
 * a task put it past the approval gate. The database holds the same pair
 * (`workflow_state_default_kind`, `workflow_state_default_ungated`).
 */
export const canStartHere = (stage: Pick<StageLike, "category" | "requiresApproval">): boolean =>
  defaultKindAllowed(stage.category) && !stage.requiresApproval;

/** Why `stage` cannot be made where new tasks start, or null when it can. */
export const defaultRefusal = (stage: Pick<StageLike, "category" | "requiresApproval">): StageRefusal | null =>
  !defaultKindAllowed(stage.category) ? "STAGE_DEFAULT_KIND" : stage.requiresApproval ? "STAGE_DEFAULT_GATED" : null;

/**
 * A name as it will be stored, or the refusal. Trimmed; never blank (and
 * so never cleared — the migration's one-way trigger is the belt); at most
 * 40 characters; unique among the OTHER stages' stored names, ignoring
 * case. A stored name equal to a seeded default's translation is not
 * refused (design §3.6): the member sees the twin and can rename it.
 */
export function checkStageName(
  raw: string,
  list: readonly StageLike[],
  exceptId: string | null,
): { ok: true; name: string } | { ok: false; code: StageRefusal } {
  const cleaned = singleLineName(raw, MAX_STAGE_NAME_LENGTH);
  if (!cleaned.ok) return cleaned;
  const name = cleaned.name;
  const folded = name.toLocaleLowerCase("sv");
  const taken = list.some(
    (s) => s.id !== exceptId && s.name !== null && s.name.toLocaleLowerCase("sv") === folded,
  );
  return taken ? { ok: false, code: "STAGE_NAME_TAKEN" } : { ok: true, name };
}

/** Whether another stage fits (TRIAGE not counted). */
export const canAddStage = (list: readonly StageLike[]): boolean => editableStages(list).length < MAX_STAGES;

/**
 * Where a NEW stage of `kind` goes: at the end of its kind — right after
 * the last stage of that kind, or, when it has none, right before the
 * first stage of a later kind (TRIAGE included, which is why it stays
 * last). Always between two LIST neighbours, so a list whose ranks were
 * somehow not grouped by kind still gets a valid rank.
 */
export function insertIndex(list: readonly StageLike[], kind: StageKind): number {
  const k = kindIndex(kind);
  let lastOfKind = -1;
  list.forEach((s, i) => {
    if (s.category === kind) lastOfKind = i;
  });
  if (lastOfKind >= 0) return lastOfKind + 1;
  const firstLater = list.findIndex((s) => kindIndex(s.category) > k);
  return firstLater >= 0 ? firstLater : list.length;
}

/**
 * Moving a stage up or down WITHIN ITS KIND (design §3.1 — the kinds stay
 * in order). Answers the position to insert it at in the list WITHOUT it,
 * or null when it is already first (or last) of its kind.
 */
export function moveIndex(list: readonly StageLike[], id: string, dir: "up" | "down"): number | null {
  const self = list.find((s) => s.id === id);
  if (!self || self.category === "TRIAGE") return null;
  const siblings = list.filter((s) => s.category === self.category);
  const i = siblings.indexOf(self);
  const rest = list.filter((s) => s.id !== id);
  if (dir === "up") {
    if (i <= 0) return null;
    return rest.indexOf(siblings[i - 1]!);
  }
  if (i >= siblings.length - 1) return null;
  return rest.indexOf(siblings[i + 1]!) + 1;
}

export const canMove = (list: readonly StageLike[], id: string, dir: "up" | "down"): boolean =>
  moveIndex(list, id, dir) !== null;

/** The stages a removed stage's tasks may go to: the others of its kind, in board order. */
export const removalTargets = <S extends StageLike>(list: readonly S[], id: string): S[] => {
  const self = list.find((s) => s.id === id);
  return self ? list.filter((s) => s.id !== id && s.category === self.category) : [];
};

/**
 * Where "new tasks start here" goes when the stage carrying it is removed:
 * the member's pick when it may carry the mark, else the first other stage
 * of the kind that may (`canStartHere` — not gated), else nowhere.
 */
export function defaultHeir<S extends StageLike>(list: readonly S[], id: string, pickId: string | null): S | null {
  const candidates = removalTargets(list, id).filter(canStartHere);
  return candidates.find((s) => s.id === pickId) ?? candidates[0] ?? null;
}

/**
 * Whether a stage may go, given how many tasks point at it (design §3.2):
 * To do, In progress, Done and Cancelled each keep at least one stage —
 * the triage Decline needs a Cancelled one, reports need Done, a new task
 * needs a To do or Backlog default — and the last Backlog stage may go
 * only when nothing points at it, because its tasks would have nowhere of
 * their own kind to move to. `tasks` counts every task pointing at the
 * stage; `binned` says how many of those are deleted (in the bin), which
 * the page's count leaves out — so a last Backlog stage whose only tasks
 * are deleted ones gets its own answer (`STAGE_IN_BIN`) rather than "move
 * its tasks first", which nobody could do (the code review's LOW).
 */
export function removalRefusal(
  list: readonly StageLike[],
  id: string,
  tasks: number,
  binned = 0,
): StageRefusal | null {
  const self = list.find((s) => s.id === id);
  if (!self || self.category === "TRIAGE") return "INVALID_INPUT";
  if (removalTargets(list, id).length === 0) {
    if (self.category !== "BACKLOG") return "STAGE_LAST_OF_KIND";
    if (tasks - binned > 0) return "STAGE_NOT_EMPTY";
    if (binned > 0) return "STAGE_IN_BIN";
  }
  // The mark must have somewhere to go: another stage of the kind that may
  // carry it. Choose another stage for new tasks first.
  if (self.isDefault && defaultHeir(list, id, null) === null) return "STAGE_IS_DEFAULT";
  if (tasks > MAX_STAGE_REMOVE_TASKS) return "STAGE_TOO_FULL";
  return null;
}

/**
 * Whether a whole set obeys the rules — what the preset's parse checks
 * before a project is seeded from it (design §4: a tampered or old row
 * falls back to Fortleva's built-in set, never trusted). In list order:
 * the kinds never go backwards; each of To do, In progress, Done and
 * Cancelled has a stage; exactly one default, of kind Backlog or To do and
 * not gated;
 * at most MAX_STAGES; every stage named or seeded, names unique ignoring
 * case; a seed key at most once and only in its own built-in kind (a
 * "To do" seed in the Done kind would be translated as To do and be done).
 */
export function setIsValid(list: readonly StageLike[]): boolean {
  const stages = editableStages(list);
  if (stages.length === 0 || stages.length > MAX_STAGES) return false;
  for (let i = 1; i < stages.length; i++) {
    if (kindIndex(stages[i]!.category) < kindIndex(stages[i - 1]!.category)) return false;
  }
  for (const k of ["TODO", "IN_PROGRESS", "DONE", "CANCELLED"] as const) {
    if (!stages.some((s) => s.category === k)) return false;
  }
  const defaults = stages.filter((s) => s.isDefault);
  if (defaults.length !== 1 || !canStartHere(defaults[0]!)) return false;
  const names = new Set<string>();
  const seeds = new Set<string>();
  for (const s of stages) {
    if (s.name === null && s.seedKey === null) return false;
    if (s.name !== null) {
      const checked = checkStageName(s.name, [], null);
      if (!checked.ok || checked.name !== s.name) return false;
      const folded = s.name.toLocaleLowerCase("sv");
      if (names.has(folded)) return false;
      names.add(folded);
    }
    if (s.seedKey !== null) {
      const builtIn = BUILT_IN_STAGES.find((b) => b.seedKey === s.seedKey);
      if (!builtIn || builtIn.category !== s.category || seeds.has(s.seedKey)) return false;
      seeds.add(s.seedKey);
    }
  }
  return true;
}

/**
 * MOVING A TASK — ITS PURE HALF (slice 131; founder decision C108 — design
 * docs/research/2026-10-17-slice-131-move-a-task-design.md §3.2). No
 * database: the bounds, and which of the target project's stages a moved
 * task lands in. Pinned by `move-plan.test.ts`.
 */

/** At most this many tasks under the one moved — the copy's and the repeat's bound. */
export const MOVE_MAX_SUBTASKS = 100;
/** At most this many time entries on the moved tasks — `repriceRateCard`'s batch. */
export const MOVE_MAX_ENTRIES = 5000;

export type StageRef = {
  readonly id: string;
  /** A stage still wearing its seeded name has none; a non-null name IS the rename. */
  readonly name: string | null;
  readonly seedKey: string | null;
  readonly category: string;
  /** Column order (text, COLLATE "C"): the lowest comes first. */
  readonly rank: string;
  readonly isDefault: boolean;
};

/**
 * The target project's stage for a moved task (design §3.2), first match
 * wins — and ALWAYS one of the same KIND when the target has one, so a move
 * never finishes, reopens or cancels a task (both reviews' LOW: a name match
 * across kinds put an open task in Done without `transitionState`):
 *   1. the stage of the same kind with the same NAME, ignoring case;
 *   2. the stage of the same kind seeded as the same default (`seedKey`) —
 *      "In progress" is "In progress" whatever either project calls it;
 *   3. the target's first stage (by column order) of the same kind;
 *   4. where new tasks start — only when the target has no stage of that
 *      kind at all (a project may drop its Backlog, C104).
 * Returns null only for a target with no stages at all, which
 * `ensureProjectStates` rules out before the move reads them.
 */
export function stageInTarget(
  from: { readonly name: string | null; readonly seedKey: string | null; readonly category: string },
  targets: readonly StageRef[],
): string | null {
  const sameKind = targets
    .filter((s) => s.category === from.category)
    .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0));
  const name = from.name?.trim().toLocaleLowerCase();
  if (name) {
    const hit = sameKind.find((s) => s.name !== null && s.name.trim().toLocaleLowerCase() === name);
    if (hit) return hit.id;
  }
  if (from.seedKey !== null) {
    const hit = sameKind.find((s) => s.seedKey === from.seedKey);
    if (hit) return hit.id;
  }
  if (sameKind[0]) return sameKind[0].id;
  return targets.find((s) => s.isDefault)?.id ?? null;
}

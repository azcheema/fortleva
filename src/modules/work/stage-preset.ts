import { z } from "zod";

import type { TenantDb } from "@/db";
import { STATE_SEED_KEYS, type StateSeedKey } from "@/lib/enum-map";
import {
  BUILT_IN_STAGES,
  MAX_STAGES,
  STAGE_KINDS,
  setIsValid,
  type StageKind,
} from "@/lib/stage-rules";

/**
 * THE WORKSPACE'S DEFAULT STAGES — the read side (slice 123, C99 (a);
 * design doc §4). One `workflow_preset` row per tenant, `name = 'default'`
 * (never shown), whose `states` is the ordered list a NEW project copies
 * (`ensureProjectStates`). No row means Fortleva's built-in set.
 *
 * Its own file, apart from the editor (`stage-editor.ts`), because
 * `states.ts` reads it while seeding and the editor imports `states.ts`:
 * one direction, no cycle.
 *
 * NEVER TRUSTED. The row is parsed with zod and checked against the stage
 * rules (`setIsValid`) on every read; anything that fails — an old shape,
 * a hand-edited row — reads as the built-in set, so a project can never
 * be seeded with a set the board cannot draw or the triage cannot use.
 */

export const PRESET_NAME = "default";

/** One stage of the workspace default. `key` is what the editor's actions address. */
export type PresetStage = {
  key: string;
  /** NULL = still the built-in default, shown in the viewer's language (as on a project). */
  name: string | null;
  seedKey: StateSeedKey | null;
  category: StageKind;
  isDefault: boolean;
  requiresApproval: boolean;
};

const EDITABLE_SEED_KEYS = STATE_SEED_KEYS.filter((k) => k !== "TRIAGE") as [
  Exclude<StateSeedKey, "TRIAGE">,
  ...Exclude<StateSeedKey, "TRIAGE">[],
];

const presetSchema = z
  .array(
    z
      .object({
        key: z.string().min(1).max(64),
        name: z.string().max(200).nullable(),
        seedKey: z.enum(EDITABLE_SEED_KEYS).nullable(),
        category: z.enum(STAGE_KINDS),
        isDefault: z.boolean(),
        requiresApproval: z.boolean(),
      })
      .strict(),
  )
  .max(MAX_STAGES);

/** The built-in set as preset entries. Keys are stable, so the editor can address a stage before the row exists. */
export const builtInPreset = (): PresetStage[] =>
  BUILT_IN_STAGES.map((s) => ({
    key: `seed-${s.seedKey}`,
    name: null,
    seedKey: s.seedKey,
    category: s.category,
    isDefault: s.isDefault,
    requiresApproval: s.requiresApproval,
  }));

/** A stored value as a valid set, or null. Keys must be unique too — they are the editor's addresses. */
export function parsePreset(value: unknown): PresetStage[] | null {
  const parsed = presetSchema.safeParse(value);
  if (!parsed.success) return null;
  const list = parsed.data;
  if (new Set(list.map((s) => s.key)).size !== list.length) return null;
  return setIsValid(list.map((s) => ({ ...s, id: s.key }))) ? list : null;
}

/**
 * The workspace's default set. `custom` is true only when a VALID row is
 * stored — the Settings page says "Fortleva's original stages" otherwise,
 * and offers no Restore.
 */
export async function readWorkspaceStages(
  tx: TenantDb,
  tenantId: string,
): Promise<{ stages: PresetStage[]; custom: boolean }> {
  const row = await tx.workflowPreset.findFirst({
    where: { tenantId, name: PRESET_NAME },
    select: { states: true },
  });
  const stages = row ? parsePreset(row.states) : null;
  // The database's own fold too (below): a set it would call two names
  // alike would fail the copy on `workflow_state_name_ci_key` — every new
  // project's first board read, until someone fixed the default.
  return stages && (await namesDistinctToDb(tx, stages))
    ? { stages, custom: true }
    : { stages: builtInPreset(), custom: false };
}

/**
 * Whether the set's stored names are distinct under POSTGRES's `lower()` —
 * the fold `workflow_state_name_ci_key` uses, which JavaScript's
 * lower-casing does not always match (a final sigma, a dotted capital I;
 * both reviews' LOW). `setIsValid`'s own check is the early, cheap one; this
 * is the one that decides. One statement, no rows read.
 */
export async function namesDistinctToDb(tx: TenantDb, stages: readonly { name: string | null }[]): Promise<boolean> {
  const names = stages.flatMap((s) => (s.name === null ? [] : [s.name]));
  if (names.length < 2) return true;
  const [row] = await tx.$queryRaw<{ all_distinct: boolean }[]>`
    SELECT count(DISTINCT lower(n)) = count(*) AS all_distinct FROM unnest(${names}::text[]) AS n`;
  return row?.all_distinct === true;
}

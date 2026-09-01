import type { StateSeedKey } from "./enum-map";

/**
 * What a workflow state is CALLED on screen (DATA_MODEL §6.14, amended
 * 2026-09-01).
 *
 * The rule, and it is one line: a state still wearing its seeded default
 * has a NULL `name` and renders through i18n **in the viewer's
 * language**; a state with a name renders that name, verbatim, forever.
 * Writing a name IS the rename. "Renamed ⇒ tenant text" is enforced by
 * the WRITE PATH rather than by the schema: nothing writes a name except
 * a rename, but `SET name = NULL` would put a state back into
 * translate-mode, so the future state editor must refuse to clear one.
 *
 * Why this is a plain function taking a translator, rather than
 * something the work service does: nothing under `src/modules` imports
 * next-intl, and `listItems` runs outside any request scope — three
 * dbtest suites and a server action call it — where there is no locale
 * to resolve against. So the service carries the raw pair and the SERVER PAGE
 * resolves it once, at the boundary, before any client component sees
 * it. Every downstream prop stays a plain `string`.
 *
 * The empty-string fallback is unreachable by construction: the
 * migration's `workflow_state_name_or_seed_key` CHECK refuses a row with
 * neither. It is here so that a future column change cannot turn a bad
 * row into a crash inside a render.
 */
export function stateLabel(
  source: { readonly name: string | null; readonly seedKey: StateSeedKey | null },
  t: (key: StateSeedKey) => string,
): string {
  if (source.name !== null) return source.name;
  return source.seedKey ? t(source.seedKey) : "";
}

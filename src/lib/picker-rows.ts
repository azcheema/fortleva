import { matchesQuery } from "./text-match";

/**
 * `<PropertyPicker>`'s row model, pure (no React, no directive) so the
 * decisions that decide what a bare Enter commits are table-tested
 * rather than rediscovered in a browser: WHICH rows exist for a query,
 * WHICH row is highlighted on open, WHETHER a highlight survives a change
 * underneath an open picker, and the cmdk values no option may ever carry.
 */

type RowLike = { value: string; label: string; keywords?: string; group?: string; disabled?: boolean };

/**
 * THE RESERVED cmdk VALUES. cmdk tracks its selection as ONE string and
 * lights every row whose value equals it, so the picker needs strings
 * that can never be an option's:
 *
 * · `NO_HIGHLIGHT` seeds a selection that matches no row. Nothing is
 *   lit, no row is `aria-selected`, and Enter finds nothing to dispatch
 *   to (cmdk's Enter queries `[aria-selected="true"]`). cmdk runs its
 *   first-row pick on an item mount only for a FALSY selection, so this
 *   one survives every mount; the first ArrowDown walks from "no row" to
 *   the first enabled row. `aria-activedescendant` is unset on OPEN (cmdk
 *   assigns it only when its own code changes the selection), but NOT
 *   after a re-seed: a controlled value never assigns it, so it keeps
 *   naming the last row the member steered to — or a node that has left
 *   the DOM — until they steer again (property-picker.tsx, WHAT IS
 *   ANNOUNCED — part of the recorded defect).
 * · `derivedRowValue(v)` is the derived row's cmdk value. It differs from
 *   `v` so that text deriving the value of the lit fixed row still
 *   CHANGES the selection string, and `aria-selected` moves to the
 *   derived row through a real selection change rather than by the
 *   coincidence of an unchanged string. It does NOT make
 *   `aria-activedescendant` follow: measured in Chromium, cmdk assigns
 *   that attribute for its own picks from a DOM that has not re-rendered
 *   yet (property-picker.tsx, WHAT IS ANNOUNCED — a recorded defect).
 *   The row still commits `v` — its `onSelect` closes over it — so the
 *   namespace never reaches a caller.
 *
 * Collision-proof by construction rather than by luck: both contain a
 * SPACE, and an option value may not (`assertPickerValue`, enforced by
 * `pickerRows` on every render). A value is an id or an enum token,
 * never a label, and cmdk `trim()`s every value, so whitespace in one
 * was already a bug. Neither reserved string starts or ends with a
 * space, so that trim leaves both intact.
 */
export const NO_HIGHLIGHT = "picker: no highlight";

export const derivedRowValue = (value: string): string => `picker: derived ${value}`;

/** Throws for a value that could collide with a reserved one, or that cmdk would mangle: empty, or containing whitespace. */
export function assertPickerValue(value: string): void {
  if (value === "" || /\s/.test(value)) {
    throw new Error(
      `PropertyPicker: option value ${JSON.stringify(value)} is empty or contains whitespace. A value is an id or an enum token, never a label.`,
    );
  }
}

export type PickerRows<O extends RowLike> = {
  /** The one row parsed from the typed query, rendered FIRST and never filtered. */
  derived: O | null;
  /** The fixed options that match, grouped in FIRST-SEEN order, array order kept within a group. */
  groups: { heading: string | undefined; options: O[] }[];
  /** No derived row and no matching fixed row — the empty state speaks. */
  empty: boolean;
};

/**
 * The rows for a query.
 *
 * · Every value is checked against the reserved ones first, the derived
 *   row's included.
 * · `derive` is never called for a blank query: a derived row there
 *   would be a value the member never typed.
 * · A DISABLED derived row is treated as none. cmdk's `W()` skips a
 *   disabled item when it selects the first row, so a disabled derived
 *   row would leave Enter committing the NEXT row — a value the member
 *   did not aim at.
 * · A fixed option carrying the derived row's (underlying) value is
 *   dropped: one row per value, and the row the member typed is the one
 *   they aimed at. The two no longer share a cmdk value
 *   (`derivedRowValue`), but a list that offers "2h" and "Set estimate to
 *   2h" side by side says one thing twice.
 * · Fixed rows are still filtered while a derived row exists, and are
 *   never re-sorted: the caller's array order is the meaning (states
 *   arrive by rank).
 */
export function pickerRows<O extends RowLike>(
  options: readonly O[],
  query: string,
  derive?: (query: string) => O | null,
): PickerRows<O> {
  for (const option of options) assertPickerValue(option.value);
  const parsed = query.trim() === "" ? null : (derive?.(query) ?? null);
  if (parsed) assertPickerValue(parsed.value);
  const derived = parsed && !parsed.disabled ? parsed : null;

  const fixed = options.filter(
    (o) => o.value !== derived?.value && matchesQuery(`${o.label} ${o.keywords ?? ""}`, query),
  );

  const groups: { heading: string | undefined; options: O[] }[] = [];
  for (const option of fixed) {
    const last = groups[groups.length - 1];
    if (last && last.heading === option.group) last.options.push(option);
    else groups.push({ heading: option.group, options: [option] });
  }

  return { derived, groups, empty: derived === null && fixed.length === 0 };
}

const currentOption = <O extends { value: string }>(options: readonly O[], value: string | null) =>
  value === null ? undefined : options.find((o) => o.value === value);

/**
 * The picker's highlight seed on OPEN — what a bare Enter acts on before
 * the member has touched a key. Never a value the member did not choose:
 *
 * · `""` when the current row is the first enabled row. cmdk's item
 *   mount then runs its own first-row pick through `setState("value")`,
 *   which lights it — and it is the current row, so Enter is a no-op.
 *   (Measured: that pick leaves `aria-activedescendant` unset, so the
 *   row is not announced until the member steers — a recorded defect,
 *   property-picker.tsx WHAT IS ANNOUNCED.)
 * · The current value when it is enabled but NOT first (P's enum order,
 *   S's rank order). The controlled seed lights the row at once, but cmdk
 *   leaves `aria-activedescendant` unset until the member's first
 *   ArrowUp/ArrowDown/Home/End that moves the selection — a recorded
 *   residue. Enter commits the current value: a no-op.
 * · `NO_HIGHLIGHT` when the current row is DISABLED (S on TRIAGE, or a
 *   gated Done under a non-approver) or absent. `""` there let cmdk light
 *   the first ENABLED row, and a bare Enter moved the task to a state
 *   nobody chose; seeding the disabled row itself would mark it
 *   `aria-selected` on a node cmdk gave no select listener. Nothing lit,
 *   Enter inert, and the first ArrowDown lands on the first enabled row.
 */
export function initialHighlight(
  options: readonly { value: string; disabled?: boolean }[],
  value: string | null,
): string {
  const current = currentOption(options, value);
  if (!current || current.disabled) return NO_HIGHLIGHT;
  const firstEnabled = options.find((o) => !o.disabled);
  return current === firstEnabled ? "" : current.value;
}

/**
 * The RE-SEED: the highlight a change under an open picker falls back to
 * when the old one does not survive it (`highlightAfterChange`) — the new
 * current value when that row is enabled, otherwise `NO_HIGHLIGHT`.
 *
 * Never `""`: cmdk runs its first-row pick only when an item mounts or
 * the lit item unmounts, so `""` would light a row after some refreshes
 * and nothing after others.
 */
export function reseedHighlight(
  options: readonly { value: string; disabled?: boolean }[],
  value: string | null,
): string {
  const current = currentOption(options, value);
  return current && !current.disabled ? current.value : NO_HIGHLIGHT;
}

/**
 * What an open picker's highlight was last settled against: the value,
 * and every field of every option that decides WHETHER and WHERE a row
 * renders — value, label and keywords (the query matches on them), group
 * (a group is keyed by its heading) — plus whether Enter can act on it.
 *
 * The QUERY is deliberately not part of it. Typing is steering, never a
 * change underneath the member, so it can never re-seed. Neither is the
 * options array's identity, nor `icon`, `meta` or `testId`: E and D build
 * a fresh array on every render.
 */
export type HighlightBasis = {
  value: string | null;
  rows: readonly RowLike[];
  /** A MULTI property's applied values, sorted — null for a single-value picker. */
  selected: readonly string[] | null;
};
export const highlightBasis = (
  options: readonly RowLike[],
  value: string | null,
  selected?: ReadonlySet<string>,
): HighlightBasis => ({
  value,
  rows: options.map(({ value: v, label, keywords, group, disabled }) => ({ value: v, label, keywords, group, disabled })),
  selected: selected ? [...selected].sort() : null,
});

const sameMembers = (a: readonly string[] | null, b: ReadonlySet<string> | undefined): boolean => {
  if (a === null) return b === undefined;
  if (b === undefined || a.length !== b.size) return false;
  return a.every((v) => b.has(v));
};

/** True when `value`, the applied set, or any basis field of any option differs from `basis` — the only time `highlightAfterChange` runs. */
export function highlightBasisChanged(
  basis: HighlightBasis,
  options: readonly RowLike[],
  value: string | null,
  selected?: ReadonlySet<string>,
): boolean {
  if (basis.value !== value || basis.rows.length !== options.length) return true;
  if (!sameMembers(basis.selected, selected)) return true;
  return options.some((o, i) => {
    const was = basis.rows[i]!;
    return (
      was.value !== o.value ||
      was.label !== o.label ||
      (was.keywords ?? "") !== (o.keywords ?? "") ||
      was.group !== o.group ||
      Boolean(was.disabled) !== Boolean(o.disabled)
    );
  });
}

/**
 * Whether the highlight survives a change UNDER an open picker — the
 * board's poll refreshing the peek after a colleague's edit, or after a
 * change to what the member may pick. `prev` is the basis it was settled
 * against; `next.rows` is this render's `pickerRows` for the unchanged
 * query.
 *
 * A STEERED highlight is the member's choice, and it stays when:
 *
 * · it is the typed DERIVED row this render still shows (its cmdk value
 *   is reserved, so the string names that row and nothing else); or
 * · it names a fixed row that is still RENDERED for the query, still
 *   enabled and in the SAME group — and is not the OLD value's row.
 *
 * Everything else is re-seeded (`reseedHighlight`) and un-steered:
 *
 * · An UN-STEERED highlight is a seed, or a row cmdk lit by itself: it
 *   belonged to the list as it was. Left in place, a bare Enter wrote the
 *   old value's row over a colleague's edit.
 * · The OLD value's row was lit because it WAS the value, steered or not.
 * · A row that left the list, fell out of the query on a rename, or moved
 *   to another group UNMOUNTS. cmdk then lights its first enabled row BY
 *   ITSELF and reports it through `onValueChange`, and a `steered` that
 *   outlived its row would let Enter commit that pick — a state nobody
 *   chose.
 * · A row that went disabled stays lit with no select listener, so Enter
 *   on it does nothing at all.
 * · For a MULTI property (`selected`), a lit row whose MEMBERSHIP flipped
 *   underneath the member is no longer theirs: a pick there is a TOGGLE,
 *   so an Enter steered to "add Bug" the instant a colleague added Bug
 *   would REMOVE it — the one place a survived highlight is a destructive
 *   write rather than a no-op (slice 12's review). Another row's
 *   membership changing leaves this one alone.
 *
 * Re-seeding EVERY highlight on a value change (the rule this replaced)
 * dropped a pick the change had nothing to do with: after a colleague's
 * edit, Enter committed the new value as a no-op and closed without a
 * word.
 *
 * (A heading-less group is keyed by its INDEX, so a caller mixing grouped
 * and ungrouped rows could remount a row without its group changing here.
 * None does: every caller's rows all have a heading, or none has.)
 */
export function highlightAfterChange<O extends RowLike>(
  prev: HighlightBasis,
  next: { options: readonly O[]; value: string | null; rows: PickerRows<O>; selected?: ReadonlySet<string> },
  lit: { highlight: string; steered: boolean },
): { highlight: string; steered: boolean } {
  if (lit.steered && lit.highlight !== prev.value) {
    const { derived, groups } = next.rows;
    if (derived && lit.highlight === derivedRowValue(derived.value)) return lit;
    const before = prev.rows.find((r) => r.value === lit.highlight);
    const after = groups.flatMap((g) => g.options).find((o) => o.value === lit.highlight);
    const wasApplied = prev.selected?.includes(lit.highlight) ?? false;
    const isApplied = next.selected?.has(lit.highlight) ?? false;
    if (before && after && !after.disabled && after.group === before.group && wasApplied === isApplied) return lit;
  }
  return { highlight: reseedHighlight(next.options, next.value), steered: false };
}

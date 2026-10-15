import type { CSSProperties } from "react";

/**
 * A label's colour (slice 123, C99 (b)): seven TOKEN NAMES, stored as the
 * name and never as a hex literal (UI.md §10). The migration's
 * `label_color_token` CHECK holds the same list, so a value the UI cannot
 * render cannot be stored; a new colour is that CHECK and this list,
 * together.
 *
 * Each maps to one of the twelve `--entity-*` identity hues
 * (`entity-color.ts`, DESIGN SPEC §2.6), which globals.css already anchors
 * at 3:1 against every surface of both themes — chosen far apart on the
 * wheel (15°, 45°, 105°, 168°, 225°, 285°, 345°). Identity, never status:
 * the colour is a DOT inside the neutral outline chip, never a filled
 * chip (the chip pin in `label-chips.tsx`), and the name beside it always
 * carries the meaning.
 *
 * Pure and RSC-safe, with no directive: a server page reads it too (the
 * AGENTS.md "use client" constant trap).
 */
export const LABEL_COLORS = ["red", "orange", "olive", "teal", "blue", "purple", "pink"] as const;
export type LabelColor = (typeof LABEL_COLORS)[number];

const ENTITY_SLOT: Record<LabelColor, number> = {
  red: 0,
  orange: 1,
  olive: 3,
  teal: 5,
  blue: 7,
  purple: 9,
  pink: 11,
};

export const isLabelColor = (v: unknown): v is LabelColor =>
  typeof v === "string" && Object.hasOwn(ENTITY_SLOT, v);

/**
 * The dot's custom property — `style={labelColorStyle(c)}` with
 * `bg-(--entity)` — or null for "no colour" (and for any stored value the
 * palette does not know, which the CHECK makes unreachable).
 */
export function labelColorStyle(color: string | null | undefined): CSSProperties | null {
  if (!isLabelColor(color)) return null;
  return { "--entity": `var(--entity-${ENTITY_SLOT[color]})` } as CSSProperties;
}

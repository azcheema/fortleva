/**
 * The file field's naming and sizing rules (UI.md §10.15 pattern 4).
 *
 * The native `<input type="file">` renders an OS widget that no design
 * system can restyle — "Choose File / No file chosen" in the browser's
 * own type, at the browser's own contrast. `<FileDropField>` hides it
 * (sr-only, still focusable) and states the choice itself, which means
 * the product now owns the two strings the OS used to own: the file's
 * name and its size. Both are formatted here.
 */

import { formatBytes } from "./format";

export type ChosenFile = { name: string; size: number };

/** The first file of a picker or a drop, or null — never `undefined`. */
export function chosenFileFrom(files: FileList | null | undefined): ChosenFile | null {
  const file = files?.[0];
  return file ? { name: file.name, size: file.size } : null;
}

/**
 * "quarterly-report.pdf · 1,2 MB" — locale-formatted, because sv-SE
 * writes the decimal comma and groups with U+00A0.
 */
export const describeChosenFile = (locale: string, chosen: ChosenFile): string =>
  `${chosen.name} · ${formatBytes(locale, chosen.size)}`;

/**
 * A filename truncates in the MIDDLE, never at the end: the extension
 * is the half a reader checks. CSS `truncate` would eat it, so the
 * ellipsis is placed here and the full name goes in `title`.
 */
export function truncateFileName(name: string, max = 42): string {
  if (max <= 1) return "…";
  if (name.length <= max) return name;
  const dot = name.lastIndexOf(".");
  // A dotfile or an extension longer than the budget: plain head cut.
  const ext = dot > 0 && name.length - dot <= 8 ? name.slice(dot) : "";
  const head = max - ext.length - 1;
  if (head < 1) return `${name.slice(0, max - 1)}…`;
  return `${name.slice(0, head)}…${ext}`;
}

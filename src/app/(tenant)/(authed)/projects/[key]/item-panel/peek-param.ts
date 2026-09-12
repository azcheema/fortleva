/**
 * The peek's URL contract: `?item=KEY-123` (UI.md §5.4 — every peek is
 * a link). Returns the item number when the param names THIS project's
 * key (case-insensitively), else null — a foreign or malformed param is
 * ignored, never an error.
 */
export function peekItemNumber(param: string | undefined, projectKey: string): number | null {
  if (!param) return null;
  const m = /^([A-Za-z][A-Za-z0-9]*)-(\d{1,9})$/.exec(param);
  if (!m || m[1]!.toUpperCase() !== projectKey.toUpperCase()) return null;
  return Number(m[2]);
}

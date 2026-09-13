import type { ActionResult, FormResult } from "./server-actions";

/**
 * Whether a successful action result WROTE anything.
 *
 * The item property setters' `ActionResult` carries the canonical row
 * with `changed`, and `changed: false` means a colleague had already
 * made the change: the server wrote nothing, so nothing was "saved" by
 * this member, and a "Saved" toast would be the sentence
 * use-panel-commit.tsx refuses. A `FormResult`, or a canonical row that
 * carries no flag (a move, a create), counts as a write; a failure never
 * does. Directive-free, and type-only over server-actions.ts, so a client
 * component can import it without dragging the server catalogue along.
 */
export const wroteSomething = (r: FormResult | ActionResult<unknown>): boolean => {
  if (!r.ok) return false;
  if (!("value" in r)) return true;
  const value: unknown = r.value;
  if (typeof value !== "object" || value === null || !("changed" in value)) return true;
  return (value as { changed: unknown }).changed !== false;
};

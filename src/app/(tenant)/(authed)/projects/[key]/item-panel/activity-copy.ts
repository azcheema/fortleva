import type { VisibilityValue } from "@/components/semantic";
import { PRIORITIES, type Priority } from "@/lib/enum-map";
import { isIsoDate } from "@/lib/week";
import type { ActivityEntry } from "@/modules/work";

/**
 * What a history row SAYS — the pure half of the Activity section
 * (`activity-section.tsx` renders it). A row is a field and four
 * nullable columns (DATA_MODEL §6.14); this turns that into one of
 * sixteen sentences with its display values already formatted, so the
 * component is a switch over message keys and every branch is a unit
 * test here rather than a screenshot. The lookups are the section's
 * formatters — a state name from the project's states, a priority
 * label, a duration in the tenant's style, a day, a visibility token, a
 * member's name — handed in, so this module knows no locale and no
 * catalogue.
 *
 * The value columns are TEXT the writers encode ad hoc (`items.ts`:
 * `estimateMinutes.toString()`, `targetDate.toISOString().slice(0, 10)`,
 * enums as their names), so every parser here is strict about the shape
 * it accepts and answers anything else with the `fieldChanged` fallback
 * — a value it cannot read must never reach a formatter that throws on
 * it (`Intl.DateTimeFormat` on an invalid date takes the page down).
 * The writers' encodings are pinned by a dbtest against the real
 * `updateItemFields`, so a writer that changes format fails a test
 * rather than quietly degrading every row to the fallback.
 *
 * A row this slice has no sentence for (a milestone, a label, a comment
 * — each arrives with its own slice and adds its case here) renders as
 * "changed <field>" rather than nothing: a change a member cannot read
 * is still a change that happened.
 */
export type ActivityLookups = {
  /** The state a ref names; falls back to the CATEGORY the row carries when the state is gone. */
  stateName: (ref: string | null, category: string | null) => string;
  priority: (value: Priority) => string;
  duration: (minutes: number) => string;
  day: (iso: string) => string;
  visibility: (value: VisibilityValue) => string;
  /** A resolved member name, or the "Unknown" word for an id that no longer resolves. */
  member: (name: string | null) => string;
};

export type ActivitySentence =
  | { key: "created" }
  | { key: "descriptionEdited" }
  | { key: "titleChanged"; from: string; to: string }
  | { key: "priorityChanged"; from: string; to: string }
  | { key: "estimateSet"; to: string }
  | { key: "estimateChanged"; from: string; to: string }
  | { key: "estimateCleared"; from: string }
  | { key: "dueDateSet"; to: string }
  | { key: "dueDateChanged"; from: string; to: string }
  | { key: "dueDateCleared"; from: string }
  | { key: "assigned"; to: string }
  | { key: "reassigned"; from: string; to: string }
  | { key: "unassigned"; from: string }
  | { key: "stateChanged"; from: string; to: string }
  | { key: "visibilityChanged"; to: string }
  | { key: "commented" }
  | { key: "commentEdited" }
  | { key: "commentDeleted" }
  | { key: "commentVisibilityChanged"; to: string }
  | { key: "fieldChanged"; field: string };

export type ActivityRow = Pick<
  ActivityEntry,
  "field" | "oldValue" | "newValue" | "oldRef" | "newRef" | "oldRefName" | "newRefName"
>;

/** The two enum guards the sentence builder and the rail's glyph picker share — ONE definition each. */
export const isPriority = (v: string | null): v is Priority =>
  v !== null && (PRIORITIES as readonly string[]).includes(v);

export const isVisibility = (v: string | null): v is VisibilityValue =>
  v === "INTERNAL" || v === "CLIENT_VISIBLE";

/** The `estimate` columns hold whole minutes as decimal digits (items.ts) — nothing else is minutes. */
const MINUTES_RE = /^\d+$/;
const minutes = (v: string | null): number | null => {
  if (v === null || !MINUTES_RE.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : null;
};

/** The `targetDate` columns hold "YYYY-MM-DD" (items.ts) — a real calendar day, or nothing. */
const day = (v: string | null): string | null => (isIsoDate(v) ? v : null);

export function activitySentence(row: ActivityRow, look: ActivityLookups): ActivitySentence {
  const fallback: ActivitySentence = { key: "fieldChanged", field: row.field };
  switch (row.field) {
    case "created":
      return { key: "created" };
    case "description":
      return { key: "descriptionEdited" };
    case "title":
      if (row.oldValue === null && row.newValue === null) return fallback;
      return { key: "titleChanged", from: row.oldValue ?? "", to: row.newValue ?? "" };
    case "priority":
      if (!isPriority(row.oldValue) || !isPriority(row.newValue)) return fallback;
      return { key: "priorityChanged", from: look.priority(row.oldValue), to: look.priority(row.newValue) };
    case "estimate": {
      const from = minutes(row.oldValue);
      const to = minutes(row.newValue);
      if (to !== null && from !== null) return { key: "estimateChanged", from: look.duration(from), to: look.duration(to) };
      if (to !== null) return { key: "estimateSet", to: look.duration(to) };
      if (from !== null) return { key: "estimateCleared", from: look.duration(from) };
      return fallback;
    }
    case "targetDate": {
      const from = day(row.oldValue);
      const to = day(row.newValue);
      if (to !== null && from !== null) return { key: "dueDateChanged", from: look.day(from), to: look.day(to) };
      if (to !== null) return { key: "dueDateSet", to: look.day(to) };
      if (from !== null) return { key: "dueDateCleared", from: look.day(from) };
      return fallback;
    }
    case "assignee": {
      // A ref is the fact; the name is what it resolved to. A ref whose
      // member is gone still reads as a person ("Unknown"), never as
      // nobody — "unassigned" would be a lie about a real hand-over.
      const from = row.oldRef ? look.member(row.oldRefName) : null;
      const to = row.newRef ? look.member(row.newRefName) : null;
      if (to !== null && from !== null) return { key: "reassigned", from, to };
      if (to !== null) return { key: "assigned", to };
      if (from !== null) return { key: "unassigned", from };
      return fallback;
    }
    case "stateCategory":
      if (row.oldRef === null && row.oldValue === null) return fallback;
      if (row.newRef === null && row.newValue === null) return fallback;
      return {
        key: "stateChanged",
        from: look.stateName(row.oldRef, row.oldValue),
        to: look.stateName(row.newRef, row.newValue),
      };
    case "visibility":
      if (!isVisibility(row.newValue)) return fallback;
      return { key: "visibilityChanged", to: look.visibility(row.newValue) };
    // The comment rows (comments.ts, slice 10): `newValue` is the verb —
    // created / edited / deleted — and `commentId` the soft pointer the
    // panel never resolves (a deleted comment's row still says "deleted a
    // comment", which is the fact). A verb this build does not know is
    // the fallback, never a wrong sentence.
    case "comment":
      if (row.newValue === "created") return { key: "commented" };
      if (row.newValue === "edited") return { key: "commentEdited" };
      if (row.newValue === "deleted") return { key: "commentDeleted" };
      return fallback;
    case "commentVisibility":
      if (!isVisibility(row.newValue)) return fallback;
      return { key: "commentVisibilityChanged", to: look.visibility(row.newValue) };
    default:
      return fallback;
  }
}

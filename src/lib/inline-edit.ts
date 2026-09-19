/**
 * The inline-edit state machine (UI.md rule 3, §5.10).
 *
 * Kept out of the component so the part that can be wrong — when a
 * value is posted, when it is restored, what the hidden input carries
 * between a local commit and the server round trip — is testable
 * without a DOM.
 *
 * The contract the machine encodes:
 *
 *  - `value` is what the field will POST. It starts at the value the
 *    server rendered and only moves on a commit, so `<AutoForm>`'s
 *    whole-FormData post stays byte-identical to the always-mounted
 *    control it replaces (WORKLIST hazard H1).
 *  - `cancel` (Escape) never moves `value` — the control is restored to
 *    it *before* blurring, so AutoForm's focus snapshot sees no change
 *    and no request is sent.
 *  - a failed save does NOT roll `value` back. Reverting to the server
 *    value while the user's text is still on screen is the exact bug
 *    this product already shipped once.
 *  - `reseed` is the server re-render: it is authoritative and clears
 *    the invalid flag.
 */

export type InlineEditKind = "text" | "multiline" | "date" | "select";

export type InlineEditMode = "rest" | "editing";

export type InlineEditState = {
  mode: InlineEditMode;
  /** The value the hidden input posts while at rest. */
  value: string;
  /** The last commit failed; the control stays open and aria-invalid. */
  invalid: boolean;
};

export type InlineEditEvent =
  /** Click, Enter, Space or F2 on the resting trigger. */
  | { type: "activate" }
  /** Escape: restore and leave without saving. */
  | { type: "cancel" }
  /** Blur (text, multiline, date) or change (select). */
  | { type: "commit"; value: string }
  /** The server action came back not-ok. */
  | { type: "fail" }
  /** A fresh server render. */
  | { type: "reseed"; value: string };

export const inlineEditInitial = (value: string): InlineEditState => ({
  mode: "rest",
  value,
  invalid: false,
});

export function inlineEditReducer(
  state: InlineEditState,
  event: InlineEditEvent,
): InlineEditState {
  switch (event.type) {
    case "activate":
      return state.mode === "editing" ? state : { ...state, mode: "editing" };
    case "cancel":
      return { mode: "rest", value: state.value, invalid: false };
    case "commit":
      return { mode: "rest", value: event.value, invalid: false };
    case "fail":
      // The edited value stands; only the mode and the flag move.
      return { mode: "editing", value: state.value, invalid: true };
    case "reseed":
      return { mode: "rest", value: event.value, invalid: false };
  }
}

/**
 * Which DOM event `<AutoForm>` already listens for. A native <select>
 * posts on `change`; everything else — including `type="date"`, which
 * AutoForm treats as a text field — posts on `blur`. InlineEdit must
 * not invent a second save path, so it leaves edit mode on exactly
 * the event that already saves.
 */
export const commitsOn = (kind: InlineEditKind): "blur" | "change" =>
  kind === "select" ? "change" : "blur";

/** Enter, Space and F2 all open the editor (F2 is the spreadsheet alias). */
export const isActivationKey = (key: string): boolean =>
  key === "Enter" || key === " " || key === "Spacebar" || key === "F2";

/** Only text-shaped controls may be select-all'd; `.select()` throws on a date input. */
export const selectsOnFocus = (kind: InlineEditKind): boolean =>
  kind === "text" || kind === "multiline";

/**
 * Focus goes back to the trigger only when the blur was not the user
 * moving somewhere deliberately: Enter and Escape blur programmatically
 * and leave `relatedTarget` null, Tab names the element it moved to.
 * Stealing focus from a Tab would be a trap.
 */
export const returnsFocus = (relatedTarget: unknown): boolean => relatedTarget == null;

export type InlineEditOption = { value: string; label: string };

/** The rest-mode text of a select-backed value; falls back to the raw value. */
export const optionLabel = (
  options: readonly InlineEditOption[] | undefined,
  value: string,
): string => options?.find((o) => o.value === value)?.label ?? value;

/**
 * THE CURRENT VALUE IS ALWAYS OFFERED. A select's options are what may
 * be CHOSEN, which is not the same set as what a row may already HOLD:
 * the backlog's states drop TRIAGE and the gated ones, and its assignees
 * are ACTIVE members only. A row sitting on a value outside that set
 * breaks the control twice over, and both halves are silent:
 *
 *   • `optionLabel` above falls back to the raw VALUE, so the trigger's
 *     `aria-label` and `title` announce an opaque id — a screen reader
 *     reading a UUID where a person's name belongs;
 *   • `NativeSelect` takes `defaultValue`, so a value matching no option
 *     leaves the browser on the FIRST one. The picker then states a
 *     current value the row does not have — "Unassigned" over a task
 *     that is assigned.
 *
 * Prepending the held value fixes both: it is labelled, it is what the
 * select opens on, and re-picking it fires no `change`, so it commits
 * nothing (the item panel's `A` picker reaches the same end by leaving
 * the row unchecked and Enter inert). It is NOT re-offered to a row that
 * does not hold it, so a deactivated member cannot be assigned to
 * anything new, and a filtered state cannot be entered — only kept.
 *
 * `value === ""` means "none" by the convention these cells share, and
 * "none" is always a real option, so it is never prepended.
 *
 * A MISSING LABEL STILL GETS AN OPTION, labelled with the raw value —
 * which looks like the very thing this helper exists to keep off the
 * screen, and is still right (review). The two halves of the bug are not
 * equally bad: an ugly option is cosmetic, but a MISSING one leaves the
 * select anchored on some other row's value, where a single arrow key
 * commits a change nobody chose. Dropping the option would have been a
 * regression on the state cell, whose inline predecessor prepended
 * unconditionally. On the assignee path the case is unreachable anyway —
 * `assigneeName` comes from the item's own join and `User.name` is
 * non-null, so it is null only when `assigneeMemberId` is, and that is
 * the `""` bail above.
 */
export const withCurrentOption = (
  options: readonly InlineEditOption[],
  value: string,
  label: string | null | undefined,
): readonly InlineEditOption[] => {
  if (value === "") return options;
  if (options.some((o) => o.value === value)) return options;
  return [{ value, label: label || value }, ...options];
};

/**
 * THE FOCUS REVEAL UNDER A PINNED COLUMN, as a decision rather than a
 * handler (UI.md §10.12; PLAN §0's owed (b) from slice 18).
 *
 * A sticky actions column floats over the columns scrolling beneath it,
 * and the browser does not see it cover anything: a control inside the
 * scroll box but under that column counts as visible and is left where
 * it is. Measured in the live page — the time week's duration editor,
 * focused at a 526px box, sat 36px under the column. `scroll-padding-
 * inline-end` does not move it and was dropped, because it would also
 * have counted every control IN the pinned column as hidden.
 *
 * `ScrollFade` reads the DOM; these two decide what to do with what it
 * read. Split because the part that can be wrong is pure and the DOM is
 * the part a `node` test suite cannot see — the same split `keymap.ts`
 * makes for `focusedKeyApplies`, and for the same reason: every branch
 * here is pinned by a test, and the component is left as a thin adapter
 * whose only remaining risk is reading the wrong node. That half is the
 * e2e's.
 *
 * TWO functions and not one, and the reason is a reflow. `focusin` fires
 * on every focus change inside the table, and the backlog's `J K` moves
 * focus to a ROW on every press — down a four-thousand-row list. The
 * geometry needs `getBoundingClientRect()`, which forces layout, so
 * asking `revealExempt` first means an exempt target pays none of it —
 * which a single flat input object could not express without making
 * every caller build the numbers first.
 *
 * The caller decides how much of the EXEMPT input it can skip, too: an
 * identity check and an `instanceof` are free, and `ScrollFade` uses
 * them to gate the two `closest()` walks, because a value the answer
 * cannot depend on is a value not worth computing.
 */

/** The focus ring sits 2px outside a control and is 2px wide. */
export const REVEAL_RING_PX = 4;

/** `ScrollFade`'s own width (`w-8`) — the control stops this short of the column. */
export const REVEAL_FADE_PX = 32;

export type RevealTarget = {
  /** The focus landed on the scroll box itself, which is focusable (`tabIndex={0}`). */
  isBox: boolean;
  /**
   * The focus landed on a ROW. The backlog's `J K` focuses rows, and a
   * row spans the whole table — it is never "under" the column, and
   * scrolling on every `J` would fight the member for the viewport.
   */
  isRow: boolean;
  /** The control lives IN the pinned cell, so the column cannot cover it. */
  inPinnedCell: boolean;
  /**
   * The control's own row HAS a pinned cell to measure against. The
   * backlog's create row spans the column, so nothing covers it.
   */
  hasPinnedCell: boolean;
  /**
   * The browser is showing a focus ring (`:focus-visible`): keyboard
   * focus, and a text field however it was focused, because every engine
   * rings those. A mouse-opened `<InlineEdit>` field is therefore
   * revealed after its click has landed, where the caret would otherwise
   * sit under the column, while a click on a resting control never moves
   * it between press and release.
   */
  focusVisible: boolean;
};

/**
 * Whether this focus is one the reveal leaves alone — asked before any
 * layout is read. Every clause is a case the live page produces, and
 * losing one is a defect no screenshot can show: the exemptions only
 * differ from the geometry at a rung edge.
 */
export function revealExempt(target: RevealTarget): boolean {
  return (
    target.isBox ||
    target.isRow ||
    target.inPinnedCell ||
    !target.hasPinnedCell ||
    !target.focusVisible
  );
}

export type RevealGeometry = {
  /** The control's right edge, in viewport px. */
  targetRight: number;
  /** The control's width, in viewport px. */
  targetWidth: number;
  /** The pinned cell's left edge, in viewport px. */
  pinnedLeft: number;
  /** The scroll box's CONTENT-box left edge (client rect + `clientLeft`). */
  boxContentLeft: number;
};

/**
 * How far right the scroll box must move to bring a focused control out
 * from under the pinned column — `0` for "leave it alone", which covers
 * the two geometric no-ops:
 *
 *   • the control and its ring already end left of the fade, so there is
 *     nothing to reveal;
 *   • the control plus both rings is WIDER than the room the column and
 *     the fade leave, so there is no scroll position that reveals it and
 *     moving would only take its left edge away instead.
 *
 * At the table's right end the caller's `scrollLeft` clamps and the fade
 * is gone, so a delta that overshoots costs nothing.
 *
 * Callers ask `revealExempt` first; this answers geometry only.
 */
export function revealScrollDelta(geometry: RevealGeometry): number {
  const edge = geometry.pinnedLeft - REVEAL_FADE_PX;
  const room = edge - geometry.boxContentLeft;
  if (geometry.targetRight + REVEAL_RING_PX <= edge) return 0;
  if (geometry.targetWidth + 2 * REVEAL_RING_PX > room) return 0;
  return geometry.targetRight + REVEAL_RING_PX - edge;
}

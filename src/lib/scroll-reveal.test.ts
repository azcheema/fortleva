import { describe, expect, it } from "vitest";

import {
  REVEAL_FADE_PX,
  REVEAL_RING_PX,
  revealExempt,
  revealScrollDelta,
  type RevealTarget,
} from "./scroll-reveal";

/**
 * The reveal's geometry and every one of its exemptions (UI.md §10.12).
 * Nothing automated covered this until now — PLAN §0's owed (b) from
 * slice 18 — and it is the one table behaviour that only shows itself at
 * a rung edge, where no screenshot looks.
 *
 * The numbers describe a real, narrow box: content from 100 to 500, a
 * 60px pinned column starting at 440, so the fade runs 408..440 and a
 * control must end at or left of 408 (less its 4px ring) to be clear.
 */
const BOX_LEFT = 100;
const PINNED_LEFT = 440;
const EDGE = PINNED_LEFT - REVEAL_FADE_PX; // 408
const ROOM = EDGE - BOX_LEFT; // 308

/** A keyboard-focused control in an ordinary row: nothing exempts it. */
const eligible: RevealTarget = {
  isBox: false,
  isRow: false,
  inPinnedCell: false,
  hasPinnedCell: true,
  focusVisible: true,
};

const geometry = { pinnedLeft: PINNED_LEFT, boxContentLeft: BOX_LEFT };
/** A control sitting UNDER the column: its right edge is past the fade. */
const covered = { ...geometry, targetRight: 470, targetWidth: 80 };
/** One clear of it. */
const clear = { ...geometry, targetRight: 300, targetWidth: 80 };

describe("revealExempt", () => {
  it("lets an ordinary keyboard-focused control through", () => {
    expect(revealExempt(eligible)).toBe(false);
  });

  it("exempts the scroll box itself", () => {
    // The box is `tabIndex={0}` so a keyboard can reach the scroll at
    // all; focusing it must not scroll it.
    expect(revealExempt({ ...eligible, isBox: true })).toBe(true);
  });

  it("exempts a ROW", () => {
    // The backlog's `J K` focuses rows. A row spans the table, so it is
    // never under the column — and this is also the case that must cost
    // no layout, since it fires on every press down the list.
    expect(revealExempt({ ...eligible, isRow: true })).toBe(true);
  });

  it("exempts a control inside the pinned cell", () => {
    // The column cannot cover its own contents — and this is the
    // exemption `scroll-padding-inline-end` could not express, which is
    // why that approach was dropped.
    expect(revealExempt({ ...eligible, inPinnedCell: true })).toBe(true);
  });

  it("exempts a row that has no pinned cell", () => {
    // The backlog's create row spans the actions column, so nothing
    // covers it and there is no cell to measure against.
    expect(revealExempt({ ...eligible, hasPinnedCell: false })).toBe(true);
  });

  it("exempts focus the browser is not ringing", () => {
    // `:focus-visible` is the whole test for "the member is looking":
    // keyboard focus, and a text field however focused. A click on a
    // resting control must not move it between press and release.
    expect(revealExempt({ ...eligible, focusVisible: false })).toBe(true);
  });

  it("holds every clause over every combination", () => {
    // The shape `focusedKeyApplies` is pinned with: a future edit cannot
    // satisfy one clause and quietly drop another. Exempt iff at least
    // one reason says so.
    for (let bits = 0; bits < 32; bits += 1) {
      const target: RevealTarget = {
        isBox: (bits & 1) !== 0,
        isRow: (bits & 2) !== 0,
        inPinnedCell: (bits & 4) !== 0,
        hasPinnedCell: (bits & 8) !== 0,
        focusVisible: (bits & 16) !== 0,
      };
      const reasons =
        target.isBox ||
        target.isRow ||
        target.inPinnedCell ||
        !target.hasPinnedCell ||
        !target.focusVisible;
      expect(revealExempt(target), JSON.stringify(target)).toBe(reasons);
    }
    // Exactly one combination of the five is NOT exempt.
    expect(revealExempt(eligible)).toBe(false);
  });
});

describe("revealScrollDelta", () => {
  it("scrolls a covered control out, stopping a fade's width short of the column", () => {
    const delta = revealScrollDelta(covered);
    expect(delta).toBe(470 + REVEAL_RING_PX - EDGE); // 66

    // The property, stated rather than left to the arithmetic: after the
    // scroll the control's ring ends exactly at the fade's left edge, so
    // nothing of it is under the 32px fade or the column behind it.
    expect(covered.targetRight - delta + REVEAL_RING_PX).toBe(EDGE);
  });

  it("leaves a control that is already clear of the fade", () => {
    expect(revealScrollDelta(clear)).toBe(0);
    // Exactly touching counts as clear — the ring lands ON the edge.
    expect(revealScrollDelta({ ...clear, targetRight: EDGE - REVEAL_RING_PX })).toBe(0);
    // One pixel further and it is not.
    expect(revealScrollDelta({ ...clear, targetRight: EDGE - REVEAL_RING_PX + 1 })).toBe(1);
  });

  it("refuses to move a control wider than the room the column and fade leave", () => {
    // A control that cannot fit would only trade its right edge for its
    // left, so it stays where the member can at least read its start.
    expect(
      revealScrollDelta({ ...covered, targetWidth: ROOM - 2 * REVEAL_RING_PX }),
    ).toBeGreaterThan(0);
    expect(revealScrollDelta({ ...covered, targetWidth: ROOM - 2 * REVEAL_RING_PX + 1 })).toBe(0);
  });

  it("asks nothing about WHO is focused — that is revealExempt's half", () => {
    // Stated so the split cannot rot: this function is geometry alone,
    // and a caller that forgets `revealExempt` gets a number for a row.
    expect(revealScrollDelta(covered)).toBeGreaterThan(0);
  });
});

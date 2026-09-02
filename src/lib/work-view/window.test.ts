import { describe, expect, it } from "vitest";

import {
  EMPTY_SPAN,
  INITIAL_ROWS,
  OVERSCAN,
  VIRTUALISE_ABOVE,
  growTo,
  initialWindow,
  sameWindow,
  wholeList,
  windowOf,
  type RowWindow,
} from "./window";

/**
 * The windowing arithmetic, tested hard, because nothing else can test
 * it: the window is INERT at or below 200 rows, so the 5-row e2e
 * fixture and all 43 visual stops (172 shots) run the unwindowed path and would
 * never see a mistake here. This file is the only guard on the maths.
 */

const ROW = 36;
const BIG = 1000;

const win = (over: Partial<Parameters<typeof windowOf>[0]> = {}): RowWindow =>
  windowOf({
    count: BIG,
    rowHeight: ROW,
    scrollTop: 0,
    listTop: 0,
    viewportHeight: 900,
    ...over,
  });

/** Rows the window claims to render, plus the rows its spacers stand in for. */
const accountedFor = (w: RowWindow, rowHeight = ROW): number =>
  w.padTop / rowHeight + (w.end - w.start) + w.padBottom / rowHeight;

describe("the threshold — virtualisation cannot touch a list that does not need it", () => {
  it("at or below VIRTUALISE_ABOVE the whole list renders, with no spacers at all", () => {
    for (const count of [0, 1, 5, 199, VIRTUALISE_ABOVE]) {
      expect(win({ count, scrollTop: 99_999 }), `count ${count}`).toEqual({
        start: 0,
        end: count,
        padTop: 0,
        padBottom: 0,
      });
    }
  });

  it("one row past the threshold it engages", () => {
    // Scrolled to row 100 of 201 — inside the list, so both edges bite.
    const w = win({ count: VIRTUALISE_ABOVE + 1, scrollTop: 100 * ROW });
    expect(w.start).toBeGreaterThan(0);
    expect(w.end).toBeLessThan(VIRTUALISE_ABOVE + 1);
  });

  it("wholeList is the identity for any count, including a nonsensical one", () => {
    expect(wholeList(0)).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0 });
    expect(wholeList(-5).end).toBe(0);
  });
});

describe("windowOf — the slice and its spacers", () => {
  it("at the very top it starts at 0 and pads only below", () => {
    const w = win({ scrollTop: 0, listTop: 0 });
    expect(w.start).toBe(0);
    expect(w.padTop).toBe(0);
    expect(w.padBottom).toBe((BIG - w.end) * ROW);
  });

  it("EVERY row is accounted for — rendered, or paid for by a spacer", () => {
    for (const scrollTop of [0, 100, 1000, 5000, 20_000, 35_000, 36_000]) {
      const w = win({ scrollTop });
      expect(accountedFor(w), `scrollTop ${scrollTop}`).toBe(BIG);
    }
  });

  it("the padding is the row index times the height — never accumulated, so it cannot drift", () => {
    // A fractional row height is where a summing implementation goes
    // wrong; multiplication cannot.
    const w = windowOf({ count: BIG, rowHeight: 36.4, scrollTop: 18_200, listTop: 0, viewportHeight: 900 });
    expect(w.padTop).toBeCloseTo(w.start * 36.4, 10);
    expect(w.padBottom).toBeCloseTo((BIG - w.end) * 36.4, 10);
    expect(accountedFor(w, 36.4)).toBeCloseTo(BIG, 10);
  });

  it("the rendered slice covers the viewport, plus the overscan on each side", () => {
    const scrollTop = 10_000;
    const w = win({ scrollTop });
    const firstVisible = Math.floor(scrollTop / ROW);
    const lastVisible = Math.floor((scrollTop + 900) / ROW);
    expect(w.start).toBeLessThanOrEqual(firstVisible);
    expect(w.end).toBeGreaterThan(lastVisible);
    expect(firstVisible - w.start).toBe(OVERSCAN);
  });

  it("honours the list's own offset down the page", () => {
    // The same scroll position, with the list starting 500px lower, must
    // render an earlier slice — the list has not been scrolled as far.
    const flush = win({ scrollTop: 5000, listTop: 0 });
    const lower = win({ scrollTop: 5000, listTop: 500 });
    expect(lower.start).toBeLessThan(flush.start);
  });

  it("clamps at the bottom rather than running past the end", () => {
    const w = win({ scrollTop: BIG * ROW + 10_000 });
    expect(w.end).toBe(BIG);
    expect(w.padBottom).toBe(0);
    expect(w.start).toBeLessThanOrEqual(BIG);
    expect(accountedFor(w)).toBe(BIG);
  });

  it("clamps at the top when the list is still below the fold (a negative offset)", () => {
    const w = win({ scrollTop: 0, listTop: 4000 });
    expect(w.start).toBe(0);
    expect(w.padTop).toBe(0);
  });

  it("start never exceeds end, at any scroll position", () => {
    for (let scrollTop = 0; scrollTop <= BIG * ROW + 2000; scrollTop += 613) {
      const w = win({ scrollTop });
      expect(w.start, `scrollTop ${scrollTop}`).toBeLessThanOrEqual(w.end);
      expect(w.padTop).toBeGreaterThanOrEqual(0);
      expect(w.padBottom).toBeGreaterThanOrEqual(0);
    }
  });

  it("a taller viewport renders more rows", () => {
    expect(win({ viewportHeight: 2000 }).end).toBeGreaterThan(win({ viewportHeight: 500 }).end);
  });

  it("a bigger overscan renders more on both sides", () => {
    const tight = win({ scrollTop: 10_000, overscan: 0 });
    const loose = win({ scrollTop: 10_000, overscan: 30 });
    expect(loose.start).toBeLessThan(tight.start);
    expect(loose.end).toBeGreaterThan(tight.end);
  });

  it("NONSENSE IN, WHOLE LIST OUT — never a broken window", () => {
    // Before layout, a measurement can be 0 or NaN. Rendering everything
    // is always correct, merely slower; rendering a garbage slice is not.
    for (const bad of [
      { rowHeight: 0 },
      { rowHeight: -36 },
      { rowHeight: Number.NaN },
      { scrollTop: Number.NaN },
      { listTop: Number.NaN },
      { viewportHeight: Number.NaN },
      { viewportHeight: Number.POSITIVE_INFINITY },
    ]) {
      expect(win(bad), JSON.stringify(bad)).toEqual(wholeList(BIG));
    }
  });

  it("a negative viewport height does not produce a negative slice", () => {
    const w = win({ viewportHeight: -100, scrollTop: 10_000 });
    expect(w.end).toBeGreaterThanOrEqual(w.start);
    expect(accountedFor(w)).toBe(BIG);
  });
});

describe("initialWindow — what the server and the first client render agree on", () => {
  it("is a CONSTANT slice: it cannot depend on a viewport the server does not have", () => {
    // Same inputs, same answer, whatever the client's screen turns out
    // to be — which is what keeps hydration from mismatching.
    expect(initialWindow(BIG, ROW)).toEqual(initialWindow(BIG, ROW));
    expect(initialWindow(BIG, ROW).end).toBe(INITIAL_ROWS);
    expect(initialWindow(BIG, ROW).start).toBe(0);
  });

  it("pays for the rows it does not render, so the page is full height on the first paint", () => {
    const w = initialWindow(BIG, ROW);
    expect(w.padBottom).toBe((BIG - INITIAL_ROWS) * ROW);
    expect(accountedFor(w)).toBe(BIG);
  });

  it("is inert below the threshold, exactly like windowOf", () => {
    expect(initialWindow(5, ROW)).toEqual(wholeList(5));
    expect(initialWindow(VIRTUALISE_ABOVE, ROW)).toEqual(wholeList(VIRTUALISE_ABOVE));
  });

  it("renders enough to fill a tall screen before any scroll event arrives", () => {
    // 60 rows at 36px is 2160px — taller than a 1440p viewport, so
    // nothing is missing on the first paint of a large display.
    expect(INITIAL_ROWS * 36).toBeGreaterThan(1440);
  });

  it("a shorter list than INITIAL_ROWS is not padded past its end", () => {
    const count = VIRTUALISE_ABOVE + 5;
    const w = initialWindow(count, ROW);
    expect(w.end).toBe(Math.min(count, INITIAL_ROWS));
    expect(accountedFor(w)).toBe(count);
  });
});

describe("sameWindow — the bail-out that keeps a scroll from re-rendering every frame", () => {
  it("is true only when the rendered DOM would be identical", () => {
    const a = win({ scrollTop: 10_000 });
    expect(sameWindow(a, win({ scrollTop: 10_000 }))).toBe(true);
    // Scrolling WITHIN one row changes nothing: 10_000 and 10_005 both
    // sit in row 277, which spans 9_972..10_007 at 36px.
    expect(sameWindow(a, win({ scrollTop: 10_005 }))).toBe(true);
    // A full row further does.
    expect(sameWindow(a, win({ scrollTop: 10_000 + ROW * 2 }))).toBe(false);
  });

  it("catches a change in any of the four fields", () => {
    const base: RowWindow = { start: 1, end: 2, padTop: 3, padBottom: 4 };
    expect(sameWindow(base, { ...base })).toBe(true);
    expect(sameWindow(base, { ...base, start: 9 })).toBe(false);
    expect(sameWindow(base, { ...base, end: 9 })).toBe(false);
    expect(sameWindow(base, { ...base, padTop: 9 })).toBe(false);
    expect(sameWindow(base, { ...base, padBottom: 9 })).toBe(false);
  });
});

describe("growTo — the grow-only rule a drag depends on", () => {
  const w = (start: number, end: number): RowWindow => ({
    start,
    end,
    padTop: start * ROW,
    padBottom: (BIG - end) * ROW,
  });

  it("EMPTY_SPAN widens nothing — a drag that never scrolls behaves as if there were no drag", () => {
    const base = w(100, 140);
    expect(growTo(base, EMPTY_SPAN, BIG, ROW)).toBe(base);
  });

  it("widens in both directions and never narrows", () => {
    const base = w(100, 140);
    expect(growTo(base, { start: 80, end: 160 }, BIG, ROW)).toEqual(w(80, 160));
    // A span INSIDE the window leaves it alone — growth only.
    expect(growTo(base, { start: 120, end: 130 }, BIG, ROW)).toBe(base);
  });

  it("recomputes the spacers so every row is still accounted for", () => {
    const grown = growTo(w(100, 140), { start: 50, end: 300 }, BIG, ROW);
    expect(grown.padTop).toBe(50 * ROW);
    expect(grown.padBottom).toBe((BIG - 300) * ROW);
    expect(accountedFor(grown)).toBe(BIG);
  });

  it("cannot grow past the ends of the list", () => {
    const grown = growTo(w(0, 10), { start: -50, end: BIG + 500 }, BIG, ROW);
    expect(grown.start).toBe(0);
    expect(grown.end).toBe(BIG);
    expect(grown.padTop).toBe(0);
    expect(grown.padBottom).toBe(0);
  });

  it("returns the SAME OBJECT when nothing changed, so a render can bail on identity", () => {
    const base = w(10, 20);
    expect(growTo(base, EMPTY_SPAN, BIG, ROW)).toBe(base);
    expect(growTo(base, { start: 15, end: 18 }, BIG, ROW)).toBe(base);
  });

  it("a drag that scrolls a long way keeps every row it has ever covered", () => {
    // The source row is at index 100. Auto-scroll carries the viewport to
    // row 900; the window must still contain 100, or the drag can never end.
    let win = w(92, 140);
    let span = EMPTY_SPAN;
    for (const top of [100, 300, 600, 900]) {
      const live = windowOf({ count: BIG, rowHeight: ROW, scrollTop: top * ROW, listTop: 0, viewportHeight: 900 });
      span = { start: Math.min(span.start, win.start), end: Math.max(span.end, win.end) };
      win = growTo(live, span, BIG, ROW);
    }
    expect(win.start).toBeLessThanOrEqual(100);
    expect(win.end).toBeGreaterThan(900);
  });
});

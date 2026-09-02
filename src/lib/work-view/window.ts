/**
 * The backlog's window: which slice of a long row list is actually in
 * the DOM, and how much empty space stands in for the rest.
 *
 * Pure arithmetic, no React and no DOM — the component measures and
 * calls this, so the interesting part is testable without a browser,
 * which matters here more than usual: a windowed list is INERT below
 * the threshold, so the fixture, every e2e selector and all 43 visual
 * stops (172 shots) exercise the unwindowed path and would never catch a mistake in
 * this file.
 *
 * IT ONLY ENGAGES ABOVE `VIRTUALISE_ABOVE` (UI.md §5.3: "Virtualised at
 * ~200 rows"). Below it the whole list renders exactly as it did before
 * this module existed — same DOM, same find-in-page, same tab order —
 * so virtualisation cannot regress any project a person actually has
 * today, and the cost lands only where the cost of NOT having it would.
 *
 * Every row is one `--row-h`, which is what makes this arithmetic rather
 * than measurement: `<DataTable>` sets that height once and the craft
 * audit asserts every row matches it within a pixel. Group headers are
 * rows of the same height, so a flat list of mixed row kinds windows
 * exactly like a uniform one.
 */

/** Rows above which the list is windowed. At or below: everything renders. */
export const VIRTUALISE_ABOVE = 200;

/**
 * Rows kept mounted beyond each edge of the viewport. Eight is a
 * compromise: enough that a fast scroll does not show a gap before the
 * next scroll event lands, few enough that the DOM stays small. It also
 * buys the drag a margin — a row being dragged toward the edge keeps
 * real neighbours to anchor on for ~290px past what is visible.
 */
export const OVERSCAN = 8;

/**
 * The slice rendered before anything has been measured — the first
 * server render AND the first client render, which must agree or React
 * logs a hydration mismatch. It is a constant for exactly that reason:
 * the server cannot know the viewport, so neither may the first client
 * render. 60 rows is 2160px at the default 36px, taller than any
 * ordinary viewport, so nothing is missing before the first scroll or
 * resize event refines it.
 */
export const INITIAL_ROWS = 60;

export type RowWindow = {
  /** First rendered row index, inclusive. */
  start: number;
  /** Last rendered row index, EXCLUSIVE. */
  end: number;
  /** Pixels of spacer standing in for the rows before `start`. */
  padTop: number;
  /** Pixels of spacer standing in for the rows after `end`. */
  padBottom: number;
};

/** Everything rendered, no spacers — the shape below the threshold. */
export const wholeList = (count: number): RowWindow => ({
  start: 0,
  end: Math.max(0, count),
  padTop: 0,
  padBottom: 0,
});

/**
 * The constant opening slice, used until a real measurement arrives.
 *
 * `rowHeight` is not measured and does not need to be: it is a design
 * token the density already fixes (`ROW_HEIGHT` in `<DataTable>`), so
 * the server can compute the bottom spacer too. That matters — a first
 * paint with no bottom spacer would render a 250-row list as a short
 * page with a short scrollbar, and the scroll position would jump the
 * moment the first event corrected it. With the spacer the page is its
 * full height from the first byte, and refining the window never moves
 * anything.
 */
export const initialWindow = (count: number, rowHeight: number): RowWindow => {
  if (count <= VIRTUALISE_ABOVE) return wholeList(count);
  const end = Math.min(count, INITIAL_ROWS);
  return { start: 0, end, padTop: 0, padBottom: (count - end) * rowHeight };
};

export type WindowInput = {
  /** Total rows in the list, headers included. */
  count: number;
  /** One row's height in px — the `--row-h` the table is rendering at. */
  rowHeight: number;
  /** How far the PAGE is scrolled (`window.scrollY`). */
  scrollTop: number;
  /** The row container's top in DOCUMENT coordinates (rect.top + scrollY). */
  listTop: number;
  /** The viewport's height (`window.innerHeight`). */
  viewportHeight: number;
  overscan?: number;
};

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/**
 * The window for a measured scroll position.
 *
 * `padTop`/`padBottom` are computed by MULTIPLICATION from the row
 * index, never accumulated — so a fractional row height (a browser at
 * 110% zoom, or compact density's 32px) cannot drift the list out of
 * alignment over hundreds of rows the way summing per-row heights would.
 *
 * Nonsense in gives the whole list back rather than a broken window: a
 * zero or negative row height, or a non-finite measurement, means
 * something is not laid out yet, and rendering everything is always
 * correct — merely slower.
 */
export function windowOf(input: WindowInput): RowWindow {
  const { count, rowHeight, scrollTop, listTop, viewportHeight } = input;
  if (count <= VIRTUALISE_ABOVE) return wholeList(count);
  if (!Number.isFinite(rowHeight) || rowHeight <= 0) return wholeList(count);
  if (!Number.isFinite(scrollTop) || !Number.isFinite(listTop) || !Number.isFinite(viewportHeight)) {
    return wholeList(count);
  }
  const overscan = Math.max(0, input.overscan ?? OVERSCAN);

  // How far the viewport's top edge has travelled INTO the list. Negative
  // while the list is still below the fold, which clamps to the top.
  const into = scrollTop - listTop;
  const firstVisible = Math.floor(into / rowHeight);
  const visible = Math.ceil(Math.max(0, viewportHeight) / rowHeight) + 1;

  const start = clamp(firstVisible - overscan, 0, count);
  const end = clamp(firstVisible + visible + overscan, start, count);
  return {
    start,
    end,
    padTop: start * rowHeight,
    padBottom: (count - end) * rowHeight,
  };
}

/** Whether two windows would render the same DOM — the bail-out test a
 * scroll handler uses so it does not re-render on every frame. */
export const sameWindow = (a: RowWindow, b: RowWindow): boolean =>
  a.start === b.start && a.end === b.end && a.padTop === b.padTop && a.padBottom === b.padBottom;

/**
 * A window widened to cover `span` as well — the GROW-ONLY rule a drag
 * needs.
 *
 * Why a drag may never shrink the window: pragmatic-drag-and-drop's
 * source element must stay mounted for the drag to end. Its own source
 * says so — "the dragend event will not fire on the source draggable if
 * it has been removed from the DOM" — and the consequences are not
 * cosmetic. `finish()` never runs, so the library's `isActive` latch
 * stays set and REFUSES THE NEXT DRAG, and the auto-scroll scheduler,
 * which resets only on the monitor's drop, keeps calling `scrollBy` on
 * its animation frame: the page goes on scrolling after the mouse is
 * released. So from the moment a drag starts until it ends, rows may
 * enter the window but none may leave it.
 *
 * A larger overscan is NOT a substitute: however large, auto-scrolling
 * far enough still walks the source row out of the window. Only
 * "never shrink" is actually safe.
 */
export const growTo = (
  win: RowWindow,
  span: { start: number; end: number },
  count: number,
  rowHeight: number,
): RowWindow => {
  const start = Math.max(0, Math.min(win.start, span.start));
  const end = Math.min(count, Math.max(win.end, span.end));
  if (start === win.start && end === win.end) return win;
  return { start, end, padTop: start * rowHeight, padBottom: (count - end) * rowHeight };
};

/**
 * The IDENTITY for `growTo`: +Infinity/-1 are the neutral elements of
 * the min/max it takes, so widening by this span widens nothing. That
 * is what lets a caller write `growTo(win, maybeSpan ?? EMPTY_SPAN)`
 * with no branch — a drag that is not happening and a focused row that
 * does not exist both cost exactly one comparison.
 *
 * A drag does NOT start from here: it seeds its span with the window as
 * it was at drag start, because the union only ever sees new windows and
 * would otherwise forget where the source row was.
 */
export const EMPTY_SPAN = { start: Number.POSITIVE_INFINITY, end: -1 };

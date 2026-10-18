import { describe, expect, it } from "vitest";

import { boundedSpan, layoutTable, TABLE_MAX_COLUMNS, TABLE_MAX_ROWS } from "./table-bounds";

/**
 * The table grid (slice 132, C109): cells placed as a browser and
 * prosemirror-tables place them, so the bounds count what is DRAWN — the
 * security review's MEDIUM-1 was a width counted per row.
 */

const c = (colspan = 1, rowspan = 1) => ({ colspan, rowspan });

describe("layoutTable", () => {
  it("places each cell after the columns a cell from above still covers", () => {
    const layout = layoutTable([[c(1, 2), c(), c()], [c(), c()]]);
    expect(layout).toEqual({
      ok: true,
      width: 3,
      rows: [
        { cells: [{ column: 0, colspan: 1 }, { column: 1, colspan: 1 }, { column: 2, colspan: 1 }], coveredFromAbove: [] },
        { cells: [{ column: 1, colspan: 1 }, { column: 2, colspan: 1 }], coveredFromAbove: [0] },
      ],
    });
  });

  it("counts a carried cell toward the width: 20 per row is 10 000 on the grid", () => {
    const rows = Array.from({ length: 3 }, () => [c(TABLE_MAX_COLUMNS, 3)]);
    expect(layoutTable(rows)).toEqual({ ok: false, reason: "too_wide" });
    expect(layoutTable([[c(TABLE_MAX_COLUMNS)]])).toMatchObject({ ok: true, width: TABLE_MAX_COLUMNS });
    expect(layoutTable([[c(TABLE_MAX_COLUMNS), c()]])).toEqual({ ok: false, reason: "too_wide" });
  });

  it("refuses too many rows, a rowspan past the last row, and a cell over a carried one", () => {
    expect(layoutTable(Array.from({ length: TABLE_MAX_ROWS + 1 }, () => [c()]))).toEqual({ ok: false, reason: "too_long" });
    expect(layoutTable([[c(1, 3)], [c()]])).toEqual({ ok: false, reason: "past_end" });
    // Row 2's first cell starts at column 1 (column 0 carried) and spans 2 —
    // into column 2, which the first row's second cell also carries down.
    expect(layoutTable([[c(1, 2), c(1), c(1, 2)], [c(2)]])).toEqual({ ok: false, reason: "overlap" });
  });

  it("lets a ragged row and an empty one through — every surface draws them", () => {
    expect(layoutTable([[c(), c(), c()], [c()], []])).toMatchObject({ ok: true, width: 3 });
  });
});

describe("boundedSpan", () => {
  it("keeps an integer within its bound and makes anything else 1", () => {
    expect(boundedSpan(3, 20)).toBe(3);
    expect(boundedSpan("4", 20)).toBe(4);
    expect(boundedSpan("1e9", 20)).toBe(1);
    expect(boundedSpan(0.5, 20)).toBe(1);
    expect(boundedSpan(-2, 20)).toBe(1);
    expect(boundedSpan("abc", 20)).toBe(1);
  });
});

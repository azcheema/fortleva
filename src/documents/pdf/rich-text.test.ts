import { describe, expect, it } from "vitest";

import { layoutTable } from "@/lib/rich-text/table-bounds";

import { estimatedLines, rowBoxes, tallRow, type PmNode } from "./rich-text";

/**
 * The PDF walker's table rows (slice 132, C109): which boxes a row draws
 * under the header, and which rows may break across pages. The drawing
 * itself is `made-report-pdf.test.ts`'s (it renders a table with a merged
 * header and a merged-down cell); these are the decisions behind it.
 */

const text = (t: string): PmNode => ({ type: "text", text: t });
const para = (t: string): PmNode => ({ type: "paragraph", content: [text(t)] });
const cell = (...content: PmNode[]): PmNode => ({ type: "tableCell", content });

describe("rowBoxes", () => {
  it("draws an empty box where a cell from the row above still covers, so every cell stays under its header", () => {
    const layout = layoutTable([
      [{ colspan: 1, rowspan: 2 }, { colspan: 1, rowspan: 1 }, { colspan: 1, rowspan: 1 }],
      [{ colspan: 1, rowspan: 1 }, { colspan: 1, rowspan: 1 }],
    ]);
    if (!layout.ok) throw new Error("lays out");
    expect(rowBoxes(layout.rows[1]!.cells, layout.width)).toEqual([
      { kind: "gap", column: 0, span: 1 },
      { kind: "cell", index: 0, colspan: 1 },
      { kind: "cell", index: 1, colspan: 1 },
    ]);
  });

  it("fills a short row's end, and widens a spanning cell", () => {
    const layout = layoutTable([[{ colspan: 3, rowspan: 1 }], [{ colspan: 1, rowspan: 1 }]]);
    if (!layout.ok) throw new Error("lays out");
    expect(rowBoxes(layout.rows[0]!.cells, layout.width)).toEqual([{ kind: "cell", index: 0, colspan: 3 }]);
    expect(rowBoxes(layout.rows[1]!.cells, layout.width)).toEqual([
      { kind: "cell", index: 0, colspan: 1 },
      { kind: "gap", column: 1, span: 2 },
    ]);
  });
});

describe("estimatedLines / tallRow", () => {
  it("counts lines, not characters — a long checklist of short words is tall (the re-check's LOW-D)", () => {
    const checklist: PmNode = {
      type: "taskList",
      content: Array.from({ length: 70 }, () => ({ type: "taskItem", content: [para("ok")] })),
    };
    expect(estimatedLines(checklist, 50)).toBe(70);
    const code: PmNode = { type: "codeBlock", content: [text(Array.from({ length: 30 }, () => "x").join("\n"))] };
    expect(estimatedLines(code, 50)).toBe(30);
    expect(estimatedLines(para("a".repeat(120)), 50)).toBe(3);
  });

  it("lets a tall row break and keeps a short one together", () => {
    const placed = [
      { column: 0, colspan: 1 },
      { column: 1, colspan: 1 },
    ];
    expect(tallRow([cell(para("short")), cell(para("also short"))], placed, 2)).toBe(false);
    const list: PmNode = { type: "bulletList", content: Array.from({ length: 30 }, () => ({ type: "listItem", content: [para("item")] })) };
    expect(tallRow([cell(list), cell(para("x"))], placed, 2)).toBe(true);
  });
});

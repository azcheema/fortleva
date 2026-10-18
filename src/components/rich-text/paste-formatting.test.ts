import { getSchema } from "@tiptap/core";
import { Fragment, Slice, type Node as PMNode } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";
import { describe, expect, it } from "vitest";

import { descriptionExtensions } from "@/lib/rich-text/extensions";

import { fixPastedSlice, markdownSlice, pasteIntoCell, wordListsInHtml } from "./paste-formatting";

/**
 * The paste extension's hooks against the REAL description schema (slice
 * 132, C109) — no DOM: ProseMirror's model runs in node, and these are the
 * functions the plugin's props call. Word's HTML needs a DOM and is proven
 * in a browser (`e2e/paste-and-tables.spec.ts`).
 */

const schema = getSchema(descriptionExtensions());

const p = (value: string) => schema.nodes["paragraph"]!.create(null, value ? schema.text(value) : null);
const cell = (value: string, attrs?: Record<string, unknown>) => schema.nodes["tableCell"]!.create(attrs ?? null, p(value));
const row = (...cells: ReturnType<typeof cell>[]) => schema.nodes["tableRow"]!.create(null, cells);
const table = (...rows: ReturnType<typeof row>[]) => schema.nodes["table"]!.create(null, rows);
const doc = (...blocks: PMNode[]) => schema.nodes["doc"]!.create(null, blocks);

/** A caret in a document: `inCell` puts it in the paragraph of the table's cell at `column` (of `width`). */
const $at = (inCell: boolean, width = 1, column = 0) => {
  const d = doc(p("before"), table(row(...Array.from({ length: width }, () => cell("x")))), p("after"));
  // doc > table(1) > row(2) > cell(3) > paragraph(4) — each "x" cell is 5 long.
  return TextSelection.create(d, inCell ? d.child(0).nodeSize + 4 + 5 * column : 1);
};
/** From inside the first cell to the paragraph after the table — Shift+click below it. */
const straddling = () => {
  const d = doc(p("before"), table(row(cell("x"))), p("after"));
  return TextSelection.create(d, d.child(0).nodeSize + 4, d.content.size - 1);
};

const kinds = (slice: Slice) => {
  const out: string[] = [];
  slice.content.forEach((n) => out.push(n.type.name));
  return out;
};

describe("markdownSlice", () => {
  it("makes a markdown paste formatted blocks that fit the schema", () => {
    const slice = markdownSlice("## Title\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |", false, schema);
    expect(kinds(slice!)).toEqual(["heading", "bulletList", "table"]);
  });

  it("leaves ordinary text, and any paste as plain text (Ctrl+Shift+V), to the editor", () => {
    expect(markdownSlice("Hello there,\nsee you", false, schema)).toBeNull();
    expect(markdownSlice("## Title", true, schema)).toBeNull();
  });

  it("keeps the formatting around code written inside a link (the code review's MEDIUM-2)", () => {
    const slice = markdownSlice("See [`useState`](https://react.dev/x)\n\n- a", false, schema);
    expect(kinds(slice!)).toEqual(["paragraph", "bulletList"]);
  });
});

describe("fixPastedSlice", () => {
  it("returns the same slice when nothing needs changing", () => {
    const slice = new Slice(Fragment.from(p("plain")), 1, 1);
    expect(fixPastedSlice(slice, schema)).toBe(slice);
    const clean = new Slice(Fragment.from(table(row(cell("a")))), 0, 0);
    expect(fixPastedSlice(clean, schema)).toBe(clean);
  });

  it("flattens a table inside a table, so the save is never refused", () => {
    const nested = table(row(schema.nodes["tableCell"]!.create(null, table(row(cell("inner"))))));
    const out = fixPastedSlice(new Slice(Fragment.from(nested), 0, 0), schema);
    let tables = 0;
    out.content.descendants((n) => {
      if (n.type.name === "table") tables += 1;
      return true;
    });
    expect(tables).toBe(1);
    expect(out.content.textBetween(0, out.content.size)).toBe("inner");
  });

  it("a rebuilt slice stops at the table's edge: the text after the caret stays outside it (the code review's MEDIUM-1)", () => {
    const nested = table(row(schema.nodes["tableCell"]!.create(null, table(row(cell("inner"))))));
    const out = fixPastedSlice(new Slice(Fragment.from(nested), 0, 0), schema);
    expect([out.openStart, out.openEnd]).toEqual([0, 0]);
    // Pasted mid-paragraph — "Hello |world" — "world" is still a paragraph of its own after the table.
    const start = EditorState.create({ schema, doc: doc(p("Hello world")) });
    const caret = start.apply(start.tr.setSelection(TextSelection.create(start.doc, 7)));
    const after = caret.apply(caret.tr.replaceSelection(out));
    const blocks: string[] = [];
    after.doc.forEach((n) => blocks.push(`${n.type.name}:${n.textContent}`));
    expect(blocks).toEqual(["paragraph:Hello ", "table:inner", "paragraph:world"]);
  });

  it("cleans a pasted cell's attributes — a string span bounded, no width, no alignment", () => {
    const wild = table(row(cell("a", { colspan: "1e9", colwidth: [900], align: "right" })));
    const out = fixPastedSlice(new Slice(Fragment.from(wild), 0, 0), schema);
    const attrs = out.content.firstChild!.firstChild!.firstChild!.attrs;
    expect([attrs["colspan"], attrs["colwidth"], attrs["align"]]).toEqual([1, null, null]);
  });
});

describe("pasteIntoCell", () => {
  it("leaves a paste without a table, or outside a table, alone", () => {
    expect(pasteIntoCell(new Slice(Fragment.from(p("x")), 1, 1), schema, $at(true))).toBeNull();
    const mixed = new Slice(Fragment.from([p("intro"), table(row(cell("a")))]), 0, 0);
    expect(pasteIntoCell(mixed, schema, $at(false))).toBeNull();
  });

  it("flattens a table with blocks around it — a cell never holds a table", () => {
    const mixed = new Slice(Fragment.from([p("intro"), table(row(cell("a")))]), 0, 0);
    expect(kinds(pasteIntoCell(mixed, schema, $at(true))!)).toEqual(["paragraph", "paragraph"]);
  });

  it("leaves one table that fits to prosemirror-tables, and flattens one that would push the table past 20 columns", () => {
    const three = new Slice(Fragment.from(table(row(cell("a"), cell("b"), cell("c")))), 0, 0);
    expect(pasteIntoCell(three, schema, $at(true, 1))).toBeNull();
    // A 20-wide table: 3 spread from its first column fit; from its 19th
    // they would make it 21 wide, so they arrive as text.
    expect(pasteIntoCell(three, schema, $at(true, 20, 0))).toBeNull();
    expect(kinds(pasteIntoCell(three, schema, $at(true, 20, 18))!)).toEqual(["paragraph", "paragraph", "paragraph"]);
  });

  it("sizes a block of cells copied out of a table too — the most common in-app paste (the second re-check's LOW-2)", () => {
    const cells = new Slice(Fragment.from(row(cell("a"), cell("b"), cell("c"))), 1, 1);
    expect(pasteIntoCell(cells, schema, $at(true, 20, 0))).toBeNull();
    expect(kinds(pasteIntoCell(cells, schema, $at(true, 20, 18))!)).toEqual(["paragraph", "paragraph", "paragraph"]);
  });

  it("checks the rows too: a block that would push the table past 500 rows arrives as text", () => {
    const tall = new Slice(Fragment.from(Array.from({ length: 500 }, (_, i) => row(cell(`r${i}`)))), 1, 1);
    // From the first row of a one-row table: exactly 500 — it fits.
    expect(pasteIntoCell(tall, schema, $at(true))).toBeNull();
    // From the second row of a two-row table: 501 — it does not.
    const d = doc(p("before"), table(row(cell("x")), row(cell("y"))), p("after"));
    const secondRow = TextSelection.create(d, d.child(0).nodeSize + 4 + 5 + 2);
    expect(kinds(pasteIntoCell(tall, schema, secondRow)!)).toHaveLength(500);
  });

  it("leaves a paste over a cell selection to prosemirror-tables — it clips the paste to the selection", () => {
    const d = doc(p("before"), table(row(cell("x"), cell("y"))), p("after"));
    const first = d.child(0).nodeSize + 2; // before the first cell
    const sel = CellSelection.create(d, first, first + 5);
    const wide = new Slice(Fragment.from(table(row(...Array.from({ length: 5 }, (_, i) => cell(`c${i}`))))), 0, 0);
    expect(pasteIntoCell(wide, schema, sel)).toBeNull();
  });

  it("a head in a cell, its anchor before the table: a table that fits from the head's cell is left to prosemirror-tables", () => {
    const d = doc(p("before"), table(row(cell("x"))), p("after"));
    const sel = TextSelection.create(d, 1, d.child(0).nodeSize + 4);
    const one = new Slice(Fragment.from(table(row(cell("a")))), 0, 0);
    expect(pasteIntoCell(one, schema, sel)).toBeNull();
  });

  it("a selection from a cell to past the table counts as in it: the table arrives as text, never nested in the start cell (the re-check's LOW-C)", () => {
    const one = new Slice(Fragment.from(table(row(cell("a")))), 0, 0);
    expect(kinds(pasteIntoCell(one, schema, straddling())!)).toEqual(["paragraph"]);
  });
});

describe("wordListsInHtml", () => {
  it("returns any HTML that is not Word's as it came", () => {
    const html = "<ul><li>a</li></ul>";
    expect(wordListsInHtml(html)).toBe(html);
  });
});

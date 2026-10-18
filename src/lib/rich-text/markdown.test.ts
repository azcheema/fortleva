import { describe, expect, it } from "vitest";

import { fixPastedTables, inline, looksLikeMarkdown, markdownToBlocks, untable, type PmJson } from "./markdown";
import { normalizeDescription } from "./normalize";
import { TABLE_MAX_COLUMNS, TABLE_MAX_ROWS } from "./table-bounds";

/**
 * Pasted formatting, the pure half (slice 132, C109): what ChatGPT's and
 * Claude's Copy buttons put on the clipboard as plain text, and pasted
 * tables. Every result is fed through the REAL normaliser too — the paste
 * is only a proposal; what the server keeps is what counts. Word's lists
 * are `word-lists.test.ts`'s.
 */

const LINE_SEPARATOR = String.fromCharCode(0x2028);

const blocks = (md: string): PmJson[] => {
  const out = markdownToBlocks(md);
  if (!out) throw new Error("not read as markdown");
  return out;
};
const stored = (content: readonly PmJson[]) => normalizeDescription({ type: "doc", content });
const types = (nodes: readonly PmJson[]) => nodes.map((n) => n.type);
const para = (value: string): PmJson => ({ type: "paragraph", content: [{ type: "text", text: value }] });

describe("looksLikeMarkdown", () => {
  it("is false for ordinary text, and true for a block or an inline marker", () => {
    expect(looksLikeMarkdown("Hi Anna,\nthe site is live. Thanks!")).toBe(false);
    expect(looksLikeMarkdown("snake_case and 2 * 3 * 4")).toBe(false);
    expect(looksLikeMarkdown("## Plan")).toBe(true);
    expect(looksLikeMarkdown("Do it **now**")).toBe(true);
    expect(looksLikeMarkdown("- one\n- two")).toBe(true);
    expect(looksLikeMarkdown("| a | b |\n|---|---|")).toBe(true);
  });

  it("refuses to read a paste past the cap", () => {
    expect(looksLikeMarkdown(`# x\n${"a".repeat(200_001)}`)).toBe(false);
  });

  it("stays linear on the inputs that make a backtracking pattern quadratic (AGENTS.md's slice-121 trap)", () => {
    const spaces = " ".repeat(60_000);
    const hostile = [
      `# ${spaces}x y`,
      `\`\`\`${spaces}x y`,
      `-${spaces}x`,
      `|${spaces}|${spaces}x`,
      `| a |\n|${"-".repeat(30_000)}${spaces}x`,
      // A heading's text goes through `inline`, so these exercise its scans.
      `# ${"[".repeat(150_000)}`,
      `# ${"https://.".repeat(15_000)}`,
      `# ${"**a ".repeat(30_000)}`,
      `# ${"`a".repeat(50_000)}`,
      // A line terminator JavaScript's `.` refuses, after a run of spaces —
      // `(.*)$` backtracked through the run (both reviews' LOW); a lone CR too.
      `# ${spaces}x${LINE_SEPARATOR}y`,
      `- ${spaces}x${LINE_SEPARATOR}x`,
      `1. ${spaces}x\rx`,
      // Quotes in quotes, once per `>`.
      ">".repeat(100_000),
      // No block marker at all: only the inline hint runs, its link scan bounded.
      "[a](".repeat(50_000),
      // A table past the bounds is never built cell by cell (the re-check's LOW-B).
      `|a|\n|---|\n${"|a|\n".repeat(5_000)}${"|".repeat(5_000)}`,
    ];
    const started = performance.now();
    for (const text of hostile) markdownToBlocks(text);
    // Each would take seconds to minutes if quadratic; linear is milliseconds.
    expect(performance.now() - started).toBeLessThan(3_000);
  });
});

describe("markdownToBlocks", () => {
  const ANSWER = [
    "## The plan",
    "",
    "Here is **the** plan, with `code` and a [link](https://example.com/a).",
    "A second line of the same paragraph.",
    "",
    "1. First",
    "2. Second",
    "   - nested *point*",
    "",
    "| Page | Owner |",
    "|:-----|------:|",
    "| Home | **Anna** |",
    "| About |",
    "",
    "```TypeScript",
    "const x = 1;",
    "",
    "const y = 2;",
    "```",
    "",
    "> A quote",
    "> over two lines",
    "",
    "---",
    "",
    "- [ ] To do",
    "- [x] Done",
    "",
    "#### Deep heading",
  ].join("\n");

  it("reads a typical assistant answer into the blocks the editor keeps", () => {
    const out = blocks(ANSWER);
    expect(types(out)).toEqual([
      "heading",
      "paragraph",
      "orderedList",
      "table",
      "codeBlock",
      "blockquote",
      "horizontalRule",
      "taskList",
      "heading",
    ]);
    // Every block survives the server's gate, as the paste would be stored.
    const kept = stored(out);
    expect(kept.doc).not.toBeNull();
    expect(kept.checklistTotal).toBe(2);
    expect(kept.checklistDone).toBe(1);
  });

  it("clamps a deep heading to level 3 and keeps a soft line break as a break", () => {
    const out = blocks(ANSWER);
    expect(out[0]).toMatchObject({ type: "heading", attrs: { level: 2 } });
    expect(out[8]).toMatchObject({ type: "heading", attrs: { level: 3 } });
    expect(types(out[1]!.content!)).toContain("hardBreak");
  });

  it("nests a deeper list line into the item above it", () => {
    const list = blocks(ANSWER)[2]!;
    expect(list).toMatchObject({ type: "orderedList", attrs: { start: 1 } });
    const second = list.content![1]!;
    expect(types(second.content!)).toEqual(["paragraph", "bulletList"]);
  });

  it("reads a pipe table with a header row, short rows padded to its width", () => {
    const t = blocks(ANSWER)[3]!;
    expect(t.content).toHaveLength(3);
    expect(types(t.content![0]!.content!)).toEqual(["tableHeader", "tableHeader"]);
    expect(types(t.content![2]!.content!)).toEqual(["tableCell", "tableCell"]);
    expect(t.content![1]!.content![1]!.content![0]!.content![0]).toMatchObject({ text: "Anna", marks: [{ type: "bold" }] });
  });

  it("keeps a fenced block's lines and its language, lowercased", () => {
    expect(blocks(ANSWER)[4]).toEqual({
      type: "codeBlock",
      attrs: { language: "typescript" },
      content: [{ type: "text", text: "const x = 1;\n\nconst y = 2;" }],
    });
  });

  it("starts a numbered list where the text does", () => {
    expect(blocks("3. Third\n4. Fourth")[0]).toMatchObject({ type: "orderedList", attrs: { start: 3 } });
  });

  it("reads a line separator as a line break", () => {
    expect(types(blocks(`# One${LINE_SEPARATOR}- two`))).toEqual(["heading", "bulletList"]);
  });

  it("caps quotes inside quotes — deeper ones are text", () => {
    let depth = 0;
    let node: PmJson | undefined = blocks(">".repeat(50) + " deep")[0];
    while (node?.type === "blockquote") {
      depth += 1;
      node = node.content?.[0];
    }
    expect(depth).toBe(8);
    expect(node?.type).toBe("paragraph");
  });

  it("a fence under a list item is a code block, its lines whole and unindented", () => {
    const out = blocks("1. Run:\n   ```bash\n   npm i\n     - key: value\n   ```\n2. Done");
    expect(types(out)).toEqual(["orderedList", "codeBlock", "orderedList"]);
    expect(out[1]).toEqual({ type: "codeBlock", attrs: { language: "bash" }, content: [{ type: "text", text: "npm i\n  - key: value" }] });
  });

  it("a four-backtick fence holds a three-backtick line", () => {
    expect(blocks("````md\n```js\nx\n```\n````")).toEqual([
      { type: "codeBlock", attrs: { language: "md" }, content: [{ type: "text", text: "```js\nx\n```" }] },
    ]);
  });

  it("a table past the bounds is a line of text per row, never built", () => {
    const wide = `| ${Array.from({ length: 21 }, (_, i) => `h${i}`).join(" | ")} |\n|${"---|".repeat(21)}\n| 1 | 2 |`;
    const out = blocks(wide);
    expect(types(out)).toEqual(["paragraph", "paragraph"]);
    expect(out[1]!.content![0]!.text).toBe("1 | 2");
  });

  it("an indented heading under a list item is a heading of its own", () => {
    expect(types(blocks("- item\n  ## Sub\n- next"))).toEqual(["bulletList", "heading", "bulletList"]);
  });

  it("keeps a row's cells past the header's — the header widens", () => {
    const t = blocks("| a |\n|---|\n| 1 | 2 |")[0]!;
    expect(t.content![0]!.content).toHaveLength(2);
    expect(t.content![1]!.content![1]!.content![0]!.content![0]!.text).toBe("2");
  });

  it("an unclosed fence runs to the end, never loops", () => {
    expect(blocks("```\nopen")).toEqual([{ type: "codeBlock", content: [{ type: "text", text: "open" }] }]);
  });
});

describe("inline", () => {
  it("reads bold, italic, strike, code and nesting", () => {
    expect(inline("a **b *c*** ~~d~~ `e`")).toEqual([
      { type: "text", text: "a " },
      { type: "text", text: "b ", marks: [{ type: "bold" }] },
      { type: "text", text: "c", marks: [{ type: "bold" }, { type: "italic" }] },
      { type: "text", text: " " },
      { type: "text", text: "d", marks: [{ type: "strike" }] },
      { type: "text", text: " " },
      { type: "text", text: "e", marks: [{ type: "code" }] },
    ]);
  });

  it("reads three stars as bold and italic", () => {
    expect(inline("***both***")).toEqual([{ type: "text", text: "both", marks: [{ type: "bold" }, { type: "italic" }] }]);
  });

  it("never reads snake_case, a lone star or an unclosed pair as emphasis", () => {
    expect(inline("snake_case_name")).toEqual([{ type: "text", text: "snake_case_name" }]);
    expect(inline("2 * 3 * 4")).toEqual([{ type: "text", text: "2 * 3 * 4" }]);
    expect(inline("**open")).toEqual([{ type: "text", text: "**open" }]);
  });

  it("links http(s) and mailto only — any other scheme stays its text", () => {
    expect(inline("[site](https://example.com)")).toEqual([
      { type: "text", text: "site", marks: [{ type: "link", attrs: { href: "https://example.com" } }] },
    ]);
    // Read whole (balanced parentheses), and not a link: just its text.
    expect(inline("[x](javascript:alert(1))")).toEqual([{ type: "text", text: "x" }]);
    expect(inline("[x](data:text/html,hi)")).toEqual([{ type: "text", text: "x" }]);
    expect(inline("see https://example.com/a.")).toEqual([
      { type: "text", text: "see " },
      { type: "text", text: "https://example.com/a", marks: [{ type: "link", attrs: { href: "https://example.com/a" } }] },
      { type: "text", text: "." },
    ]);
  });

  it("code inside a link keeps the link — the schema's code mark excludes every other (the code review's MEDIUM-2)", () => {
    const out = blocks("See [`useState`](https://react.dev/x)\n\n- a");
    expect(out[0]!.content).toEqual([
      { type: "text", text: "See " },
      { type: "text", text: "useState", marks: [{ type: "link", attrs: { href: "https://react.dev/x" } }] },
    ]);
    expect(stored(out).doc).not.toBeNull();
  });

  it("keeps a URL's balanced parentheses, in a link and bare", () => {
    const wiki = "https://en.wikipedia.org/wiki/Mercury_(planet)";
    expect(inline(`[Mercury](${wiki})`)).toEqual([{ type: "text", text: "Mercury", marks: [{ type: "link", attrs: { href: wiki } }] }]);
    expect(inline(`(see ${wiki}).`)).toEqual([
      { type: "text", text: "(see " },
      { type: "text", text: wiki, marks: [{ type: "link", attrs: { href: wiki } }] },
      { type: "text", text: ")." },
    ]);
  });

  it("a backslash escapes the next mark", () => {
    expect(inline("\\*not italic\\*")).toEqual([{ type: "text", text: "*not italic*" }]);
  });

  it("a pasted javascript: link never survives the server either", () => {
    const out = stored([
      { type: "paragraph", content: [{ type: "text", text: "x", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }] },
    ]);
    expect(JSON.stringify(out.doc)).not.toContain("javascript");
  });
});

describe("fixPastedTables", () => {
  const cell = (value: string, attrs?: Record<string, unknown>): PmJson => ({
    type: "tableCell",
    ...(attrs ? { attrs } : {}),
    content: [para(value)],
  });
  const row = (...cells: PmJson[]): PmJson => ({ type: "tableRow", content: cells });
  const table = (...rows: PmJson[]): PmJson => ({ type: "table", content: rows });

  it("leaves a table the document can keep alone — the same array", () => {
    const nodes = [table(row(cell("a"), cell("b", { colspan: 1, rowspan: 1, colwidth: null, align: null })))];
    expect(fixPastedTables(nodes)).toBe(nodes);
  });

  it("flattens a table inside a table into its cells' blocks — an email's layout", () => {
    const nodes = [table(row({ type: "tableCell", content: [table(row(cell("x"), cell("y")))] }))];
    const out = fixPastedTables(nodes);
    expect(out).toEqual([table(row({ type: "tableCell", content: [para("x"), para("y")] }))]);
    expect(stored(out).doc).not.toBeNull();
  });

  it("cleans a page's cell attributes: a string span bounded, a rowspan cut to the rows left, no width or alignment", () => {
    const out = fixPastedTables([
      table(row(cell("a", { colspan: "1e9", rowspan: "7", colwidth: [900], align: "right" })), row(cell("b"))),
    ]);
    expect(out[0]!.content![0]!.content![0]!.attrs).toEqual({ colspan: 1, rowspan: 2 });
    expect(stored(out).doc).not.toBeNull();
  });

  it("a table past the bounds becomes one line per row — nothing dropped, nothing refused", () => {
    const wide = Array.from({ length: TABLE_MAX_COLUMNS + 1 }, (_, i) => cell(`c${i}`));
    const out = fixPastedTables([table(row(...wide), row(cell("only")))]);
    expect(types(out)).toEqual(["paragraph", "paragraph"]);
    expect(out[0]!.content![0]!.text).toBe(wide.map((_, i) => `c${i}`).join(" | "));
    expect(out[1]).toEqual(para("only"));
    // A span counts by its width.
    expect(types(fixPastedTables([table(row(cell("a", { colspan: 15 }), cell("b", { colspan: 6 })))]))).toEqual(["paragraph"]);
    const long = table(...Array.from({ length: TABLE_MAX_ROWS + 1 }, () => row(cell("r"))));
    expect(fixPastedTables([long])).toHaveLength(TABLE_MAX_ROWS + 1);
  });

  it("counts a cell carried down from the row above (the security review's MEDIUM-1)", () => {
    // Each row's own cells are 15 wide; the grid, with the carried 10, is 25.
    const carried = table(
      row(cell("tall", { rowspan: 2, colspan: 10 }), cell("a", { colspan: 5 })),
      row(cell("b", { colspan: 15 })),
    );
    expect(types(fixPastedTables([carried]))).toEqual(["paragraph", "paragraph"]);
  });

  it("cleans a lone pasted cell or row the same way — a page's single `<td colspan=\"1e9\">` (the re-check's LOW-A)", () => {
    const lone = fixPastedTables([cell("x", { colspan: "1e9" })]);
    expect(lone[0]!.attrs).toEqual({ colspan: 1, rowspan: 1 });
    const loneRow = fixPastedTables([row(cell("a", { colspan: "1e9", rowspan: "9" }))]);
    expect(loneRow[0]!.content![0]!.attrs).toEqual({ colspan: 1, rowspan: 1 });
    const wideRow = fixPastedTables([row(...Array.from({ length: TABLE_MAX_COLUMNS + 1 }, (_, i) => cell(`c${i}`)))]);
    expect(types(wideRow)).toEqual(["paragraph"]);
    const clean = [row(cell("a"))];
    expect(fixPastedTables(clean)).toBe(clean);
  });

  it("a block of rows copied out of a table keeps a merged-down cell's span (the second re-check's LOW-1)", () => {
    // A (rowspan 2) | B over C: copied as two rows, the second holding only C.
    const block = [row(cell("A", { rowspan: 2 }), cell("B")), row(cell("C"))];
    expect(fixPastedTables(block)).toBe(block);
    // A rowspan past the copied block is cut to it — and only that.
    const out = fixPastedTables([row(cell("A", { rowspan: 5 }), cell("B")), row(cell("C"))]);
    expect(out[0]!.content![0]!.attrs).toEqual({ colspan: 1, rowspan: 2 });
    expect(out[1]!.content![0]!.attrs ?? null).toBeNull();
  });

  it("a nested table of empty rows leaves its cell a block to hold, never an empty cell", () => {
    const out = fixPastedTables([table(row({ type: "tableCell", content: [{ type: "table", content: [{ type: "tableRow", content: [] }] }] }))]);
    expect(out[0]!.content![0]!.content![0]!.content).toEqual([{ type: "paragraph" }]);
  });

  it("a run of lone cells is one row: past 20 wide, a line of text", () => {
    const cells = Array.from({ length: TABLE_MAX_COLUMNS + 1 }, (_, i) => cell(`c${i}`));
    expect(types(fixPastedTables(cells))).toEqual(["paragraph"]);
  });

  it("untable turns every table into its cells' blocks", () => {
    expect(untable([para("a"), table(row(cell("b"), cell("c")))])).toEqual([para("a"), para("b"), para("c")]);
  });
});

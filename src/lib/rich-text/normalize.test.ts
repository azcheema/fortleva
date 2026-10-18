import { describe, expect, it } from "vitest";

import { DomainError } from "@/lib/domain-error";
import { DESCRIPTION_JSON_BYTES, normalizeDescription } from "./normalize";

/**
 * The description's gatekeeper, tested as the server sees it: JSON in,
 * canonical JSON + derived text + derived counts out. Everything here is
 * something a hand-written POST can send — the editor is not a
 * validator, it is a convenience.
 */

const doc = (...content: unknown[]) => ({ type: "doc", content });
const para = (...content: unknown[]) => ({ type: "paragraph", content });
const text = (value: string, marks?: unknown[]) => ({ type: "text", text: value, ...(marks ? { marks } : {}) });
const task = (checked: unknown, value: string) => ({
  type: "taskItem",
  attrs: { checked },
  content: [para(text(value))],
});

describe("normalizeDescription", () => {
  it("keeps a plain document and derives its text", () => {
    const out = normalizeDescription(doc(para(text("Set up staging")), para(text("Then tell the client"))));
    expect(out.text).toBe("Set up staging\nThen tell the client");
    expect(out.checklistTotal).toBe(0);
    expect(out.doc).toMatchObject({ type: "doc" });
  });

  it("treats an empty document as no description at all", () => {
    expect(normalizeDescription(doc(para()))).toMatchObject({ doc: null, text: null, checklistTotal: 0 });
    expect(normalizeDescription(doc(para(text("   "))))).toMatchObject({ doc: null, text: null });
  });

  it("refuses a node type the editor cannot produce", () => {
    expect(() => normalizeDescription(doc({ type: "iframe", attrs: { src: "https://evil.test" } }))).toThrow(
      DomainError,
    );
    expect(() => normalizeDescription(doc(para(text("hi", [{ type: "script" }]))))).toThrow(DomainError);
    expect(() => normalizeDescription("not a document")).toThrow(DomainError);
  });

  it("keeps http, https and mailto links and drops every other scheme — the text always survives", () => {
    for (const href of ["https://example.test/a", "http://example.test", "mailto:a@example.test"]) {
      const out = normalizeDescription(doc(para(text("go", [{ type: "link", attrs: { href } }]))));
      expect(JSON.stringify(out.doc)).toContain(href.replace(/\/$/, ""));
    }
    for (const href of ["javascript:alert(1)", "data:text/html;base64,PHN2Zz4=", "/projects/ACME", "", "vbscript:x"]) {
      const out = normalizeDescription(doc(para(text("go", [{ type: "link", attrs: { href } }]))));
      expect(JSON.stringify(out.doc)).not.toContain("link");
      expect(out.text).toBe("go"); // the mark goes, the words stay
    }
  });

  it("stores a link's href and nothing else — no class, no title, no target", () => {
    const out = normalizeDescription(
      doc(
        para(
          text("go", [
            {
              type: "link",
              attrs: {
                href: "https://example.test/",
                class: "fixed inset-0 bg-black",
                title: "text the team never sees",
                target: "_self",
                rel: "me",
              },
            },
          ]),
        ),
      ),
    );
    const json = JSON.stringify(out.doc);
    expect(json).toContain("https://example.test/");
    expect(json).not.toContain("inset-0");
    expect(json).not.toContain("never sees");
    expect(json).not.toContain("_self");
  });

  it("clamps the attributes a crafted document can set", () => {
    const heading = normalizeDescription(doc({ type: "heading", attrs: { level: 7 }, content: [text("H")] }));
    expect(JSON.stringify(heading.doc)).toContain('"level":1');
    const code = normalizeDescription(
      doc({ type: "codeBlock", attrs: { language: "<script>alert(1)</script>" }, content: [text("x")] }),
    );
    expect(JSON.stringify(code.doc)).not.toContain("script");
    const list = normalizeDescription(
      doc({
        type: "orderedList",
        attrs: { start: -5, type: "evil" },
        content: [{ type: "listItem", content: [para(text("one"))] }],
      }),
    );
    expect(JSON.stringify(list.doc)).toContain('"start":1');
    expect(JSON.stringify(list.doc)).not.toContain("evil");
  });

  it("counts every checklist item, nested ones included, and only a REAL true is done", () => {
    const out = normalizeDescription(
      doc({
        type: "taskList",
        content: [
          task(true, "done"),
          task("false", "a string is not done"),
          task("true", "nor is this"),
          {
            ...task(false, "parent"),
            content: [para(text("parent")), { type: "taskList", content: [task(true, "nested done")] }],
          },
        ],
      }),
    );
    expect(out.checklistTotal).toBe(5);
    expect(out.checklistDone).toBe(2);
  });

  it("refuses a document past the byte cap before it parses anything", () => {
    const huge = doc(para(text("x".repeat(DESCRIPTION_JSON_BYTES))));
    expect(() => normalizeDescription(huge)).toThrow(expect.objectContaining({ code: "DESCRIPTION_TOO_LARGE" }));
  });

  it("refuses text past the search feed's cap", () => {
    // Under the byte cap, over the 100k character cap: many small blocks.
    const blocks = Array.from({ length: 400 }, () => para(text("y".repeat(260))));
    expect(() => normalizeDescription(doc(...blocks))).toThrow(
      expect.objectContaining({ code: "DESCRIPTION_TOO_LARGE" }),
    );
  });


  it("refuses a document whose root is not `doc`", () => {
    // A hand-written POST can send any node type as the root. Stored, it
    // would be a `paragraph` where every reader expects a `doc` — and the
    // editor's own setContent would throw on the next poll re-render.
    expect(() => normalizeDescription({ type: "paragraph", content: [text("loose")] })).toThrow(DomainError);
    expect(() => normalizeDescription(text("bare text"))).toThrow(DomainError);
  });

  it("refuses content smuggled inside a leaf node — text that indexes but never renders", () => {
    // `Node.fromJSON` builds a node WITHOUT checking it against its
    // content expression, so a leaf can be handed children. They render
    // nothing and still reach descriptionText, which is the search
    // index's body tier: a task would surface for words no one can see.
    expect(() =>
      normalizeDescription(doc({ type: "horizontalRule", content: [text("invisible keyword")] })),
    ).toThrow(DomainError);
    expect(() => normalizeDescription(doc({ type: "hardBreak", content: [text("also hidden")] }))).toThrow(DomainError);
  });

  it("refuses text Postgres cannot store, rather than letting the write throw", () => {
    // jsonb and text both reject U+0000 and unpaired surrogates. Without
    // a check here the failure is a 500 from the database driver instead
    // of a typed refusal the panel can toast.
    expect(() => normalizeDescription(doc(para(text(`a${String.fromCharCode(0)}b`))))).toThrow(DomainError);
    expect(() => normalizeDescription(doc(para(text(`a${String.fromCharCode(0xd800)}b`))))).toThrow(DomainError);
  });


  it("accepts the document the real editor produces for a checklist", () => {
    // The exact shape Tiptap emits after typing text, Enter, "[ ] a",
    // Enter, "b": a paragraph, a taskList of two taskItems each wrapping
    // a paragraph, and the trailing paragraph ProseMirror keeps.
    const out = normalizeDescription(
      doc(
        para(text("The stack is behind the shed.")),
        {
          type: "taskList",
          content: [
            { type: "taskItem", attrs: { checked: false }, content: [para(text("buy sealant"))] },
            { type: "taskItem", attrs: { checked: false }, content: [para(text("bleed the radiator"))] },
          ],
        },
        para(),
      ),
    );
    expect(out.checklistTotal).toBe(2);
    expect(out.checklistDone).toBe(0);
    expect(out.text).toContain("buy sealant");
  });


  it("drops a link whose host is spoofed with embedded credentials", () => {
    // Reads as the-bank.example to a person; goes to evil.test. A
    // description can be CLIENT_VISIBLE, so the target is the tenant's
    // own customer.
    const out = normalizeDescription(
      doc(para(text("pay here", [{ type: "link", attrs: { href: "https://www.the-bank.example@evil.test/" } }]))),
    );
    expect(JSON.stringify(out.doc)).not.toContain("link");
    expect(JSON.stringify(out.doc)).not.toContain("evil.test");
    expect(out.text).toBe("pay here");
  });

  it("measures the cap on what is STORED, not only on what arrived", () => {
    // Normalisation adds the attributes the sender omitted, so a
    // document can grow crossing this function. Bare headings carry no
    // attrs in; each leaves with {"level":1}.
    const headings = Array.from({ length: 8_000 }, () => ({ type: "heading", content: [text("h")] }));
    const input = doc(...headings);
    expect(Buffer.byteLength(JSON.stringify(input), "utf8")).toBeLessThan(DESCRIPTION_JSON_BYTES);
    expect(() => normalizeDescription(input)).toThrow(
      expect.objectContaining({ code: "DESCRIPTION_TOO_LARGE" }),
    );
  });


  it("refuses a taskItem that is not inside a taskList, so no count comes from a node that renders nowhere", () => {
    // checklistTotal drives the "n of m" on the board card and the
    // panel's rail. A taskItem loose in the document, or buried in a
    // blockquote, would be counted and never drawn as a checkbox.
    expect(() => normalizeDescription(doc(task(true, "phantom")))).toThrow(DomainError);
    expect(() =>
      normalizeDescription(doc({ type: "blockquote", content: [task(true, "buried")] })),
    ).toThrow(DomainError);
  });

  it("runs with no DOM — this file's environment is node, which is where the server does it", () => {
    expect(typeof globalThis.document).toBe("undefined");
  });
});

// Slice 132 (C109): simple tables.
const cell = (type: "tableHeader" | "tableCell", value: string, attrs?: Record<string, unknown>) => ({
  type,
  ...(attrs ? { attrs } : {}),
  content: [para(text(value))],
});
const row = (...cells: unknown[]) => ({ type: "tableRow", content: cells });
const table = (...rows: unknown[]) => ({ type: "table", content: rows });

describe("normalizeDescription — tables", () => {
  it("keeps a table with a header row, and its cells' text is searchable", () => {
    const out = normalizeDescription(
      doc(table(row(cell("tableHeader", "Page"), cell("tableHeader", "Owner")), row(cell("tableCell", "Home"), cell("tableCell", "Anna")))),
    );
    const stored = out.doc as { content: { type: string; content: { content: { type: string }[] }[] }[] };
    expect(stored.content[0]!.type).toBe("table");
    expect(stored.content[0]!.content[0]!.content.map((c) => c.type)).toEqual(["tableHeader", "tableHeader"]);
    expect(out.text).toContain("Home");
    expect(out.text).toContain("Anna");
  });

  it("drops a stored width and an alignment, and bounds a span", () => {
    const out = normalizeDescription(
      doc(
        table(
          row(
            cell("tableCell", "a", { colwidth: [400], align: "right", colspan: 2, rowspan: 1 }),
            cell("tableCell", "b", { colspan: 9999, rowspan: -3 }),
          ),
        ),
      ),
    );
    const cells = (out.doc as { content: { content: { content: { attrs: Record<string, unknown> }[] }[] }[] }).content[0]!.content[0]!
      .content;
    expect(cells[0]!.attrs["colwidth"] ?? null).toBeNull();
    expect(cells[0]!.attrs["align"] ?? null).toBeNull();
    expect(cells[0]!.attrs["colspan"]).toBe(2);
    expect(cells[1]!.attrs["colspan"]).toBe(1);
    expect(cells[1]!.attrs["rowspan"]).toBe(1);
  });

  it("refuses a table inside a table — no surface draws one", () => {
    const inner = table(row(cell("tableCell", "inner")));
    expect(() => normalizeDescription(doc(table(row({ type: "tableCell", content: [inner] }))))).toThrow(DomainError);
  });

  it("refuses a table past the bounds as too large — a row's width counts a span", () => {
    const wide = row(...Array.from({ length: 21 }, (_, i) => cell("tableCell", `c${i}`)));
    expect(() => normalizeDescription(doc(table(wide)))).toThrow(expect.objectContaining({ code: "TABLE_TOO_LARGE" }));
    const spanned = row(...Array.from({ length: 11 }, (_, i) => cell("tableCell", `c${i}`, { colspan: 2 })));
    expect(() => normalizeDescription(doc(table(spanned)))).toThrow(expect.objectContaining({ code: "TABLE_TOO_LARGE" }));
    const long = table(...Array.from({ length: 501 }, () => row(cell("tableCell", "x"))));
    expect(() => normalizeDescription(doc(long))).toThrow(expect.objectContaining({ code: "TABLE_TOO_LARGE" }));
    expect(normalizeDescription(doc(table(...Array.from({ length: 500 }, () => row(cell("tableCell", "x"))))))).toMatchObject({
      doc: { type: "doc" },
    });
  });

  it("counts a cell carried down by its rowspan — the grid's width, not a row's own (the security review's MEDIUM-1)", () => {
    // Every row's own cells are 20 wide; the grid is 20 × 3 = 60.
    const carried = table(...Array.from({ length: 3 }, () => row(cell("tableCell", "x", { colspan: 20, rowspan: 3 }))));
    expect(() => normalizeDescription(doc(carried))).toThrow(expect.objectContaining({ code: "TABLE_TOO_LARGE" }));
  });

  it("refuses a rowspan past the last row and cells that overlap — the editor repairs both, so only a crafted body holds one", () => {
    const pastEnd = table(row(cell("tableCell", "x", { rowspan: 3 })), row(cell("tableCell", "y")));
    expect(() => normalizeDescription(doc(pastEnd))).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    const overlap = table(
      row(cell("tableCell", "a", { rowspan: 2 }), cell("tableCell", "b"), cell("tableCell", "c", { rowspan: 2 })),
      row(cell("tableCell", "d", { colspan: 2 })),
    );
    expect(() => normalizeDescription(doc(overlap))).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("keeps a table with nothing typed in it yet — someone made it", () => {
    const empty = { type: "table", content: [row({ type: "tableHeader", content: [{ type: "paragraph" }] })] };
    expect(normalizeDescription(doc(empty)).doc).toMatchObject({ type: "doc", content: [{ type: "table" }] });
  });

  it("refuses a row outside a table, and a table with no rows", () => {
    expect(() => normalizeDescription(doc(row(cell("tableCell", "x"))))).toThrow(DomainError);
    expect(() => normalizeDescription(doc({ type: "table", content: [] }))).toThrow(DomainError);
  });
});

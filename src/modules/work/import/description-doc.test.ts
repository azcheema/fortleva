import { describe, expect, it } from "vitest";

import { normalizeDescription } from "@/lib/rich-text/normalize";

import { importDescription, inline } from "./description-doc";

const LABEL = "Imported from Trello:";
const build = (text: string, extra: Partial<Parameters<typeof importDescription>[0]> = {}) =>
  importDescription({ text, checklists: [], link: null, linkLabel: LABEL, ...extra });

describe("importDescription", () => {
  it("is null when there is nothing at all", () => {
    expect(build("   \n\n")).toBeNull();
  });

  it("draws paragraphs, hard breaks, headings and the three lists — and passes the description gate", () => {
    const doc = build("# Goal\nLine one\nLine two\n\n- a\n- b\n\n1. first\n2. second\n\n- [ ] open\n- [x] done");
    expect(doc!.content!.map((n) => n.type)).toEqual(["heading", "paragraph", "bulletList", "orderedList", "taskList"]);
    expect(doc!.content![1]!.content!.map((n) => n.type)).toEqual(["text", "hardBreak", "text"]);
    const stored = normalizeDescription(doc);
    expect(stored.checklistTotal).toBe(2);
    expect(stored.checklistDone).toBe(1);
    expect(stored.text).toContain("Line one");
  });

  it("keeps an ordered list's start and leaves **bold** as typed", () => {
    const doc = build("3. third\n4. fourth\n\n**bold**");
    expect(doc!.content![0]).toMatchObject({ type: "orderedList", attrs: { start: 3 } });
    expect(doc!.content![1]!.content![0]!.text).toBe("**bold**");
  });

  it("adds the checklists under their names and the closing link line", () => {
    const doc = build("Body", {
      checklists: [
        { name: null, items: [{ text: "One", done: true }] },
        { name: "Launch", items: [{ text: "Two", done: false }, { text: "  ", done: false }] },
      ],
      link: "https://trello.com/c/AbCd",
    });
    expect(doc!.content!.map((n) => n.type)).toEqual(["paragraph", "taskList", "heading", "taskList", "paragraph"]);
    const last = doc!.content!.at(-1)!;
    expect(last.content![1]).toEqual({ type: "text", text: "https://trello.com/c/AbCd", marks: [{ type: "link", attrs: { href: "https://trello.com/c/AbCd" } }] });
    const stored = normalizeDescription(doc);
    expect(stored.checklistTotal).toBe(2);
  });
});

describe("inline", () => {
  it("links bare URLs without the sentence's closing punctuation, and Markdown links", () => {
    expect(inline("See https://example.se/a. And [docs](https://example.se/d)!")).toEqual([
      { type: "text", text: "See " },
      { type: "text", text: "https://example.se/a", marks: [{ type: "link", attrs: { href: "https://example.se/a" } }] },
      { type: "text", text: ". And " },
      { type: "text", text: "docs", marks: [{ type: "link", attrs: { href: "https://example.se/d" } }] },
      { type: "text", text: "!" },
    ]);
  });

  it("never makes an empty text node", () => {
    for (const node of inline("https://a.se")) expect(node.text).not.toBe("");
  });

  it("stays linear on long runs the browser chooses — no quadratic regex (the security review's MEDIUM)", () => {
    // Six lines of 40 000 spaces ending in a letter: the old `/\s+$/` took
    // ~300 ms PER LINE on a laptop (measured), so ~2 s here; linear, both
    // builds are a few milliseconds.
    const spaces = Array.from({ length: 6 }, () => `${" ".repeat(39_999)}x`).join("\n");
    // The fix round's shapes: each line pattern's head, a long run of spaces,
    // and a LINE SEPARATOR mid-line — the character `.` does not match, which
    // used to make `\s+(.+)$` try every split of the spaces.
    const ls = String.fromCharCode(0x2028);
    const heads = ["# ", "- ", "1. ", "- [ ] "].map((head) => `${head}${" ".repeat(39_990)}x${ls}y`).join("\n");
    const started = performance.now();
    build(spaces);
    build(heads);
    expect(performance.now() - started).toBeLessThan(250);
  });

  it("treats the line and paragraph separators as line breaks", () => {
    const ls = String.fromCharCode(0x2028);
    const ps = String.fromCharCode(0x2029);
    const doc = build(`# Title${ls}- one${ps}- two`);
    expect(doc!.content!.map((n) => n.type)).toEqual(["heading", "bulletList"]);
    expect(doc!.content![1]!.content).toHaveLength(2);
  });

  it("an unsafe link is dropped by the gate, its text kept", () => {
    const doc = build("[x](https://user:pw@evil.test/)");
    const stored = normalizeDescription(doc);
    expect(JSON.stringify(stored.doc)).not.toContain("evil.test/\"");
    expect(stored.text).toBe("x");
  });
});

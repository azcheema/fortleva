import { describe, expect, it } from "vitest";

import { DomainError } from "@/lib/domain-error";
import { COMMENT_JSON_BYTES, COMMENT_TEXT_CHARS, normalizeComment, normalizeDescription } from "./normalize";

/**
 * The comment half of the gatekeeper (panel slice 10): the comment
 * schema, the comment caps, and "a comment must say something". The
 * shared walk is `normalize.test.ts`'s; this pins only what differs.
 */

const doc = (...content: unknown[]) => ({ type: "doc", content });
const para = (...content: unknown[]) => ({ type: "paragraph", content });
const text = (value: string, marks?: unknown[]) => ({ type: "text", text: value, ...(marks ? { marks } : {}) });

const code = (e: unknown): string => (e instanceof DomainError ? e.code : String(e));

describe("normalizeComment", () => {
  it("keeps a plain comment and derives its text — never null", () => {
    const out = normalizeComment(doc(para(text("Looks good — ship it")), para(text("Then invoice"))));
    expect(out.text).toBe("Looks good — ship it\nThen invoice");
    expect(out.doc).toMatchObject({ type: "doc" });
  });

  it("refuses an empty comment as COMMENT_EMPTY, where a description is a legitimate nothing", () => {
    expect(normalizeDescription(doc(para()))).toMatchObject({ doc: null });
    expect(() => normalizeComment(doc(para()))).toThrow(DomainError);
    try {
      normalizeComment(doc(para(text("   "))));
      expect.unreachable();
    } catch (e) {
      expect(code(e)).toBe("COMMENT_EMPTY");
    }
  });

  it("refuses the nodes the comment schema does not declare: a heading, a checklist", () => {
    // Both are legal in a DESCRIPTION — the same JSON, two answers.
    const heading = doc({ type: "heading", attrs: { level: 2 }, content: [text("Plan")] }, para(text("body")));
    expect(normalizeDescription(heading).doc).not.toBeNull();
    expect(() => normalizeComment(heading)).toThrow(DomainError);
    const checklist = doc({
      type: "taskList",
      content: [{ type: "taskItem", attrs: { checked: true }, content: [para(text("done"))] }],
    });
    expect(normalizeDescription(checklist).checklistTotal).toBe(1);
    expect(() => normalizeComment(checklist)).toThrow(DomainError);
  });

  it("keeps the inline marks and a safe link, and drops an unsafe one with its text intact", () => {
    const out = normalizeComment(
      doc(
        para(
          text("bold", [{ type: "bold" }]),
          text(" site", [{ type: "link", attrs: { href: "https://example.test/x", target: "_blank", class: "x" } }]),
          text(" evil", [{ type: "link", attrs: { href: "javascript:alert(1)" } }]),
        ),
      ),
    );
    const marks = JSON.stringify(out.doc);
    expect(marks).toContain('"type":"bold"');
    expect(marks).toContain('"href":"https://example.test/x"');
    // The client's `class` did not survive (the re-parse fills the mark's
    // attributes from the SCHEMA's defaults — never from what was sent);
    // the unsafe link is gone with its mark, its text kept.
    expect(marks).not.toContain('"class":"x"');
    expect(marks).not.toContain("javascript:");
    expect(marks).toContain('"text":" evil"}');
    expect(out.text).toBe("bold site evil");
  });

  it("caps at the comment's own size with the comment's own code", () => {
    // Past the comment's TEXT cap, well under the description's.
    const big = doc(para(text("x".repeat(COMMENT_TEXT_CHARS + 1))));
    try {
      normalizeComment(big);
      expect.unreachable();
    } catch (e) {
      expect(code(e)).toBe("COMMENT_TOO_LARGE");
    }
    expect(normalizeDescription(big).text?.length).toBe(COMMENT_TEXT_CHARS + 1);
    // Past the comment's JSON cap on the way in, before any parse.
    const bytes = doc(para(text("y".repeat(COMMENT_JSON_BYTES))));
    try {
      normalizeComment(bytes);
      expect.unreachable();
    } catch (e) {
      expect(code(e)).toBe("COMMENT_TOO_LARGE");
    }
  });

  it("refuses what the editor cannot produce, with the description's own code", () => {
    for (const input of ["not a document", { type: "paragraph" }, doc({ type: "iframe" }), null, 42]) {
      try {
        normalizeComment(input);
        expect.unreachable();
      } catch (e) {
        expect(code(e)).toBe("INVALID_INPUT");
      }
    }
  });
});

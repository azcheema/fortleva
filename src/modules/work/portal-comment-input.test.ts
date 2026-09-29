import { describe, expect, it } from "vitest";

import { normalizeComment } from "@/lib/rich-text/normalize";

import { PORTAL_COMMENT_MAX, portalCommentDoc } from "./portal-comment-input";

/**
 * A CONTACT'S TEXT → THE STORED COMMENT (Phase 3 slice 75). The builder is
 * pure, and what matters about it is that every document it can produce
 * passes the gate every stored comment passes (`normalizeComment`) and
 * says what the person typed — so each case here runs both.
 */
const store = (text: string) => normalizeComment(portalCommentDoc(text));

describe("portalCommentDoc", () => {
  it("one line is one paragraph, stored as typed", () => {
    const n = store("Tack, ser bra ut!");
    expect(n.doc).toEqual({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Tack, ser bra ut!" }] }] });
    expect(n.text).toBe("Tack, ser bra ut!");
  });

  it("a blank line starts a paragraph; a single break is a hard break inside one", () => {
    const doc = portalCommentDoc("Hej\nrad två\n\nNytt stycke");
    expect(doc.content).toHaveLength(2);
    expect(doc.content[0]!.content).toEqual([
      { type: "text", text: "Hej" },
      { type: "hardBreak" },
      { type: "text", text: "rad två" },
    ]);
    expect(doc.content[1]!.content).toEqual([{ type: "text", text: "Nytt stycke" }]);
    expect(() => store("Hej\nrad två\n\nNytt stycke")).not.toThrow();
  });

  it("CRLF from a Windows browser reads as the same text", () => {
    expect(portalCommentDoc("a\r\nb\r\n\r\nc")).toEqual(portalCommentDoc("a\nb\n\nc"));
  });

  it("runs of blank lines — whitespace-only ones too — never make an empty paragraph or an empty text node", () => {
    const doc = portalCommentDoc("a\n\n\n \n\t\n\nb");
    expect(doc.content).toHaveLength(2);
    for (const p of doc.content) {
      expect(p.content.length).toBeGreaterThan(0);
      for (const node of p.content) if (node.type === "text") expect(node.text.length).toBeGreaterThan(0);
    }
    expect(() => store("a\n\n\n \n\t\n\nb")).not.toThrow();
  });

  it("several whitespace-only lines are ONE paragraph break, with no stray space or break after it", () => {
    for (const text of ["a\n \n \nb", "a\n\t\n\n \nb", "a\r\n \r\n\r\nb"]) {
      expect(portalCommentDoc(text)).toEqual(portalCommentDoc("a\n\nb"));
    }
  });

  it("trailing blank lines add nothing", () => {
    const [p] = portalCommentDoc("a\n\n").content;
    expect(p!.content).toEqual([{ type: "text", text: "a" }]);
  });

  it("markup is text: a client's angle brackets and asterisks are stored as characters, never as nodes or marks", () => {
    const n = store("<b>bold</b> **not bold** [link](https://example.com)");
    expect(n.doc).toEqual({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "<b>bold</b> **not bold** [link](https://example.com)" }] }],
    });
  });

  it("the longest comment the box allows is still well under the stored caps", () => {
    const n = store("x".repeat(PORTAL_COMMENT_MAX));
    expect(n.text).toHaveLength(PORTAL_COMMENT_MAX);
  });
});

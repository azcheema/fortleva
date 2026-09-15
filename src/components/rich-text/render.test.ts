import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { normalizeComment, normalizeDescription } from "@/lib/rich-text/normalize";
import { RichText } from "./render";

/**
 * The static renderer (panel slice 10), fed what the NORMALISER stores
 * — the only input it ever sees in the app — and checked as markup: the
 * link's attributes are decided here, an unknown node prints nothing,
 * and a heading never becomes an h1 (the page has one).
 */

const doc = (...content: unknown[]) => ({ type: "doc", content });
const para = (...content: unknown[]) => ({ type: "paragraph", content });
const text = (value: string, marks?: unknown[]) => ({ type: "text", text: value, ...(marks ? { marks } : {}) });

const html = (d: unknown): string => renderToStaticMarkup(RichText({ doc: d }));

describe("RichText", () => {
  it("renders paragraphs, marks and a link with rel and target decided here", () => {
    const stored = normalizeComment(
      doc(
        para(
          text("a "),
          text("bold", [{ type: "bold" }]),
          text(" and ", []),
          text("code", [{ type: "code" }]),
          text(" link", [{ type: "link", attrs: { href: "https://example.test/x" } }, { type: "italic" }]),
        ),
      ),
    ).doc;
    const out = html(stored);
    expect(out).toContain('<div class="prose-body">');
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<code>code</code>");
    expect(out).toContain('<a href="https://example.test/x" target="_blank" rel="noopener noreferrer nofollow"><em> link</em></a>');
  });

  it("renders lists, quotes, code blocks and breaks", () => {
    const stored = normalizeComment(
      doc(
        { type: "bulletList", content: [{ type: "listItem", content: [para(text("one"))] }] },
        { type: "orderedList", attrs: { start: 3 }, content: [{ type: "listItem", content: [para(text("three"))] }] },
        { type: "blockquote", content: [para(text("said"))] },
        { type: "codeBlock", attrs: { language: "ts" }, content: [text("const x = 1;")] },
        para(text("a"), { type: "hardBreak" }, text("b")),
        { type: "horizontalRule" },
      ),
    ).doc;
    const out = html(stored);
    expect(out).toContain("<ul><li><p>one</p></li></ul>");
    expect(out).toContain('<ol start="3"><li><p>three</p></li></ol>');
    expect(out).toContain("<blockquote><p>said</p></blockquote>");
    expect(out).toContain("<pre><code>const x = 1;</code></pre>");
    expect(out).toContain("<p>a<br/>b</p>");
    expect(out).toContain("<hr/>");
  });

  it("a description's headings sit under the page's h1 and the panel's h2; a checklist is read-only", () => {
    const stored = normalizeDescription(
      doc(
        { type: "heading", attrs: { level: 1 }, content: [text("Top")] },
        { type: "heading", attrs: { level: 3 }, content: [text("Small")] },
        {
          type: "taskList",
          content: [{ type: "taskItem", attrs: { checked: true }, content: [para(text("done"))] }],
        },
      ),
    ).doc;
    const out = html(stored);
    expect(out).toContain("<h3>Top</h3>");
    expect(out).toContain("<h5>Small</h5>");
    expect(out).not.toContain("<h1");
    expect(out).toContain('data-checked="true"');
    expect(out).toMatch(/<input type="checkbox"[^>]*disabled=""[^>]*>/);
    expect(out).toMatch(/<input type="checkbox"[^>]*checked=""[^>]*>/);
  });

  it("prints nothing for a node it does not know, and nothing at all for a non-document", () => {
    // Never normalised — the belt for a row written past the gate.
    expect(html(doc({ type: "iframe", attrs: { src: "https://evil.test" } }, para(text("ok"))))).toBe(
      '<div class="prose-body"><p>ok</p></div>',
    );
    expect(html("nope")).toBe('<div class="prose-body"></div>');
    expect(html(null)).toBe('<div class="prose-body"></div>');
  });

  it("escapes text — a stored body is never markup", () => {
    const stored = normalizeComment(doc(para(text("<img src=x onerror=alert(1)>")))).doc;
    const out = html(stored);
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});

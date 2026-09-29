/**
 * WHAT A CONTACT MAY TYPE INTO A TASK'S COMMENT BOX, AND HOW IT BECOMES
 * A DOCUMENT (Phase 3 slice 75).
 *
 * A LEAF, and that is load-bearing: the portal's composer island is a
 * client component and imports the cap from here. Anything it imported
 * from the work barrel would drag `withTenant` → `pg` into the browser
 * graph, which is the measured failure `request-limits.ts` records.
 *
 * PLAIN TEXT, NEVER A DOCUMENT FROM THE BROWSER — the request body's rule
 * (`requests.ts`), applied to the one row a contact writes under their
 * own principal. A client types into a textarea; admitting ProseMirror
 * JSON here would mean admitting whatever a client's browser chose to
 * send into a `jsonb` column that the member panel renders. So the
 * SERVER builds the document, from text, out of the three node types a
 * paragraph of prose needs — and the writer still passes it through
 * `normalizeComment`, the gate every stored comment goes through, so a
 * bug here is refused rather than stored.
 */

/** The longest comment a contact may send, in UTF-16 units — what a textarea's `maxLength` counts. */
export const PORTAL_COMMENT_MAX = 4000;

type TextNode = { readonly type: "text"; readonly text: string };
type HardBreak = { readonly type: "hardBreak" };
type Paragraph = { readonly type: "paragraph"; readonly content: readonly (TextNode | HardBreak)[] };
export type PortalCommentDoc = { readonly type: "doc"; readonly content: readonly Paragraph[] };

/**
 * Text → the comment schema's smallest document: a blank line starts a
 * new paragraph, a single line break is a `hardBreak` inside one — what
 * a person who pressed Enter meant. Line endings are normalised first
 * (a Windows browser sends CRLF). A blank line is any line of
 * whitespace alone — the same rule `.trim()` applies, NBSP included — so
 * trailing blank lines add nothing. An empty text node is never produced
 * (ProseMirror refuses one): the split leaves no empty line inside a
 * paragraph, and the `line.length` guard below is the backstop. The
 * caller has already refused a comment with no words in it.
 */
export function portalCommentDoc(text: string): PortalCommentDoc {
  const paragraphs = text
    .replace(/\r\n?/g, "\n")
    // One OR MORE blank lines, whitespace-only ones included — a pattern
    // that ate only the first left a stray space and break at the head
    // of the next paragraph (code review).
    .split(/\n(?:[^\S\n]*\n)+/)
    .map((block) => block.replace(/^\n+|\n+$/g, ""))
    .filter((block) => block.trim().length > 0);
  return {
    type: "doc",
    content: paragraphs.map((block) => {
      const content: (TextNode | HardBreak)[] = [];
      block.split("\n").forEach((line, i) => {
        if (i > 0) content.push({ type: "hardBreak" });
        if (line.length > 0) content.push({ type: "text", text: line });
      });
      return { type: "paragraph", content };
    }),
  };
}

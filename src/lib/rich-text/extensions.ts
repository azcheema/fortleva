import { mergeAttributes, Node } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { TaskItem, TaskList } from "@tiptap/extension-list";

import { MEMBER_ID, MENTION_NODE } from "./mention-node";

export { MENTION_NODE };

/**
 * The rich-text schemas (ARC-19). NO React import anywhere in this file:
 * the server parses, validates and extracts text with the SAME schema
 * the browser edits with, and a client-only import would drag the editor
 * into a server action's bundle.
 *
 * TWO SETS, never one. A description and a comment are different
 * documents with different dangers: a comment may mention a member (a
 * name that must never reach a Contact through a client-visible body),
 * a description may carry a checklist and, later, file chips. Sharing
 * one schema is how a paste handler added for one ends up accepting
 * nodes in the other — so each surface declares what it allows, and its
 * normaliser refuses everything else.
 */

/**
 * Client-only trimmings. NOTHING here may change the schema — the server
 * validates against the list this function returns, so an option that
 * added a node or a mark would let the browser store what the server
 * never agreed to. `checkboxLabel` only names the checklist's checkbox
 * for a screen reader (Tiptap renders it into `aria-label` from a node
 * view), which is a translated string and therefore client-side: the
 * server imports this module and has no locale.
 */
type DescriptionOptions = {
  readonly checkboxLabel?: (node: { textContent: string }, checked: boolean) => string;
};

/**
 * The description: StarterKit (paragraphs, headings, lists, quote, code,
 * bold/italic/strike, link) plus the checklist. Deliberately absent:
 * image and file-handler (the paste slice), mention (`Mention.commentId`
 * is NOT NULL, and a name in a client-visible body is the worst bug this
 * product can have), and code-block-lowlight (a later slice).
 *
 * A function, not a constant, so the one definition serves both callers:
 * the server builds the schema from it with no arguments, the editor
 * passes its translated a11y label. Two lists would be two schemas.
 */
export const descriptionExtensions = (options: DescriptionOptions = {}) => [
  StarterKit.configure({
    // The panel is not a document editor: three heading levels are what
    // a task description needs, and each one is a real outline level.
    heading: { levels: [1, 2, 3] },
    // Links are typed, never pasted as HTML with their own attributes;
    // the normaliser is what decides which schemes survive.
    link: { openOnClick: false, autolink: false },
  }),
  TaskList,
  TaskItem.configure({
    nested: true,
    // Without this Tiptap names every checkbox in ENGLISH ("Task item
    // checkbox for …"), whatever the workspace's locale.
    ...(options.checkboxLabel ? { a11y: { checkboxLabel: options.checkboxLabel } } : {}),
  }),
];

/**
 * An @mention of a teammate (slice 125, founder decision C101): an inline
 * atom whose ONE attribute is the member's id. NO name is stored — not as
 * an attribute (Tiptap's own mention extension stores `label` and prints
 * it) and not as text: a name inside a body is a name that travels with it
 * (a raise to client-visible, a copy, the search index), and a member's
 * name must never reach a client (C42). A member READING the comment gets
 * the name resolved at read time (`readItemComments` → `RichText`'s
 * `mentions` map); the portal never passes that map, and the database
 * refuses a client-visible body holding this node at all
 * (the CHECK `comment_visible_no_mention`, 20261029090000).
 *
 * `label` is a RENDER decision, not a schema one (the description's
 * `checkboxLabel` rule): the editor passes the names it knows so a chip
 * reads "@Anna" while it is being written; the server builds the schema
 * with no argument and never renders. The node's text for `textBetween`
 * is the normaliser's leaf rule — a space — so `bodyText` never holds a
 * name either.
 */
const mentionNode = (label?: (id: string | null) => string) =>
  Node.create({
    name: MENTION_NODE,
    group: "inline",
    inline: true,
    atom: true,
    addAttributes() {
      return {
        id: {
          default: null,
          parseHTML: (element) => element.getAttribute("data-id"),
          renderHTML: (attributes) => ({ "data-id": attributes["id"] as string | null }),
        },
      };
    },
    parseHTML() {
      return [
        {
          tag: `span[data-type="${MENTION_NODE}"]`,
          // A chip only WITH a member id: a span without one pastes as its
          // text, never as a mention naming nobody that the server would
          // refuse with a bare "invalid input" (the code review's LOW).
          getAttrs: (element) => (MEMBER_ID.test(element.getAttribute("data-id") ?? "") ? null : false),
        },
      ];
    },
    renderHTML({ node, HTMLAttributes }) {
      const id = typeof node.attrs["id"] === "string" ? (node.attrs["id"] as string) : null;
      return ["span", mergeAttributes({ "data-type": MENTION_NODE, class: "mention" }, HTMLAttributes), `@${label ? label(id) : ""}`];
    },
  });

/** Client-only trimmings for the comment — never a schema change (see `DescriptionOptions`). */
type CommentOptions = {
  /** The name a mention chip shows while it is edited; the server passes none. */
  readonly mentionLabel?: (id: string | null) => string;
};

/**
 * The comment (panel slice 10): StarterKit WITHOUT headings — a comment
 * is a remark under a task, not a document with an outline, and a
 * heading inside a 40-word reply is what a pasted email signature
 * looks like — and without the checklist (a comment has no counters; a
 * checklist belongs in the description, where `⌘⇧O` will turn it into
 * subtasks). Since slice 125 it holds the MENTION node (above) — in this
 * schema only: a description, an update and a contract can be read by a
 * client whole, and the `mention` table hangs off a comment. Deliberately
 * absent: image and file-handler.
 *
 * Its own list, never the description's with an option: the server
 * normaliser refuses every node this list does not declare
 * (`normalizeComment`), so a heading pasted into a comment is refused
 * rather than stored.
 */
export const commentExtensions = (options: CommentOptions = {}) => [
  StarterKit.configure({
    heading: false,
    link: { openOnClick: false, autolink: false },
  }),
  mentionNode(options.mentionLabel),
];

/**
 * The contract (Phase 4 slice 112, founder decision C84 (a)): a document
 * a client SIGNS, written from a template and frozen at sending. Headings,
 * lists, quotes, rules and the text marks a contract is written with; NO
 * code or code block (a contract is prose) and NO checklist — a checkbox
 * has no meaning in a signed document, and one ticked or not at sending
 * would read as a term. The PDF walker (`src/modules/contracts/pdf`) draws
 * exactly this list, so a node added here must be drawn there too.
 */
export const contractExtensions = () => [
  StarterKit.configure({
    heading: { levels: [1, 2, 3] },
    code: false,
    codeBlock: false,
    link: { openOnClick: false, autolink: false },
  }),
];

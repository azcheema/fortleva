import { StarterKit } from "@tiptap/starter-kit";
import { TaskItem, TaskList } from "@tiptap/extension-list";

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
 * The comment (panel slice 10): StarterKit WITHOUT headings — a comment
 * is a remark under a task, not a document with an outline, and a
 * heading inside a 40-word reply is what a pasted email signature
 * looks like — and without the checklist (a comment has no counters; a
 * checklist belongs in the description, where `⌘⇧O` will turn it into
 * subtasks). Deliberately absent, as above: mention (`Mention.commentId`
 * is NOT NULL and the extraction is its own slice; a member's name in a
 * client-visible body is the product's worst bug), image and
 * file-handler.
 *
 * Its own list, never the description's with an option: the server
 * normaliser refuses every node this list does not declare
 * (`normalizeComment`), so a heading pasted into a comment is refused
 * rather than stored.
 */
export const commentExtensions = () => [
  StarterKit.configure({
    heading: false,
    link: { openOnClick: false, autolink: false },
  }),
];

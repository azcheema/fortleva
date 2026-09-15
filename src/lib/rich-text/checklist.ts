import type { Node as PMNode } from "@tiptap/pm/model";

/**
 * `⌘⇧O` — "convert the focused checklist item into a subtask" (UI.md §6,
 * panel slice 13) — decided as a PURE function of the document and the
 * caret, so the whole rule is a table test rather than a decision buried
 * in an editor closure (the same reason `src/lib/keymap.ts` exists).
 *
 * It answers only WHICH node and WHAT TITLE. Everything else belongs to
 * the caller: the create is a server action, and the removal is an
 * ordinary edit in the editor that owns the document.
 *
 * THE ONE RULE THIS FILE ENFORCES, and why it is narrow on purpose: a
 * checklist item becomes a task TITLE, and a title is one line. An item
 * that holds more than that — a nested checklist under it, a second
 * paragraph, a line break — is REFUSED rather than flattened, because
 * every way of converting it loses something the member wrote: the title
 * would silently join two lines, or the nested items would be deleted
 * with their parent. Refusing says so and stays actionable — convert
 * what is nested first, and the parent becomes convertible.
 */

export type ChecklistTarget =
  /**
   * The selection is not inside ONE checklist item — no checklist item at
   * all, or a selection that runs out of the one it starts in. A
   * selection across two lines names no single line to convert, and the
   * line is the unit here: a partial selection inside one item still
   * converts the whole item, because a task title is the line.
   */
  | { readonly kind: "none" }
  /** A checklist item, but not a single line of text (see above). */
  | { readonly kind: "complex" }
  /**
   * A TICKED item. Refused for the same reason `complex` is: a new task
   * starts in the project's default state, so converting a finished line
   * would delete the one record that it was finished and replace it with
   * work still to do. Unticking first is the member's call, not ours.
   */
  | { readonly kind: "checked" }
  /** A checklist item with no words in it yet. */
  | { readonly kind: "empty" }
  /** Longer than a title may be — the server would refuse it. */
  | { readonly kind: "tooLong" }
  | {
      readonly kind: "ok";
      /** The position the `taskItem` starts at, and the node itself. */
      readonly from: number;
      readonly node: PMNode;
      /** Trimmed text of its one paragraph — the new item's title. */
      readonly title: string;
    };

/**
 * The innermost `taskItem` the selection `from…to` lies in, and what can
 * be done with it. INNERMOST, so that a caret inside a nested item
 * converts the item it is in rather than the one that contains it.
 *
 * THE ORDER OF THE REFUSALS IS THE DESIGN, not an accident of writing:
 * `checked` comes LAST because unticking is the only remedy that is a
 * different action, and telling someone to untick a line that is also
 * empty or too long would send them back for a second refusal.
 *
 * Total: an out-of-range position is `none`, never a throw — the
 * positions come from a live selection, but this is the kind of guard
 * whose absence only ever shows up as a broken keystroke.
 */
export function checklistTargetAt(doc: PMNode, from: number, to: number, maxTitle: number): ChecklistTarget {
  const inRange = (n: number) => Number.isInteger(n) && n >= 0 && n <= doc.content.size;
  if (!inRange(from) || !inRange(to) || to < from) return { kind: "none" };
  const $pos = doc.resolve(from);
  for (let depth = $pos.depth; depth > 0; depth--) {
    const node = $pos.node(depth);
    if (node.type.name !== "taskItem") continue;
    const start = $pos.before(depth);
    // A selection that runs past this item names no single line.
    if (to > start + node.nodeSize) return { kind: "none" };
    const only = node.childCount === 1 ? node.firstChild : null;
    if (!only || only.type.name !== "paragraph") return { kind: "complex" };
    // A `hardBreak` is a leaf with no text, so `textContent` would join
    // the two lines around it without a trace. It is the one inline node
    // this schema has besides text; anything else that ever joins it
    // lands here too, which is the point of asking `isText` rather than
    // naming the node.
    let inline = true;
    only.content.forEach((child) => {
      if (!child.isText) inline = false;
    });
    if (!inline) return { kind: "complex" };
    const title = only.textContent.trim();
    if (title.length === 0) return { kind: "empty" };
    if (title.length > maxTitle) return { kind: "tooLong" };
    // A strict `=== true` with no coercion, and the guarantee is the
    // EDITOR's, not the normaliser's: this reads the browser's live
    // document, which `normalize.ts` has never seen for a line the member
    // just typed or ticked. TaskItem's own `parseHTML`, its input rules
    // and its toggle command all write a real boolean, and a paste
    // re-parses through that same `parseHTML`. (`normalize.ts` coerces it
    // too — a string "false" once counted as done — but only for the half
    // of the document that came back from the server.)
    if (node.attrs["checked"] === true) return { kind: "checked" };
    return { kind: "ok", from: start, node, title };
  }
  return { kind: "none" };
}

/**
 * Where `node` sits in `doc` RIGHT NOW, by identity — or -1.
 *
 * This is how the removal survives the round trip that creates the
 * subtask. ProseMirror nodes are immutable and shared: a document the
 * member has not touched still holds the very object the keystroke
 * looked at, while any edit to that item replaces it. So a lookup by
 * identity answers both questions at once — where the line moved to, and
 * whether it is still the line that was converted. A position remembered
 * across the await would answer neither.
 *
 * Identity is not a unique KEY, and the first match is taken — so the
 * `at >= 0` guard is load-bearing, not tidiness. A PASTE does not produce
 * a duplicate (prosemirror-view re-parses the clipboard HTML on every
 * path, so the pasted nodes are new objects, and a pasted copy simply
 * reads as gone); an internal copy-DRAG does, because the drag keeps the
 * original slice and drops it without re-parsing, and so does an undo
 * that re-inserts the nodes its inverted step held. Accepted deliberately:
 * the two are the same node, so which of them goes is not a difference
 * anybody can see in the document.
 */
export function nodePosition(doc: PMNode, node: PMNode): number {
  let at = -1;
  doc.descendants((child, pos) => {
    if (at >= 0) return false;
    if (child === node) {
      at = pos;
      return false;
    }
    return true;
  });
  return at;
}

import { Extension } from "@tiptap/core";
import { Fragment, Slice, type Node as PMNode, type ResolvedPos, type Schema } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Selection } from "@tiptap/pm/state";
import { __pastedCells as pastedCells, CellSelection, TableMap } from "@tiptap/pm/tables";

import { fixPastedTables, hasTable, markdownToBlocks, untable, type PmJson } from "@/lib/rich-text/markdown";
import { TABLE_MAX_COLUMNS, TABLE_MAX_ROWS } from "@/lib/rich-text/table-bounds";
import { wordListOf, wordListTree, type WordList } from "@/lib/rich-text/word-lists";

/** A block's plain text as paragraphs, one per line — what a block that does not fit the schema becomes. */
function asText(schema: Schema, block: PmJson): PMNode[] {
  const lines: string[] = [];
  const walk = (n: PmJson) => {
    const kids = n.content ?? [];
    if (typeof n.text === "string" || kids.some((k) => typeof k.text === "string" || k.type === "hardBreak")) {
      // Text, or a block of it: a hard break or a newline starts a line.
      const runs = typeof n.text === "string" ? [n] : kids;
      for (const line of runs.map((k) => (k.type === "hardBreak" ? "\n" : (k.text ?? ""))).join("").split("\n")) lines.push(line);
      return;
    }
    kids.forEach(walk);
  };
  walk(block);
  const paragraph = schema.nodes["paragraph"]!;
  return lines.filter((line) => line.trim() !== "").map((line) => paragraph.create(null, schema.text(line)));
}

/**
 * Blocks as a fragment of `schema` — EACH block on its own: one that does
 * not fit (a mark combination the schema refuses, say) becomes its text,
 * and the rest of the paste keeps its formatting (the code review's
 * MEDIUM-2: one misfit used to send the whole answer back to raw text).
 */
function fragmentOf(schema: Schema, blocks: readonly PmJson[]): Fragment {
  const nodes: PMNode[] = [];
  for (const block of blocks) {
    try {
      const node = schema.nodeFromJSON(block);
      node.check();
      nodes.push(node);
    } catch {
      for (const node of asText(schema, block)) nodes.push(node);
    }
  }
  return Fragment.from(nodes);
}

/** The depth of the table cell `$pos` is in, or -1. */
export const cellDepth = ($pos: ResolvedPos): number => {
  for (let d = $pos.depth; d > 0; d--) {
    const role = $pos.node(d).type.spec["tableRole"];
    if (role === "cell" || role === "header_cell") return d;
  }
  return -1;
};

/** Whether a pasted table of `cols` × `rows`, spread from the cell at `$pos`, keeps the table inside the bounds. */
function roomFrom($pos: ResolvedPos, cols: number, rows: number): boolean {
  const d = cellDepth($pos);
  if (d < 2) return false;
  const table = $pos.node(d - 2);
  const map = TableMap.get(table);
  const rect = map.findCell($pos.before(d) - $pos.start(d - 2));
  return Math.max(map.width, rect.left + cols) <= TABLE_MAX_COLUMNS && Math.max(map.height, rect.top + rows) <= TABLE_MAX_ROWS;
}

/**
 * PASTED FORMATTING — THE BROWSER HALF (slice 132; founder decision C109 —
 * design docs/research/2026-10-18-slice-132-paste-and-tables-design.md §3).
 * The description's and the progress update's editors only; the comment
 * keeps pasting as it always has.
 *
 *  - `transformPastedHTML`: Word's list paragraphs (`mso-list` — only Word
 *    writes it) become real nested lists before ProseMirror parses them.
 *  - `clipboardTextParser`: PLAIN TEXT that reads as markdown (what
 *    ChatGPT's and Claude's "Copy" buttons put on the clipboard) becomes
 *    headings, lists, tables, bold… — Ctrl+Shift+V ("paste as plain text",
 *    `plain`) and a paste into a code block still paste it as typed.
 *  - `transformPasted`: every pasted table made keepable (`fixPastedTables`).
 *  - `handlePaste` / `handleDrop`: a table never lands INSIDE a table — a
 *    paste into a cell has its tables flattened, unless it is exactly one
 *    table that fits where prosemirror-tables will spread it across the
 *    cells; a table dropped onto a cell is refused.
 *
 * It adds no node and no mark: the schema the server validates against is
 * unchanged (`extensions.ts`), and the normaliser still decides what is
 * stored. `priority` puts these props ahead of prosemirror-tables' own.
 */
export const PasteFormatting = Extension.create({
  name: "pasteFormatting",
  priority: 1000,
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("pasteFormatting"),
        props: {
          transformPastedHTML: (html) => wordListsInHtml(html),
          // ProseMirror falls back to its own line-per-paragraph parse when
          // this returns nothing; its type says Slice, hence the cast.
          clipboardTextParser: (text, _$context, plain, view) =>
            markdownSlice(text, plain, view.state.schema) ?? (null as unknown as Slice),
          transformPasted: (slice, view) => fixPastedSlice(slice, view.state.schema),
          handlePaste: (view, _event, slice) => {
            const into = pasteIntoCell(slice, view.state.schema, view.state.selection);
            if (!into) return false;
            view.dispatch(view.state.tr.replaceSelection(into).scrollIntoView().setMeta("paste", true).setMeta("uiEvent", "paste"));
            return true;
          },
          handleDrop: (view, event, slice) => {
            // A table, or rows or cells dragged out of one (a cell selection):
            // dropped onto a cell, either would nest or grow the table unchecked.
            let parts = false;
            slice.content.descendants((node) => {
              if (node.type.spec["tableRole"]) parts = true;
              return !parts;
            });
            if (!parts) return false;
            const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
            // Swallowed: nothing moves, nothing nests.
            return at !== null && cellDepth(view.state.doc.resolve(at.pos)) > 0;
          },
        },
      }),
    ];
  },
});

/** A plain-text paste as a slice of formatted blocks — or null: not markdown, pasted as plain text, or unreadable. */
export function markdownSlice(text: string, plain: boolean, schema: Schema): Slice | null {
  if (plain) return null;
  try {
    const blocks = markdownToBlocks(text);
    if (!blocks || blocks.length === 0) return null;
    return new Slice(fragmentOf(schema, blocks), 0, 0);
  } catch {
    return null; // never lose a paste to a reader's failure: ProseMirror's own paste runs
  }
}

/**
 * Every pasted slice with its tables made keepable; the SAME slice when
 * nothing changes. A rebuilt slice opens only up to the first ISOLATING
 * node (a table, a cell) — as ProseMirror's own clipboard parse closes it.
 * Opening into a table's last cell put the text after the caret INSIDE
 * that cell (the code review's MEDIUM-1).
 */
export function fixPastedSlice(slice: Slice, schema: Schema): Slice {
  const before = slice.content.toJSON() as PmJson[] | null;
  if (!before) return slice;
  const next = fixPastedTables(before);
  if (next === before) return slice;
  return Slice.maxOpen(fragmentOf(schema, next), false);
}

/**
 * A paste touching a table cell that must not go in as it is — the slice to
 * insert instead (its tables flattened into their cells' blocks), or null to
 * let the paste proceed: no table in it, neither end of the selection in a
 * cell, or exactly one table that prosemirror-tables will take — a cell
 * selection (it clips the paste to the selection) or a caret whose HEAD is in
 * a cell (it spreads from that cell; the table must fit from there). A
 * selection that straddles the table's edge counts as in it: the Fitter put
 * a table pasted over one INSIDE the start cell (the re-check's LOW-C).
 */
export function pasteIntoCell(slice: Slice, schema: Schema, selection: Selection): Slice | null {
  const { $from, $head } = selection;
  if (cellDepth($from) < 0 && cellDepth($head) < 0) return null;
  const json = (slice.content.toJSON() as PmJson[] | null) ?? [];
  // What prosemirror-tables will take as CELLS — one table, or a block of
  // rows or cells copied out of one (the most common in-app paste, which a
  // "one table" test missed: the second re-check's LOW-2) — by its own
  // reading, sized by the room from the cell it spreads from.
  let area: ReturnType<typeof pastedCells> = null;
  try {
    area = slice.size > 0 ? pastedCells(slice) : null;
  } catch {
    area = null; // an odd slice it cannot read: not cells
  }
  if (area) {
    if (selection instanceof CellSelection) return null; // clipped to the selection: it cannot grow the table
    if (cellDepth($head) >= 0 && roomFrom($head, area.width, area.height)) return null;
    return Slice.maxOpen(fragmentOf(schema, untable(json)), false);
  }
  if (!hasTable(json)) return null;
  return Slice.maxOpen(fragmentOf(schema, untable(json)), false);
}

// ── Word's lists, in its HTML ───────────────────────────────────────

/** The marker Word drew before a list paragraph's text — taken OUT of the paragraph. */
function takeMarker(p: Element): string {
  const ignored = p.querySelector('span[style*="mso-list:ignore" i], span[style*="mso-list: ignore" i]');
  if (ignored) {
    const marker = (ignored.textContent ?? "").trim();
    ignored.remove();
    return marker;
  }
  // No marker span (an older or another writer): the paragraph's first word
  // — taken only when it READS as a marker ("1.", "a)", "·"), never a word
  // ("Payment terms" stays whole: the re-check's NIT-2).
  const doc = p.ownerDocument;
  const walker = doc.createTreeWalker(p, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode() as Text | null;
  while (node && node.data.trim() === "") node = walker.nextNode() as Text | null;
  if (!node) return "";
  const m = /^\s*(\S{1,8})\s+/.exec(node.data);
  if (!m) return "";
  const token = m[1]!;
  // A number, ONE letter or a roman numeral before "." or ")" — never "Dr."
  // or "Inc." — "o" (Word's own second-level bullet), or one or two symbols.
  const numbered = /^(\d{1,4}|[A-Za-z]|[ivxlcIVXLC]{1,6})[.)]$/.test(token);
  if (!numbered && token !== "o" && !/^[^\p{L}\p{N}]{1,2}$/u.test(token)) return "";
  node.data = node.data.slice(m[0].length);
  return token;
}

function buildList(doc: Document, list: WordList, paragraphs: readonly Element[]): HTMLElement {
  const el = doc.createElement(list.kind.ordered ? "ol" : "ul");
  if (list.kind.ordered) {
    if (list.kind.type !== "1") el.setAttribute("type", list.kind.type);
    if (list.kind.start !== 1) el.setAttribute("start", String(list.kind.start));
  }
  for (const item of list.items) {
    const li = doc.createElement("li");
    const p = doc.createElement("p");
    p.append(...Array.from(paragraphs[item.index]!.childNodes));
    li.append(p);
    for (const child of item.children) li.append(buildList(doc, child, paragraphs));
    el.append(li);
  }
  return el;
}

/**
 * Word's HTML with its list paragraphs made `<ul>`/`<ol>` — by Word's own
 * level and list (`word-lists.ts`), the marker it drew removed. Any other
 * HTML is returned as it came. Parsed with `DOMParser`, which runs no
 * script and loads nothing; ProseMirror parses the result as it would have.
 */
export function wordListsInHtml(html: string): string {
  if (!/mso-list/i.test(html) || typeof DOMParser === "undefined") return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const paragraphs = Array.from(doc.body.querySelectorAll("p")).filter((p) => wordListOf(p.getAttribute("style") ?? "") !== null);
  if (paragraphs.length === 0) return html;
  // Runs of list paragraphs that follow one another.
  const runs: Element[][] = [];
  for (const p of paragraphs) {
    const run = runs[runs.length - 1];
    if (run && run[run.length - 1]!.nextElementSibling === p) run.push(p);
    else runs.push([p]);
  }
  for (const run of runs) {
    const items = run.map((p) => {
      const of = wordListOf(p.getAttribute("style") ?? "")!;
      return { level: of.level, list: of.list, marker: takeMarker(p) };
    });
    for (const list of wordListTree(items)) run[0]!.before(buildList(doc, list, run));
    for (const p of run) p.remove();
  }
  return doc.body.innerHTML;
}

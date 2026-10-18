import { boundedSpan, layoutTable, TABLE_MAX_COLUMNS, TABLE_MAX_ROWS } from "./table-bounds";

/**
 * PASTED FORMATTING — THE PURE HALF (slice 132; founder decision C109 —
 * design docs/research/2026-10-18-slice-132-paste-and-tables-design.md §3.1).
 * No DOM, no editor: the browser's paste handler (`paste-formatting.ts`) and
 * the unit tests call these, and what they return is still only a PROPOSAL —
 * the editor parses it against its schema, and the server's normaliser
 * decides what is stored (links included: `[t](javascript:…)` is a text here
 * and would be dropped there anyway).
 *
 *  - `markdownToBlocks` — the markdown that ChatGPT's and Claude's "Copy"
 *    buttons put on the clipboard as PLAIN TEXT, as document blocks:
 *    headings (`#`–`###`, deeper ones as level 3), paragraphs, bullet and
 *    numbered lists (nested by indent), checklists (`- [ ]` / `- [x]`),
 *    quotes, fenced code blocks, rules and pipe tables; inline bold,
 *    italic, strike, code and links. Text with none of these is not
 *    markdown: `null`, and the editor pastes it as it always has.
 *  - `fixPastedTables` — any pasted table made one the document can keep.
 *
 * Word's lists are `word-lists.ts`'s: they are read from Word's HTML.
 */

/** A ProseMirror JSON node, as the editor's `fromJSON` takes it. */
export type PmJson = {
  readonly type: string;
  readonly attrs?: Record<string, unknown>;
  readonly content?: readonly PmJson[];
  readonly marks?: readonly { readonly type: string; readonly attrs?: Record<string, unknown> }[];
  readonly text?: string;
};

type Mark = { readonly type: string; readonly attrs?: Record<string, unknown> };

/** At most this many characters are read as markdown — past it, a paste is the editor's own. */
export const MARKDOWN_MAX_CHARS = 200_000;
/** Quotes inside quotes past this depth are read as text: `>` × 100 000 recursed once per `>`. */
const QUOTE_MAX_DEPTH = 8;

/*
 * EVERY PATTERN HERE IS LINEAR, on purpose: a paste is text of up to
 * MARKDOWN_MAX_CHARS that nobody vetted, and a regex with two `\s*` around an
 * optional run, or an unanchored `+` scanning for a closer, backtracks
 * quadratically on a long run of spaces or brackets (AGENTS.md's slice-121
 * trap). So the line shapes are anchored at the start and never end in `$`
 * (JavaScript's `.` refuses U+2028/U+2029 and a lone CR, so `(.*)$` after a
 * run of spaces backtracked through the run — the reviews' LOW), every line
 * terminator is turned into `\n` before anything is matched (`toLines`),
 * fences, rules and table rows are checked by hand, and every scan for a
 * closer is bounded.
 */
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)/;
const QUOTE = /^\s{0,3}>\s?(.*)/;
const TASK = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)/;
const BULLET = /^(\s*)[-*+•]\s+(.*)/;
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)/;
const INLINE_HINT = /\*\*[^*\n]{1,500}\*\*|__[^_\n]{1,500}__|`[^`\n]{1,500}`|~~[^~\n]{1,500}~~|\[[^\]\n]{1,500}\]\([^)\s]{1,2000}\)/;

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

/** The text's lines, split on EVERY line terminator — so no line holds one. */
function toLines(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split(LINE_SEPARATOR).join("\n").split(PARAGRAPH_SEPARATOR).join("\n").split("\n");
}

/** `# Title ##` — the level and the text, a closing run of `#` dropped. */
function heading(line: string): { level: number; text: string } | null {
  const m = HEADING.exec(line);
  if (!m) return null;
  let text = m[2]!.trimEnd();
  let end = text.length;
  while (end > 0 && text[end - 1] === "#") end--;
  if (end < text.length && (end === 0 || text[end - 1] === " " || text[end - 1] === "\t")) text = text.slice(0, end).trimEnd();
  return { level: m[1]!.length, text };
}

/** ```` ```ts ```` or `~~~` — the fence's character, its length, its indent and its language, or null. */
function fence(line: string): { ch: string; length: number; indent: number; language: string } | null {
  const t = line.trim();
  const ch = t[0];
  if (ch !== "`" && ch !== "~") return null;
  let n = 0;
  while (t[n] === ch) n++;
  if (n < 3) return null;
  const language = t.slice(n).trim();
  if (!/^[A-Za-z0-9+#-]*$/.test(language)) return null;
  return { ch, length: n, indent: line.length - line.trimStart().length, language };
}

/** A closing fence: the opening's character, at least as many, and nothing else. */
function closes(line: string, open: { ch: string; length: number }): boolean {
  const t = line.trim();
  if (t.length < open.length) return false;
  for (const c of t) if (c !== open.ch) return false;
  return true;
}

/** `---`, `***`, `___`, spaces between allowed, indented under four. */
function isRule(line: string): boolean {
  if (/^[ \t]{4}/.test(line)) return false;
  return /^(?:-{3,}|\*{3,}|_{3,})$/.test(line.replace(/[ \t]/g, ""));
}

const isTableRow = (line: string): boolean => {
  const t = line.trim();
  return t.length >= 2 && t.startsWith("|") && t.endsWith("|");
};

/** `|---|:---:|` — a pipe table's separator row. */
const isTableSeparator = (line: string): boolean =>
  line.includes("|") && line.includes("-") && cells(line).every((c) => /^:?-{3,}:?$/.test(c));

/** Whether a plain text is worth reading as markdown at all (a block marker, or an inline one). */
export function looksLikeMarkdown(text: string): boolean {
  if (text.length > MARKDOWN_MAX_CHARS) return false;
  const lines = toLines(text);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (heading(line) || fence(line) || TASK.test(line) || BULLET.test(line) || ORDERED.test(line) || QUOTE.test(line)) {
      return true;
    }
    if (isRule(line) && i > 0) return true;
    if (isTableRow(line) && isTableSeparator(lines[i + 1] ?? "")) return true;
  }
  return INLINE_HINT.test(text);
}

// ── inline ──────────────────────────────────────────────────────────

const LINK_SCHEMES = /^(https?:|mailto:)/i;
/** `[text](url)` — a url may hold one level of balanced parentheses (Wikipedia's `Foo_(bar)`). */
const LINK = /^\[([^\]\n]{1,500})\]\(((?:[^()\s]|\([^()\s]{0,200}\)){1,2000})\)/;
/** A bare http(s) URL, the same parentheses allowed; trailing punctuation is trimmed after. */
const BARE_URL = /^https?:\/\/(?:[^\s<>()]|\([^\s<>()]{0,200}\)){1,2000}/;
const TRAILING = ".,;:!?'\"";

const text = (value: string, marks: readonly Mark[]): PmJson =>
  marks.length > 0 ? { type: "text", text: value, marks: [...marks] } : { type: "text", text: value };

/** Merges neighbouring text nodes with the same marks, and drops empty ones. */
function tidy(nodes: PmJson[]): PmJson[] {
  const out: PmJson[] = [];
  for (const n of nodes) {
    if (n.type === "text" && !n.text) continue;
    const last = out[out.length - 1];
    if (last && last.type === "text" && n.type === "text" && JSON.stringify(last.marks ?? []) === JSON.stringify(n.marks ?? [])) {
      out[out.length - 1] = { ...last, text: (last.text ?? "") + (n.text ?? "") };
    } else {
      out.push(n);
    }
  }
  return out;
}

/**
 * Inline markdown: `**bold**`/`__bold__`, `*italic*`/`_italic_`, `~~strike~~`,
 * `` `code` ``, `[text](url)` and a bare http(s) URL; a backslash escapes the
 * next punctuation. Delimiters that never close are text.
 */
export function inline(source: string, marks: readonly Mark[] = []): PmJson[] {
  const out: PmJson[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer) out.push(text(buffer, marks));
    buffer = "";
  };
  const inLink = marks.some((m) => m.type === "link");
  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);
    const c = source[i]!;
    if (c === "\\" && i + 1 < source.length && /[\\`*_~[\]()#+\-.!|>]/.test(source[i + 1]!)) {
      buffer += source[i + 1];
      i += 2;
      continue;
    }
    if (c === "`") {
      const end = source.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        // Tiptap's code mark EXCLUDES every other mark, a link's included
        // (`excludes: "_"`): one code-in-a-link made the whole paste fail the
        // schema and fall back to raw text (the code review's MEDIUM-2). In
        // a link the link wins; elsewhere code stands alone.
        out.push(text(source.slice(i + 1, end), inLink ? marks.filter((m) => m.type === "link") : [{ type: "code" }]));
        i = end + 1;
        continue;
      }
    }
    const pair = (delimiter: string, types: readonly string[]): boolean => {
      if (!rest.startsWith(delimiter)) return false;
      let end = source.indexOf(delimiter, i + delimiter.length);
      if (end <= i + delimiter.length) return false;
      // `**bold *italic***` closes the bold on the LAST two of the three.
      if (delimiter.length === 2 && source[end + 2] === delimiter[0]) end += 1;
      const inner = source.slice(i + delimiter.length, end);
      // `_snake_case_` and `2 * 3 * 4` are not emphasis.
      if (/^\s|\s$/.test(inner)) return false;
      if (delimiter.startsWith("_") && (/\w/.test(source[i - 1] ?? "") || /\w/.test(source[end + delimiter.length] ?? ""))) return false;
      flush();
      pushAll(out, inline(inner, [...marks, ...types.map((type) => ({ type }))]));
      i = end + delimiter.length;
      return true;
    };
    if (pair("***", ["bold", "italic"]) || pair("**", ["bold"]) || pair("__", ["bold"]) || pair("~~", ["strike"])) continue;
    if ((c === "*" || c === "_") && !rest.startsWith(c + c) && pair(c, ["italic"])) continue;
    if (c === "[") {
      const m = LINK.exec(rest);
      if (m) {
        flush();
        const href = m[2]!;
        pushAll(out, LINK_SCHEMES.test(href) && !inLink ? inline(m[1]!, [...marks, { type: "link", attrs: { href } }]) : inline(m[1]!, marks));
        i += m[0].length;
        continue;
      }
    }
    if ((c === "h" || c === "H") && !inLink && !/\w/.test(source[i - 1] ?? "")) {
      const m = BARE_URL.exec(rest);
      let url = m ? m[0] : "";
      while (url.length > 0 && TRAILING.includes(url[url.length - 1]!)) url = url.slice(0, -1);
      if (/^https?:\/\/./i.test(url)) {
        flush();
        out.push(text(url, [...marks, { type: "link", attrs: { href: url } }]));
        i += url.length;
        continue;
      }
    }
    buffer += c;
    i += 1;
  }
  flush();
  return tidy(out);
}

const paragraph = (source: string): PmJson => {
  const content = inline(source.trim());
  return content.length > 0 ? { type: "paragraph", content } : { type: "paragraph" };
};

// ── blocks ──────────────────────────────────────────────────────────

/** A pipe table row's cells, `|` escapes kept as text. */
function cells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const out: string[] = [];
  let cell = "";
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i]!;
    if (c === "\\" && trimmed[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (c === "|") {
      out.push(cell.trim());
      cell = "";
    } else {
      cell += c;
    }
  }
  out.push(cell.trim());
  return out;
}

/**
 * The table at its WIDEST row — a row with more cells than the header keeps
 * them (nothing pasted is dropped). Past the bounds it is never BUILT: rows ×
 * width padded cells first and flattened after was 25 million nodes from a
 * 25 KB paste (the re-check's LOW-B) — it is one line of text per row, what
 * `fixPastedTables` makes of such a table anyway.
 */
function table(header: string[], rows: string[][]): PmJson[] {
  const width = rows.reduce((w, r) => Math.max(w, r.length), header.length);
  if (width > TABLE_MAX_COLUMNS || rows.length + 1 > TABLE_MAX_ROWS) {
    // Each cell's TEXT, its markdown read (no `**` or `[x](url)` left behind).
    const cellText = (c: string) => inline(c).map((n) => n.text ?? "").join("");
    return [header, ...rows].map((r) => {
      const text = r.map(cellText).join(" | ").trim();
      return text ? { type: "paragraph", content: [{ type: "text", text }] } : { type: "paragraph" };
    });
  }
  const cell = (type: "tableHeader" | "tableCell", value: string): PmJson => ({ type, content: [paragraph(value)] });
  return [{
    type: "table",
    content: [
      { type: "tableRow", content: Array.from({ length: width }, (_, k) => cell("tableHeader", header[k] ?? "")) },
      ...rows.map((r) => ({
        type: "tableRow",
        content: Array.from({ length: width }, (_, k) => cell("tableCell", r[k] ?? "")),
      })),
    ],
  }];
}

type ListLine = { indent: number; kind: "bullet" | "ordered" | "task"; start: number; checked: boolean; text: string };

const indentOf = (s: string): number => s.replace(/\t/g, "    ").length;

/** Consecutive list lines as nested lists: a deeper indent opens a list inside the last item. */
function lists(items: ListLine[]): PmJson[] {
  const out: PmJson[] = [];
  let i = 0;
  const build = (base: number): PmJson | null => {
    const first = items[i];
    if (!first) return null;
    const kind = first.kind;
    const listItems: PmJson[] = [];
    while (i < items.length) {
      const it = items[i]!;
      if (it.indent < base) break;
      if (it.indent > base) {
        // A deeper line belongs to the item before it.
        const nested = build(it.indent);
        const last = listItems[listItems.length - 1];
        if (nested && last) listItems[listItems.length - 1] = { ...last, content: [...(last.content ?? []), nested] };
        else if (nested)
          listItems.push(
            kind === "task"
              ? { type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph" }, nested] }
              : { type: "listItem", content: [{ type: "paragraph" }, nested] },
          );
        continue;
      }
      if (it.kind !== kind) break; // a different kind at this level starts its own list
      listItems.push(
        kind === "task"
          ? { type: "taskItem", attrs: { checked: it.checked }, content: [paragraph(it.text)] }
          : { type: "listItem", content: [paragraph(it.text)] },
      );
      i++;
    }
    if (listItems.length === 0) return null;
    if (kind === "task") return { type: "taskList", content: listItems };
    if (kind === "ordered") return { type: "orderedList", attrs: { start: first.start }, content: listItems };
    return { type: "bulletList", content: listItems };
  };
  while (i < items.length) {
    const before = i;
    const list = build(items[i]!.indent);
    if (list) out.push(list);
    if (i === before) i++; // never stall
  }
  return out;
}

/** The blocks of a markdown text — or null when it is not markdown (`looksLikeMarkdown`). */
export function markdownToBlocks(source: string): PmJson[] | null {
  if (!looksLikeMarkdown(source)) return null;
  return blocks(toLines(source), 0);
}

function blocks(lines: readonly string[], depth: number): PmJson[] {
  const out: PmJson[] = [];
  let i = 0;
  let para: string[] = [];
  const endParagraph = () => {
    if (para.length === 0) return;
    // A soft line break inside a paragraph is kept as a line break.
    const content: PmJson[] = [];
    para.forEach((line, k) => {
      if (k > 0) content.push({ type: "hardBreak" });
      pushAll(content, inline(line.trim()));
    });
    out.push(content.length > 0 ? { type: "paragraph", content: tidy(content) } : { type: "paragraph" });
    para = [];
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      endParagraph();
      i++;
      continue;
    }
    const open = fence(line);
    if (open) {
      endParagraph();
      const body: string[] = [];
      i++;
      while (i < lines.length && !closes(lines[i]!, open)) {
        // A fence indented under a list item: its lines lose that indent.
        const l = lines[i]!;
        let cut = 0;
        while (cut < open.indent && (l[cut] === " " || l[cut] === "\t")) cut++;
        body.push(l.slice(cut));
        i++;
      }
      i++; // the closing fence (or the end)
      const language = open.language.toLowerCase().slice(0, 20);
      out.push({
        type: "codeBlock",
        ...(language ? { attrs: { language } } : {}),
        ...(body.length > 0 ? { content: [{ type: "text", text: body.join("\n") }] } : {}),
      });
      continue;
    }
    const title = heading(line);
    if (title) {
      endParagraph();
      const content = inline(title.text);
      out.push({ type: "heading", attrs: { level: Math.min(3, title.level) }, ...(content.length ? { content } : {}) });
      i++;
      continue;
    }
    if (isRule(line) && para.length === 0) {
      out.push({ type: "horizontalRule" });
      i++;
      continue;
    }
    if (isTableRow(line) && isTableSeparator(lines[i + 1] ?? "")) {
      endParagraph();
      const header = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i]!)) {
        rows.push(cells(lines[i]!));
        i++;
      }
      pushAll(out, table(header, rows));
      continue;
    }
    if (depth < QUOTE_MAX_DEPTH && QUOTE.test(line)) {
      endParagraph();
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) {
        body.push(QUOTE.exec(lines[i]!)![1]!);
        i++;
      }
      const inner = blocks(body, depth + 1);
      out.push({ type: "blockquote", content: inner.length > 0 ? inner : [{ type: "paragraph" }] });
      continue;
    }
    if (TASK.test(line) || BULLET.test(line) || ORDERED.test(line)) {
      endParagraph();
      const items: ListLine[] = [];
      while (i < lines.length) {
        const l = lines[i]!;
        const task = TASK.exec(l);
        const bullet = task ? null : BULLET.exec(l);
        const ordered = task || bullet ? null : ORDERED.exec(l);
        if (task) items.push({ indent: indentOf(task[1]!), kind: "task", start: 1, checked: task[2] !== " ", text: task[3]! });
        else if (bullet) items.push({ indent: indentOf(bullet[1]!), kind: "bullet", start: 1, checked: false, text: bullet[2]! });
        else if (ordered)
          items.push({ indent: indentOf(ordered[1]!), kind: "ordered", start: Math.min(10_000, Math.max(1, Number(ordered[2]))), checked: false, text: ordered[3]! });
        // A fence, heading or quote under an item is a block of its own,
        // never words folded into the item (the code review's MEDIUM-4).
        else if (fence(l) || heading(l) || QUOTE.test(l)) break;
        else if (l.trim() !== "" && /^\s{2,}\S/.test(l) && items.length > 0) {
          // A continuation line of the last item.
          const last = items[items.length - 1]!;
          last.text = `${last.text} ${l.trim()}`;
        } else break;
        i++;
      }
      pushAll(out, lists(items));
      continue;
    }
    para.push(line);
    i++;
  }
  endParagraph();
  return out;
}

// ── pasted tables ───────────────────────────────────────────────────

const plain = (node: PmJson): string =>
  typeof node.text === "string" ? node.text : (node.content ?? []).map(plain).join(node.type === "tableRow" ? " | " : " ");

/** `out.push(...items)` without the spread: a spread of tens of thousands of nodes passes an engine's argument cap. */
function pushAll<T>(out: T[], items: readonly T[]): void {
  for (const item of items) out.push(item);
}

const line = (row: PmJson): PmJson => {
  const text = plain(row).replace(/\s+/g, " ").trim();
  return text ? { type: "paragraph", content: [{ type: "text", text }] } : { type: "paragraph" };
};

/** Whether any node in `nodes`, at any depth, is a table. */
export const hasTable = (nodes: readonly PmJson[]): boolean => nodes.some((n) => n.type === "table" || hasTable(n.content ?? []));

const TABLE_PARTS = new Set(["table", "tableRow", "tableCell", "tableHeader"]);

/**
 * Every table met — and every row or cell standing alone — becomes the
 * blocks of its cells, in order: inside a table, or for a paste into a cell
 * that must not take it as cells.
 */
export function untable(nodes: readonly PmJson[]): PmJson[] {
  const out: PmJson[] = [];
  for (const n of nodes) {
    if (TABLE_PARTS.has(n.type)) pushAll(out, untable(n.content ?? []));
    else out.push(n.content ? { ...n, content: untable(n.content) } : n);
  }
  return out;
}

/**
 * A pasted cell's attributes as the normaliser keeps them — bounded spans,
 * the rowspan cut to the rows left, no width and no alignment. A page's
 * `colspan="1e9"` arrives as a STRING from Tiptap's attribute parse and
 * would have sized prosemirror-tables' map in the member's own tab (the
 * security review's LOW-3). The same object when there is nothing to clean.
 */
function cleanCell(cell: PmJson, rowsLeft: number): PmJson {
  const a = cell.attrs ?? {};
  const colspan = boundedSpan(a["colspan"] ?? 1, TABLE_MAX_COLUMNS);
  const rowspan = Math.min(boundedSpan(a["rowspan"] ?? 1, TABLE_MAX_ROWS), rowsLeft);
  const clean =
    (a["colspan"] ?? 1) === colspan &&
    (a["rowspan"] ?? 1) === rowspan &&
    (a["colwidth"] ?? null) === null &&
    (a["align"] ?? null) === null;
  const cleaned = clean ? cell : { ...cell, attrs: { colspan, rowspan } };
  if (!hasTable(cleaned.content ?? [])) return cleaned;
  // A nested table of empty rows flattens to nothing; a cell needs a block.
  const blocks = untable(cleaned.content ?? []);
  return { ...cleaned, content: blocks.length > 0 ? blocks : [{ type: "paragraph" }] };
}

const spanOf = (c: PmJson) => ({
  colspan: typeof c.attrs?.["colspan"] === "number" ? (c.attrs["colspan"] as number) : 1,
  rowspan: typeof c.attrs?.["rowspan"] === "number" ? (c.attrs["rowspan"] as number) : 1,
});

/**
 * Rows as one table's rows: each cell cleaned with the rows left BELOW it in
 * this run (so a merged-down cell copied with the rows it covers keeps its
 * span — the second re-check's LOW-1), then laid out; null when the grid is
 * past the bounds or its cells overlap. `changed` says whether any cell moved.
 */
function fixRows(rowsIn: readonly PmJson[]): { rows: PmJson[]; changed: boolean } | null {
  let changed = false;
  const rows = rowsIn.map((row, r) => {
    const cellsIn = row.content ?? [];
    const cellsOut = cellsIn.map((cell) => cleanCell(cell, rowsIn.length - r));
    if (cellsOut.some((c, k) => c !== cellsIn[k])) changed = true;
    return changed ? { ...row, content: cellsOut } : row;
  });
  const layout = layoutTable(rows.map((row) => (row.content ?? []).map(spanOf)));
  return layout.ok ? { rows, changed } : null;
}

/**
 * A pasted fragment's tables made ones a description can keep (C109 (b)):
 * every cell's attributes cleaned (`cleanCell`) — in a table, in a run of
 * rows copied out of one (a cell block: prosemirror-tables' own copy), or
 * standing alone; a table inside a table — an e-mail's layout, a web page's —
 * becomes its cells' blocks; a grid past `table-bounds` (spans carried down
 * counted) or whose cells overlap becomes one line of text per row, cells
 * joined by " | ". Nothing pasted is dropped. Returns the SAME array when
 * there is nothing to change.
 */
export function fixPastedTables(nodes: readonly PmJson[]): readonly PmJson[] {
  let changed = false;
  const walk = (list: readonly PmJson[]): PmJson[] => {
    const out: PmJson[] = [];
    for (let k = 0; k < list.length; k++) {
      const n = list[k]!;
      if (n.type === "tableRow" || n.type === "tableCell" || n.type === "tableHeader") {
        // A run of rows, or of cells (one row's worth): one table's rows.
        const isRow = n.type === "tableRow";
        let end = k;
        const sameKind = (t: string) => (isRow ? t === "tableRow" : t === "tableCell" || t === "tableHeader");
        while (end < list.length && sameKind(list[end]!.type)) end++;
        const run = list.slice(k, end);
        const rowsIn = isRow ? run : [{ type: "tableRow", content: run }];
        const fixed = fixRows(rowsIn);
        if (!fixed) {
          changed = true;
          for (const row of rowsIn) out.push(line(row));
        } else {
          if (fixed.changed) changed = true;
          pushAll(out, isRow ? fixed.rows : (fixed.rows[0]!.content ?? []));
        }
        k = end - 1;
        continue;
      }
      if (n.type !== "table") {
        out.push(n.content ? { ...n, content: walk(n.content) } : n);
        continue;
      }
      const fixed = fixRows(n.content ?? []);
      if (!fixed) {
        changed = true;
        for (const row of n.content ?? []) out.push(line(row));
        continue;
      }
      if (fixed.changed) changed = true;
      out.push(fixed.changed ? { ...n, content: fixed.rows } : n);
    }
    return out;
  };
  const out = walk(nodes);
  return changed ? out : nodes;
}

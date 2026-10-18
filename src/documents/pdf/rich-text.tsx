// OUT OF THE REACT COMPILER: rendered by react-pdf's own reconciler (the
// invoice's PDF says why at length).
"use no memo";

import type { ReactNode } from "react";

import { Link, StyleSheet, Text, View } from "@react-pdf/renderer";

import { listMarker } from "@/lib/list-marker";
import { boundedSpan, layoutTable, TABLE_MAX_COLUMNS, TABLE_MAX_ROWS, type RowLayout } from "@/lib/rich-text/table-bounds";

/**
 * A STORED RICH-TEXT DOCUMENT, DRAWN INTO A PDF (Phase 7 slice 119) — the
 * description schema a progress update's section is normalised to
 * (`normalizeUpdateSection` → `descriptionExtensions`): paragraphs, headings
 * 1–3, bullet and numbered lists (nested), TASK LISTS, blockquotes, code
 * blocks, rules, hard breaks and — since slice 132 — simple tables; bold,
 * italic, underline, strike, code and links. The contract's PDF has a walker of its own over the narrower
 * contract schema, and keeps it: its archive drawing is frozen under
 * `CONTRACT_PDF_TEMPLATE_VERSION`, and a shared walker would move it.
 *
 * THE TRAPS, inherited from the invoice's and the contract's drawings:
 *  - NEVER A NEWLINE IN A TEXT: react-pdf 4.9 lays any newline out in its
 *    default Helvetica, whatever the family, so the PDF then references a
 *    font that cannot print "Łódź". A hard break is a LINE of its own; a
 *    text node that carries a newline (the normaliser keeps a text as typed)
 *    is split the same way.
 *  - A checklist's box is ASCII (`[x]` / `[ ]`), never a glyph Inter may
 *    lack.
 *  - An unknown node is drawn as its text, never dropped: nothing a client
 *    can read on their portal goes missing from the PDF.
 */

const INK = { text: "#1a1a1a", muted: "#5f5f5f", rule: "#d4d4d4", band: "#f4f4f4" } as const;

/** About this many characters fill a full-width line of the report's body text. */
const LINE_CHARS = 110;
/** A table row estimated past this many lines (about a third of a page) may break across pages. */
const TALL_ROW_LINES = 20;

const s = StyleSheet.create({
  p: { marginBottom: 5 },
  h1: { fontSize: 11.5, lineHeight: 1.3, fontWeight: 600, marginTop: 6, marginBottom: 3 },
  h2: { fontSize: 10.5, lineHeight: 1.3, fontWeight: 600, marginTop: 5, marginBottom: 3 },
  h3: { fontSize: 9.5, lineHeight: 1.35, fontWeight: 600, marginTop: 4, marginBottom: 2 },
  list: { marginBottom: 5 },
  item: { flexDirection: "row", marginBottom: 1.5 },
  marker: { width: 16 },
  box: { width: 22 },
  itemBody: { flexGrow: 1, flexShrink: 1, flexBasis: 0 },
  quote: { borderLeftWidth: 1.5, borderLeftColor: INK.rule, paddingLeft: 8, marginBottom: 5, color: INK.muted },
  code: { backgroundColor: INK.band, padding: 6, marginBottom: 5 },
  rule: { borderBottomWidth: 0.5, borderBottomColor: INK.rule, marginVertical: 8 },
  link: { color: INK.text, textDecoration: "underline" },
  // Slice 132 (C109): a simple table — a grid of equal-share cells (no widths
  // are stored), the header row on a band; a cell's span widens it, and a
  // column a cell from above still covers is an empty box.
  table: { borderTopWidth: 0.5, borderLeftWidth: 0.5, borderColor: INK.rule, marginBottom: 6 },
  tableRow: { flexDirection: "row" },
  tableCell: { flexBasis: 0, borderRightWidth: 0.5, borderBottomWidth: 0.5, borderColor: INK.rule, paddingVertical: 3, paddingHorizontal: 4 },
  tableHeader: { backgroundColor: INK.band },
});

type BlockStyle = (typeof s)[keyof typeof s];

type PmMark = { readonly type?: unknown; readonly attrs?: { readonly href?: unknown } };
export type PmNode = {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly content?: unknown;
  readonly marks?: unknown;
  readonly attrs?: {
    readonly level?: unknown;
    readonly start?: unknown;
    readonly type?: unknown;
    readonly checked?: unknown;
    readonly colspan?: unknown;
    readonly rowspan?: unknown;
  };
};

const children = (node: PmNode): PmNode[] => (Array.isArray(node.content) ? (node.content as PmNode[]) : []);

/** The plain text of a node — what an unknown node is drawn as. Never a newline. */
export function plainText(node: PmNode): string {
  if (typeof node.text === "string") return node.text.replace(/\s*\n\s*/g, " ");
  return children(node).map(plainText).join(" ");
}

/** One text run with its marks, as nested react-pdf text. */
function inline(node: PmNode, text: string, key: number): ReactNode {
  const marks = Array.isArray(node.marks) ? (node.marks as PmMark[]) : [];
  const style: Record<string, string | number> = {};
  const decorations: string[] = [];
  let href: string | null = null;
  for (const m of marks) {
    if (m.type === "bold") style["fontWeight"] = 600;
    else if (m.type === "italic") style["fontStyle"] = "italic";
    else if (m.type === "underline") decorations.push("underline");
    else if (m.type === "strike") decorations.push("line-through");
    else if (m.type === "link" && typeof m.attrs?.href === "string") href = m.attrs.href;
    // `code` is drawn as plain text: Inter is the one family.
  }
  if (decorations.length > 0) style["textDecoration"] = decorations.join(" ");
  if (href !== null) {
    return (
      <Link key={key} src={href} style={[s.link, style]}>
        {text}
      </Link>
    );
  }
  return (
    <Text key={key} style={style}>
      {text}
    </Text>
  );
}

/**
 * A paragraph's inline children as LINES: a hard break starts a new line,
 * and so does a newline inside a text node. An empty line keeps its height.
 */
function lines(node: PmNode): { node: PmNode; text: string }[][] {
  const out: { node: PmNode; text: string }[][] = [[]];
  for (const child of children(node)) {
    if (child.type === "hardBreak") {
      out.push([]);
      continue;
    }
    if (typeof child.text !== "string") {
      out[out.length - 1]!.push({ node: child, text: plainText(child) });
      continue;
    }
    const parts = child.text.split("\n");
    parts.forEach((part, i) => {
      if (i > 0) out.push([]);
      if (part.length > 0) out[out.length - 1]!.push({ node: child, text: part });
    });
  }
  return out;
}

function paragraph(node: PmNode, key: number, style: BlockStyle | undefined): ReactNode {
  const rows = lines(node);
  const line = (parts: { node: PmNode; text: string }[], k: number, st?: BlockStyle) => (
    <Text key={k} style={st}>
      {parts.length === 0 ? " " : parts.map((part, i) => inline(part.node, part.text, i))}
    </Text>
  );
  if (rows.length === 1) return line(rows[0]!, key, style);
  return (
    <View key={key} style={style}>
      {rows.map((parts, i) => line(parts, i))}
    </View>
  );
}

/** Inside a list item a paragraph takes no bottom margin of its own. */
function listChild(node: PmNode, key: number): ReactNode {
  if (node.type === "paragraph") return paragraph(node, key, undefined);
  return block(node, key);
}

function block(node: PmNode, key: number): ReactNode {
  switch (node.type) {
    case "paragraph":
      return paragraph(node, key, s.p);
    case "heading": {
      const level = node.attrs?.level === 2 ? s.h2 : node.attrs?.level === 3 ? s.h3 : s.h1;
      return (
        <View key={key} style={level} minPresenceAhead={24}>
          {paragraph(node, 0, undefined)}
        </View>
      );
    }
    case "bulletList":
    case "orderedList": {
      const ordered = node.type === "orderedList";
      const start = typeof node.attrs?.start === "number" ? node.attrs.start : 1;
      const kind = typeof node.attrs?.type === "string" ? node.attrs.type : "1";
      return (
        <View key={key} style={s.list}>
          {children(node).map((item, i) => (
            <View key={i} style={s.item}>
              <Text style={s.marker}>{ordered ? `${listMarker(start + i, kind)}.` : "•"}</Text>
              <View style={s.itemBody}>{children(item).map((child, j) => listChild(child, j))}</View>
            </View>
          ))}
        </View>
      );
    }
    case "taskList":
      return (
        <View key={key} style={s.list}>
          {children(node).map((item, i) => (
            <View key={i} style={s.item}>
              <Text style={s.box}>{item.attrs?.checked === true ? "[x]" : "[ ]"}</Text>
              <View style={s.itemBody}>{children(item).map((child, j) => listChild(child, j))}</View>
            </View>
          ))}
        </View>
      );
    case "blockquote":
      return (
        <View key={key} style={s.quote}>
          {children(node).map((child, i) => block(child, i))}
        </View>
      );
    case "codeBlock": {
      // A code block's text is its lines; drawn one Text per line on a band.
      const text = children(node)
        .map((c) => (typeof c.text === "string" ? c.text : plainText(c)))
        .join("");
      return (
        <View key={key} style={s.code}>
          {text.split("\n").map((line, i) => (
            <Text key={i}>{line.length === 0 ? " " : line}</Text>
          ))}
        </View>
      );
    }
    case "horizontalRule":
      return <View key={key} style={s.rule} />;
    case "table": {
      const rows = children(node);
      const layout = layoutTable(
        rows.map((row) =>
          children(row).map((cell) => ({
            colspan: boundedSpan(cell.attrs?.colspan ?? 1, TABLE_MAX_COLUMNS),
            rowspan: boundedSpan(cell.attrs?.rowspan ?? 1, TABLE_MAX_ROWS),
          })),
        ),
      );
      // The normaliser stores only tables that lay out; one that would not
      // is drawn as its text, never dropped (this file's rule).
      if (!layout.ok) {
        return (
          <Text key={key} style={s.p}>
            {plainText(node)}
          </Text>
        );
      }
      return (
        <View key={key} style={s.table}>
          {rows.map((row, i) => {
            const cells = children(row);
            const placed = layout.rows[i]!.cells;
            return (
              <View key={i} style={s.tableRow} wrap={tallRow(cells, placed, layout.width)}>
                {rowBoxes(placed, layout.width).map((box) => {
                  if (box.kind === "gap") return <View key={`g${box.column}`} style={[s.tableCell, { flexGrow: box.span }]} />;
                  const cell = cells[box.index]!;
                  return (
                    <View
                      key={`c${box.index}`}
                      style={[s.tableCell, cell.type === "tableHeader" ? s.tableHeader : {}, { flexGrow: box.colspan }]}
                    >
                      {children(cell).map((child, k) => listChild(child, k))}
                    </View>
                  );
                })}
              </View>
            );
          })}
        </View>
      );
    }
    default:
      return (
        <Text key={key} style={s.p}>
          {plainText(node)}
        </Text>
      );
  }
}

export type RowBox =
  | { readonly kind: "cell"; readonly index: number; readonly colspan: number }
  | { readonly kind: "gap"; readonly column: number; readonly span: number };

/**
 * A table row's boxes, column by column: a cell where one starts, an empty
 * box where a cell from a row above still covers (or a short row ends) — so
 * every cell stays under its own header (the code review's LOW-9).
 */
export function rowBoxes(placed: RowLayout["cells"], width: number): RowBox[] {
  const out: RowBox[] = [];
  let column = 0;
  let next = 0;
  while (column < width) {
    const at = placed[next];
    if (at && at.column === column) {
      out.push({ kind: "cell", index: next, colspan: at.colspan });
      column += at.colspan;
      next += 1;
    } else {
      const until = at ? at.column : width;
      if (until <= column) break; // never backwards (placements only increase)
      out.push({ kind: "gap", column, span: until - column });
      column = until;
    }
  }
  return out;
}

/**
 * About how many lines a node takes in a column of `perLine` characters a
 * line: a text block's text by the line — each hard break and each code
 * line a line of its own — every other block the sum of its children.
 * Counted in LINES, not characters: a 70-item checklist of short words is
 * short in characters and taller than a page (the re-check's LOW-D).
 */
export function estimatedLines(node: PmNode, perLine: number): number {
  if (node.type === "paragraph" || node.type === "heading" || node.type === "codeBlock") {
    const text = children(node)
      .map((c) => (c.type === "hardBreak" ? "\n" : typeof c.text === "string" ? c.text : plainText(c)))
      .join("");
    return text.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / perLine)), 0);
  }
  const kids = children(node);
  return kids.length === 0 ? 1 : kids.reduce((sum, k) => sum + estimatedLines(k, perLine), 0);
}

/**
 * Whether a row may run past a third of a page, and so may break across
 * pages: a short row is kept on one page, but react-pdf CLIPS an unbreakable
 * row taller than a page — text the client reads on the portal, missing from
 * their report (the security review's LOW-4).
 */
export function tallRow(cells: readonly PmNode[], placed: RowLayout["cells"], width: number): boolean {
  return cells.some((cell, k) => {
    const perLine = Math.max(4, Math.floor((LINE_CHARS * (placed[k]?.colspan ?? 1)) / Math.max(1, width)));
    return estimatedLines(cell, perLine) > TALL_ROW_LINES;
  });
}

/** The blocks of a stored document (`{ type: "doc", content: [...] }`), drawn in order. */
export function RichTextBlocks({ doc }: { readonly doc: unknown }): ReactNode {
  const root = doc as PmNode | null;
  if (!root || typeof root !== "object") return null;
  return <>{children(root).map((node, i) => block(node, i))}</>;
}

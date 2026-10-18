/**
 * A table's bounds (slice 132, founder decision C109): far past a task's or
 * an update's honest table, and what keeps one drawable — on a phone, in the
 * portal and in the monthly report's PDF. The normaliser refuses a document
 * past either (`TABLE_TOO_LARGE`); the paste handler turns a pasted table
 * past either into lines of text first, so nothing pasted is lost.
 */
export const TABLE_MAX_COLUMNS = 20;
export const TABLE_MAX_ROWS = 500;

export type SpanCell = { readonly colspan: number; readonly rowspan: number };

/** Where each cell of a row sits, and which columns a cell from a row above still covers. */
export type RowLayout = {
  readonly cells: readonly { readonly column: number; readonly colspan: number }[];
  readonly coveredFromAbove: readonly number[];
};

export type TableLayout =
  | { readonly ok: true; readonly width: number; readonly rows: readonly RowLayout[] }
  | { readonly ok: false; readonly reason: "too_wide" | "too_long" | "overlap" | "past_end" };

/**
 * Lays a table's cells on its grid the way a browser and prosemirror-tables
 * both do: each cell at the first column of its row that no cell from a row
 * above still covers (a `rowspan` CARRIES DOWN). The width is the grid's,
 * spans and carried cells included — counting only a row's own cells let a
 * row of one `colspan 20, rowspan 500` cell per row through as "20 wide"
 * while the grid was 10 000 columns, which prosemirror-tables then filled
 * with millions of cells in every open editor (slice 132's security
 * review, MEDIUM-1). Refuses a cell placed over a carried one and a
 * `rowspan` past the last row: the editor repairs both (`fixTables`), so
 * only a crafted document holds one. Linear: rows × (cells + bound).
 */
export function layoutTable(rows: readonly (readonly SpanCell[])[]): TableLayout {
  if (rows.length > TABLE_MAX_ROWS) return { ok: false, reason: "too_long" };
  // Per column: how many rows, this one included, a placed cell still covers.
  const covered: number[] = [];
  const out: RowLayout[] = [];
  let width = 0;
  for (let r = 0; r < rows.length; r++) {
    const coveredFromAbove: number[] = [];
    for (let k = 0; k < covered.length; k++) if ((covered[k] ?? 0) > 0) coveredFromAbove.push(k);
    const cells: { column: number; colspan: number }[] = [];
    let column = 0;
    for (const cell of rows[r]!) {
      while ((covered[column] ?? 0) > 0) column++;
      if (column + cell.colspan > TABLE_MAX_COLUMNS) return { ok: false, reason: "too_wide" };
      for (let k = column; k < column + cell.colspan; k++) if ((covered[k] ?? 0) > 0) return { ok: false, reason: "overlap" };
      if (cell.rowspan > rows.length - r) return { ok: false, reason: "past_end" };
      cells.push({ column, colspan: cell.colspan });
      for (let k = column; k < column + cell.colspan; k++) covered[k] = cell.rowspan;
      column += cell.colspan;
    }
    width = Math.max(width, column, covered.length);
    out.push({ cells, coveredFromAbove });
    for (let k = 0; k < covered.length; k++) if ((covered[k] ?? 0) > 0) covered[k]! -= 1;
  }
  return { ok: true, width, rows: out };
}

/** A span as the normaliser keeps it: an integer within its bound, else 1. */
export function boundedSpan(value: unknown, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) && n >= 1 && n <= max ? n : 1;
}

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { DataTable } from "./data-table";
import { Disclosure } from "./disclosure";

/**
 * A CHART'S TABLE TWIN (Phase 6 slice 117, the team charts) — every row and
 * every part a chart draws, as a table, behind "Show as a table". The
 * dataviz rule: no value is reachable only through colour or hover. A
 * `Disclosure`, so it costs no JavaScript and find-in-page reaches it. The
 * first column is the row's name; the rest are numbers, right-aligned.
 *
 * FLUSH, bleeding to the card's edges under a hairline of its own — a
 * bordered table 16 px inside a card's border is the double hairline UI.md
 * §10.15.1 forbids and the visual walk refuses (`doubleHairlines`, which
 * measures a CLOSED disclosure's table too; slice 117's code review). The
 * name column takes the spare width (`w-full max-w-0`) and truncates inside,
 * its full text in the `title`.
 *
 * ITS CONTRACT: the LAST child of a DEFAULT-size `SectionCard` (`p-4`) — the
 * `-mx-4 -mb-4` bleed is that padding. In a `size="sm"` card (`p-3`) it would
 * be clipped by the card's `overflow-hidden`, and anything after it would be
 * pulled up over it.
 */
export function ChartTable({
  label,
  scrollLabel,
  columns,
  rows,
}: {
  /** From t(): "Show as a table". */
  label: string;
  /** From t(): the table's name for its scroll region. */
  scrollLabel: string;
  columns: readonly string[];
  rows: readonly { readonly key: string; readonly cells: readonly string[] }[];
}) {
  return (
    <Disclosure label={label} className="mt-3" contentClassName="-mx-4 -mb-4 border-t border-border">
      <DataTable flush density="compact" scrollLabel={scrollLabel}>
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map((c, i) => (
                <TableHead key={c} className={i === 0 ? undefined : "text-right"}>
                  {c}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.key}>
                {r.cells.map((cell, i) =>
                  i === 0 ? (
                    <TableCell key={i} className="w-full max-w-0">
                      <span className="block truncate" title={cell}>
                        {cell}
                      </span>
                    </TableCell>
                  ) : (
                    <TableCell key={i} className="num text-right whitespace-nowrap">
                      {cell}
                    </TableCell>
                  ),
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DataTable>
    </Disclosure>
  );
}

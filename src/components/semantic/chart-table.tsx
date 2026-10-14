import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { ColumnPriority } from "@/components/ui/table-rungs";

import { DataTable } from "./data-table";
import { Disclosure } from "./disclosure";

/** A twin's column: its heading, and the rung it joins at (default: always). */
export type ChartTableColumn = string | { readonly label: string; readonly priority: ColumnPriority };

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
 * A column may carry a PRIORITY (the table's rungs) — for a column whose
 * values are reachable another way (a total that is the sum of the parts
 * beside it, a value the chart prints): CI run 38547997418's Swedish width
 * walk measured two twins 10 and 14 px over a phone's 356 px box with all of
 * their columns ("PROJEKT · ATT GÖRA · PÅGÅR · FÖRSENAD · TOTALT"). In the
 * two-column grid a card's box is under 38rem up to ~1520 px wide, so such a
 * column waits on most laptops too.
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
  columns: readonly ChartTableColumn[];
  rows: readonly { readonly key: string; readonly cells: readonly string[] }[];
}) {
  const heads = columns.map((c) => (typeof c === "string" ? { label: c, priority: "high" as const } : c));
  return (
    <Disclosure label={label} className="mt-3" contentClassName="-mx-4 -mb-4 border-t border-border">
      <DataTable flush density="compact" scrollLabel={scrollLabel}>
        <Table>
          <TableHeader>
            <TableRow>
              {heads.map((c, i) => (
                <TableHead key={c.label} priority={c.priority} className={i === 0 ? undefined : "text-right"}>
                  {c.label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.key}>
                {r.cells.map((cell, i) =>
                  i === 0 ? (
                    <TableCell key={i} priority={heads[0]?.priority ?? "high"} className="w-full max-w-0">
                      <span className="block truncate" title={cell}>
                        {cell}
                      </span>
                    </TableCell>
                  ) : (
                    <TableCell key={i} priority={heads[i]?.priority ?? "high"} className="num text-right whitespace-nowrap">
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

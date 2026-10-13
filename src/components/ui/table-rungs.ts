// NO "use client" — ON PURPOSE. These maps are read by SERVER components
// too (`/reports`, Phase 6 slice 116), and a constant exported from a
// "use client" module is a CLIENT REFERENCE on the server: `HIDE_FROM.lower`
// read there evaluated to nothing, `cn` dropped it, and the class never
// reached the page — no error, no warning, a stand-in shown at every width
// (AGENTS.md's standing trap; found by a browser probe of computed styles).
// `table.tsx` imports them from here; import them from here too, never
// through `table.tsx`.

/**
 * Column priority (UI.md §12: never a second implementation of a list).
 * A narrow table drops COLUMNS, not the table — one prop per column, no
 * parallel stacked-row renderer to drift from this one. The trailing
 * actions column is always `high`: an action a reader cannot reach is
 * the same as an action that does not exist.
 *
 * Each rung is a width of the TABLE — `<DataTable>`'s scroll box is the
 * `data-table` size container — never of the viewport (UI.md §10.12).
 * The rail is 224px, open by default from `md` up and collapsible by the
 * member, and a media query can see neither fact: at 768px the box was
 * 494px, narrower than `sm`, while `md:` switched the low columns ON —
 * measured, ten tables overflowed there and five put their row actions
 * past the box, and the backlog overflowed from 768px all the way to
 * ~1370px. Below `md` there is no rail, so `medium` (38rem = `sm` less the
 * page's two 16px gutters) and `low` (46rem = `md` less them) keep a phone
 * as it was, to the pixel for a flush table on the canvas (a bordered or
 * carded one reaches `medium` at 642px). `lower` (61.5rem) and `lowest`
 * (71rem) exist for the tables that need more than a phone rung to fit
 * (the backlog, client agreements), placed for real laptops: with a classic
 * 17px page scrollbar (computed — the harness's headless Chromium hides it,
 * a Windows browser does not), a 1280px window with the rail open (991px)
 * reaches `lower`, and a 1440px one with it open (1151px) or a 1280px one
 * with it collapsed (1167px) reaches `lowest`. Since the actions column is
 * PINNED (below), a rung no longer has to fit the widest content to keep a
 * row's verbs in view — a Swedish backlog row is 29px wider than `lowest`'s
 * narrowest box and simply scrolls under the pinned column there
 * (measured on CI run 35443979863 by the Swedish width walk, which
 * ratchets it as the trade it is; the ~21px this line carried before
 * was a hand probe's arithmetic and was low) — so the rungs trade a
 * little scroll at their very edge for more columns.
 * A `form`-width page never gives a table more than 670px, and a
 * `default`-width one caps it at 1030px, so a column that must render there
 * sits no higher than `medium` or `lower` respectively.
 *
 * A column with a priority renders only inside a `<DataTable>`: outside
 * one there is no container, the query never matches, and it stays hidden.
 */
export type ColumnPriority = "high" | "medium" | "low" | "lower" | "lowest"

export const PRIORITY: Record<ColumnPriority, string> = {
  high: "",
  medium: "hidden @min-[38rem]/data-table:table-cell",
  low: "hidden @min-[46rem]/data-table:table-cell",
  lower: "hidden @min-[61.5rem]/data-table:table-cell",
  lowest: "hidden @min-[71rem]/data-table:table-cell",
}

/**
 * The SAME rungs, for something that is not a column.
 *
 * Sometimes the thing that will not fit is inside a cell rather than
 * being a cell — the time week's status badges, which are `shrink-0`
 * `whitespace-nowrap` and so force their column exactly as a cell would.
 * Such an element wants the same widths, and the reason this exists is
 * that it was first written out by hand at its call site: a rung spelled
 * twice is a rung that can be re-measured in one place and not the
 * other, and the stop that would have caught it is exempt from the
 * overflow ratchet (review, 2026-09-18).
 *
 * `flex`, not `table-cell` — and the strings are COMPLETE class names on
 * purpose, never built by concatenation, because Tailwind scans source
 * text and a class assembled at runtime is a class that is never
 * generated. `high` is "" for the same reason `PRIORITY.high` is: it
 * always renders.
 */
export const SHOW_FROM: Record<ColumnPriority, string> = {
  high: "",
  medium: "hidden @min-[38rem]/data-table:flex",
  low: "hidden @min-[46rem]/data-table:flex",
  lower: "hidden @min-[61.5rem]/data-table:flex",
  lowest: "hidden @min-[71rem]/data-table:flex",
}

/**
 * The inverse of `SHOW_FROM`: an element shown only WHILE a rung's column is
 * hidden — what stands in for that column below its width (the client Reports
 * table's short month in the report cell while the Month column is hidden,
 * Phase 6 slice 115). Same rungs, same reason to live here (a rung spelled at
 * a call site is a rung re-measured in one place only), same complete class
 * strings. `high` is "hidden": a high column always renders, so its stand-in
 * never does.
 */
export const HIDE_FROM: Record<ColumnPriority, string> = {
  high: "hidden",
  medium: "@min-[38rem]/data-table:hidden",
  low: "@min-[46rem]/data-table:hidden",
  lower: "@min-[61.5rem]/data-table:hidden",
  lowest: "@min-[71rem]/data-table:hidden",
}

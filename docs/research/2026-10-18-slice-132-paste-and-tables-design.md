# Slice 132 — pasted formatting and simple tables (founder decision C109)

*2026-10-18. Asked "what do you want me to do?", the founder answered with recommendations in front of them: going live **not yet**; next, **a small polish item**, none named — so the option's stated default, paste formatting. Then two answers, both WITH the recommendation: tables in **descriptions and progress updates**, with **simple controls**. Everything marked **(reading)** is the implementing session's choice, named so a reviewer can push on it.*

## 1. What the founder decided

- **(a) Tables in descriptions AND progress updates.** One shared schema (`descriptionExtensions`), so the update's live preview, the portal and the monthly report's PDF learn to draw a table too.
- **(b) Simple controls.** A Table button; add and remove a row or a column; Tab between cells. No merged cells made, no colours, no widths.
- **Settled by me, stated with the question:** markdown copied with ChatGPT's or Claude's Copy button (it arrives as PLAIN TEXT) becomes formatting — headings, lists, checklists, quotes, code blocks, tables, bold, italic, links; Word's bulleted and numbered lists arrive as lists.

## 2. What already exists (read, not assumed)

- **HTML pastes already keep formatting.** The description and update editors are Tiptap over `descriptionExtensions`; ProseMirror parses pasted HTML against the schema, so a web page's or Google Docs' headings, lists, bold and `<a>` survive (the old comment in `extensions.ts` saying a pasted link would not was wrong). What did NOT survive: a **plain-text** paste (ChatGPT's and Claude's Copy buttons) — one paragraph per line with every `**` and `|` kept; **Word lists** — Word writes a list as paragraphs that START with the marker it drew (`·`, `o`, `§`, `1.`) padded with no-break spaces; and **tables** — no table nodes in the schema, so a table's cells pasted as loose paragraphs.
- **The server decides what is stored.** `normalize.ts` parses the JSON against the same schema, rebuilds every node's attributes from an allow-list, re-parses, and refuses past caps. The static renderer (`render.tsx`) draws only what the normaliser keeps; the PDF walker (`documents/pdf/rich-text.tsx`) draws an unknown node as its text.
- **The comment schema is separate** (`commentExtensions`, mentions) and is untouched; the contract schema likewise.
- **The import's markdown-lite** (`modules/work/import/description-doc.ts`) is a server-side builder for imported descriptions; it is not this and is unchanged.

## 3. The design

### 3.1 The pure half (`src/lib/rich-text/markdown.ts`, no DOM)

- `markdownToBlocks(text)` → document blocks, or `null` when the text is not markdown (`looksLikeMarkdown`: a block marker on some line, or an inline `**x**`/`__x__`/`` `x` ``/`~~x~~`/`[t](u)`). Headings `#`–`######` (deeper than 3 become 3); paragraphs, a soft line break kept as a hard break; fenced code (``` or ~~~, language ≤ 20 characters, lowercased); rules; GFM pipe tables (header row + separator; short rows padded to the header's width); quotes (recursive); bullet, numbered (start kept) and checklist items, nested by indent, with continuation lines. Inline: bold, italic, bold-italic (`***`), strike, code, links (`http`, `https`, `mailto` only — any other scheme stays its text) and bare `http(s)` URLs; a backslash escapes.
- **Linear by construction (reading).** A paste is unvetted text up to 200 000 characters, so no pattern backtracks: every line terminator (CR, U+2028, U+2029) becomes `\n` before anything is matched, line shapes anchor at the start and never end in `$`, fences, rules and table rows are checked by hand, every scan for a closer is bounded (500 / 2 000), and quotes nest at most 8 deep. A unit test runs the inputs that make such shapes quadratic (`# ` + 60 000 spaces + `x` + U+2028, 150 000 `[`, 100 000 `>`…) and holds them under three seconds — they take ~400 ms together.
- Code inside a link keeps the link (Tiptap's code mark excludes every other mark); a fence, heading or quote under a list item is a block of its own (a fence indented under an item loses that indent); a closing fence needs at least the opening's length; a URL may hold one level of balanced parentheses; a row with more cells than the header widens the table.
- `fixPastedTables(nodes)` — every pasted cell's attributes cleaned (spans bounded — a page's `colspan="1e9"` arrives as a STRING — the rowspan cut to the rows left, no width, no alignment); a table inside a table (an e-mail's layout, a web page's) becomes its cells' blocks; a table whose GRID is past the bounds (`layoutTable`, below) or whose cells overlap becomes one paragraph per row, cells joined by " | ". Nothing pasted is dropped.
- **Word's lists** (`src/lib/rich-text/word-lists.ts`, reading after the code review): read from WORD'S HTML only — a paragraph styled `mso-list:l<list> level<n>` — never guessed from leading characters, so "§ 3 Betalning" or "J. Doe" elsewhere stays text. The level and the list are Word's; a list's kind and start come from its first marker (`1.`, `a.`, `C)`, `i.`/`iv.` roman, anything else bullets), so a lettered sub-list's "c." is its third item. A run that starts deeper than it later goes is several lists; a skipped level hangs under an item with no paragraph of its own.
- **`layoutTable`** (`table-bounds.ts`): places each cell at the first column of its row that no cell from a row above still covers — the browser's and prosemirror-tables' placement — and so measures the GRID: 20 columns and 500 rows, spans carried down included; a cell over a carried one or a `rowspan` past the last row refused (the editor's `fixTables` repairs both, so only a crafted document holds one). Shared by the normaliser, the paste and the PDF.

### 3.2 The browser half (`src/components/rich-text/paste-formatting.ts`)

A client-only Tiptap extension (no node, no mark — the server's schema is unchanged), in the description editor and the update section editor ONLY, at priority 1000 so its props run before prosemirror-tables':
- `transformPastedHTML` → `wordListsInHtml`: Word's HTML (it holds `mso-list`) parsed with `DOMParser` (no script runs, nothing loads); each run of list paragraphs replaced by `<ul>`/`<ol type start>` built from `wordListTree`, Word's marker span (`mso-list:Ignore`) removed. Any other HTML untouched.
- `clipboardTextParser` → `markdownSlice`: a plain-text paste that reads as markdown becomes those blocks — EACH block checked against the schema on its own, a misfit becoming its text while the rest keeps its formatting; any failure of the reader → `null` and ProseMirror's own paste. ProseMirror never calls it for a paste into a code block, and passes `plain` for Ctrl+Shift+V — which keeps pasting the text exactly as typed (reading: the escape hatch).
- `transformPasted` → `fixPastedSlice`: every paste passes `fixPastedTables`; a rebuilt slice opens only up to the first ISOLATING node (`Slice.maxOpen(…, false)`), as ProseMirror's own parse closes it — opened into a table's last cell, the text after the caret moved INTO the cell.
- `handlePaste` → `pasteIntoCell`: **into a table cell (reading)**, a paste holding a table has its tables flattened — unless it is exactly one table that fits FROM THAT CELL (`TableMap`: the table's width and height after prosemirror-tables spreads it), which is left to prosemirror-tables.
- `handleDrop`: a drop holding a table onto a cell is swallowed (nothing moves, nothing nests).

### 3.3 Tables in the schema (`extensions.ts`, `normalize.ts`)

- `@tiptap/extension-table` 3.31.3 (`Table`, `TableRow`, `TableHeader`, `TableCell`) added to `descriptionExtensions`, `resizable: false`.
- **The normaliser:** a cell keeps `colspan` (1–20) and `rowspan` (1–500) — a merged cell arrives only by paste — and nothing else: no `colwidth` (a stored width is a layout a client's screen would inherit), no `align`. A table inside a table, cells that overlap or a `rowspan` past the last row → `INVALID_INPUT`; a grid past 20 columns or 500 rows (`layoutTable`) → **`TABLE_TOO_LARGE`** ("A table can have at most 20 columns and 500 rows…", its own message). The schema's own content rules refuse a row outside a table and a table with no rows. A document holding only an empty table is KEPT (it used to read as "no description" and vanish on reload).
- **Search** reads a table's cells as lines (the normaliser's `textBetween` with a block separator) — no change needed.

### 3.4 Drawing (`render.tsx`, `globals.css`, the PDF)

- **Static renderer:** `<div class="table-scroll"><table><tbody>` with `th`/`td`; a span is drawn only within the bounds. The editor's own node view wraps the table in `.tableWrapper`. Both scroll sideways inside the body, so a wide table never widens the panel or a phone's page; cells keep a 5rem floor so many columns scroll rather than squeeze. Borders and the header's band are tokens (`--border`, `--muted`); the editor's cell selection is `--accent`.
- **The monthly report's PDF:** rows of equal-share cells laid out by `layoutTable`, a cell's span widening it, an empty box where a cell from a row above still covers a column (so every cell stays under its header; the merged cell's text sits in its first row), the header row on the light band. A short row is kept on one page; a row that may be taller than a third of a page (longest cell × columns past 2 000 characters) may break — react-pdf CLIPS an unbreakable node taller than a page. A stored table that would not lay out is drawn as its text.

### 3.5 The Table menu (`src/components/rich-text/table-menu.tsx`)

One **Table** button beside each editor's formatting toolbar (not inside its roving tab stop — the contract editor's "Insert fill-in" menu is the precedent). Outside a table: **Insert a table** (three by three with a header row). Inside one: **Add a row above / below**, **Add a column to the left / right**, and, in the danger colour, **Delete this row / this column / the table** — a row or column the table cannot lose (its last, read from the table's map: `can()` does not know, prosemirror-tables checks it only when dispatching) is disabled, and so is adding a row at 500 or a column at 20. "Insert a table" is never offered inside a table. Tab moves to the next cell and adds a row from the last (the extension's own keymap); Shift+Tab goes back. Each action runs after the menu has closed (`onCloseAutoFocus`, its return prevented) — the fill-in menu's fix for CI run 38091780925. Ctrl+Z undoes any of them.

### 3.6 Not built

- Merging or splitting cells, a header column, cell colours or widths, alignment (C109 (b)); tables in comments or contracts.
- A setext heading (`Title` underlined with `---` or `===`): the underline stays text.
- ChatGPT's HTML clipboard (when there is one) is parsed as any HTML; its code blocks' "Copy code" header text is not removed.
- Tab from the last cell of a 500-row table adds a 501st row (the extension's own key); the save then says TABLE_TOO_LARGE.
- The size caps stay what they were: a very large pasted sheet can be too long for a description (about 3 000 cells) or an update section (about 800) — the save says so.
- A drop of a table onto a cell is refused rather than flattened; the into-a-cell rule for a PASTE reads the caret, as a paste goes there.
- Images and files by paste (a later slice, as before).

## 4. Authorisation and portal

- No permission code, no audit action, no migration, no new model. A description's and an update's saves are unchanged; what they may hold grows by four node types, each through the normaliser's allow-list.
- **Portal:** a contact reads a client-visible description or a published update through `RichText`, which now draws a table — cell text escaped as all text is, attributes only the bounded spans. Nothing a contact can see that they could not see before; no member name can enter a table (descriptions and updates have no mention node).

## 5. Tests

- **Unit:** `markdown.test.ts` (blocks, inline, link schemes, code in a link, parentheses in URLs, fences under items and four-backtick fences, line separators, quote depth, pasted tables and their cell attributes, the linear-time guard, every result through `normalizeDescription`), `word-lists.test.ts` (Word's style, a list's kind, the tree — lettered "c." included), `table-bounds.test.ts` (the grid: carried cells, overlap, past the end, ragged rows), `paste-formatting.test.ts` (the hooks against the real schema: open depths applied mid-paragraph, cleaned cells, into a cell and the room from it), `normalize.test.ts` (a table kept, width/alignment dropped, spans bounded, nested / oversized / carried-too-wide / overlapping / past-the-end refused, an empty table kept), `render.test.ts` (the table's markup), `made-report-pdf.test.ts` (the fixture holds a table with a column span, a merged-down cell and a list in a cell).
- **e2e** `e2e/paste-and-tables.spec.ts`: a markdown answer pasted as plain text becomes a heading, bold, a list and a table that saves and survives a reload; Word's HTML (its real list markup) becomes nested bulleted and lettered lists with the markers gone, and a "§" paragraph stays text; the Table menu inserts a table, Tab walks the row, a column added stays after a reload, "Insert a table" is not offered inside one, and deleting down to the header row disables the delete; a table pasted into a progress update shows in its live preview.

## 6. The slice reviews (fresh agents, read-only: code + security in parallel) — dispositions

### Security review — no HIGH; nothing a client could see that they should not, no XSS

- **MEDIUM-1 — the width counted per row, not on the grid: a stored 10 000 × 500 grid froze every open editor.** TAKEN: `layoutTable` measures the grid (spans carried down counted), refuses overlaps and a `rowspan` past the end; the normaliser, the paste and the PDF share it. Tests: `table-bounds.test.ts`, the carried and overlap cases in `normalize.test.ts`.
- **LOW-2 — four line patterns quadratic on U+2028/U+2029 or a lone CR.** TAKEN: `toLines` turns every terminator into `\n` first, and the patterns no longer end in `$`; the guard test holds those inputs.
- **LOW-3 — `fixPastedTables` trusted pasted spans (`"1e9"` arrives as a string).** TAKEN: `cleanCell`.
- **LOW-4 — a PDF row taller than a page is clipped.** TAKEN: a row that may be tall may break.
- **NIT-5 — quote recursion unbounded.** TAKEN: 8 deep; `markdownSlice` also catches any reader failure.
- **NIT-6 — irregular shapes stored as-is.** TAKEN by MEDIUM-1's helper (overlap and past-the-end refused); a ragged or empty row is still allowed — every surface draws it.
- **NIT-7 — §5.17's last sentences were spliced into §5.18.** TAKEN.

### Code review — no HIGH

- **MEDIUM-1 — a rebuilt slice opened into the table's isolating nodes, so the text after the caret moved into the last cell.** TAKEN: `Slice.maxOpen(…, false)`; a test applies the slice mid-paragraph.
- **MEDIUM-2 — code inside a link failed the schema and the whole paste fell back to raw text.** TAKEN twice: the link wins over code, and each block is checked on its own (a misfit becomes its text).
- **MEDIUM-3 — Word's lettered `c.`/`i.`/`l.`/`v.`/`x.` read as roman, a level too deep.** TAKEN by reading Word's own `mso-list` level and list (`word-lists.ts`), the kind from a list's first marker.
- **MEDIUM-4 — a fence directly under a list item folded into the item.** TAKEN.
- **LOW-5 — "the last row/column is disabled" never took effect (`can()` is true).** TAKEN: read from the table's map; the e2e deletes down to the header row and finds the item disabled.
- **LOW-6 — bounds and caps could still make a save fail.** TAKEN in part: add-row/add-column disabled at the bounds, a single table pasted into a cell checked against the room from that cell, the bounds' own message (`TABLE_TOO_LARGE`), and UI.md now says what a paste cannot avoid (the size caps). Tab past 500 rows is recorded (§3.6).
- **LOW-7 — not linear for every input.** TAKEN (as the security LOW-2 and NIT-5).
- **LOW-8 — "§ 3 Betalning" and "J. Doe" taken for Word markers.** TAKEN by MEDIUM-3's fix: only Word's HTML is read for lists.
- **LOW-9 — the PDF misdrew merged-down cells and clipped tall rows.** TAKEN: empty boxes where a cell from above covers; tall rows may break.
- **LOW-10 — drops used the caret, not the drop point.** TAKEN: the into-a-cell rule moved to `handlePaste` (the caret is where a paste goes) and `handleDrop` refuses a table dropped onto a cell.
- **NITs:** Ctrl+Shift+V converting Word markers (gone with LOW-8's fix); extra cells past the header cut (the header widens); a four-backtick fence closed by three (fixed); URLs with parentheses (one balanced level kept); pasted `colwidth`/`align` shown until reload (cleaned on paste); a document of one empty table stored as null (kept); the per-row width (MEDIUM-1 of the security review); the misplaced UI.md text (fixed); the test gaps (each of the above now has a test). All TAKEN.

## 7. The narrow re-check of the fixes (a fresh agent, read-only) — dispositions

No HIGH, no MEDIUM; it confirmed each fix above in code (the grid matches prosemirror-tables' `computeMap`, the editor cannot itself produce an overlap or a rowspan past the end — `fixTables` runs on every changed table — the open depths, the drop point, the PDF loop's termination, `roomFrom`'s arithmetic, every pattern's linearity). Its findings, all TAKEN:
- **LOW-A — a lone pasted `<td>`/`<tr>` (no table around it) skipped `cleanCell`**, and prosemirror-tables then sized its map from `colspan="1e9"`. Now every cell is cleaned wherever it sits, and a lone row wider than 20 becomes its text.
- **LOW-B — a markdown table was BUILT at rows × widest row before it could be flattened** (25 million nodes from a 25 KB paste). Past the bounds it is now lines of text from the start; the guard test holds that input.
- **LOW-C — a selection straddling the table's edge (Shift+click below it) could nest a table** — by paste (the Fitter put it in the start cell) or by "Insert a table". Either end in a cell now counts as in the table; a single table is left to prosemirror-tables only when it will take it (a cell selection, or the HEAD in a cell with room from there); "Insert a table" is disabled for such a selection.
- **LOW-D — the PDF's tall-row test counted characters**, so a 70-item checklist of short words stayed unbreakable. Now estimated in lines (`estimatedLines`), with `rowBoxes` and `tallRow` unit-tested (`src/documents/pdf/rich-text.test.ts`).
- **NITs:** an empty table in an UPDATE section was still sent as "no section" (Tiptap's `isEmpty` reads empty cells as empty) — `isBlank`, also for Add to Done; the Word marker fallback stripped any first word — only a marker now; an indented heading under a list item (`  ## Sub`) is a heading (up to three spaces before `#`); the unreachable "item with no paragraph" branch removed and its test renamed; a marker-free hostile input added to the guard; the PDF test's claim narrowed (the row decisions have their own test); the Swedish message lost its English comma, and both now say "split it in two" (an update section has no attachments).

## 8. The second narrow re-check (a fresh agent, read-only) — dispositions

No HIGH, no MEDIUM. Taken:
- **LOW-1 — a REGRESSION of §7's LOW-A fix:** cleaning every lone row's cells with "one row left" cut a merged-down cell's span in a block of rows copied OUT of a table (prosemirror-tables' own cell copy), so its cells pasted a column off. Now a run of rows is cleaned as one table's rows (a span cut only to the rows of the run), and a run of lone cells as one row.
- **LOW-2 — the room check missed a copied block of cells** (rows or cells, not a `table` node — the most common in-app paste) and a 20-wide table grew past the bounds. `pasteIntoCell` now sizes whatever prosemirror-tables will take as cells by its own reading (`__pastedCells`).
- **LOW-3 — an update holding only an empty table could be published** (its text was `""`, the gate read `null`). `normalizeUpdateBody` now counts only sections that say something: such a draft is kept and says nothing, so `UPDATE_EMPTY` holds — an update of only an empty checklist too.
- **NITs taken:** the Word marker fallback takes only a number, ONE letter or a roman numeral (never "Dr." or "Inc."); spread pushes of possibly huge arrays replaced by a loop; an oversized markdown table's lines carry its cells' TEXT (no `**` left); the untested branches (a cell selection, a head in a cell with its anchor outside) tested; `isBlank` also keeps an empty checklist.
- **NIT accepted — `#` with up to three leading spaces is a heading everywhere** (CommonMark's rule, needed for a heading under a list item): a YAML or shell comment indented one to three spaces, pasted as plain text, now reads as a heading — as an unindented one always did. Ctrl+Shift+V pastes such text as typed.

## 9. The third narrow re-check (a fresh agent, read-only) — clean

No HIGH, MEDIUM or LOW: a block of rows copied out of a table is preserved exactly (prosemirror-tables' `CellSelection.content()` already cuts spans to the rectangle), `fixPastedTables` returns the same array when nothing changes, runs cannot misgroup, `pasteIntoCell` applies the room check to every paste prosemirror-tables' `handlePaste` would spread, and no reader relied on an update's text being non-null. Its four NITs were applied as it proposed, with no further pass: a nested table of empty rows leaves its cell an empty paragraph (not an empty cell the schema refuses); `handleDrop` refuses any table PART dropped onto a cell (rows or cells dragged out of a cell selection too); the last two spread pushes are loops; and the missing tests (an update of only an empty checklist, the 500-row room) were added.

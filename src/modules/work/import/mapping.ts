import { MAX_LABEL_NAME_LENGTH, MAX_TITLE_LENGTH } from "@/lib/work-view";

import type { ParsedCsv } from "./csv-parse";
import {
  IMPORT_BATCH_BYTES,
  IMPORT_BATCH_ROWS,
  IMPORT_CHECKLIST_ITEM_MAX,
  IMPORT_CHECKLIST_ITEMS_MAX,
  IMPORT_CHECKLIST_NAME_MAX,
  IMPORT_CHECKLISTS_MAX,
  IMPORT_LABELS_MAX,
  IMPORT_SOURCE_ID_MAX,
  IMPORT_TEXT_MAX,
  isImportDay,
  type ImportRow,
} from "./rules";
import type { TrelloBoard } from "./trello";

/**
 * MATCHING A FILE TO A PROJECT (Phase 6 slice 121; design §2.3, R4, R5).
 * Pure and browser-safe: every guess here is SHOWN to the member, who can
 * change it, before anything is written — the guesses only save typing.
 */

export const IMPORT_FIELDS = ["name", "description", "status", "due", "assignee", "assigneeEmail", "labels", "id"] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];
export type ColumnMap = Readonly<Record<ImportField, number | null>>;

/** Lower case, accents folded, inner space collapsed: "Förfallodatum" → "forfallodatum". */
export const fold = (s: string): string =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

/** Header words, English and Swedish, ALREADY FOLDED; first match wins per field. */
const HEADER_WORDS: Readonly<Record<ImportField, readonly string[]>> = {
  name: ["name", "title", "task name", "task", "summary", "card name", "item", "item name", "namn", "titel", "uppgift", "rubrik", "arende"],
  description: ["description", "notes", "task content", "content", "desc", "details", "beskrivning", "anteckningar", "detaljer", "innehall"],
  status: ["status", "state", "section/column", "section", "column", "list", "list name", "stage", "kolumn", "lista", "sektion", "fas", "tillstand"],
  due: ["due date", "due", "due on", "deadline", "end date", "forfallodatum", "slutdatum", "klart senast", "datum"],
  assignee: ["assignee", "assignees", "assigned to", "owner", "person", "people", "responsible", "ansvarig", "tilldelad", "utforare"],
  assigneeEmail: ["assignee email", "assignee e-mail", "ansvarig e-post", "ansvarigs e-post"],
  labels: ["labels", "label", "tags", "tag", "etiketter", "etikett", "taggar"],
  id: ["id", "task id", "issue key", "issue id", "item id", "card id", "key", "uppgifts-id", "uppgift-id"],
};

/** Each field's first matching header; a header is used once. */
export function guessColumns(headers: readonly string[]): ColumnMap {
  const folded = headers.map(fold);
  const used = new Set<number>();
  const map = {} as Record<ImportField, number | null>;
  for (const field of IMPORT_FIELDS) {
    map[field] = null;
    for (const word of HEADER_WORDS[field]) {
      const i = folded.findIndex((h, idx) => h === word && !used.has(idx));
      if (i >= 0) {
        map[field] = i;
        used.add(i);
        break;
      }
    }
  }
  return map;
}

// ── Dates ───────────────────────────────────────────────────────────

export type DateFormat = "DMY" | "MDY";

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, january: 1, januari: 1,
  feb: 2, february: 2, februari: 2,
  mar: 3, march: 3, mars: 3,
  apr: 4, april: 4,
  may: 5, maj: 5,
  jun: 6, june: 6, juni: 6,
  jul: 7, july: 7, juli: 7,
  aug: 8, august: 8, augusti: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, okt: 10, october: 10, oktober: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

const pad = (n: number) => String(n).padStart(2, "0");
const day = (y: number, m: number, d: number): string | null => {
  const iso = `${y}-${pad(m)}-${pad(d)}`;
  return isImportDay(iso) ? iso : null;
};
const year = (y: string): number => (y.length === 2 ? 2000 + Number(y) : Number(y));

// Matched against FOLDED text, so an ISO time's "T" is a lower-case "t".
const YMD = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:$|[t\s])/;
const NUMERIC = /^(\d{1,2})([./-])(\d{1,2})\2(\d{4})(?:$|[t\s,])/;
const DAY_MONTH_NAME = /^(\d{1,2})\.?[\s/-]([a-z]{3,9})\.?[\s/-](\d{2}|\d{4})(?:$|[\s,])/;
const MONTH_NAME_DAY = /^([a-z]{3,9})\.?\s(\d{1,2})(?:st|nd|rd|th)?,?\s(\d{4})(?:$|[\s,])/;

/**
 * One cell → `YYYY-MM-DD`, or null when it is not a date we can read with
 * certainty. ISO (with or without a time), `D.M.YYYY` (always day first —
 * the dot is the Nordic and German form), `D/M/YYYY` or `M/D/YYYY` as the
 * member said, and a written month in English or Swedish.
 */
export function parseDateCell(value: string, format: DateFormat): string | null {
  const v = fold(value).replace(/^[a-z]+day,?\s/, ""); // "wednesday, october 15th 2026"
  if (v === "") return null;
  let m = YMD.exec(v);
  if (m) return day(Number(m[1]), Number(m[2]), Number(m[3]));
  m = NUMERIC.exec(v);
  if (m) {
    const [a, b, y] = [Number(m[1]), Number(m[3]), Number(m[4])];
    if (m[2] === ".") return day(y, b, a);
    return format === "DMY" ? day(y, b, a) : day(y, a, b);
  }
  m = DAY_MONTH_NAME.exec(v);
  if (m && MONTHS[m[2]!]) return day(year(m[3]!), MONTHS[m[2]!]!, Number(m[1]));
  m = MONTH_NAME_DAY.exec(v);
  if (m && MONTHS[m[1]!]) return day(Number(m[3]), MONTHS[m[1]!]!, Number(m[2]));
  return null;
}

/**
 * Whether a column's slash-dates are day-first or month-first, from the
 * values themselves: a first part above 12 says day-first, a second above
 * 12 month-first. `ambiguous` when nothing tells — the member is asked.
 */
export function guessDateFormat(values: readonly string[]): { format: DateFormat; ambiguous: boolean } {
  let dmy = false;
  let mdy = false;
  let any = false;
  for (const value of values) {
    const m = NUMERIC.exec(fold(value));
    if (!m || m[2] === ".") continue;
    any = true;
    if (Number(m[1]) > 12) dmy = true;
    if (Number(m[3]) > 12) mdy = true;
  }
  if (dmy && !mdy) return { format: "DMY", ambiguous: false };
  if (mdy && !dmy) return { format: "MDY", ambiguous: false };
  return { format: "DMY", ambiguous: any };
}

// ── Labels and people ───────────────────────────────────────────────

/** A labels cell → names: split on `,` and `;`, trimmed, de-duplicated case-insensitively, capped. */
export function splitLabels(cell: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of cell.split(/[,;]/)) {
    const name = raw.trim().slice(0, MAX_LABEL_NAME_LENGTH).trim();
    if (name === "" || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
    if (out.length === IMPORT_LABELS_MAX) break;
  }
  return out;
}

/** The FIRST person in an assignee cell ("Anna Berg, Bo Ek" → "Anna Berg"). */
export const firstPerson = (cell: string): string => (cell.split(/[,;]/)[0] ?? "").trim();

export type MemberOption = { readonly id: string; readonly name: string; readonly email: string };

/**
 * A person in the file → a member: email exactly (case-insensitive) when the
 * file gave one, else the full name exactly with case and accents folded.
 * `null` = Nobody. Never a fuzzy guess — a wrong person would be handed work.
 */
export function guessMember(person: { name: string; email: string | null }, members: readonly MemberOption[]): string | null {
  if (person.email) {
    const email = person.email.trim().toLowerCase();
    const hit = members.find((m) => m.email.toLowerCase() === email);
    if (hit) return hit.id;
  }
  const name = fold(person.name);
  if (name === "") return null;
  const byName = members.filter((m) => fold(m.name) === name);
  return byName.length === 1 ? byName[0]!.id : null;
}

// ── States ──────────────────────────────────────────────────────────

export type StateCategory = "TRIAGE" | "BACKLOG" | "TODO" | "IN_PROGRESS" | "DONE" | "CANCELLED";
export type StateOption = {
  readonly id: string;
  readonly name: string;
  readonly category: StateCategory;
  readonly isDefault: boolean;
  readonly requiresApproval: boolean;
};

/** Words for a category, ALREADY FOLDED (English and Swedish). */
const CATEGORY_WORDS: readonly [Exclude<StateCategory, "TRIAGE">, readonly string[]][] = [
  ["CANCELLED", ["cancelled", "canceled", "won't do", "wont do", "wontfix", "rejected", "dropped", "avbruten", "avbrutna", "struken", "avbojd"]],
  ["DONE", ["done", "complete", "completed", "closed", "finished", "resolved", "klar", "klart", "klara", "fardig", "fardigt", "avslutad", "avslutade", "stangd", "lost"]],
  ["IN_PROGRESS", ["doing", "in progress", "wip", "started", "active", "in review", "review", "testing", "pagaende", "pagar", "paborjad", "under arbete", "granskning"]],
  ["BACKLOG", ["backlog", "someday", "later", "ideas", "icebox", "ideer", "senare"]],
  ["TODO", ["to do", "todo", "to-do", "open", "new", "next", "planned", "att gora", "ny", "nya", "oppen", "planerad", "planerat"]],
];

/** The states a member may put an imported task in: never TRIAGE, a gated state only with the approve code (R5). */
export const offeredStates = (states: readonly StateOption[], canApprove: boolean): StateOption[] =>
  states.filter((s) => s.category !== "TRIAGE" && (canApprove || !s.requiresApproval));

/**
 * A status or list name → a state: the state's own name, else a category's
 * words (as a whole value, then as a whole word inside it), else the
 * default. Only `offered` states are ever answered.
 */
export function guessState(value: string, offered: readonly StateOption[]): string | null {
  const fallback = offered.find((s) => s.isDefault)?.id ?? offered[0]?.id ?? null;
  const v = fold(value);
  if (v === "") return fallback;
  const named = offered.find((s) => fold(s.name) === v);
  if (named) return named.id;
  const words = ` ${v.replace(/[^a-z0-9' -]+/g, " ").replace(/\s+/g, " ").trim()} `;
  for (const pass of ["exact", "word"] as const) {
    for (const [category, list] of CATEGORY_WORDS) {
      const hit = list.some((w) => (pass === "exact" ? v === w : words.includes(` ${w} `)));
      if (!hit) continue;
      const state = offered.find((s) => s.category === category);
      if (state) return state.id;
    }
  }
  return fallback;
}

// ── Rows ────────────────────────────────────────────────────────────

/** What the check step says about the rows before anything is written (design §2.5). */
export type RowStats = {
  /** Rows with no name — not imported. */
  skippedNoName: number;
  /** Rows whose name, description or a checklist was cut to fit. */
  shortened: number;
  /** Non-empty date cells that could not be read — imported without a date. */
  badDates: number;
  /** Rows whose id repeats an earlier row's — imported without one (a re-import copies them). */
  duplicateIds: number;
  /** Label names not yet in the project. */
  newLabels: readonly string[];
};

/**
 * A string cut to `max` UTF-16 units with an ellipsis — never through a
 * surrogate pair: half an emoji is a character the database refuses (the
 * code review; the server strips one anyway, `storable`).
 */
const cut = (s: string, max: number): [string, boolean] => {
  if (s.length <= max) return [s, false];
  let end = max - 1;
  const last = s.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return [`${s.slice(0, end)}…`, true];
};

type Draft = ImportRow;

function finishRows(drafts: readonly Draft[], existingLabels: readonly string[], base: Omit<RowStats, "newLabels" | "shortened" | "duplicateIds">): { rows: ImportRow[]; stats: RowStats } {
  const known = new Set(existingLabels.map((l) => l.toLowerCase()));
  const fresh = new Map<string, string>();
  const ids = new Set<string>();
  let shortened = 0;
  let duplicateIds = 0;
  const rows: ImportRow[] = [];
  for (const d of drafts) {
    let changed = false;
    const [title, titleCut] = cut(d.title, MAX_TITLE_LENGTH);
    const [text, textCut] = cut(d.text, IMPORT_TEXT_MAX);
    changed = titleCut || textCut;
    let items = 0;
    const checklists = d.checklists.slice(0, IMPORT_CHECKLISTS_MAX).map((c) => {
      const room = Math.max(0, IMPORT_CHECKLIST_ITEMS_MAX - items);
      const kept = c.items.slice(0, room);
      items += kept.length;
      if (kept.length < c.items.length) changed = true;
      return {
        name: c.name === null ? null : cut(c.name, IMPORT_CHECKLIST_NAME_MAX)[0],
        items: kept.map((i) => {
          const [t, wasCut] = cut(i.text, IMPORT_CHECKLIST_ITEM_MAX);
          if (wasCut) changed = true;
          return { text: t, done: i.done };
        }),
      };
    }).filter((c) => c.items.length > 0);
    if (d.checklists.length > IMPORT_CHECKLISTS_MAX) changed = true;
    if (changed) shortened++;
    let sourceId = d.sourceId === null ? null : d.sourceId.trim().slice(0, IMPORT_SOURCE_ID_MAX) || null;
    if (sourceId !== null) {
      if (ids.has(sourceId)) {
        duplicateIds++;
        sourceId = null;
      } else {
        ids.add(sourceId);
      }
    }
    for (const l of d.labels) if (!known.has(l.toLowerCase()) && !fresh.has(l.toLowerCase())) fresh.set(l.toLowerCase(), l);
    rows.push({ ...d, sourceId, title, text, checklists });
  }
  return { rows, stats: { ...base, shortened, duplicateIds, newLabels: [...fresh.values()] } };
}

/** The distinct, non-blank values of one column, in file order (for the status and people tables). */
export function distinctValues(csv: ParsedCsv, column: number | null): string[] {
  if (column === null) return [];
  const seen = new Map<string, string>();
  for (const row of csv.rows) {
    const v = (row[column] ?? "").trim();
    if (v !== "" && !seen.has(fold(v))) seen.set(fold(v), v);
  }
  return [...seen.values()];
}

/** The person a CSV row names — its email cell when mapped and filled, else its first name. */
export function csvPersonKey(row: readonly string[], columns: ColumnMap): string | null {
  const email = columns.assigneeEmail === null ? "" : firstPerson(row[columns.assigneeEmail] ?? "");
  if (email !== "") return email.toLowerCase();
  const name = columns.assignee === null ? "" : firstPerson(row[columns.assignee] ?? "");
  return name === "" ? null : fold(name);
}

/**
 * A CSV's rows as the server will receive them. `stateFor` keys on the
 * FOLDED status value ("" for an empty one); `memberFor` on `csvPersonKey`.
 */
export function buildCsvRows(input: {
  csv: ParsedCsv;
  columns: ColumnMap;
  dateFormat: DateFormat;
  stateFor: ReadonlyMap<string, string>;
  defaultStateId: string;
  memberFor: ReadonlyMap<string, string | null>;
  existingLabels: readonly string[];
}): { rows: ImportRow[]; stats: RowStats } {
  const { csv, columns } = input;
  const cell = (row: readonly string[], c: number | null) => (c === null ? "" : (row[c] ?? ""));
  let skippedNoName = 0;
  let badDates = 0;
  const drafts: Draft[] = [];
  for (const row of csv.rows) {
    const title = cell(row, columns.name).replace(/\s+/g, " ").trim();
    if (title === "") {
      skippedNoName++;
      continue;
    }
    const dueCell = cell(row, columns.due).trim();
    const due = dueCell === "" ? null : parseDateCell(dueCell, input.dateFormat);
    if (dueCell !== "" && due === null) badDates++;
    const person = csvPersonKey(row, columns);
    const id = cell(row, columns.id).trim();
    drafts.push({
      sourceId: id === "" ? null : id,
      title,
      text: cell(row, columns.description),
      checklists: [],
      link: null,
      stateId: input.stateFor.get(fold(cell(row, columns.status))) ?? input.defaultStateId,
      targetDate: due,
      assigneeMemberId: person === null ? null : (input.memberFor.get(person) ?? null),
      labels: splitLabels(cell(row, columns.labels)),
    });
  }
  return finishRows(drafts, input.existingLabels, { skippedNoName, badDates });
}

/** A Trello board's cards as the server will receive them. `stateFor` keys on the list id; `memberFor` on the Trello member id. */
export function buildTrelloRows(input: {
  board: TrelloBoard;
  stateFor: ReadonlyMap<string, string>;
  defaultStateId: string;
  memberFor: ReadonlyMap<string, string | null>;
  existingLabels: readonly string[];
}): { rows: ImportRow[]; stats: RowStats } {
  let skippedNoName = 0;
  const drafts: Draft[] = [];
  for (const card of input.board.cards) {
    const title = card.name.replace(/\s+/g, " ").trim();
    if (title === "") {
      skippedNoName++;
      continue;
    }
    drafts.push({
      sourceId: card.id,
      title,
      text: card.desc,
      checklists: card.checklists.map((c) => ({ name: c.name, items: c.items.map((i) => ({ text: i.text, done: i.done })) })),
      link: card.link,
      stateId: input.stateFor.get(card.listId) ?? input.defaultStateId,
      targetDate: card.due,
      assigneeMemberId: card.memberId === null ? null : (input.memberFor.get(card.memberId) ?? null),
      labels: card.labels.slice(0, IMPORT_LABELS_MAX).map((l) => l.slice(0, MAX_LABEL_NAME_LENGTH).trim()).filter((l) => l !== ""),
    });
  }
  return finishRows(drafts, input.existingLabels, { skippedNoName, badDates: 0 });
}

/** Rows → batches of at most `IMPORT_BATCH_ROWS` rows and about `IMPORT_BATCH_BYTES` serialised. */
export function batchRows(rows: readonly ImportRow[]): ImportRow[][] {
  const encoder = new TextEncoder();
  const batches: ImportRow[][] = [];
  let current: ImportRow[] = [];
  let bytes = 0;
  for (const row of rows) {
    const size = encoder.encode(JSON.stringify(row)).length;
    if (current.length > 0 && (current.length >= IMPORT_BATCH_ROWS || bytes + size > IMPORT_BATCH_BYTES)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(row);
    bytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

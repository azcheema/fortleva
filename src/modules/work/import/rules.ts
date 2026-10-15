import { z } from "zod";

import { MAX_LABEL_NAME_LENGTH, MAX_TITLE_LENGTH } from "@/lib/work-view";

/**
 * THE IMPORT'S RULES, shared by the browser (which builds rows) and the
 * server (which trusts none of them) — Phase 6 slice 121, founder decision
 * C97; docs/research/2026-10-15-slice-121-imports-design.md §3. Pure:
 * zod and constants only, so a client component can import it.
 */

export const IMPORT_SOURCES = ["CSV", "TRELLO"] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

/** `work_item.source_system` for a job's source (CHECK `work_item_source_system_known`). */
export const sourceSystemOf = (source: ImportSource): "csv" | "trello" => (source === "CSV" ? "csv" : "trello");

/** Rows per import (CHECK `import_job_row_count_bounded`); a bigger file is refused whole (R11). */
export const IMPORT_MAX_ROWS = 2000;
/** Rows per batch — one transaction each. */
export const IMPORT_BATCH_ROWS = 100;
/**
 * A batch's serialised size the browser stays under: Next refuses a
 * server-action body over 1 MB, and a row at every cap below is ~400 KB.
 */
export const IMPORT_BATCH_BYTES = 700 * 1024;
/** The largest file the browser will read (a Trello board runs to tens of MB). */
export const IMPORT_FILE_BYTES = 50 * 1024 * 1024;
export const IMPORT_FILE_NAME_MAX = 200;

/**
 * A description's own text, before checklists. With the checklist caps
 * below the whole document's TEXT stays under `DESCRIPTION_TEXT_CHARS`
 * (100 000). Its JSON can still pass `DESCRIPTION_JSON_BYTES` (512 KB) —
 * ten thousand one-word bullets do — so the server falls back to the text
 * as one plain paragraph rather than refuse the row (`service.ts`; the code
 * review's finding).
 */
export const IMPORT_TEXT_MAX = 40_000;
export const IMPORT_CHECKLISTS_MAX = 20;
export const IMPORT_CHECKLIST_NAME_MAX = 200;
export const IMPORT_CHECKLIST_ITEMS_MAX = 200;
export const IMPORT_CHECKLIST_ITEM_MAX = 250;
export const IMPORT_LABELS_MAX = 20;
export const IMPORT_SOURCE_ID_MAX = 200;
export const IMPORT_LINK_MAX = 300;

/** Undo is possible this long after the import's last write (C97 (c)). */
export const IMPORT_UNDO_DAYS = 7;
/** "Bring back" is possible this long after an undo (design R10). */
export const IMPORT_RESTORE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A RUNNING import untouched this long is shown as stopped part-way (R11). */
export const IMPORT_STALE_MS = 15 * 60 * 1000;

export const undoOpen = (lastWriteAt: Date, now: Date): boolean =>
  now.getTime() - lastWriteAt.getTime() <= IMPORT_UNDO_DAYS * DAY_MS;
export const restoreOpen = (undoneAt: Date, now: Date): boolean =>
  now.getTime() - undoneAt.getTime() <= IMPORT_RESTORE_DAYS * DAY_MS;

/** The Trello card link — the card's `shortUrl`, an https trello.com address only. */
export const isTrelloLink = (value: string): boolean => {
  if (value.length > IMPORT_LINK_MAX) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "trello.com" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
};

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
/** A real calendar day in 1970–2100, as `YYYY-MM-DD`. */
export const isImportDay = (value: string): boolean => {
  const m = ISO_DAY.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1970 || y > 2100) return false;
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
};

/** NUL and lone surrogates — what Postgres refuses to store (`normalize.ts`'s set). */
const UNSTORABLE = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
/**
 * A string as the database can hold it. Applied on the SERVER to every text
 * a row carries, whatever the browser did: one lone surrogate (a cut through
 * an emoji) would otherwise refuse the whole batch (the code review).
 */
export const storable = (s: string): string => s.replace(UNSTORABLE, "");

/**
 * C0/C1 controls and the bidi overrides and isolates — kept out of a file
 * NAME, which members read in a list (the security review's nit).
 */
const isNameControl = (code: number): boolean =>
  code <= 0x1f || (code >= 0x7f && code <= 0x9f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
const withoutNameControls = (s: string): string =>
  Array.from(s)
    .filter((ch) => !isNameControl(ch.codePointAt(0)!))
    .join("");

const trimmed = (max: number) => z.string().transform((s) => storable(s).trim()).pipe(z.string().max(max));

/**
 * ONE ROW AS THE SERVER RECEIVES IT — plain values, never a document (the
 * description is built on the server: design §2.4). Every field is checked
 * again on the server whatever the browser claims (R1).
 */
export const importRowSchema = z
  .object({
    sourceId: trimmed(IMPORT_SOURCE_ID_MAX).pipe(z.string().min(1)).nullable(),
    title: trimmed(MAX_TITLE_LENGTH).pipe(z.string().min(1)),
    text: z.string().max(IMPORT_TEXT_MAX).transform(storable),
    checklists: z
      .array(
        z.object({
          name: trimmed(IMPORT_CHECKLIST_NAME_MAX).nullable(),
          items: z.array(z.object({ text: trimmed(IMPORT_CHECKLIST_ITEM_MAX), done: z.boolean() })),
        }),
      )
      .max(IMPORT_CHECKLISTS_MAX),
    link: z.string().transform(storable).refine(isTrelloLink).nullable(),
    stateId: z.uuid(),
    targetDate: z.string().refine(isImportDay).nullable(),
    assigneeMemberId: z.uuid().nullable(),
    labels: z.array(trimmed(MAX_LABEL_NAME_LENGTH).pipe(z.string().min(1))).max(IMPORT_LABELS_MAX),
  })
  .strict()
  .refine((r) => r.checklists.reduce((n, c) => n + c.items.length, 0) <= IMPORT_CHECKLIST_ITEMS_MAX, {
    message: "too many checklist items",
  });

export type ImportRow = z.input<typeof importRowSchema>;
export type CheckedImportRow = z.output<typeof importRowSchema>;

export const importBatchSchema = z.array(importRowSchema).min(1).max(IMPORT_BATCH_ROWS);

export const startImportSchema = z
  .object({
    projectId: z.uuid(),
    source: z.enum(IMPORT_SOURCES),
    fileName: z
      .string()
      .transform((s) => withoutNameControls(storable(s)).trim())
      .pipe(z.string().min(1).max(IMPORT_FILE_NAME_MAX)),
    rowCount: z.number().int().min(1).max(IMPORT_MAX_ROWS),
  })
  .strict();

/**
 * The stamps a task BORN in a category gets — exactly what
 * `transitionState` writes for a row arriving there from the default state
 * with no stamps of its own (`states.ts`): IN_PROGRESS stamps `startedAt`,
 * DONE stamps `completedAt`, every other category neither.
 */
export const stampsOnBirth = (
  category: "TRIAGE" | "BACKLOG" | "TODO" | "IN_PROGRESS" | "DONE" | "CANCELLED",
  now: Date,
): { startedAt: Date | null; completedAt: Date | null } => ({
  startedAt: category === "IN_PROGRESS" ? now : null,
  completedAt: category === "DONE" ? now : null,
});

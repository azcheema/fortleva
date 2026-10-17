import { normalizeDescription, type NormalizedDescription } from "@/lib/rich-text/normalize";

import { cleanCell } from "./import/csv-parse";
import { textBlocks } from "./import/description-doc";

/**
 * THE "NEW TASK" FORM'S DESCRIPTION (slice 129, founder decision C106 (c)):
 * the plain text typed in the form's box becomes a task description HERE, on
 * the server — paragraphs, `#` headings, lists, `- [ ]` checklist lines and
 * links, the import's own reading (`textBlocks`, slice 121) — and passes the
 * one gate every description passes (`normalizeDescription`). The browser
 * never sends a document, so the ProseMirror-across-actions trap cannot
 * apply, and characters the database cannot store are removed first, as an
 * imported cell's are (`cleanCell`).
 *
 * Null when the text says nothing. A text past the gate's bounds is refused
 * by the gate (`DESCRIPTION_TOO_LARGE`), never cut short.
 */
export function descriptionFromText(text: string): NormalizedDescription | null {
  const blocks = textBlocks(cleanCell(text));
  if (blocks.length === 0) return null;
  const n = normalizeDescription({ type: "doc", content: blocks });
  return n.doc === null ? null : n;
}

/**
 * THE BIN's RULES (slice 126, founder decision C102) — pure, so the page,
 * the service and a unit test read one answer.
 *
 * A deleted task stays in its project's bin for 30 days (C102 (a)); after
 * that it leaves the bin and can no longer be brought back, but the row is
 * KEPT (C102 (c)) — erasing old deleted tasks is its own later piece.
 */

const DAY_MS = 86_400_000;

/** How long a deleted task can be brought back. */
export const BIN_DAYS = 30;

/** At most this many rows on the page, newest first (a line says when there are more). */
export const BIN_PAGE_SIZE = 200;

/** The earliest deletion still in the bin at `now`. */
export const binSince = (now: Date): Date => new Date(now.getTime() - BIN_DAYS * DAY_MS);

/** Whether a task deleted at `deletedAt` can still be brought back at `now`. */
export const binOpen = (deletedAt: Date, now: Date): boolean => deletedAt.getTime() >= binSince(now).getTime();

/** Why a row's Bring back is drawn disabled — null when it can be pressed. */
export type BinBlock =
  | { readonly reason: "archived" }
  | { readonly reason: "parent_in_bin"; readonly parentNumber: number }
  | { readonly reason: "parent_from_import" }
  | { readonly reason: "parent_gone" }
  | { readonly reason: "source_twin" };

/**
 * The row's answer, in the service's own order of refusals: an archived
 * project first, then a parent that is deleted too — removed by undoing an
 * import whose own Bring back is still open (it comes back from the
 * import's row, not from here), still in the bin (bring that back first),
 * or out of it (it can no longer come back, so neither can this one) — and
 * last, a task imported from the same card that is live in the project now
 * (one live task per card, the import's partial unique index).
 */
export function binBlock(
  row: {
    readonly parent: {
      readonly number: number;
      readonly deletedAt: Date | null;
      /** Its newest deletion is an import's undo, and that import can still be brought back. */
      readonly fromImport: boolean;
    } | null;
    /** A live task of the project was imported from the same card. */
    readonly hasTwin: boolean;
  },
  projectArchived: boolean,
  now: Date,
): BinBlock | null {
  if (projectArchived) return { reason: "archived" };
  const parent = row.parent;
  if (parent !== null && parent.deletedAt !== null) {
    if (!binOpen(parent.deletedAt, now)) return { reason: "parent_gone" };
    return parent.fromImport ? { reason: "parent_from_import" } : { reason: "parent_in_bin", parentNumber: parent.number };
  }
  return row.hasTwin ? { reason: "source_twin" } : null;
}

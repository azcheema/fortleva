/**
 * Element ids the bookkeeping page and its client parts share — in a plain
 * module, never a "use client" one: a client module's export read by the
 * server page would be a client reference, not a string (AGENTS.md).
 */

/** The newest file's List link — where focus goes once Book the year end has unmounted its own trigger. */
export const NEWEST_FILE_LINK_ID = "bookkeeping-newest-list";

/** The "Waiting for you" card's body (slice 114c) — where focus goes once a decided entry's row is gone. */
export const NEEDS_YOU_BODY_ID = "bookkeeping-needs-you";

/** A Fortnox file's "Not sent (SIE)" link (slice 114c) — where focus goes once its hand-over has unmounted its button. */
export const unsentLinkId = (exportId: string): string => `bookkeeping-unsent-${exportId}`;

/**
 * Where focus goes when the control that had it is gone: the first of these
 * ids that is on the page, else nothing is touched. Never `<body>` while
 * something better exists (AGENTS.md's Radix trap).
 */
export function focusFirst(ids: readonly string[], opts: { readonly preventScroll?: boolean } = {}): void {
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) {
      el.focus({ preventScroll: opts.preventScroll === true });
      return;
    }
  }
}

import type { FortnoxFileState } from "@/modules/invoicing";

/** The words a Fortnox file's line is made of (the page's `files.state.*`). */
export type FileLineWords = {
  readonly waiting: () => string;
  readonly sending: (booked: number, vouchers: number) => string;
  readonly done: (series: string, numbers: string) => string;
  readonly byHand: (count: number) => string;
  readonly downloaded: (count: number) => string;
  readonly notSent: (count: number) => string;
  readonly pdfs: (count: number) => string;
};

/**
 * Where a Fortnox file's vouchers stand, in a line (slice 114b; slice 114c
 * made it whole — its code review's NIT: a file all booked by hand read "In
 * Fortnox:" with no numbers). While its connection still sends and something
 * waits: waiting, or sending k of n. Otherwise every part that is true, in
 * order — Fortnox's numbers, booked by hand, handed over in a file, not sent
 * (a disconnect), PDFs still to attach. Null for a file that books nothing.
 */
export function fortnoxFileLine(s: FortnoxFileState, w: FileLineWords): string | null {
  if (s.vouchers === 0) return null;
  if (s.waiting > 0 && s.live) return s.booked === 0 ? w.waiting() : w.sending(s.booked, s.vouchers);
  const parts: string[] = [];
  if (s.from !== null && s.to !== null) parts.push(w.done(s.series ?? "", s.from === s.to ? String(s.from) : `${s.from}–${s.to}`));
  if (s.byHand > 0) parts.push(w.byHand(s.byHand));
  if (s.downloaded > 0) parts.push(w.downloaded(s.downloaded));
  if (s.waiting > 0) parts.push(w.notSent(s.waiting));
  if (s.pdfsOwed > 0) parts.push(w.pdfs(s.pdfsOwed));
  return parts.length > 0 ? parts.join(" · ") : null;
}

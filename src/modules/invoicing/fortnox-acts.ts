/**
 * WHAT A PERSON MAY DECIDE ABOUT AN ENTRY OWED TO FORTNOX (Phase 4 slice
 * 114c; founder decision C90) — pure, so `fortnox-acts.test.ts` pins it; the
 * Bookkeeping page offers exactly these and `fortnox-people.ts` refuses
 * anything else. The database's delivery guard is wider (it would let a
 * person book ANY queued entry by hand while connected); this narrows it to
 * the entries a person should decide (`fortnox-people.ts`' header).
 */

export type FortnoxAct = "BY_HAND" | "NOT_IN_FORTNOX";

export type DeliveryFacts = {
  readonly state: string;
  readonly entryId: string;
  readonly connStatus: string;
  /** The entry the connection's stop names (BROKEN only). */
  readonly stoppedAt: string | null;
  /** A BOOKED voucher whose PDFs are owed past their day. */
  readonly overdue: boolean;
};

export function actsFor(d: DeliveryFacts): FortnoxAct[] {
  if (d.connStatus === "DISCONNECTED") {
    if (d.state === "QUEUED" || d.state === "BOOKED") return ["BY_HAND"];
    if (d.state === "SENDING") return ["BY_HAND", "NOT_IN_FORTNOX"];
    return [];
  }
  if (d.state === "QUEUED" && d.connStatus === "BROKEN" && d.stoppedAt !== null && d.stoppedAt === d.entryId) return ["BY_HAND"];
  if (d.state === "BOOKED" && d.overdue) return ["BY_HAND"];
  return [];
}

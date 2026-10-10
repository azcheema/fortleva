import { dbErrorMapper } from "@/lib/db-error-map";

/**
 * The invoice guards' tokens (migration 20261009120000) a member can reach
 * through a service. Every draft verb locks its invoice `FOR UPDATE` and
 * re-reads its status first, so these are the belt catching a race — an
 * invoice issued (slice 108) between a page's render and a write — worth a
 * sentence rather than a stack.
 *
 * Unmapped on purpose, so they surface as bugs: `INVOICE_GUARD` (a write no
 * service makes — a draft's client changed, a line moved between invoices,
 * a member acting as someone else) and `TENANT_INVOICE_DETAILS_GUARD` (the
 * company or payment details written by anything but `seller.ts`'s two
 * protected writes, which check `settings:edit` first).
 */
export const { mapDbError, guarded } = dbErrorMapper([
  ["INVOICE_NOT_DRAFT", "INVOICE_NOT_DRAFT"],
  ["INVOICE_RATE_NOT_ALLOWED", "INVOICE_RATE_NOT_ALLOWED"],
  // Slice 108: the issue guard's own "something an invoice must carry is
  // missing" — the service checks the same list first (`checkIssue`), so
  // these are the belt for a detail changed between that read and the write.
  ["INVOICE_NO_SERIES", "INVOICE_NOT_READY"],
  ["INVOICE_SELLER_INCOMPLETE", "INVOICE_NOT_READY"],
  ["INVOICE_BUYER_INCOMPLETE", "INVOICE_NOT_READY"],
  // A first number changed after an issue took one (a race with the read).
  ["INVOICE_SERIES_IN_USE", "INVOICE_SERIES_IN_USE"],
  // Slice 108b: a credit note's invoice credited in full (or never issued) —
  // the service checks first, under the original's lock; and the over-credit
  // rule, which `checkCreditIssue` names rate by rate before the guard does.
  ["INVOICE_NOT_CREDITABLE", "INVOICE_NOT_CREDITABLE"],
  ["INVOICE_OVER_CREDIT", "INVOICE_NOT_READY"],
  // Slice 109: a first send recorded twice (two "Mark as sent" at once — the
  // service checks under the invoice's lock first). `INVOICE_DELIVERY_GUARD`
  // stays unmapped: a send's record written by anything but `send.ts`.
  ["INVOICE_ALREADY_SENT", "INVOICE_ALREADY_SENT"],
  // Slice 110 (migration 20261010180000): an hour taken, changed or marked
  // between the page's read and the write — every hours verb locks and
  // re-checks first, so these are the belt. `INVOICE_HOURS_MISMATCH` is the
  // issue's: the record and the marks disagree (`checkIssue` names it first).
  // (Never a token containing another: `HOURS_CHANGED` would match inside it.)
  // `INVOICE_HOURS_GUARD` and `TIME_BILLING_GUARD` stay unmapped: a write no
  // service makes.
  ["HOURS_CHANGED", "HOURS_CHANGED"],
  ["INVOICE_HOURS_KEPT", "INVOICE_HOURS_KEPT"],
  ["INVOICE_HAS_HOURS", "INVOICE_HAS_HOURS"],
  ["INVOICE_HOURS_MISMATCH", "INVOICE_NOT_READY"],
  // Slice 111b (migration 20261011090100): an invoice or credit note leaving
  // DRAFT dated on or before a booked year end — reachable through the issue
  // (a workspace's time zone changed across the year turn), so a sentence,
  // not a stack (its design re-check's NIT).
  ["INVOICE_CLOSED_YEAR_GUARD", "INVOICE_YEAR_CLOSED"],
]);

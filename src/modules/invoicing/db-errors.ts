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
]);

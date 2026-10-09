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
]);

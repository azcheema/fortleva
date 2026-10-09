/**
 * The mail every OWNER gets when an invoice is ISSUED WITH A PAY NOW LINK
 * (Phase 4 slice 109; founder decision C79 (g)). The link sends the client's
 * money to whichever Stripe or PayPal account made it, and the
 * Stripe-or-PayPal fence cannot tell whose that is — so, like a change of the
 * bank details (`invoice-details-mail-key.ts`), it is a SECURITY NOTICE: it
 * goes whatever the owner's email level, enqueued straight into the outbox by
 * `src/modules/invoicing/issue.ts` in the issue's own transaction. A LINK,
 * never data (ARC-09): neither the payment link nor the amount is in it; the
 * invoice's page it opens shows both and who issued it.
 *
 * It carries NO `Reply-To` (`MAIL_WITHOUT_REPLY_TO`): a security notice to the
 * workspace's own people.
 */
export const INVOICE_PAY_LINK_ISSUED_MAIL = "invoice.pay_link_issued" as const;

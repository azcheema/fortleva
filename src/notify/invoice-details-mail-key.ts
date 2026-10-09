/**
 * The mail every OWNER gets when what the workspace's INVOICES SAY ABOUT IT
 * changes — the company details (legal name, org. number, VAT number,
 * registered office, F-tax, address), the Bankgiro, PlusGiro, IBAN or BIC, or
 * the note printed on every invoice (Phase 4 slice 107; founder decisions
 * C75 (h), (i), (j)). A template key, not a notification kind, enqueued
 * straight into the outbox by `src/modules/invoicing/seller.ts`, for the
 * reason the reply-address notice is (`reply-address-mail-key.ts`): it is a
 * SECURITY NOTICE — any of these could tell a client to pay someone else,
 * which is how invoice fraud works, and an admin must not change them quietly
 * — so it goes whatever the owner's email level. A LINK, never data (ARC-09):
 * nothing of the details is in it; the settings page it opens says what they
 * are now, who changed them and when.
 *
 * It carries NO `Reply-To` (`MAIL_WITHOUT_REPLY_TO`): a security notice to the
 * workspace's own people.
 */
export const INVOICE_DETAILS_CHANGED_MAIL = "workspace.invoice_details_changed" as const;

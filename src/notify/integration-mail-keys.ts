/**
 * The mails every OWNER gets when the workspace is CONNECTED TO, or
 * DISCONNECTED FROM, its Fortnox company (Phase 4 slice 114; founder decision
 * C89 (d)). The connection decides where every client's invoices are booked,
 * so — like a change of the bank details (`invoice-details-mail-key.ts`) —
 * each is a SECURITY NOTICE: it goes whatever the owner's email level,
 * enqueued straight into the outbox by
 * `src/modules/invoicing/fortnox-connection.ts` in the act's own transaction.
 * A LINK, never data (ARC-09): neither the company nor its org. number is in
 * it; the Fortnox card it opens says which company, who and when.
 *
 * Neither carries a `Reply-To` (`MAIL_WITHOUT_REPLY_TO`): a security notice to
 * the workspace's own people.
 */
export const INTEGRATION_CONNECTED_MAIL = "integration.fortnox_connected" as const;
export const INTEGRATION_DISCONNECTED_MAIL = "integration.fortnox_disconnected" as const;
export const INTEGRATION_MAIL_KEYS = [INTEGRATION_CONNECTED_MAIL, INTEGRATION_DISCONNECTED_MAIL] as const;

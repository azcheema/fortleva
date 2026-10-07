/**
 * The mail every OWNER gets when a new reply address is confirmed (Phase 5
 * slice 100; founder decision C68 (i)) — a template key, not a notification
 * kind, enqueued straight into the outbox by `confirmReplyAddress`
 * (`reply-address.ts`), for the reason the vault's export notice is
 * (`vault-export-mail-key.ts`): it is a SECURITY NOTICE — an admin must not
 * quietly redirect clients' replies, which can carry passwords — so it goes
 * whatever the owner's email level. A LINK, never data (ARC-09): the address
 * is not in it; the settings page it opens shows where replies go now.
 *
 * It carries NO `Reply-To` (`MAIL_WITHOUT_REPLY_TO`): a reply to it would go
 * to the very address it is warning about.
 */
export const REPLY_ADDRESS_CHANGED_MAIL = "workspace.reply_address_changed" as const;

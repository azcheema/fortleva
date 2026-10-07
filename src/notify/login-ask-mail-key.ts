/**
 * The one mail the contact the agency asks for a login gets (Phase 3V
 * slice 98; founder decision C66 (b)) — a template key, not a notification
 * kind: a contact has no inbox and no email level, so it is enqueued
 * straight into the outbox by the vault (`src/modules/vault/asks.ts`), in
 * the ask's own transaction, as the sealed asks' mail to a client's main
 * contacts is (`sealed-mail-keys.ts`). At most one per person per 12 hours
 * (`ASK_MAIL_EVERY_HOURS` — later asks wait in their portal), no reminders.
 *
 * A LINK, never data (ARC-09): it names neither the agency's member, nor
 * what was asked, nor the client — the portal page it opens says what the
 * agency needs, to the one person signed in who was asked. It says, too,
 * that a password is never sent by email: the point of the ask is that it
 * is not.
 */
export const LOGIN_ASK_MAIL = "portal.login_asked" as const;

/**
 * The mail every holder of `credential:export` gets when somebody exports
 * logins (Phase 3V slice 95; founder decision C63 (b)) — a template key,
 * not a notification kind, enqueued straight into the outbox by the vault
 * (`src/modules/vault/export.ts`), for the reason the sealed asks' mails
 * are (`sealed-mail-keys.ts`): it is a SECURITY NOTICE about the
 * workspace's own secrets, so it goes whatever the reader's email level,
 * the exporter included — the person whose account was used learns of it.
 * A LINK, never data (ARC-09): no name, count or client is in it; the page
 * it opens says who exported what, and when.
 */
export const VAULT_EXPORTED_MAIL = "vault.exported" as const;

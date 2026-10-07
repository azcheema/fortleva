/**
 * The two mails of the client's door's ALARM (Phase 3V slice 99; founder
 * decision C67 (b), (c)) — template keys, not notification kinds, enqueued
 * straight into the outbox by the vault (`src/modules/vault/door-alarm.ts`)
 * in the alarm's own transaction, as the export's notice
 * (`vault-export-mail-key.ts`) and the sealed asks' mails
 * (`sealed-mail-keys.ts`) are:
 *
 *   - `DOOR_ALARM_MEMBER_MAIL`, to every owner: a SECURITY NOTICE, so it
 *     goes whatever their email level (the inbox row beside it is the
 *     `contact.logins_alarm` kind, which mails nothing itself, so nobody
 *     gets two). It opens the client's Contacts tab, where that person's
 *     access can be paused.
 *   - `DOOR_ALARM_CONTACT_MAIL`, to the client person whose portal account
 *     it was: if this wasn't you, change your password — it opens the
 *     portal's "forgot your password" page, and a reset signs every other
 *     session out (`revokeSessionsOnPasswordReset`).
 *
 * LINKS, never data (ARC-09): neither names the client, the person, the
 * logins or what was typed; the owners' link carries the client's id only.
 */
export const DOOR_ALARM_MEMBER_MAIL = "vault.door_alarm" as const;
export const DOOR_ALARM_CONTACT_MAIL = "portal.logins_alarm" as const;
export const DOOR_ALARM_MAIL_KEYS = [DOOR_ALARM_MEMBER_MAIL, DOOR_ALARM_CONTACT_MAIL] as const;

/**
 * The mails of a client's ask to open their SEALED logins (Phase 3V slice
 * 93; founder decisions C52 (f)–(h), C61) — template keys, not notification
 * kinds (`templates.ts` says why the two part company): they are enqueued
 * straight into the outbox by the vault (`src/modules/vault/sealed-mail.ts`),
 * with no inbox row behind them.
 *
 * WHY NOT THROUGH `notify.emit`: emit honours each receiver's email level,
 * and a member who turned email down to NONE would never hear that a
 * client asked — while the wait ran out and the logins opened. These are
 * SECURITY NOTICES about the workspace's own secrets (C52 (f): "every owner
 * is emailed"), so they go to every answerer whatever their level, as a
 * sign-in alert would. The receivers are few (the holders of
 * `credential:unseal`, and the client's main contacts), and every mail is
 * a LINK, never data (ARC-09): no client, login or reason is named in one.
 */
export const SEALED_MEMBER_MAIL = {
  /** Day 0: a client asked. */
  asked: "vault.sealed_open_asked",
  /** Day 3, 6, then daily while the wait still runs: still unanswered. */
  reminder: "vault.sealed_open_reminder",
  /** Daily once the wait has run with no answer: the client can confirm it now (the code review's low — the waiting reminder's words were wrong by then). */
  confirmable: "vault.sealed_open_confirmable",
  /** Daily during the 48 hours after the client confirmed: it opens soon unless someone denies it. */
  opening: "vault.sealed_open_opening",
  /** The client confirmed after the silent wait: it opens in 48 hours unless denied. */
  confirmed: "vault.sealed_open_confirmed",
  /** It opened (approved, or the 48 hours ran out): change those passwords afterwards (C52 (h)). */
  opened: "vault.sealed_opened",
} as const;

/** To the client's main contacts: there is news — the page says which. */
export const SEALED_CONTACT_MAIL = "portal.sealed_open_news" as const;

export const SEALED_MAIL_KEYS = [...Object.values(SEALED_MEMBER_MAIL), SEALED_CONTACT_MAIL] as const;

export type SealedMemberMail = (typeof SEALED_MEMBER_MAIL)[keyof typeof SEALED_MEMBER_MAIL];
export type SealedMailKey = (typeof SEALED_MAIL_KEYS)[number];

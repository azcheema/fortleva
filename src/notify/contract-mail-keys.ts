/**
 * The two mails a client's SIGNER gets about a contract (Phase 4 slice 112b2;
 * founder decision C85 (b), (d)) — template keys, not notification kinds: a
 * contact has no inbox and no email level, so each is enqueued straight into
 * the outbox by the contracts module (`src/modules/contracts/mail.ts`), as the
 * login ask's mail is (`login-ask-mail-key.ts`):
 *   - SENT: the agency sent them a contract to sign — in the send's own
 *     transaction, so it exists exactly when the sent contract does;
 *   - SIGNED: it is signed, and the signed copy is in their portal — by the
 *     announcer after the signature committed (C85 (b): in the portal, with an
 *     email linking there; nothing attached).
 * No reminder (C85 (d)) and nothing on a withdrawal: the portal says it.
 *
 * LINKS, NEVER DATA (ARC-09): neither names the agency's member, the contract,
 * its title or the client — the portal page each opens says all of it, to the
 * one person signed in who may read it. Each carries the workspace's Reply-To:
 * a question about a contract is a reply worth getting.
 */
export const CONTRACT_SENT_MAIL = "portal.contract_sent" as const;
export const CONTRACT_SIGNED_MAIL = "portal.contract_signed" as const;

export const CONTRACT_MAIL_KEYS = [CONTRACT_SENT_MAIL, CONTRACT_SIGNED_MAIL] as const;

import { z } from "zod";

import type { TenantDb } from "@/db";

import { INVOICE_DETAILS_CHANGED_MAIL } from "./invoice-details-mail-key";
import { DOOR_ALARM_MEMBER_MAIL } from "./door-alarm-mail-keys";
import { REPLY_ADDRESS_CHANGED_MAIL } from "./reply-address-mail-key";
import { SEALED_MEMBER_MAIL } from "./sealed-mail-keys";
import { VAULT_EXPORTED_MAIL } from "./vault-export-mail-key";

/**
 * WHERE A REPLY GOES — the READ half (Phase 5 slice 100; founder decision
 * C68 (c)), on its own so the mail senders can import it — the auth plane's
 * portal reset among them — without pulling in the request/confirm service
 * (`reply-address.ts`) and everything IT imports. Nothing here but a type
 * import from `@/db` and two reads inside the caller's transaction.
 */

export const REPLY_TO_KEY = "mail.replyTo";
export const REPLY_TO_PENDING_KEY = "mail.replyToPending";

/**
 * OUTBOX mail that carries NO `Reply-To` although a workspace sends it: the
 * SECURITY NOTICES to its own members, where a reply would go to the
 * workspace's reply address — which an admin may set, and which the
 * reply-address notice is warning about. A member answering "this wasn't me"
 * must not be answering the person it might have been. Every security-notice
 * key in `src/notify` is here (`reply-address-resolve.test.ts` pins the list;
 * the security review found the sealed asks' notices missing from it).
 *
 * AND FOUR DIRECT SENDS NEVER RESOLVE ONE AT ALL (founder decision C68 (j)) —
 * the mails that carry a client's LIVE link or code: the portal password reset
 * (`src/auth/portal.ts`), the portal invitation (`src/clients/contact-access.ts`),
 * the codes that open a client's logins (`src/modules/vault/portal-writes.ts`)
 * and a share link's code (`src/modules/vault/share-open.ts`). A client who
 * replies "I didn't ask for this" usually quotes the link, and whoever reads
 * the agency's mailbox could then set the client's password and act as them
 * (the security review's medium). Pinned by the same test: none of the four
 * imports this module.
 */
export const MAIL_WITHOUT_REPLY_TO: ReadonlySet<string> = new Set([
  REPLY_ADDRESS_CHANGED_MAIL,
  INVOICE_DETAILS_CHANGED_MAIL,
  VAULT_EXPORTED_MAIL,
  DOOR_ALARM_MEMBER_MAIL,
  ...Object.values(SEALED_MEMBER_MAIL),
]);

const confirmedShape = z.object({
  email: z.string(),
  confirmedAt: z.string(),
  requestedByMemberId: z.string().nullable(),
});

export type ConfirmedReplyAddress = z.infer<typeof confirmedShape>;

export const parseConfirmedReplyAddress = (raw: unknown): ConfirmedReplyAddress | null => {
  const parsed = confirmedShape.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

/** The earliest-made ACTIVE member holding the system owner role, or null. */
export async function ownerReplyAddress(tx: TenantDb, tenantId: string): Promise<string | null> {
  const owner = await tx.member.findFirst({
    where: {
      tenantId,
      status: "ACTIVE",
      memberRoles: { some: { role: { isSystem: true, templateKey: "owner" } } },
    },
    // Member ids are UUIDv7: id order is the order they were made.
    orderBy: { id: "asc" },
    select: { user: { select: { email: true } } },
  });
  return owner?.user.email ? owner.user.email.toLowerCase() : null;
}

/**
 * The `Reply-To` of a mail this workspace sends: its confirmed address, else
 * its owner's (C68 (c): "the owner's email until one is set"), else none. Read
 * inside a transaction the caller already holds — a system one in the outbox
 * and the portal's mails, the member's own at an invitation. Two reads in
 * SEQUENCE: never make this a leg of a `Promise.all` (AGENTS.md).
 */
export async function resolveReplyAddress(tx: TenantDb, tenantId: string): Promise<string | null> {
  const row = await tx.tenantPreference.findFirst({
    where: { tenantId, key: REPLY_TO_KEY },
    select: { value: true },
  });
  const confirmed = parseConfirmedReplyAddress(row?.value);
  if (confirmed) return confirmed.email;
  return ownerReplyAddress(tx, tenantId);
}

import { record } from "@/audit/record";
import { withTenant, type TenantDb } from "@/db";

import { readClientSummaryToken } from "./client-summary-token";

/**
 * A CLIENT PERSON STOPS — OR STARTS AGAIN — THEIR OWN WEEKLY SUMMARY (Phase 5
 * slice 101; founder decision C69; RFC 8058).
 *
 * Two doors, one service: the mail's `List-Unsubscribe` header, which a
 * mailbox provider POSTs to with no person in front of it
 * (`/api/client-summary/unsubscribe/<token>`), and the link in the mail's
 * body, whose page asks first (`/portal/unsubscribe/<token>`). Both carry the
 * stateless token (`client-summary-token.ts`); neither has a session, so the
 * workspace comes from the token and everything runs under that workspace's
 * SYSTEM principal — the reply-address confirmation's shape.
 *
 * THE SETTING is the person's own `NotificationPreference` row
 * (`receiverType CONTACT`): `digestCadence = NONE` means stopped; no row, or
 * any other cadence, means the summary goes. No column, no migration.
 *
 * IDEMPOTENT, by the RFC's demand and the plan's non-negotiable test: a
 * second stop changes nothing and records nothing. Serialised per person by
 * an advisory lock, so a provider's POST and the person's own press at once
 * cannot both create the row and fail one on the unique key.
 *
 * NOBODY AT THE AGENCY CAN START IT AGAIN for a person who stopped it — no
 * member surface writes this row, by design (C69): an unsubscribe the sender
 * can quietly undo is not one. And so STARTING needs more than the link
 * (slice 101's design review): the summary carries the agency's reply
 * address (C68 (c)), so a person who replies "please stop these" quotes
 * their link into a mailbox the agency reads. Stopping stays one click —
 * whoever holds the link can only ever stop mail to its owner — but starting
 * again asks that the presser be signed in to the portal AS that person. The
 * workspace's own switch (`mail.clientSummary`) can only stop everyone's.
 */

export type ClientSummaryLink = {
  /** Whether this person's summary goes today. */
  readonly on: boolean;
};

/** Which door a change came through — the audit row's only metadata. */
export type ClientSummaryDoor = "one_click" | "page";

const isStopped = (cadence: string | undefined): boolean => cadence === "NONE";

/** The person the token names, if they still exist in that workspace. */
async function personOf(tx: TenantDb, tenantId: string, contactId: string): Promise<boolean> {
  // ANY status: a paused or removed person may still want their mail to
  // stop (no summary reaches them meanwhile, but the page must not say
  // their link is broken). Only a deleted one is gone.
  const found = await tx.contact.findFirst({ where: { tenantId, id: contactId }, select: { id: true } });
  return found !== null;
}

async function cadenceOf(tx: TenantDb, tenantId: string, contactId: string): Promise<string | undefined> {
  const row = await tx.notificationPreference.findFirst({
    where: { tenantId, receiverType: "CONTACT", receiverId: contactId },
    select: { digestCadence: true },
  });
  return row?.digestCadence;
}

/**
 * The page's read: is this link good, and is the summary on? Null for every
 * bad token and for a person who no longer exists — one answer for all.
 * Writes nothing (a mail scanner opens every link).
 */
export async function readClientSummaryLink(token: unknown): Promise<ClientSummaryLink | null> {
  const who = readClientSummaryToken(token);
  if (!who) return null;
  return withTenant(who.tenantId, { type: "system" }, async (tx) => {
    if (!(await personOf(tx, who.tenantId, who.contactId))) return null;
    return { on: !isStopped(await cadenceOf(tx, who.tenantId, who.contactId)) };
  });
}

/**
 * Stop (`on = false`) or start again (`on = true`) the summary of the person
 * the token names. "dead" for every bad token and a person who no longer
 * exists; "signIn" for a start by anybody not signed in to the portal as that
 * person (`signedInAs`: the portal session's contact id, or null — the caller
 * reads it from the session, never from a form); "done" otherwise —
 * including when it already was so, which writes and records nothing.
 */
export async function setClientSummary(
  token: unknown,
  on: boolean,
  door: ClientSummaryDoor,
  signedInAs: string | null = null,
): Promise<"done" | "dead" | "signIn"> {
  const who = readClientSummaryToken(token);
  if (!who) return "dead";
  const { tenantId, contactId } = who;
  if (on && signedInAs !== contactId) return "signIn";
  return withTenant(tenantId, { type: "system" }, async (tx) => {
    if (!(await personOf(tx, tenantId, contactId))) return "dead" as const;
    // `$executeRaw`: the lock returns `void`, which `$queryRaw` cannot read.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`client_summary:${tenantId}:${contactId}`}))`;
    const cadence = await cadenceOf(tx, tenantId, contactId);
    if (isStopped(cadence) === !on) return "done" as const;
    const digestCadence = on ? "WEEKLY" : "NONE";
    if (cadence === undefined) {
      await tx.notificationPreference.create({
        data: { tenantId, receiverType: "CONTACT", receiverId: contactId, digestCadence },
        select: { id: true },
      });
    } else {
      await tx.notificationPreference.updateMany({
        where: { tenantId, receiverType: "CONTACT", receiverId: contactId },
        data: { digestCadence },
      });
    }
    await record(tx, {
      action: on ? "contact.summary_started" : "contact.summary_stopped",
      targetType: "Contact",
      targetId: contactId,
      // A start is the person's own act, proven by their portal session —
      // said, so the log does not read it like a stop by whoever held the
      // link (the security review's nit). The actor stays SYSTEM: naming a
      // contact as actor is the brokers' seam, and this is not one.
      metadata: on ? { via: door, signedInAsThePerson: true } : { via: door },
    });
    return "done" as const;
  });
}

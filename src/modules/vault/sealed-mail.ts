import { resolveScope } from "@/authz/authorize";
import type { TenantDb } from "@/db";
import { SEALED_CONTACT_MAIL, type SealedMemberMail } from "@/notify/sealed-mail-keys";

import { anchorInScope } from "./scope";

/**
 * WHO HEARS ABOUT A CLIENT'S SEALED ASK, AND THE MAILS THEMSELVES (Phase 3V
 * slice 93; founder decisions C52 (f)–(h), C61 (f)).
 *
 * THE ANSWERERS (C61 (f): the answer follows the roles): every ACTIVE
 * member who holds `credential:unseal` — owners by default — and whose
 * scope reaches the client (a member of a custom role kept to some clients
 * hears about those clients only, as every vault surface scopes). The
 * permission is read as gate 4 with the second factor set aside: the code
 * is ✦, and a person is told about a request whether or not they stepped
 * up in the last fifteen minutes — they will when they act. Gates 1–3 (the
 * vault module open) are the CALLER's: a member's answer has just passed
 * `requireAccess`, and every SYSTEM caller asks `moduleOpenUnderSystem`
 * first — with the module closed nobody could act on the mail.
 *
 * THE CLIENT'S PEOPLE: the client's ACTIVE, invited MAIN contacts (C61
 * (e)) — the people who may ask, confirm and see.
 *
 * THE MAILS go straight into the outbox (template keys, not notification
 * kinds — `sealed-mail-keys.ts` says why: security notices, whatever the
 * reader's email level), in the caller's transaction, so a mail exists
 * exactly when the act it reports committed. Idempotent by key: the same
 * event for the same person is enqueued once. Each carries the ask's id
 * and nothing else (ARC-09: links, not data). Nothing here logs.
 */

export type Receiver = {
  readonly receiverType: "MEMBER" | "CONTACT";
  readonly receiverId: string;
  readonly email: string;
  readonly locale: "en" | "sv";
};

const localeOf = (raw: string | null | undefined, fallback: string): "en" | "sv" =>
  (raw ?? fallback) === "sv" ? "sv" : "en";

/**
 * The members who may answer an ask of this client — see the file's
 * comment. ONE read finds the holders of the code (an ACTIVE member with a
 * role granting it, not revoked — `effectivePermissions`' own reading, and
 * the guard's), then each holder's scope, in sequence: these run inside the
 * ask's, the answer's and the job's locked transactions, so a per-member
 * permission walk over the whole tenant would stretch the locks (the code
 * review's low).
 */
export async function answerersOf(tx: TenantDb, tenantId: string, clientId: string): Promise<Receiver[]> {
  const members = await tx.member.findMany({
    where: {
      tenantId,
      status: "ACTIVE",
      memberRoles: {
        some: {
          role: {
            rolePermissions: { some: { source: { not: "TENANT_REVOKE" }, permission: { code: "credential:unseal" } } },
          },
        },
      },
    },
    select: { id: true, user: { select: { email: true, locale: true } } },
    orderBy: { id: "asc" },
  });
  const out: Receiver[] = [];
  for (const m of members) {
    const actor = { memberId: m.id };
    const scope = await resolveScope(tx, actor);
    if (!anchorInScope(scope, { clientId, projectId: null })) continue;
    if (!m.user.email) continue;
    out.push({ receiverType: "MEMBER", receiverId: m.id, email: m.user.email.toLowerCase(), locale: localeOf(m.user.locale, "en") });
  }
  return out;
}

/** The client's active, invited main contacts, in their own language (else the workspace's). */
export async function clientPeopleOf(tx: TenantDb, tenantId: string, clientId: string): Promise<Receiver[]> {
  const tenant = await tx.tenant.findFirst({ where: { id: tenantId }, select: { defaultLocale: true } });
  const contacts = await tx.contact.findMany({
    where: {
      tenantId,
      clientId,
      portalProfile: "CONTACT_PRIMARY",
      portalStatus: "ACTIVE",
      invitedAt: { not: null },
    },
    select: { id: true, email: true, locale: true },
    orderBy: { id: "asc" },
  });
  return contacts.map((c) => ({
    receiverType: "CONTACT" as const,
    receiverId: c.id,
    email: c.email.toLowerCase(),
    locale: localeOf(c.locale, tenant?.defaultLocale ?? "en"),
  }));
}

/**
 * Enqueue one event's mail to each receiver — `memberTemplate` for the
 * members, the client's "there is news" for the contacts — keyed by the ask, the
 * event and the receiver, so the same event is mailed to a person once.
 * Suppressed addresses are left out (the worker checks again at send).
 * Answers how many were enqueued.
 */
export async function enqueueSealedMail(
  tx: TenantDb,
  tenantId: string,
  requestId: string,
  event: string,
  receivers: readonly Receiver[],
  memberTemplate?: SealedMemberMail,
): Promise<number> {
  if (receivers.length === 0) return 0;
  if (memberTemplate === undefined && receivers.some((r) => r.receiverType === "MEMBER")) {
    throw new Error("vault: a mail to the agency names its template");
  }
  const suppressed = new Set(
    (
      await tx.emailSuppression.findMany({
        where: { email: { in: receivers.map((r) => r.email) } },
        select: { email: true },
      })
    ).map((s) => s.email),
  );
  const data = receivers
    .filter((r) => !suppressed.has(r.email))
    .map((r) => ({
      tenantId,
      idempotencyKey: `sealed:${requestId}:${event}:${r.receiverType}:${r.receiverId}`,
      receiverType: r.receiverType,
      receiverId: r.receiverId,
      toEmail: r.email,
      kind: r.receiverType === "MEMBER" ? memberTemplate! : SEALED_CONTACT_MAIL,
      locale: r.locale,
      // The ask's id only — the link's; nothing about the client or a login.
      params: { requestId },
      notificationIds: [],
    }));
  if (data.length === 0) return 0;
  const { count } = await tx.emailOutbox.createMany({ data, skipDuplicates: true });
  return count;
}

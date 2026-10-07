import { resolveScope, type MemberActor } from "@/authz/authorize";
import type { TenantDb } from "@/db";
import { accessibleCodes } from "@/entitlements/resolver";

/**
 * WHAT THE DOOR'S ALARM MAY NAME IN THE INBOX (Phase 3V slice 99; founder
 * decision C67 (c)) — the inbox's subject resolution for
 * `contact.logins_alarm`, which `src/notify/inbox.ts` hands over as it does
 * the vault's other kinds (`submission-subjects.ts`).
 *
 * The entity is the CONTACT whose portal account kept failing at the door.
 * Under the READER's own principal, at read time, the row names that person
 * and their client — "Ann Andersson · Acme" — and links to the client's
 * Contacts tab, where their portal access is paused, only while the reader
 * holds `client:view` on all four gates and reaches the client by the
 * client CARD's rule (direct or lifted assignment, AUTHZ.md §4: a client's
 * card is its name and its contacts). Otherwise the row resolves to nothing
 * and the inbox draws the kind's generic label with no name and no link.
 * The receivers are the owners, who reach every client; the rule is for
 * the day that changes, and for an owner whose role was narrowed since.
 *
 * Not behind the vault's door: what it names is the client's card, not a
 * login — so, unlike the vault's other resolvers (which refuse under
 * impersonation because the door does), it answers an impersonating reader
 * as the client card would (the code review's nit: deliberate). Reads in
 * sequence on the caller's transaction (AGENTS.md's trap);
 * the permission read is ONE `accessibleCodes`, never a leg.
 */

export const DOOR_ALARM_KIND = "contact.logins_alarm";

export const isDoorAlarmKind = (kind: string): boolean => kind === DOOR_ALARM_KIND;

export type DoorAlarmRef = {
  /** The notification's id — the key of the answer. */
  readonly id: string;
  readonly kind: string;
  readonly entityType: string;
  readonly entityId: string;
};

export type DoorAlarmSubject = { readonly title: string; readonly href: string };

export async function doorAlarmSubjects(
  tx: TenantDb,
  tenantId: string,
  actor: MemberActor,
  refs: readonly DoorAlarmRef[],
): Promise<Map<string, DoorAlarmSubject>> {
  const out = new Map<string, DoorAlarmSubject>();
  const mine = refs.filter((r) => isDoorAlarmKind(r.kind) && r.entityType === "Contact");
  if (mine.length === 0) return out;
  const may = await accessibleCodes(tx, tenantId, actor, ["client:view"]);
  if (!may.has("client:view")) return out;
  const scope = await resolveScope(tx, actor);
  const reaches = (clientId: string): boolean =>
    scope.all || scope.directClientIds.includes(clientId) || scope.liftedClientIds.includes(clientId);

  const contacts = await tx.contact.findMany({
    where: { tenantId, id: { in: [...new Set(mine.map((r) => r.entityId))] } },
    select: { id: true, name: true, clientId: true, client: { select: { name: true } } },
  });
  const byContact = new Map(contacts.filter((c) => reaches(c.clientId)).map((c) => [c.id, c]));
  for (const r of mine) {
    const c = byContact.get(r.entityId);
    if (c) out.set(r.id, { title: `${c.name} · ${c.client.name}`, href: `/clients/${c.clientId}/contacts` });
  }
  return out;
}

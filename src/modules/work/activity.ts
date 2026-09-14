import type { TenantDb } from "@/db";
import { idCursor } from "@/lib/id-cursor";
import type { WorkCtx } from "./states";

/**
 * Field-level history rows (§6.14). The PORTAL-SAFE LIST is the whole
 * portal story for activity: a row is CLIENT_VISIBLE only when its
 * field is on this list AND the item is CLIENT_VISIBLE at write time —
 * the service decides, the row carries it, portal_gate enforces it.
 * Everything else (labels, estimates, priority, assigneeMemberId,
 * internal comments) is INTERNAL by construction.
 */

const PORTAL_SAFE_FIELDS: ReadonlySet<string> = new Set([
  "stateCategory",
  "title",
  "targetDate",
  "milestoneId",
  "assigneeContactId",
]);

type ItemRef = {
  readonly id: string;
  readonly clientId: string;
  readonly projectId: string;
  readonly visibility: "INTERNAL" | "CLIENT_VISIBLE";
};

export async function writeActivity(
  tx: TenantDb,
  ctx: WorkCtx,
  item: ItemRef,
  change: {
    readonly field: string;
    readonly oldValue?: string | null;
    readonly newValue?: string | null;
    readonly oldRef?: string | null;
    readonly newRef?: string | null;
    /**
     * Hold a row INTERNAL even though its field is on the list: a move
     * WITHIN a state category tells the portal nothing (it is shown
     * categories, never state names) while carrying two state ids.
     * A field that is NOT on the list is INTERNAL without this.
     */
    readonly forceInternal?: boolean;
  },
): Promise<void> {
  const portalSafe =
    !change.forceInternal &&
    PORTAL_SAFE_FIELDS.has(change.field) &&
    item.visibility === "CLIENT_VISIBLE";
  await tx.workItemActivity.create({
    data: {
      tenantId: ctx.tenantId,
      clientId: item.clientId,
      projectId: item.projectId,
      workItemId: item.id,
      actorMemberId: ctx.actor.memberId,
      field: change.field,
      oldValue: change.oldValue ?? null,
      newValue: change.newValue ?? null,
      oldRef: change.oldRef ?? null,
      newRef: change.newRef ?? null,
      visibility: portalSafe ? "CLIENT_VISIBLE" : "INTERNAL",
    },
  });
}

/**
 * THE READ (slice 8, the panel's Activity section). One page of an
 * item's history, newest first, for the member UI — never a portal
 * projection: a row carries its actor's member id and the assignee
 * refs, both on the portal-forbidden list, and the Phase 3 portal reads
 * history through `modules/work/portal.ts` with its own allow-listed
 * select, under the contact principal and `portal_gate`. FOR THAT
 * REASON THIS FUNCTION IS NOT EXPORTED FROM THE BARREL (`index.ts`) —
 * `portal-projections.test.ts` greps only `portal.ts` files for the
 * forbidden columns, so a portal module that merely CALLED this read
 * would pass it; the non-export is the belt, and `getItemDetail` is the
 * one caller.
 *
 * Keyset on the row id (UUIDv7), never on `created_at`: rows written in
 * one transaction share that stamp, so a cursor on it dropped whole
 * batches at a page boundary (the inbox, 2026-09-06). Prisma mints
 * `uuid(7)` in the client with a per-millisecond sequence, so ids
 * written in one transaction — one `updateItemFields` with three
 * fields — are in write order (pinned in work.dbtest.ts).
 *
 * A cursor is one of THIS item's rows or it is nothing: garbage, a
 * well-formed id that is no row, the item's own id, a row of another
 * item — each is the newest page, and the page says so (`before` is
 * null). A bare `id <` bound would have let a stale or foreign link
 * render "no older activity" for an item with a full history.
 *
 * Names are resolved HERE, in the panel's transaction: the actor and,
 * for the `assignee` field, both refs — every member of the tenant,
 * suspended ones included (a suspended member still has a name to show
 * against the row they wrote), and a Phase 3 contact actor, bound to the
 * item's own client so a mis-attributed id can never name another
 * client's contact. An id that no longer resolves is a null name; the
 * panel says "Unknown".
 */

export const ACTIVITY_PAGE_SIZE = 50;

export type ActivityActor = {
  /** Who acted: a member, a Phase 3 contact, or nobody at all (an import, a job) — the UI's "System". */
  kind: "member" | "contact" | "system";
  memberId: string | null;
  contactId: string | null;
  /** Resolved display name — null when the row names nobody, or someone who no longer resolves. */
  name: string | null;
};

export type ActivityEntry = {
  id: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  oldRef: string | null;
  newRef: string | null;
  actor: ActivityActor;
  /** The member `oldRef` / `newRef` name — the `assignee` field only; null otherwise, or when the id no longer resolves. */
  oldRefName: string | null;
  newRefName: string | null;
  visibility: "INTERNAL" | "CLIENT_VISIBLE";
  createdAt: Date;
};

export type ItemActivityPage = {
  /** Newest first. */
  rows: ActivityEntry[];
  /** The row this page starts strictly after — null for the newest page, and for any cursor that was not one of the item's rows. */
  before: string | null;
  /** Pass back as `before` for the next older page; null at the end. */
  nextCursor: string | null;
};

export async function readItemActivity(
  tx: TenantDb,
  tenantId: string,
  workItemId: string,
  clientId: string,
  rawBefore: string | null | undefined,
): Promise<ItemActivityPage> {
  // The cursor must name one of THIS item's rows (see above): one primary
  // key probe, only when a well-formed cursor arrived at all.
  const candidate = idCursor(rawBefore);
  const anchor = candidate
    ? await tx.workItemActivity.findFirst({ where: { tenantId, workItemId, id: candidate }, select: { id: true } })
    : null;
  const before = anchor?.id ?? null;

  const found = await tx.workItemActivity.findMany({
    where: { tenantId, workItemId, ...(before ? { id: { lt: before } } : {}) },
    orderBy: { id: "desc" },
    take: ACTIVITY_PAGE_SIZE + 1,
    select: {
      id: true,
      field: true,
      oldValue: true,
      newValue: true,
      oldRef: true,
      newRef: true,
      actorMemberId: true,
      actorContactId: true,
      visibility: true,
      createdAt: true,
    },
  });
  const hasMore = found.length > ACTIVITY_PAGE_SIZE;
  const page = hasMore ? found.slice(0, ACTIVITY_PAGE_SIZE) : found;

  const memberIds = new Set<string>();
  const contactIds = new Set<string>();
  for (const r of page) {
    if (r.actorMemberId) memberIds.add(r.actorMemberId);
    if (r.actorContactId) contactIds.add(r.actorContactId);
    if (r.field === "assignee") {
      if (r.oldRef) memberIds.add(r.oldRef);
      if (r.newRef) memberIds.add(r.newRef);
    }
  }
  // Only the reads the page needs: a history of member edits makes no
  // contact query, and an empty page makes none at all.
  const [members, contacts] = await Promise.all([
    memberIds.size > 0
      ? tx.member.findMany({
          where: { tenantId, id: { in: [...memberIds] } },
          select: { id: true, user: { select: { name: true } } },
        })
      : Promise.resolve([]),
    contactIds.size > 0
      ? tx.contact.findMany({
          where: { tenantId, clientId, id: { in: [...contactIds] } },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
  ]);
  const memberName = new Map(members.map((m) => [m.id, m.user.name]));
  const contactName = new Map(contacts.map((c) => [c.id, c.name]));
  const nameOf = (id: string | null, names: Map<string, string>): string | null =>
    id ? (names.get(id) ?? null) : null;

  return {
    rows: page.map((r) => ({
      id: r.id,
      field: r.field,
      oldValue: r.oldValue,
      newValue: r.newValue,
      oldRef: r.oldRef,
      newRef: r.newRef,
      actor: {
        kind: r.actorMemberId ? "member" : r.actorContactId ? "contact" : "system",
        memberId: r.actorMemberId,
        contactId: r.actorContactId,
        name: nameOf(r.actorMemberId, memberName) ?? nameOf(r.actorContactId, contactName),
      },
      oldRefName: r.field === "assignee" ? nameOf(r.oldRef, memberName) : null,
      newRefName: r.field === "assignee" ? nameOf(r.newRef, memberName) : null,
      visibility: r.visibility,
      createdAt: r.createdAt,
    })),
    before,
    nextCursor: hasMore ? page[page.length - 1]!.id : null,
  };
}

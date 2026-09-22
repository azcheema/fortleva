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

/** A history row a MEMBER caused: the module's ordinary writer. */
export async function writeActivity(
  tx: TenantDb,
  ctx: WorkCtx,
  item: ItemRef,
  change: ActivityChange,
): Promise<void> {
  await insertActivity(tx, ctx.tenantId, { memberId: ctx.actor.memberId, contactId: null }, item, change);
}

/**
 * A history row a CONTACT caused — the brokered twin of `writeActivity`,
 * and a separate function for the same reason `portal-writes.ts` is a
 * separate file: who the actor is should be a property of what you
 * called, never of an argument somebody can forget to pass.
 *
 * It takes a tenant id rather than a `WorkCtx` because there is no
 * member here at all. `actor_member_id` stays NULL and
 * `actor_contact_id` carries the claimant, which is what
 * `resolveActorNames` already resolves (it has handled a contact actor
 * since slice 8, against the item's OWN client, so a mis-attributed id
 * cannot name another client's contact).
 *
 * THE PORTAL-SAFE DECISION IS THE SAME ONE, deliberately: this shares
 * `insertActivity` with the member writer, so a field's visibility does
 * not depend on which plane wrote the row. A contact-caused row about a
 * field that is not on the list is INTERNAL exactly as a member's would
 * be — which today means every one of them, since `contactCompletedAt`
 * is not on the list and no portal history view exists to read it.
 */
export async function writeContactActivity(
  tx: TenantDb,
  tenantId: string,
  contactId: string,
  item: ItemRef,
  change: ActivityChange,
): Promise<void> {
  await insertActivity(tx, tenantId, { memberId: null, contactId }, item, change);
}

type ActivityChange = {
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
  /** The soft pointer a `comment` / `commentVisibility` row carries (§6.14) — never an FK, never resolved by the panel. */
  readonly commentId?: string | null;
};

/**
 * THE ONE INSERT, so the portal-safe decision is made in exactly one
 * place whichever plane caused the row. Both wrappers reach it; nothing
 * else does.
 */
async function insertActivity(
  tx: TenantDb,
  tenantId: string,
  actor: { readonly memberId: string | null; readonly contactId: string | null },
  item: ItemRef,
  change: ActivityChange,
): Promise<void> {
  const portalSafe =
    !change.forceInternal &&
    PORTAL_SAFE_FIELDS.has(change.field) &&
    item.visibility === "CLIENT_VISIBLE";
  await tx.workItemActivity.create({
    data: {
      tenantId,
      clientId: item.clientId,
      projectId: item.projectId,
      workItemId: item.id,
      actorMemberId: actor.memberId,
      actorContactId: actor.contactId,
      field: change.field,
      oldValue: change.oldValue ?? null,
      newValue: change.newValue ?? null,
      oldRef: change.oldRef ?? null,
      newRef: change.newRef ?? null,
      commentId: change.commentId ?? null,
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
 * Names are resolved HERE, in the panel's transaction: the actor, the
 * `assignee` field's two refs and the `milestoneId` field's — every
 * member of the tenant, suspended ones included (a suspended member
 * still has a name to show against the row they wrote), a Phase 3
 * contact actor bound to the item's own client so a mis-attributed id
 * can never name another client's contact, and every phase the reader's
 * own RLS lets them see. An id that no longer resolves is a null name;
 * the panel says "Unknown".
 */

export const ACTIVITY_PAGE_SIZE = 50;

/**
 * The names behind a set of actor ids, resolved in the panel's own
 * transaction — ONE definition for the history (here) and the thread
 * (comments.ts): every member of the tenant, suspended ones included (a
 * suspended member still has a name to show against what they wrote),
 * and a Phase 3 contact bound to the item's OWN client, so a
 * mis-attributed id can never name another client's contact. Only the
 * reads the page needs: no contact ids, no contact query; none at all
 * for an empty page. An id that resolves to nobody is null — the panel
 * says "Unknown".
 */
export async function resolveActorNames(
  tx: TenantDb,
  tenantId: string,
  clientId: string,
  memberIds: ReadonlySet<string>,
  contactIds: ReadonlySet<string>,
): Promise<{ member: (id: string | null) => string | null; contact: (id: string | null) => string | null }> {
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
  return {
    member: nameLookup(members.map((m) => ({ id: m.id, name: m.user.name }))),
    contact: nameLookup(contacts),
  };
}

/** The one shape of "an id that may resolve to a name": null for no id, and for an id no row answers to. */
const nameLookup = (rows: readonly { id: string; name: string }[]): ((id: string | null) => string | null) => {
  const byId = new Map(rows.map((r) => [r.id, r.name]));
  return (id) => (id ? (byId.get(id) ?? null) : null);
};

/**
 * The phases behind a page's `milestoneId` refs — read HERE, never
 * written into the row (items.ts, `setItemMilestone`, says why at
 * length). `Milestone` is class B, so this read answers with the
 * READER's own access: every phase of the project for a member, and for
 * a Phase 3 contact only the client-visible ones — an internal phase
 * resolves to null and the row names no phase at all. Bound to the
 * item's OWN client as the contact resolution is, so a mis-attributed
 * ref can never name another client's phase, and to the ids the page
 * actually carries; no query for a page with no milestone row on it.
 */
async function resolveMilestoneNames(
  tx: TenantDb,
  tenantId: string,
  clientId: string,
  milestoneIds: ReadonlySet<string>,
): Promise<(id: string | null) => string | null> {
  if (milestoneIds.size === 0) return () => null;
  return nameLookup(
    await tx.milestone.findMany({
      where: { tenantId, clientId, id: { in: [...milestoneIds] } },
      select: { id: true, name: true },
    }),
  );
}

/**
 * The labels behind a page's `labels` refs — class A, tenant-bound, and
 * never a portal concern: every `labels` row is INTERNAL by construction.
 * Resolved rather than stored for the same reason as a phase: a rename
 * shows the label's current name, and a deleted label reads as gone.
 */
async function resolveLabelNames(
  tx: TenantDb,
  tenantId: string,
  labelIds: ReadonlySet<string>,
): Promise<(id: string | null) => string | null> {
  if (labelIds.size === 0) return () => null;
  return nameLookup(
    await tx.label.findMany({ where: { tenantId, id: { in: [...labelIds] } }, select: { id: true, name: true } }),
  );
}

/** Which resolver a field's refs belong to — the one place the four ref-bearing fields are named. */
const refName = (
  field: string,
  ref: string | null,
  by: {
    member: (id: string | null) => string | null;
    contact: (id: string | null) => string | null;
    milestone: (id: string | null) => string | null;
    label: (id: string | null) => string | null;
  },
): string | null => {
  if (field === "assignee") return by.member(ref);
  // Bound to the item's OWN client by `resolveActorNames`, so a
  // mis-attributed ref can never name another client's contact — the
  // same rule the actor resolution follows, for the same reason.
  if (field === "assigneeContactId") return by.contact(ref);
  if (field === "milestoneId") return by.milestone(ref);
  if (field === "labels") return by.label(ref);
  return null;
};

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
  /**
   * What `oldRef` / `newRef` NAME, resolved by this read: a member for
   * `assignee`, a CONTACT for `assigneeContactId`, a milestone for
   * `milestoneId`, a label for `labels`.
   * Null for every other
   * field, and for a ref whose row no longer resolves — which, for a
   * milestone, is also the answer RLS gives a Phase 3 contact about an
   * INTERNAL phase. That is the whole reason the writer stores ids and
   * not names (items.ts, `setItemMilestone`).
   */
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
  const milestoneIds = new Set<string>();
  const labelIds = new Set<string>();
  for (const r of page) {
    if (r.actorMemberId) memberIds.add(r.actorMemberId);
    if (r.actorContactId) contactIds.add(r.actorContactId);
    if (r.field === "assignee") {
      if (r.oldRef) memberIds.add(r.oldRef);
      if (r.newRef) memberIds.add(r.newRef);
    }
    // A CONTACT assignment is its own field and never `assignee`, so
    // that field's refs stay homogeneously member ids and these stay
    // homogeneously contact ids. Mixing them would have resolved a
    // contact id against the member table and rendered "Unknown" — the
    // panel's word for a row it cannot explain — on the one kind of
    // assignment a client can see.
    if (r.field === "assigneeContactId") {
      if (r.oldRef) contactIds.add(r.oldRef);
      if (r.newRef) contactIds.add(r.newRef);
    }
    if (r.field === "milestoneId") {
      if (r.oldRef) milestoneIds.add(r.oldRef);
      if (r.newRef) milestoneIds.add(r.newRef);
    }
    if (r.field === "labels") {
      if (r.oldRef) labelIds.add(r.oldRef);
      if (r.newRef) labelIds.add(r.newRef);
    }
  }
  const [names, milestone, label] = await Promise.all([
    resolveActorNames(tx, tenantId, clientId, memberIds, contactIds),
    resolveMilestoneNames(tx, tenantId, clientId, milestoneIds),
    resolveLabelNames(tx, tenantId, labelIds),
  ]);
  const by = { member: names.member, contact: names.contact, milestone, label };

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
        name: names.member(r.actorMemberId) ?? names.contact(r.actorContactId),
      },
      oldRefName: refName(r.field, r.oldRef, by),
      newRefName: refName(r.field, r.newRef, by),
      visibility: r.visibility,
      createdAt: r.createdAt,
    })),
    before,
    nextCursor: hasMore ? page[page.length - 1]!.id : null,
  };
}

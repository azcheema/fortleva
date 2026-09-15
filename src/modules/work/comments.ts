import { record } from "@/audit/record";
import { deny } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { fail } from "@/lib/domain-error";
import { normalizeComment } from "@/lib/rich-text/normalize";

import { resolveActorNames, writeActivity } from "./activity";
import { guarded } from "./db-errors";
import { notifyItemMembers } from "./notify";
import { loadItemInScope } from "./rows";
import { principalOf, type WorkCtx } from "./states";

/**
 * Comments on a work item (UI.md §5.4 / §5.6, panel slice 10) — the
 * first code that writes a `Comment` outside a dbtest, so the settled
 * rules are stated here once (PLAN §0, the eight panel decisions,
 * 2026-09-12):
 *
 * · FLAT in 2W: no `parentId` is ever written. Threaded replies need a
 *   guard that keeps a reply no more visible than its parent, and the
 *   database does not have one yet (SECURITY.md §5.1 is corrected in
 *   this slice).
 * · Default = "Internal note" (INTERNAL). "Reply to client"
 *   (CLIENT_VISIBLE) is a mode of the same composer, offered only on a
 *   task the client can see, and posted under `comment:create` — no
 *   extra code, decision 3. The database has the last word: the guard
 *   refuses CLIENT_VISIBLE on a private subject (`SUBJECT_NOT_VISIBLE`,
 *   db-errors.ts), and the service pre-checks the same thing so the
 *   ordinary case is a typed refusal before any write.
 * · One's OWN comment is routine: create and edit write a
 *   `WorkItemActivity` row and no audit event (the AGENTS.md carve-out,
 *   extended). Editing SOMEONE ELSE's is `comment:edit_any` and audits
 *   `comment.edited_by_other`; a delete is never routine
 *   (`comment.deleted`, own or not), nor is a visibility change
 *   (`comment.visibility_changed`).
 * · A CONTACT's words are theirs: no member rewrites them (`edit_any`
 *   is for another MEMBER's comment — a client's comment stays what the
 *   client wrote, under the client's name) and nobody hides them from
 *   the client who wrote them; `comment:delete` may still remove one.
 * · WHO MAY DO WHAT is ONE rule (`commentCaps`): the read stamps it on
 *   every row for the panel's menu, and each writer enforces the same
 *   rule with `requireAccess`, so a verb the panel offers is a verb the
 *   service accepts — own words under `comment:create`, another
 *   member's under the `any` code — whatever a custom role holds.
 * · Mentions are not extracted here: `Mention` stays untouched, and the
 *   comment schema has no mention node (extensions.ts). The assignee is
 *   told (`work_item.commented`, coalesced) — a task's conversation is
 *   the assignee's business; a subscriber model has no writer yet.
 *
 * LOCKS (20260915120000, the header states the order). A write that can
 * put a client-visible comment on a task — a create, a raise — takes
 * the task FOR SHARE FIRST (`loadItemInScope`, lock "SHARE": locked,
 * read live, scoped), so the trigger's own share lock is re-entrant
 * and the task cannot be deleted or made private between the read and
 * the write; two creates on one task land together. A body edit, a
 * delete and a flip to INTERNAL lock only the comment row — never the
 * task's share lock, which they cannot harm, and which a make-private
 * (the safety lever) must never wait behind (their history row's
 * foreign key still takes FOR KEY SHARE on the task, as every activity
 * writer's does, so they can wait behind a rank move — never behind a
 * make-private or a delete). Every diff is taken from a row read AFTER
 * the lock (rows.ts's rule).
 *
 * THE READ is not exported from the barrel: a row carries the author's
 * member id, on the portal-forbidden list, and the portal-projections
 * test greps only `portal.ts` files — the non-export is the belt, as
 * for `readItemActivity` and `readItemSubtasks`. `getItemDetail` is
 * the one caller; Phase 3's portal reads a task's visible comments
 * through `modules/work/portal.ts` with its own allow-listed select,
 * under the contact principal and `portal_gate`.
 */

/** The newest this many are listed, oldest first; more is `truncated`. */
export const COMMENT_LIST_LIMIT = 200;

export type CommentAuthor = {
  kind: "member" | "contact";
  /** Resolved display name — null for an id that no longer resolves; the panel says "Unknown". */
  name: string | null;
};

export type CommentEntry = {
  id: string;
  /** The stored ProseMirror document — rendered statically, never edited in place without the editor. */
  body: unknown;
  author: CommentAuthor;
  /** Written by the actor reading it. */
  own: boolean;
  visibility: "INTERNAL" | "CLIENT_VISIBLE";
  createdAt: Date;
  editedAt: Date | null;
  /** Own under `comment:create`; another member's under `comment:edit_any`; never a contact's. */
  canEdit: boolean;
  /** Own under `comment:create`; anyone's under `comment:delete`. */
  canDelete: boolean;
  /** `comment:change_visibility`, a member's comment, and a task the client can see (or a row already visible, to lower). */
  canChangeVisibility: boolean;
};

export type ItemComments = {
  /** Oldest first — a thread reads top-down. */
  rows: CommentEntry[];
  /** Every live comment on the task — `rows.length` unless `truncated`. */
  total: number;
  /** More than `COMMENT_LIST_LIMIT` live comments exist; only the newest are listed. */
  truncated: boolean;
};

/** What the reading member holds — resolved once by `getItemDetail`, stamped per row here. */
export type CommentCaps = {
  readonly create: boolean;
  readonly editAny: boolean;
  readonly deleteAny: boolean;
  readonly changeVisibility: boolean;
};

type Authored = { readonly authorMemberId: string | null; readonly visibility: "INTERNAL" | "CLIENT_VISIBLE" };

/**
 * THE rule of who may do what to one comment — the read stamps it, the
 * writers enforce it (see the header). `itemVisibility` gates only the
 * raise: "Show to client" on a private task is a verb the service would
 * refuse (`SUBJECT_NOT_VISIBLE`), so it is not offered; lowering an
 * already visible row is always offerable.
 */
export function commentCaps(
  comment: Authored,
  actorMemberId: string,
  itemVisibility: "INTERNAL" | "CLIENT_VISIBLE",
  caps: CommentCaps,
): { own: boolean; canEdit: boolean; canDelete: boolean; canChangeVisibility: boolean } {
  const own = comment.authorMemberId !== null && comment.authorMemberId === actorMemberId;
  const contact = comment.authorMemberId === null;
  return {
    own,
    canEdit: own ? caps.create : !contact && caps.editAny,
    canDelete: own ? caps.create : caps.deleteAny,
    canChangeVisibility:
      caps.changeVisibility &&
      !contact &&
      (comment.visibility === "CLIENT_VISIBLE" || itemVisibility === "CLIENT_VISIBLE"),
  };
}

export async function readItemComments(
  tx: TenantDb,
  tenantId: string,
  item: { readonly id: string; readonly clientId: string; readonly visibility: "INTERNAL" | "CLIENT_VISIBLE" },
  actorMemberId: string,
  caps: CommentCaps,
): Promise<ItemComments> {
  // Newest first off the subject index, then reversed: a thread reads
  // oldest first, but the newest are the ones a long one must keep.
  const found = await tx.comment.findMany({
    where: { tenantId, subjectType: "WORK_ITEM", subjectId: item.id, deletedAt: null },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: COMMENT_LIST_LIMIT + 1,
    select: {
      id: true,
      body: true,
      authorMemberId: true,
      authorContactId: true,
      visibility: true,
      createdAt: true,
      editedAt: true,
    },
  });
  const truncated = found.length > COMMENT_LIST_LIMIT;
  const page = (truncated ? found.slice(0, COMMENT_LIST_LIMIT) : found).reverse();
  // The header's count is the THREAD's, never the page's — one count
  // query, only for the rare thread past the limit.
  const total = truncated
    ? await tx.comment.count({ where: { tenantId, subjectType: "WORK_ITEM", subjectId: item.id, deletedAt: null } })
    : page.length;

  const memberIds = new Set<string>();
  const contactIds = new Set<string>();
  for (const r of page) {
    if (r.authorMemberId) memberIds.add(r.authorMemberId);
    if (r.authorContactId) contactIds.add(r.authorContactId);
  }
  const names = await resolveActorNames(tx, tenantId, item.clientId, memberIds, contactIds);

  return {
    rows: page.map((r) => ({
      id: r.id,
      body: r.body,
      author: {
        kind: r.authorMemberId ? "member" : "contact",
        name: r.authorMemberId ? names.member(r.authorMemberId) : names.contact(r.authorContactId),
      },
      visibility: r.visibility,
      createdAt: r.createdAt,
      editedAt: r.editedAt,
      ...commentCaps(r, actorMemberId, item.visibility, caps),
    })),
    total,
    truncated,
  };
}

type LiveComment = {
  id: string;
  subjectId: string;
  authorMemberId: string | null;
  authorContactId: string | null;
  visibility: "INTERNAL" | "CLIENT_VISIBLE";
};

/**
 * The unlocked PROBE of one live comment on a work item: what a writer
 * reads to decide WHICH code to require (own or any) and which task to
 * scope-check — before it holds any lock (rank-lock.ts, THE ONE ORDER:
 * the task before the comment row). A comment that is deleted, or on
 * another subject type, is NOT_FOUND here as at the lock.
 */
async function probeComment(tx: TenantDb, tenantId: string, commentId: string): Promise<LiveComment> {
  const row = await tx.comment.findFirst({
    where: { tenantId, id: commentId, subjectType: "WORK_ITEM", deletedAt: null },
    select: { id: true, subjectId: true, authorMemberId: true, authorContactId: true, visibility: true },
  });
  if (!row) deny("NOT_FOUND");
  return row!;
}

/**
 * Lock ONE comment row and read it in the same statement — FOR NO KEY
 * UPDATE, the mode the UPDATE takes (no column a comment writer sets is
 * in a unique index). Postgres re-checks the predicate on the row
 * version it hands back after a wait, so a comment soft-deleted
 * meanwhile returns nothing: the diff is always taken from the version
 * the UPDATE replaces (rows.ts's rule, in one round trip). A comment
 * that is deleted, or on another subject type, is NOT_FOUND — the
 * address never leaks what it was.
 */
async function lockComment(tx: TenantDb, tenantId: string, commentId: string): Promise<LiveComment> {
  const rows = await tx.$queryRaw<
    { id: string; subject_id: string; author_member_id: string | null; author_contact_id: string | null; visibility: "INTERNAL" | "CLIENT_VISIBLE" }[]
  >`
    SELECT id, subject_id, author_member_id, author_contact_id, visibility
      FROM comment
     WHERE tenant_id = ${tenantId} AND id = ${commentId}
       AND subject_type = 'WORK_ITEM' AND deleted_at IS NULL
     FOR NO KEY UPDATE`;
  const row = rows[0];
  if (!row) deny("NOT_FOUND");
  return {
    id: row!.id,
    subjectId: row!.subject_id,
    authorMemberId: row!.author_member_id,
    authorContactId: row!.author_contact_id,
    visibility: row!.visibility,
  };
}

export type CommentCreated = { id: string; visibility: "INTERNAL" | "CLIENT_VISIBLE" };

/**
 * Post a comment on a live task in scope (`comment:create`). The task is
 * share-locked first (see the header); a client-visible post on a task
 * the client cannot see is refused before any write. The assignee is
 * told, unless they wrote it.
 */
export async function createComment(
  ctx: WorkCtx,
  itemId: string,
  input: { doc: unknown; visibility: "INTERNAL" | "CLIENT_VISIBLE" },
): Promise<CommentCreated> {
  // Normalise BEFORE the transaction: pure, and where a crafted document
  // is refused at no database cost.
  const body = normalizeComment(input.doc);
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "comment:create");
      const item = await loadItemInScope(tx, ctx, itemId, { lock: "SHARE" });
      if (input.visibility === "CLIENT_VISIBLE" && item.visibility !== "CLIENT_VISIBLE") {
        fail("SUBJECT_NOT_VISIBLE");
      }
      const created = await tx.comment.create({
        data: {
          tenantId: ctx.tenantId,
          subjectType: "WORK_ITEM",
          subjectId: item.id,
          authorMemberId: ctx.actor.memberId,
          body: body.doc as object,
          bodyText: body.text,
          visibility: input.visibility,
        },
        select: { id: true, visibility: true },
      });
      // Routine (own comment): a history row, no audit. The field is not
      // portal-safe, so the row is INTERNAL by construction — and by the
      // CHECK since 20260912120000 — whatever the comment's visibility.
      await writeActivity(tx, ctx, item, { field: "comment", newValue: "created", commentId: created.id });
      if (item.assigneeMemberId) {
        await notifyItemMembers(tx, ctx, item, "work_item.commented", [item.assigneeMemberId], "commented");
      }
      return created;
    }),
  );
}

export type CommentEdited = { id: string; editedAt: Date };

/**
 * Replace a comment's body. Own words under `comment:create` (routine:
 * a history row); another member's under `comment:edit_any`, audited
 * `comment.edited_by_other`; a contact's never. Locks only the comment
 * row.
 */
export async function updateComment(
  ctx: WorkCtx,
  commentId: string,
  input: { doc: unknown },
): Promise<CommentEdited> {
  const body = normalizeComment(input.doc);
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) =>
    guarded(async () => {
      // The module's order (requireAccess → assertInScope → mutate): the
      // code to check depends on WHOSE comment it is, so the author is
      // read unlocked first, the code checked, and only then the row
      // locked and re-read — a member without the code never holds a
      // lock. An author never changes, so the probe's answer stands.
      const probe = await probeComment(tx, ctx.tenantId, commentId);
      if (probe.authorMemberId === null) deny("FORBIDDEN", "a contact's comment is theirs to write");
      const own = probe.authorMemberId === ctx.actor.memberId;
      await requireAccess(tx, ctx.tenantId, ctx.actor, own ? "comment:create" : "comment:edit_any");
      // Unlocked (rows.ts): the task is read for scope and liveness only —
      // this writer never harms it and must not wait behind its lever.
      const item = await loadItemInScope(tx, ctx, probe.subjectId, { lock: false });
      const comment = await lockComment(tx, ctx.tenantId, commentId);
      const row = await tx.comment.update({
        where: { id: comment.id },
        data: { body: body.doc as object, bodyText: body.text, editedAt: new Date() },
        // INLINE: a select-less update returns the whole row, body included.
        select: { id: true, editedAt: true },
      });
      await writeActivity(tx, ctx, item, { field: "comment", newValue: "edited", commentId: comment.id });
      if (!own) {
        await record(tx, {
          action: "comment.edited_by_other",
          targetType: "Comment",
          targetId: comment.id,
          metadata: { workItemId: item.id, projectId: item.projectId, authorMemberId: comment.authorMemberId },
        });
      }
      return { id: row.id, editedAt: row.editedAt! };
    }),
  );
}

/**
 * Soft-delete one comment from a live task: own under `comment:create`,
 * anyone's under `comment:delete`. Never routine — `comment.deleted`,
 * ids only, plus a history row. The subject's own delete cascades
 * elsewhere (comments/cascade.ts) and does not come through here.
 */
export async function deleteComment(ctx: WorkCtx, commentId: string): Promise<void> {
  await withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    // Probe → code → scope → lock, as updateComment (the module's order).
    const probe = await probeComment(tx, ctx.tenantId, commentId);
    const own = probe.authorMemberId === ctx.actor.memberId;
    await requireAccess(tx, ctx.tenantId, ctx.actor, own ? "comment:create" : "comment:delete");
    const item = await loadItemInScope(tx, ctx, probe.subjectId, { lock: false });
    const comment = await lockComment(tx, ctx.tenantId, commentId);
    // The row is locked and was read live, so the guard cannot fail
    // except for a bug — kept as a belt on the one-stamp rule anyway.
    const { count } = await tx.comment.updateMany({
      where: { id: comment.id, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (count === 0) deny("NOT_FOUND");
    await writeActivity(tx, ctx, item, { field: "comment", newValue: "deleted", commentId: comment.id });
    await record(tx, {
      action: "comment.deleted",
      targetType: "Comment",
      targetId: comment.id,
      metadata: {
        reason: own ? "removed_by_author" : "removed_by_member",
        workItemId: item.id,
        projectId: item.projectId,
      },
    });
  });
}

export type CommentVisibilityCommitted = {
  id: string;
  visibility: "INTERNAL" | "CLIENT_VISIBLE";
  /** False when the comment already had that visibility: nothing written, nothing audited. */
  changed: boolean;
};

/**
 * Flip a member's comment INTERNAL ⇄ CLIENT_VISIBLE
 * (`comment:change_visibility`, audited). A RAISE share-locks the task
 * first, then the comment (the one order); a flip to INTERNAL locks only
 * the comment and never takes the task's share lock. A contact's own
 * words are never hidden from them here (refused).
 */
export async function setCommentVisibility(
  ctx: WorkCtx,
  commentId: string,
  visibility: "INTERNAL" | "CLIENT_VISIBLE",
): Promise<CommentVisibilityCommitted> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "comment:change_visibility");
      // The PROBE (rank-lock.ts, THE ONE ORDER): the comment's subject is
      // the one fact a wait cannot change — no service moves a comment —
      // and the task must be locked BEFORE the comment row.
      const probe = await probeComment(tx, ctx.tenantId, commentId);
      const raise = visibility === "CLIENT_VISIBLE";
      const item = await loadItemInScope(tx, ctx, probe.subjectId, { lock: raise ? "SHARE" : false });
      const comment = await lockComment(tx, ctx.tenantId, commentId);
      if (comment.authorMemberId === null) deny("FORBIDDEN", "a contact's comment keeps its visibility");
      if (comment.visibility === visibility) return { id: comment.id, visibility, changed: false };
      if (raise && item.visibility !== "CLIENT_VISIBLE") fail("SUBJECT_NOT_VISIBLE");
      const row = await tx.comment.update({
        where: { id: comment.id },
        data: { visibility },
        select: { id: true, visibility: true },
      });
      await writeActivity(tx, ctx, item, {
        field: "commentVisibility",
        oldValue: comment.visibility,
        newValue: row.visibility,
        commentId: comment.id,
      });
      await record(tx, {
        action: "comment.visibility_changed",
        targetType: "Comment",
        targetId: comment.id,
        metadata: { from: comment.visibility, to: row.visibility, workItemId: item.id, projectId: item.projectId },
      });
      return { id: row.id, visibility: row.visibility, changed: true };
    }),
  );
}

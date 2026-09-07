import type { CommentSubjectType } from "@/generated/prisma/enums";

import { recordMany } from "@/audit/record";
import type { TenantDb } from "@/db";

/**
 * A comment lives the life of its subject (DATA_MODEL §10).
 *
 * WHY THIS IS CORE. Comment is a work-module table — its `comment:*`
 * codes, its composer and the future `src/modules/work/comments.ts` are
 * all gated by `work` — but the table is polymorphic over CORE subjects
 * (Document, FileVersion; ProjectVersion later), and it is the SUBJECT's
 * soft delete that has to reach it. `src/documents` may not import
 * `src/modules/*` (ARC-16's direction rule, which ARCHITECTURE.md now
 * records as reviewed rather than linted), so the lifecycle helper sits
 * in core and both deleters call it. The
 * module keeps everything a member does TO a comment; this is only what
 * a subject's death does to its thread.
 *
 * WHY A CASCADE AT ALL. `search_feed_comment` indexes every comment with
 * `title = left(body_text, 140)` and the whole body behind it, and
 * nothing else removes that row: `Comment.subjectId` is a soft pointer
 * with no FK, so a subject's soft delete used to leave its thread — and
 * its index rows — alive and findable. The search hydrate drops such
 * hits as a second belt; this is the first.
 *
 * THE PERMISSION IS THE SUBJECT'S. `work_item:delete` and
 * `document:delete` cascade here without a `comment:delete` check, as
 * the attachment cascade under `work_item:delete` already does: a
 * deleted subject has no thread, and `comment:delete` governs removing
 * ONE comment from a LIVE subject. This is the first cascade that runs
 * from a broader seed (document:delete C M A) to a narrower one
 * (comment:delete C M); AUTHZ.md §4 records it. It runs whether or not
 * the tenant has the `work` module switched on — it only ever reduces
 * what is visible.
 *
 * ONE AUDIT ROW PER COMMENT, ids only, carrying the reason and the
 * subject — the per-document precedent, and the only record a future
 * undo could use to restore exactly the comments the cascade took and
 * not one a member had removed by hand. They go in one `recordMany`
 * statement, so a long thread costs the delete two statements rather
 * than two hundred.
 *
 * THE UPDATE IS ALSO THE SELECT (`updateManyAndReturn`), and that is
 * what makes the audit trail true rather than merely likely. Finding
 * the live comments and then stamping them are two statements with a
 * gap: under READ COMMITTED another transaction can remove one in
 * between, and the trail would then claim this actor deleted a comment
 * they did not touch. One `UPDATE … RETURNING` cannot disagree with
 * itself — the rows it gives back ARE the rows it stamped.
 *
 * Only LIVE comments are taken, so an already-deleted comment never
 * gets a second `comment.deleted` under a cascade reason. Replies share
 * their parent's subject (comment_denorm_guard), so matching on the
 * subject takes whole threads. The caller stamps ONE `deletedAt` across
 * its whole cascade set, and passes a whole family of subjects per call
 * — each carrying the reason to record for the comments found on it —
 * so the statement count does not grow with the number of attachments.
 * (`deleteItem` makes two: one for its documents and their versions,
 * one for the item itself.)
 *
 * NOT DONE HERE, recorded for whoever builds them: the 30-day hard
 * delete must remove comments by (subject_type, subject_id) itself — no
 * FK ever will; and an undo must restore only the comments whose
 * `comment.deleted` row names its subject.
 */

export type CascadeReason =
  | { readonly reason: "work_item_deleted"; readonly workItemId: string }
  | { readonly reason: "document_deleted"; readonly documentId: string; readonly workItemId?: string };

/** The arm a work item's own delete carries, named so the document
 * helper can take exactly it rather than re-declaring the shape. */
export type WorkItemDeletedReason = Extract<CascadeReason, { reason: "work_item_deleted" }>;

export type CascadeSubject = {
  readonly type: Extract<CommentSubjectType, "WORK_ITEM" | "DOCUMENT" | "FILE_VERSION">;
  readonly id: string;
  /** Recorded on every comment this subject yields — so one call can
   * take a task, its attachments and their versions and still audit
   * each comment against the thing it was actually written on. */
  readonly why: CascadeReason;
};

/** Soft-delete every live comment on the given subjects; returns how many. */
export async function softDeleteCommentsOn(
  tx: TenantDb,
  tenantId: string,
  subjects: readonly CascadeSubject[],
  deletedAt: Date,
): Promise<number> {
  if (subjects.length === 0) return 0;
  // A subject id that is not a real id FAILS OPEN, which for a delete
  // means taking rows nobody asked for: Prisma drops an `undefined`
  // filter, so `{subjectType: 'WORK_ITEM', subjectId: undefined}` would
  // become "every work-item comment in the tenant". The belt on the
  // platform client cannot see this one — it is nested inside an OR arm
  // that is itself present — so it is checked here, where the arms are
  // built.
  if (subjects.some((s) => !s.id)) {
    throw new Error("comment cascade: a subject id is empty (Prisma drops undefined filters)");
  }
  const taken = await tx.comment.updateManyAndReturn({
    where: {
      tenantId,
      deletedAt: null,
      OR: subjects.map((s) => ({ subjectType: s.type, subjectId: s.id })),
    },
    data: { deletedAt },
    select: { id: true, subjectType: true, subjectId: true },
  });
  if (taken.length === 0) return 0;
  const whyOf = new Map(subjects.map((s) => [`${s.type}:${s.id}`, s.why]));
  await recordMany(
    tx,
    taken.map((c) => ({
      action: "comment.deleted" as const,
      targetType: "Comment",
      targetId: c.id,
      // Present for every returned row: the WHERE above matches only
      // the subject pairs this map was built from.
      metadata: whyOf.get(`${c.subjectType}:${c.subjectId}`)!,
    })),
  );
  return taken.length;
}

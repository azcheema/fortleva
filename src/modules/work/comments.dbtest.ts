import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withTenant, type TenantDb } from "@/db";
import { setupTenant } from "@/members/dbtest-fixture";
import {
  assignItem,
  changeItemVisibility,
  createComment,
  createItem,
  deleteComment,
  deleteItem,
  getItemDetail,
  setCommentVisibility,
  updateComment,
} from "./index";
import { expectLockTimeout } from "./dbtest-locks";

/**
 * The comments service against the real database and the real
 * app_runtime role (panel slice 10): the settled rules — own is
 * routine, someone else's audits, delete and visibility always audit,
 * a client reply only on a shared task — the per-row caps
 * `getItemDetail` stamps, the assignee's notification, and the two
 * races the share lock exists for: a client-visible comment against
 * the task's make-private, and a comment against the task's delete.
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
let clientId: string;
let projectId: string;
const contact = { id: randomUUID() };

const doc = (words: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: words }] }] });

beforeAll(async () => {
  f = await setupTenant("work");
  clientId = randomUUID();
  projectId = randomUUID();
  await f.platform.client.create({ data: { id: clientId, tenantId: f.tenantId, name: "Acme" } });
  await f.platform.project.create({
    data: { id: projectId, tenantId: f.tenantId, clientId, key: "ACME", name: "Acme site", portalEnabled: true },
  });
  await f.platform.contact.create({
    data: {
      id: contact.id,
      tenantId: f.tenantId,
      clientId,
      name: "Client Carol",
      email: `carol-${randomUUID().slice(0, 8)}@test.invalid`,
    },
  });
  // The employee is scoped to the client (deny-default otherwise).
  await f.platform.memberClient.create({
    data: { tenantId: f.tenantId, memberId: f.seats.employee.memberId, clientId },
  });
}, 60_000);

afterAll(async () => {
  if (!f?.tenantId) return;
  const db = f.platform;
  await db.notification.deleteMany({ where: { tenantId: f.tenantId } });
  await db.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
  await db.comment.deleteMany({ where: { tenantId: f.tenantId } });
  await db.workItemActivity.deleteMany({ where: { tenantId: f.tenantId } });
  await db.workItem.deleteMany({ where: { tenantId: f.tenantId } });
  await db.workflowState.deleteMany({ where: { tenantId: f.tenantId } });
  await db.memberClient.deleteMany({ where: { tenantId: f.tenantId } });
  await db.contact.deleteMany({ where: { tenantId: f.tenantId } });
  await db.project.deleteMany({ where: { tenantId: f.tenantId } });
  await db.client.deleteMany({ where: { tenantId: f.tenantId } });
  await db.tenantCounter.deleteMany({ where: { tenantId: f.tenantId } });
  await f.cleanup();
}, 60_000);

const ownerCtx = () => ({ tenantId: f.tenantId, actor: f.seats.owner.actor });
const employeeCtx = () => ({ tenantId: f.tenantId, actor: f.seats.employee.actor });

const activityOf = (itemId: string) =>
  f.platform.workItemActivity.findMany({
    where: { tenantId: f.tenantId, workItemId: itemId, field: { in: ["comment", "commentVisibility"] } },
    orderBy: { id: "asc" },
    select: { field: true, oldValue: true, newValue: true, commentId: true, visibility: true, actorMemberId: true },
  });

const auditsFor = (targetId: string) =>
  f.platform.auditEvent.findMany({ where: { tenantId: f.tenantId, targetId }, orderBy: { createdAt: "asc" } });

describe("createComment", () => {
  it("an internal note: INTERNAL, text extracted, one history row and NO audit; the assignee is told, the author is not", async () => {
    const { id } = await createItem(ownerCtx(), { projectId, title: "Noted task" });
    await assignItem(ownerCtx(), id, f.seats.employee.memberId);
    const c = await createComment(ownerCtx(), id, { doc: doc("Triage: needs a repro"), visibility: "INTERNAL" });
    const row = await f.platform.comment.findUniqueOrThrow({ where: { id: c.id } });
    expect(row).toMatchObject({
      subjectType: "WORK_ITEM",
      subjectId: id,
      authorMemberId: f.seats.owner.memberId,
      authorContactId: null,
      parentId: null,
      bodyText: "Triage: needs a repro",
      visibility: "INTERNAL",
      clientId, // denormalised by the trigger
      projectId,
      portalEnabled: true,
      deletedAt: null,
      editedAt: null,
    });
    expect(await activityOf(id)).toEqual([
      expect.objectContaining({ field: "comment", newValue: "created", commentId: c.id, visibility: "INTERNAL" }),
    ]);
    expect(await auditsFor(c.id)).toHaveLength(0);

    // The assignee has one notification for it; the author none.
    const mine = await f.platform.notification.findMany({
      where: { tenantId: f.tenantId, kind: "work_item.commented", entityId: id },
      select: { receiverId: true },
    });
    expect(mine.map((n) => n.receiverId)).toEqual([f.seats.employee.memberId]);

    // The assignee commenting on their own task tells nobody.
    await createComment(employeeCtx(), id, { doc: doc("On it"), visibility: "INTERNAL" });
    const after = await f.platform.notification.count({
      where: { tenantId: f.tenantId, kind: "work_item.commented", entityId: id },
    });
    expect(after).toBe(1);
  });

  it("a client reply is refused on a private task and lands on a shared one — the history row stays INTERNAL", async () => {
    const { id } = await createItem(ownerCtx(), { projectId, title: "Reply target" });
    await expect(
      createComment(ownerCtx(), id, { doc: doc("Hi client"), visibility: "CLIENT_VISIBLE" }),
    ).rejects.toMatchObject({ code: "SUBJECT_NOT_VISIBLE" });
    expect(await f.platform.comment.count({ where: { tenantId: f.tenantId, subjectId: id } })).toBe(0);

    await changeItemVisibility(ownerCtx(), id, "CLIENT_VISIBLE");
    const c = await createComment(ownerCtx(), id, { doc: doc("Hi client"), visibility: "CLIENT_VISIBLE" });
    expect(c.visibility).toBe("CLIENT_VISIBLE");
    // Not on the portal-safe list: the CHECK since 20260912120000 would
    // refuse anything else.
    expect((await activityOf(id)).map((a) => a.visibility)).toEqual(["INTERNAL"]);
    // …and the task can no longer be made private while it lives.
    await expect(changeItemVisibility(ownerCtx(), id, "INTERNAL")).rejects.toMatchObject({
      code: "HAS_VISIBLE_CHILDREN",
    });
  });

  it("refuses an empty comment, a heading, and a task out of scope — each before any write", async () => {
    const { id } = await createItem(ownerCtx(), { projectId, title: "Refusals" });
    await expect(
      createComment(ownerCtx(), id, { doc: { type: "doc", content: [{ type: "paragraph" }] }, visibility: "INTERNAL" }),
    ).rejects.toMatchObject({ code: "COMMENT_EMPTY" });
    await expect(
      createComment(ownerCtx(), id, {
        doc: { type: "doc", content: [{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "H" }] }] },
        visibility: "INTERNAL",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    // Another client's project: the employee is not assigned to it.
    const otherClient = randomUUID();
    const otherProject = randomUUID();
    await f.platform.client.create({ data: { id: otherClient, tenantId: f.tenantId, name: "Other" } });
    await f.platform.project.create({
      data: { id: otherProject, tenantId: f.tenantId, clientId: otherClient, key: "OTHR", name: "Other" },
    });
    const foreign = await createItem(ownerCtx(), { projectId: otherProject, title: "Not yours" });
    await expect(
      createComment(employeeCtx(), foreign.id, { doc: doc("peek"), visibility: "INTERNAL" }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });
    expect(await f.platform.comment.count({ where: { tenantId: f.tenantId, subjectId: foreign.id } })).toBe(0);
  });
});

describe("updateComment / deleteComment — own is routine, someone else's is not", () => {
  it("own edit: editedAt set, a history row, no audit; the owner editing the employee's words audits comment.edited_by_other", async () => {
    const { id } = await createItem(ownerCtx(), { projectId, title: "Edited thread" });
    const theirs = await createComment(employeeCtx(), id, { doc: doc("first draft"), visibility: "INTERNAL" });

    const own = await updateComment(employeeCtx(), theirs.id, { doc: doc("second draft") });
    expect(own.editedAt).toBeInstanceOf(Date);
    const row = await f.platform.comment.findUniqueOrThrow({ where: { id: theirs.id } });
    expect(row.bodyText).toBe("second draft");
    expect(row.editedAt).toEqual(own.editedAt);
    expect(await auditsFor(theirs.id)).toHaveLength(0);

    // The employee cannot edit the owner's comment (no comment:edit_any).
    const owners = await createComment(ownerCtx(), id, { doc: doc("owner's note"), visibility: "INTERNAL" });
    await expect(updateComment(employeeCtx(), owners.id, { doc: doc("defaced") })).rejects.toMatchObject({
      reason: "FORBIDDEN",
    });
    expect((await f.platform.comment.findUniqueOrThrow({ where: { id: owners.id } })).bodyText).toBe("owner's note");

    // The owner editing the employee's: allowed, and audited.
    await updateComment(ownerCtx(), theirs.id, { doc: doc("corrected by the owner") });
    const audit = await auditsFor(theirs.id);
    expect(audit.map((a) => a.action)).toEqual(["comment.edited_by_other"]);
    expect(audit[0]!.metadata).toMatchObject({ workItemId: id, authorMemberId: f.seats.employee.memberId });
    expect((await activityOf(id)).map((a) => a.newValue)).toEqual(["created", "edited", "created", "edited"]);

    // A contact's words are theirs: even the owner (comment:edit_any)
    // cannot rewrite them — they would stay under the client's name.
    await changeItemVisibility(ownerCtx(), id, "CLIENT_VISIBLE");
    const carol = await withTenant(f.tenantId, { type: "contact", id: contact.id, clientId }, (tx) =>
      tx.comment.create({
        data: {
          tenantId: f.tenantId,
          subjectType: "WORK_ITEM",
          subjectId: id,
          authorContactId: contact.id,
          body: doc("Ser bra ut"),
          bodyText: "Ser bra ut",
          visibility: "CLIENT_VISIBLE",
        },
        select: { id: true },
      }),
    );
    await expect(updateComment(ownerCtx(), carol.id, { doc: doc("rewritten") })).rejects.toMatchObject({
      reason: "FORBIDDEN",
    });
    expect((await f.platform.comment.findUniqueOrThrow({ where: { id: carol.id } })).bodyText).toBe("Ser bra ut");
    // …but comment:delete may remove one.
    await deleteComment(ownerCtx(), carol.id);
    expect((await f.platform.comment.findUniqueOrThrow({ where: { id: carol.id } })).deletedAt).not.toBeNull();
  });

  it("own delete under comment:create; another's needs comment:delete; both audit comment.deleted with ids only", async () => {
    const { id } = await createItem(ownerCtx(), { projectId, title: "Deleted thread" });
    const mine = await createComment(employeeCtx(), id, { doc: doc("mine"), visibility: "INTERNAL" });
    const theirs = await createComment(employeeCtx(), id, { doc: doc("also mine"), visibility: "INTERNAL" });
    const owners = await createComment(ownerCtx(), id, { doc: doc("owner's"), visibility: "INTERNAL" });

    // The employee (no comment:delete) removes only their own words.
    await expect(deleteComment(employeeCtx(), owners.id)).rejects.toMatchObject({ reason: "FORBIDDEN" });
    await deleteComment(employeeCtx(), mine.id);
    // The owner removes the employee's — comment:delete — and their own.
    await deleteComment(ownerCtx(), theirs.id);
    await deleteComment(ownerCtx(), owners.id);

    const rows = await f.platform.comment.findMany({
      where: { id: { in: [mine.id, theirs.id, owners.id] } },
      select: { id: true, deletedAt: true },
    });
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.deletedAt !== null)).toBe(true);
    const reasonOf = async (commentId: string) =>
      (await auditsFor(commentId)).map((a) => [a.action, (a.metadata as { reason: string }).reason]);
    expect(await reasonOf(mine.id)).toEqual([["comment.deleted", "removed_by_author"]]);
    expect(await reasonOf(theirs.id)).toEqual([["comment.deleted", "removed_by_member"]]);
    expect(await reasonOf(owners.id)).toEqual([["comment.deleted", "removed_by_author"]]);
    // A deleted comment is gone from every write path.
    await expect(deleteComment(employeeCtx(), mine.id)).rejects.toMatchObject({ reason: "NOT_FOUND" });
    await expect(updateComment(employeeCtx(), mine.id, { doc: doc("ghost") })).rejects.toMatchObject({
      reason: "NOT_FOUND",
    });
    // …and its index row with it (the feed evicts on deleted_at).
    const indexed = await f.platform.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM search_index
       WHERE tenant_id = ${f.tenantId} AND entity_type = 'COMMENT' AND entity_id = ${mine.id}`;
    expect(indexed[0]!.n).toBe(0);
  });
});

describe("setCommentVisibility", () => {
  it("a raise needs a shared task and comment:change_visibility; it audits; a repeat is a no-op; a contact's words keep theirs", async () => {
    const { id } = await createItem(ownerCtx(), { projectId, title: "Flipped thread" });
    const note = await createComment(ownerCtx(), id, { doc: doc("note"), visibility: "INTERNAL" });

    await expect(setCommentVisibility(employeeCtx(), note.id, "CLIENT_VISIBLE")).rejects.toMatchObject({
      reason: "FORBIDDEN",
    });
    await expect(setCommentVisibility(ownerCtx(), note.id, "CLIENT_VISIBLE")).rejects.toMatchObject({
      code: "SUBJECT_NOT_VISIBLE",
    });
    // …and the panel is not offered a verb the service would refuse: on
    // a private task the row's cap is false even for the owner.
    const { number } = await f.platform.workItem.findUniqueOrThrow({ where: { id }, select: { number: true } });
    expect((await getItemDetail(ownerCtx(), projectId, number)).comments.rows[0]).toMatchObject({
      id: note.id,
      canChangeVisibility: false,
    });

    await changeItemVisibility(ownerCtx(), id, "CLIENT_VISIBLE");
    expect((await getItemDetail(ownerCtx(), projectId, number)).comments.rows[0]).toMatchObject({
      canChangeVisibility: true,
    });
    expect(await setCommentVisibility(ownerCtx(), note.id, "CLIENT_VISIBLE")).toEqual({
      id: note.id,
      visibility: "CLIENT_VISIBLE",
      changed: true,
    });
    expect(await setCommentVisibility(ownerCtx(), note.id, "CLIENT_VISIBLE")).toMatchObject({ changed: false });
    expect(await setCommentVisibility(ownerCtx(), note.id, "INTERNAL")).toMatchObject({ changed: true });
    const audit = await auditsFor(note.id);
    expect(audit.map((a) => a.action)).toEqual(["comment.visibility_changed", "comment.visibility_changed"]);
    expect(audit[0]!.metadata).toMatchObject({ from: "INTERNAL", to: "CLIENT_VISIBLE", workItemId: id });
    expect((await activityOf(id)).filter((a) => a.field === "commentVisibility")).toEqual([
      expect.objectContaining({ oldValue: "INTERNAL", newValue: "CLIENT_VISIBLE", commentId: note.id }),
      expect.objectContaining({ oldValue: "CLIENT_VISIBLE", newValue: "INTERNAL", commentId: note.id }),
    ]);

    // The contact's own comment (the census INSERT) is never hidden from them here.
    const carol = await withTenant(f.tenantId, { type: "contact", id: contact.id, clientId }, (tx) =>
      tx.comment.create({
        data: {
          tenantId: f.tenantId,
          subjectType: "WORK_ITEM",
          subjectId: id,
          authorContactId: contact.id,
          body: doc("Tack!"),
          bodyText: "Tack!",
          visibility: "CLIENT_VISIBLE",
        },
        select: { id: true },
      }),
    );
    await expect(setCommentVisibility(ownerCtx(), carol.id, "INTERNAL")).rejects.toMatchObject({
      reason: "FORBIDDEN",
    });
  });
});

describe("getItemDetail carries the thread with the reader's own caps", () => {
  it("oldest first, a deleted one absent, the contact's name resolved, and edit/delete/visibility per row", async () => {
    const { id, number } = await createItem(ownerCtx(), { projectId, title: "Read thread" });
    await changeItemVisibility(ownerCtx(), id, "CLIENT_VISIBLE");
    const a = await createComment(ownerCtx(), id, { doc: doc("one"), visibility: "INTERNAL" });
    const b = await createComment(employeeCtx(), id, { doc: doc("two"), visibility: "INTERNAL" });
    const gone = await createComment(ownerCtx(), id, { doc: doc("three"), visibility: "INTERNAL" });
    await deleteComment(ownerCtx(), gone.id);
    const carol = await withTenant(f.tenantId, { type: "contact", id: contact.id, clientId }, (tx) =>
      tx.comment.create({
        data: {
          tenantId: f.tenantId,
          subjectType: "WORK_ITEM",
          subjectId: id,
          authorContactId: contact.id,
          body: doc("four"),
          bodyText: "four",
          visibility: "CLIENT_VISIBLE",
        },
        select: { id: true },
      }),
    );

    const asOwner = await getItemDetail(ownerCtx(), projectId, number);
    expect(asOwner.caps.comment).toBe(true);
    expect(asOwner.comments.truncated).toBe(false);
    expect(asOwner.comments.rows.map((r) => r.id)).toEqual([a.id, b.id, carol.id]);
    expect(asOwner.comments.total).toBe(3);
    expect(asOwner.comments.rows[0]).toMatchObject({
      own: true,
      author: { kind: "member" },
      canEdit: true,
      canDelete: true,
      canChangeVisibility: true,
      body: doc("one"),
    });
    expect(asOwner.comments.rows[0]!.author.name!.length).toBeGreaterThan(0);
    // The owner holds every `any` code, so the employee's row is theirs to edit and delete too.
    expect(asOwner.comments.rows[1]).toMatchObject({ own: false, canEdit: true, canDelete: true, canChangeVisibility: true });
    // A contact's row: named, bound to the item's client; the client's
    // words are never rewritten or re-flipped by a member — only removed.
    expect(asOwner.comments.rows[2]).toMatchObject({
      own: false,
      author: { kind: "contact", name: "Client Carol" },
      visibility: "CLIENT_VISIBLE",
      canEdit: false,
      canDelete: true,
      canChangeVisibility: false,
    });

    const asEmployee = await getItemDetail(employeeCtx(), projectId, number);
    expect(asEmployee.caps.comment).toBe(true);
    expect(asEmployee.comments.rows.map((r) => [r.own, r.canEdit, r.canDelete, r.canChangeVisibility])).toEqual([
      [false, false, false, false],
      [true, true, true, false],
      [false, false, false, false],
    ]);
  });
});

const member = () => ({ type: "member", id: f.seats.owner.memberId }) as const;

/**
 * A transaction that runs `body`, signals, stays open until released,
 * then commits — the tree-guards dbtest's way of holding a row lock
 * while another writer is made to wait on it.
 */
function holdOpen(body: (tx: TenantDb) => Promise<unknown>) {
  let ready!: () => void;
  let release!: () => void;
  const isReady = new Promise<void>((r) => (ready = r));
  const released = new Promise<void>((r) => (release = r));
  const done = withTenant(
    f.tenantId,
    member(),
    async (tx) => {
      await body(tx);
      ready();
      await released;
    },
    { timeoutMs: 20_000 },
  );
  return { isReady, release, done };
}

/** A raw comment row, as a writer outside the service would insert one. */
const rawComment = (tx: TenantDb, subjectId: string, visibility: "INTERNAL" | "CLIENT_VISIBLE", words: string) =>
  tx.comment.create({
    data: {
      tenantId: f.tenantId,
      subjectType: "WORK_ITEM",
      subjectId,
      authorMemberId: f.seats.owner.memberId,
      body: doc(words),
      bodyText: words,
      visibility,
    },
    select: { id: true },
  });

describe("the share lock (20260915120000), pinned deterministically: who waits on whom", () => {
  it("downgrade first: a client reply WAITS on the task's held row, then re-reads it private and is refused", async () => {
    const { id } = await createItem(ownerCtx(), { projectId, title: "Held downgrade" });
    await changeItemVisibility(ownerCtx(), id, "CLIENT_VISIBLE");
    const holder = holdOpen((tx) => tx.workItem.update({ where: { id }, data: { visibility: "INTERNAL" } }));
    try {
      await holder.isReady;
      // Through the service: its share lock is what waits (the trigger's
      // is the belt behind it).
      await expectLockTimeout(
        withTenant(f.tenantId, member(), async (tx) => {
          await tx.$executeRaw`SET LOCAL lock_timeout = '300ms'`;
          await tx.$queryRaw`SELECT 1 FROM work_item WHERE tenant_id = ${f.tenantId} AND id = ${id} FOR SHARE`;
        }),
      );
      // At the trigger, for a raw writer: the same wait.
      await expectLockTimeout(
        withTenant(f.tenantId, member(), async (tx) => {
          await tx.$executeRaw`SET LOCAL lock_timeout = '300ms'`;
          await rawComment(tx, id, "CLIENT_VISIBLE", "must not land");
        }),
      );
    } finally {
      holder.release();
      await holder.done;
    }
    await expect(
      createComment(ownerCtx(), id, { doc: doc("still refused"), visibility: "CLIENT_VISIBLE" }),
    ).rejects.toMatchObject({ code: "SUBJECT_NOT_VISIBLE" });
    await expect(
      withTenant(f.tenantId, member(), (tx) => rawComment(tx, id, "CLIENT_VISIBLE", "raw, still refused")),
    ).rejects.toThrow(/COMMENT_NOT_VISIBLE/);
    expect(
      await f.platform.comment.count({ where: { tenantId: f.tenantId, subjectId: id, visibility: "CLIENT_VISIBLE" } }),
    ).toBe(0);
  });

  it("delete first: even an INTERNAL insert WAITS on the dying task (liveness), then finds it gone", async () => {
    const { id } = await createItem(ownerCtx(), { projectId, title: "Held delete" });
    const holder = holdOpen((tx) => tx.workItem.update({ where: { id }, data: { deletedAt: new Date() } }));
    try {
      await holder.isReady;
      await expectLockTimeout(
        withTenant(f.tenantId, member(), async (tx) => {
          await tx.$executeRaw`SET LOCAL lock_timeout = '300ms'`;
          await rawComment(tx, id, "INTERNAL", "orphan-to-be");
        }),
      );
    } finally {
      holder.release();
      await holder.done;
    }
    // The trigger's own answer for a raw writer; the service's is NOT_FOUND
    // (it re-reads the row live before it inserts).
    await expect(
      withTenant(f.tenantId, member(), (tx) => rawComment(tx, id, "INTERNAL", "still an orphan")),
    ).rejects.toThrow(/COMMENT_SUBJECT_GONE/);
    await expect(createComment(ownerCtx(), id, { doc: doc("late"), visibility: "INTERNAL" })).rejects.toMatchObject({
      reason: "NOT_FOUND",
    });
    expect(await f.platform.comment.count({ where: { tenantId: f.tenantId, subjectId: id } })).toBe(0);
  });

  it("a flip to INTERNAL never waits on the task; a raise does", async () => {
    const { id } = await createItem(ownerCtx(), { projectId, title: "Held for the lever" });
    await changeItemVisibility(ownerCtx(), id, "CLIENT_VISIBLE");
    const shared = await createComment(ownerCtx(), id, { doc: doc("shared"), visibility: "CLIENT_VISIBLE" });
    const shared2 = await createComment(ownerCtx(), id, { doc: doc("shared too"), visibility: "CLIENT_VISIBLE" });
    const note = await createComment(ownerCtx(), id, { doc: doc("note"), visibility: "INTERNAL" });
    // Hold the task's row as its make-private would (the guard refuses
    // the flip while `shared` lives, so hold a no-op UPDATE instead).
    const holder = holdOpen(
      (tx) => tx.$queryRaw`SELECT 1 FROM work_item WHERE tenant_id = ${f.tenantId} AND id = ${id} FOR NO KEY UPDATE`,
    );
    try {
      await holder.isReady;
      // The safety lever, at the trigger: a raw flip under a lock_timeout
      // that would have fired had it waited.
      await withTenant(f.tenantId, member(), async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '300ms'`;
        await tx.comment.update({ where: { id: shared.id }, data: { visibility: "INTERNAL" } });
      });
      // …and THROUGH THE SERVICE, whose transaction cannot be given a
      // lock_timeout: it must answer while the task is still held (the
      // holder is released only in `finally`), so a wait would be a hang
      // — bounded here by a race against the clock. A real write: its
      // history row's FOR KEY SHARE does not conflict with the holder's
      // NO KEY UPDATE either.
      const lowered = await Promise.race([
        setCommentVisibility(ownerCtx(), shared2.id, "INTERNAL"),
        new Promise<"waited">((r) => setTimeout(() => r("waited"), 5_000)),
      ]);
      expect(lowered).toMatchObject({ id: shared2.id, visibility: "INTERNAL", changed: true });
      // A raise waits — the trigger's share lock, for a raw writer.
      await expectLockTimeout(
        withTenant(f.tenantId, member(), async (tx) => {
          await tx.$executeRaw`SET LOCAL lock_timeout = '300ms'`;
          await tx.comment.update({ where: { id: note.id }, data: { visibility: "CLIENT_VISIBLE" } });
        }),
      );
    } finally {
      holder.release();
      await holder.done;
    }
    expect((await f.platform.comment.findUniqueOrThrow({ where: { id: shared.id } })).visibility).toBe("INTERNAL");
    expect((await f.platform.comment.findUniqueOrThrow({ where: { id: note.id } })).visibility).toBe("INTERNAL");
    // With the task free, the service's raise goes through.
    expect(await setCommentVisibility(ownerCtx(), note.id, "CLIENT_VISIBLE")).toMatchObject({ changed: true });
  });
});

describe("the share lock (20260915120000): what the races end on", () => {
  it("a client reply and the task's make-private never both commit; the thread never holds a visible comment on a private task", async () => {
    for (let round = 0; round < 4; round += 1) {
      const { id } = await createItem(ownerCtx(), { projectId, title: `Race ${round}` });
      await changeItemVisibility(ownerCtx(), id, "CLIENT_VISIBLE");
      const [reply, downgrade] = await Promise.allSettled([
        createComment(ownerCtx(), id, { doc: doc(`reply ${round}`), visibility: "CLIENT_VISIBLE" }),
        changeItemVisibility(ownerCtx(), id, "INTERNAL"),
      ]);
      const item = await f.platform.workItem.findUniqueOrThrow({ where: { id }, select: { visibility: true } });
      const visibleComments = await f.platform.comment.count({
        where: { tenantId: f.tenantId, subjectId: id, visibility: "CLIENT_VISIBLE", deletedAt: null },
      });
      // Either order is legal; the pair is not.
      expect(reply.status === "fulfilled" && downgrade.status === "fulfilled").toBe(false);
      if (item.visibility === "INTERNAL") expect(visibleComments).toBe(0);
      if (reply.status === "rejected") {
        expect(reply.reason).toMatchObject({ code: "SUBJECT_NOT_VISIBLE" });
        expect(downgrade.status).toBe("fulfilled");
      } else {
        expect(downgrade.status).toBe("rejected");
        expect((downgrade as PromiseRejectedResult).reason).toMatchObject({ code: "HAS_VISIBLE_CHILDREN" });
      }
    }
  }, 30_000);

  it("a comment and the task's delete: the comment either lands and is cascaded, or is refused — never a live comment on a deleted task", async () => {
    for (let round = 0; round < 4; round += 1) {
      const { id } = await createItem(ownerCtx(), { projectId, title: `Delete race ${round}` });
      const [comment, removal] = await Promise.allSettled([
        createComment(ownerCtx(), id, { doc: doc(`late ${round}`), visibility: "INTERNAL" }),
        deleteItem(ownerCtx(), id),
      ]);
      expect(removal.status).toBe("fulfilled");
      const live = await f.platform.comment.count({ where: { tenantId: f.tenantId, subjectId: id, deletedAt: null } });
      expect(live).toBe(0);
      if (comment.status === "rejected") {
        // Waited on the delete, then found the row dead: the service's own NOT_FOUND.
        expect(comment.reason).toMatchObject({ reason: "NOT_FOUND" });
      } else {
        // Landed first: the cascade took it, with the item's own stamp.
        const row = await f.platform.comment.findUniqueOrThrow({ where: { id: comment.value.id } });
        const item = await f.platform.workItem.findUniqueOrThrow({ where: { id }, select: { deletedAt: true } });
        expect(row.deletedAt).toEqual(item.deletedAt);
      }
    }
  }, 30_000);
});

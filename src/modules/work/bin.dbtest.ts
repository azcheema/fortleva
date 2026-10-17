import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { MemberActor } from "@/authz/authorize";
import { AuthzError } from "@/authz/errors";
import { withTenant } from "@/db";
import { DomainError } from "@/lib/domain-error";
import { actorFor, setupTenant } from "@/members/dbtest-fixture";

import {
  assignItemToContact,
  changeItemVisibility,
  createComment,
  createItem,
  deleteComment,
  deleteItem,
  listDeletedItems,
  restoreDeletedItem,
} from "./index";

/**
 * THE BIN FOR DELETED TASKS (slice 126, founder decision C102) against the
 * real schema, the real `app_runtime` role, the real triggers and a real
 * contact principal: who may bring a task back, what comes back with it —
 * EXACTLY what its deletion took, found by the stamp AND the audit record —
 * that it comes back PRIVATE (C102 (b)) and the client can then read none of
 * it, that a share brings the client's own words back (C37), the refusals,
 * and the database's own belt (`work_item_restore_guard`, 20261030090000).
 *
 * Tenant slugs come from `setupTenant("bin")`; the prefix `bin-` is
 * registered in `DBTEST_PREFIXES` (e2e/fixtures/seed-cli.ts).
 */

const run = randomUUID().slice(0, 8);
const LONG = 240_000;

let f: Awaited<ReturnType<typeof setupTenant>>;
let acme: string;
let beta: string;
/** Acme's project, portal on. */
let pOn: string;
/** Beta's project — the only one the custom seat reaches. */
let pBeta: string;
/** Carol — ACTIVE, CONTACT_PRIMARY, of acme. */
let carol: string;
/** `work_item:view` + `work_item:delete`, scoped to beta only — so an acme task is out of scope. */
let betaDeleter: { memberId: string; actor: MemberActor };
const extraUserIds: string[] = [];

type Principal = Parameters<typeof withTenant>[1];
const member = (): Principal => ({ type: "member", id: f.seats.owner.memberId });
const contact = (): Principal => ({ type: "contact", id: carol, clientId: acme });
const ownerCtx = () => ({ tenantId: f.tenantId, actor: f.seats.owner.actor });
const ctxOf = (actor: MemberActor) => ({ tenantId: f.tenantId, actor });

const doc = (words: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: words }] }] });
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
/** Letters + digits make a `numword` token the search configs pass through unstemmed (tree-guards.dbtest.ts). */
const word = (stem: string) => `${stem}${randomUUID().replace(/-/g, "").slice(0, 8)}7`;
const DAY = 86_400_000;

async function task(title: string, opts: { parentId?: string; projectId?: string } = {}): Promise<string> {
  const { id } = await createItem(ownerCtx(), {
    projectId: opts.projectId ?? pOn,
    title: `${title} ${run}`,
    ...(opts.parentId ? { parentId: opts.parentId } : {}),
  });
  return id;
}

async function sharedTask(title: string): Promise<string> {
  const id = await task(title);
  await changeItemVisibility(ownerCtx(), id, "CLIENT_VISIBLE");
  return id;
}

const memberComment = async (itemId: string, visibility: "INTERNAL" | "CLIENT_VISIBLE", words: string) =>
  (await createComment(ownerCtx(), itemId, { doc: doc(words), visibility })).id;

/** A contact's comment through the census — an INSERT under the contact principal (visibility.dbtest.ts' shape). */
const contactComment = async (itemId: string, words: string) =>
  (
    await withTenant(f.tenantId, contact(), (tx) =>
      tx.comment.create({
        data: {
          tenantId: f.tenantId,
          subjectType: "WORK_ITEM",
          subjectId: itemId,
          authorContactId: carol,
          body: doc(words),
          bodyText: words,
          visibility: "CLIENT_VISIBLE",
        },
        select: { id: true },
      }),
    )
  ).id;

/** A comment planted through the platform client — on a file or a version, which no member service writes. */
const rawComment = async (
  subjectType: "DOCUMENT" | "FILE_VERSION",
  subjectId: string,
  visibility: "INTERNAL" | "CLIENT_VISIBLE",
  words: string,
) =>
  (
    await f.platform.comment.create({
      data: {
        tenantId: f.tenantId,
        subjectType,
        subjectId,
        authorMemberId: f.seats.owner.memberId,
        body: doc(words),
        bodyText: words,
        visibility,
      },
      select: { id: true },
    })
  ).id;

/** A file attached to a task with one committed version (visibility.dbtest.ts' `plantFile`). */
async function plantFile(itemId: string, visibility: "INTERNAL" | "CLIENT_VISIBLE", name: string) {
  const item = await f.platform.workItem.findUniqueOrThrow({
    where: { id: itemId },
    select: { clientId: true, projectId: true },
  });
  const objectId = randomUUID();
  await f.platform.fileObject.create({
    data: {
      id: objectId,
      tenantId: f.tenantId,
      r2Key: `${f.tenantId}/${objectId}`,
      sha256: sha(objectId),
      sizeBytes: BigInt(7),
      contentType: "text/plain",
      status: "COMMITTED",
      committedAt: new Date(),
    },
  });
  const documentId = randomUUID();
  const versionId = randomUUID();
  await f.platform.document.create({
    data: {
      id: documentId,
      tenantId: f.tenantId,
      clientId: item.clientId,
      projectId: item.projectId,
      name,
      visibility,
      attachedToType: "WORK_ITEM",
      attachedToId: itemId,
      versions: { create: { id: versionId, versionNumber: 1, fileObjectId: objectId } },
    },
  });
  return { documentId, versionId };
}

const itemRow = (id: string) =>
  f.platform.workItem.findUniqueOrThrow({
    where: { id },
    select: { visibility: true, deletedAt: true, assigneeContactId: true, contactCompletedAt: true },
  });
const commentRow = (id: string) =>
  f.platform.comment.findUniqueOrThrow({ where: { id }, select: { visibility: true, deletedAt: true } });
const docRow = (id: string) =>
  f.platform.document.findUniqueOrThrow({ where: { id }, select: { visibility: true, deletedAt: true } });

const auditIds = async () =>
  new Set(
    (await f.platform.auditEvent.findMany({ where: { tenantId: f.tenantId }, select: { id: true } })).map((r) => r.id),
  );
const auditsSince = async (before: ReadonlySet<string>) =>
  (
    await f.platform.auditEvent.findMany({
      where: { tenantId: f.tenantId },
      orderBy: { id: "asc" },
      select: { id: true, action: true, targetType: true, targetId: true, metadata: true },
    })
  ).filter((r) => !before.has(r.id));

/** A refusal as one comparable string — `authz:NOT_FOUND`, `domain:BIN_CLOSED` — or `resolved`. */
const refusal = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "resolved";
  } catch (e) {
    if (e instanceof AuthzError) return `authz:${e.reason}`;
    if (e instanceof DomainError) return `domain:${e.code}`;
    throw e;
  }
};

/** What the CLIENT's own principal can read by id, with no filter of ours — `portal_gate` answers. */
async function clientReads(ids: { items?: string[]; comments?: string[]; documents?: string[] }) {
  return withTenant(f.tenantId, contact(), async (tx) => ({
    items: (await tx.workItem.findMany({ where: { id: { in: ids.items ?? [] } }, select: { id: true } })).length,
    comments: (await tx.comment.findMany({ where: { id: { in: ids.comments ?? [] } }, select: { id: true } })).length,
    documents: (await tx.document.findMany({ where: { id: { in: ids.documents ?? [] } }, select: { id: true } })).length,
  }));
}

/** How many of a task's history rows the client's own principal can read. */
const clientHistory = (itemId: string) =>
  withTenant(f.tenantId, contact(), (tx) => tx.workItemActivity.count({ where: { workItemId: itemId } }));

async function searchCount(principal: Principal, term: string): Promise<number> {
  return withTenant(f.tenantId, principal, async (tx) => {
    const rows = await tx.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM search_index
        WHERE search @@ websearch_to_tsquery('public.fortleva_sv', $1)`,
      term,
    );
    return rows[0]?.n ?? -1;
  });
}

/** An import job of this project, UNDONE (its Bring back still open) or DONE (brought back already). */
async function importJob(status: "UNDONE" | "DONE"): Promise<string> {
  const now = new Date();
  const job = await f.platform.importJob.create({
    data: {
      tenantId: f.tenantId,
      projectId: pOn,
      source: "TRELLO",
      fileName: "board.json",
      rowCount: 1,
      startedByMemberId: f.seats.owner.memberId,
      startedAt: now,
      lastWriteAt: now,
      status,
      // The job's CHECKs: an undo counts no more than the import created.
      ...(status === "UNDONE"
        ? { createdCount: 1, undoneAt: now, undoneByMemberId: f.seats.owner.memberId, undoneCount: 1 }
        : {}),
    },
    select: { id: true },
  });
  return job.id;
}

/** The record an import's undo writes on a task it removed (import/service.ts) — planted as the NEWEST. */
const plantUndoRecord = (itemId: string, jobId: string) =>
  f.platform.auditEvent.create({
    data: {
      tenantId: f.tenantId,
      actorType: "MEMBER",
      actorId: f.seats.owner.memberId,
      action: "work_item.deleted",
      targetType: "WorkItem",
      targetId: itemId,
      metadata: { reason: "import_undone", importJobId: jobId },
      visibility: "TENANT",
    },
  });

/** Moves a deletion back in time — the task's stamp and everything that shares it, so the two keys still agree. */
async function ageDeletion(itemId: string, days: number) {
  const row = await f.platform.workItem.findUniqueOrThrow({ where: { id: itemId }, select: { deletedAt: true } });
  const older = new Date(row.deletedAt!.getTime() - days * DAY);
  await f.platform.$executeRaw`
    UPDATE comment SET deleted_at = ${older}
     WHERE tenant_id = ${f.tenantId} AND subject_type = 'WORK_ITEM' AND subject_id = ${itemId}
       AND deleted_at = (SELECT deleted_at FROM work_item WHERE id = ${itemId})`;
  await f.platform.$executeRaw`UPDATE work_item SET deleted_at = ${older} WHERE id = ${itemId}`;
}

beforeAll(async () => {
  f = await setupTenant("bin");
  acme = randomUUID();
  beta = randomUUID();
  pOn = randomUUID();
  pBeta = randomUUID();
  carol = randomUUID();
  const up = run.slice(0, 3).toUpperCase();
  await f.platform.client.createMany({
    data: [
      { id: acme, tenantId: f.tenantId, name: `Acme ${run}` },
      { id: beta, tenantId: f.tenantId, name: `Beta ${run}` },
    ],
  });
  await f.platform.project.createMany({
    data: [
      { id: pOn, tenantId: f.tenantId, clientId: acme, key: `BNA${up}`, name: `Site ${run}`, portalEnabled: true },
      { id: pBeta, tenantId: f.tenantId, clientId: beta, key: `BNB${up}`, name: `Beta ${run}`, portalEnabled: true },
    ],
  });
  await f.platform.contact.create({
    data: {
      id: carol,
      tenantId: f.tenantId,
      clientId: acme,
      name: "Carol",
      email: `bin-carol-${run}@test.invalid`,
      portalProfile: "CONTACT_PRIMARY",
      portalStatus: "ACTIVE",
      invitedAt: new Date("2026-09-01T09:00:00Z"),
      emailVerified: true,
    },
  });
  // A seat that may delete, scoped to BETA only: the scope gate observable.
  // THE CATALOGUE MUST BE SEEDED — with no `permission` rows the role holds
  // nothing and every refusal would pass for the wrong reason.
  const userId = randomUUID();
  const email = `bin-deleter-${run}@test.invalid`;
  await f.platform.user.create({ data: { id: userId, name: email, email } });
  extraUserIds.push(userId);
  const seat = await f.platform.member.create({ data: { tenantId: f.tenantId, userId } });
  const role = await f.platform.role.create({ data: { tenantId: f.tenantId, name: `Beta deleter ${run}` } });
  const codes = ["work_item:delete", "work_item:view"];
  const perms = await f.platform.permission.findMany({ where: { code: { in: codes } } });
  expect(perms.map((p) => p.code).sort()).toEqual(codes);
  await f.platform.rolePermission.createMany({
    data: perms.map((p) => ({ tenantId: f.tenantId, roleId: role.id, permissionId: p.id })),
  });
  await f.platform.memberRole.create({ data: { tenantId: f.tenantId, memberId: seat.id, roleId: role.id } });
  await f.platform.memberClient.create({ data: { tenantId: f.tenantId, memberId: seat.id, clientId: beta } });
  betaDeleter = { memberId: seat.id, actor: actorFor(seat.id) };
  // The EMPLOYEE in acme's scope: it holds `work_item:view` and not
  // `work_item:delete`, so on acme's tasks only the CODE can refuse it.
  await f.platform.memberClient.create({ data: { tenantId: f.tenantId, memberId: f.seats.employee.memberId, clientId: acme } });
}, LONG);

afterAll(async () => {
  if (!f?.tenantId) return;
  const db = f.platform;
  const tenantId = f.tenantId;
  await db.$executeRaw`DELETE FROM search_index WHERE tenant_id = ${tenantId}`;
  await db.notification.deleteMany({ where: { tenantId } });
  await db.emailOutbox.deleteMany({ where: { tenantId } });
  await db.comment.deleteMany({ where: { tenantId } });
  await db.workItemActivity.deleteMany({ where: { tenantId } });
  await db.fileVersion.deleteMany({ where: { tenantId } });
  await db.document.deleteMany({ where: { tenantId } });
  await db.fileObject.deleteMany({ where: { tenantId } });
  await db.workItem.deleteMany({ where: { tenantId, depth: 2 } });
  await db.workItem.deleteMany({ where: { tenantId, depth: 1 } });
  await db.workItem.deleteMany({ where: { tenantId } });
  await db.importJob.deleteMany({ where: { tenantId } });
  await db.workflowState.deleteMany({ where: { tenantId } });
  await db.tenantCounter.deleteMany({ where: { tenantId } });
  await db.memberProject.deleteMany({ where: { tenantId } });
  await db.memberClient.deleteMany({ where: { tenantId } });
  await db.contact.deleteMany({ where: { tenantId } });
  await db.project.deleteMany({ where: { tenantId } });
  await db.client.deleteMany({ where: { tenantId } });
  await db.tenantPreference.deleteMany({ where: { tenantId } });
  await f.cleanup();
  await f.platform.user.deleteMany({ where: { id: { in: extraUserIds } } });
}, LONG);

// ═══════════════════════════════════════════════════════════════════════

describe("what is in a project's bin", () => {
  it("a task deleted by hand in the last 30 days, with who deleted it — not another project's, not an older one, not an undone import's", async () => {
    const mine = await task("Deleted by hand");
    const old = await task("Deleted long ago");
    const undone = await task("Removed by an import's undo");
    const skipped = await task("Removed by an undo, skipped by its Bring back");
    const elsewhere = await task("Another project's", { projectId: pBeta });
    const alive = await task("Still alive");
    for (const id of [mine, old, undone, skipped, elsewhere]) await deleteItem(ownerCtx(), id);
    await ageDeletion(old, 31);
    // `undone`'s import can still be brought back (UNDONE): its row is the
    // door. `skipped`'s import was brought back already (DONE) and left it
    // behind — the bin is its only way back (the pre-apply review's LOW).
    await plantUndoRecord(undone, await importJob("UNDONE"));
    await plantUndoRecord(skipped, await importJob("DONE"));

    const bin = await listDeletedItems(ownerCtx(), pOn);
    const ids = bin.entries.map((e) => e.id);
    expect(ids).toContain(mine);
    expect(ids).toContain(skipped);
    for (const id of [old, undone, elsewhere, alive]) expect(ids).not.toContain(id);
    const entry = bin.entries.find((e) => e.id === mine)!;
    const owner = await f.platform.member.findUniqueOrThrow({
      where: { id: f.seats.owner.memberId },
      select: { user: { select: { name: true } } },
    });
    expect(entry.deletedBy).toBe(owner.user.name);
    expect(entry.blocked).toBeNull();
    expect(bin.archived).toBe(false);
    expect(bin.more).toBe(false);

    // And the two the bin leaves out are refused by the verb, with the reason.
    expect(await refusal(restoreDeletedItem(ownerCtx(), old, "bin"))).toBe("domain:BIN_CLOSED");
    expect(await refusal(restoreDeletedItem(ownerCtx(), undone, "bin"))).toBe("domain:BIN_FROM_IMPORT");
    expect((await itemRow(old)).deletedAt).not.toBeNull();
    expect((await itemRow(undone)).deletedAt).not.toBeNull();
    expect(await restoreDeletedItem(ownerCtx(), skipped, "bin")).toMatchObject({ changed: true });
  }, LONG);
});

describe("bringing back a private task", () => {
  it("returns EXACTLY what its deletion took — not a comment or a file deleted by hand before it", async () => {
    const t = await task("Private with a thread");
    const kept = await memberComment(t, "INTERNAL", "a note that comes back");
    const handDeleted = await memberComment(t, "INTERNAL", "a note deleted by hand first");
    const file = await plantFile(t, "INTERNAL", `Spec ${run}`);
    const onFile = await rawComment("DOCUMENT", file.documentId, "INTERNAL", "on the file");
    const onVersion = await rawComment("FILE_VERSION", file.versionId, "INTERNAL", "on the version");
    const earlierFile = await plantFile(t, "INTERNAL", `Old spec ${run}`);
    await deleteComment(ownerCtx(), handDeleted);
    await f.platform.document.update({ where: { id: earlierFile.documentId }, data: { deletedAt: new Date(Date.now() - 60_000) } });

    await deleteItem(ownerCtx(), t);
    for (const c of [kept, onFile, onVersion]) expect((await commentRow(c)).deletedAt).not.toBeNull();

    const before = await auditIds();
    const r = await restoreDeletedItem(ownerCtx(), t, "undo");
    expect(r).toMatchObject({ id: t, changed: true, madePrivate: false, endedContactAssignment: false, files: 1, comments: 3 });

    expect((await itemRow(t)).deletedAt).toBeNull();
    expect((await docRow(file.documentId)).deletedAt).toBeNull();
    for (const c of [kept, onFile, onVersion]) expect(await commentRow(c)).toEqual({ visibility: "INTERNAL", deletedAt: null });
    // What was deleted before the task stays deleted.
    expect((await commentRow(handDeleted)).deletedAt).not.toBeNull();
    expect((await docRow(earlierFile.documentId)).deletedAt).not.toBeNull();

    const trail = await auditsSince(before);
    expect(trail.map((a) => a.action).sort()).toEqual(
      ["comment.restored", "comment.restored", "comment.restored", "document.restored", "work_item.restored"].sort(),
    );
    const restored = trail.find((a) => a.action === "work_item.restored")!;
    expect(restored.metadata).toMatchObject({ reason: "undo", files: 1, comments: 3, projectId: pOn });
    expect(restored.metadata).not.toHaveProperty("madePrivate");
    expect(trail.find((a) => a.targetId === onVersion)!.metadata).toMatchObject({
      workItemId: t,
      fileVersionId: file.versionId,
    });

    // Out of the bin; a second Bring back writes nothing.
    expect((await listDeletedItems(ownerCtx(), pOn)).entries.map((e) => e.id)).not.toContain(t);
    const again = await auditIds();
    expect(await restoreDeletedItem(ownerCtx(), t, "undo")).toMatchObject({ changed: false, files: 0, comments: 0 });
    expect(await auditsSince(again)).toEqual([]);
  }, LONG);

  it("a comment deleted BY HAND with the task's very stamp stays deleted — its newest record is not the cascade's", async () => {
    const t = await task("Same millisecond");
    const cascaded = await memberComment(t, "INTERNAL", "taken by the task's delete");
    const byHand = await memberComment(t, "INTERNAL", "deleted by hand in the same millisecond");
    // The race, planted: the hand delete commits first (so the cascade does
    // not take it), in the millisecond the task's delete then stamps. A hand
    // delete NAMES ITS TASK too (`removed_by_author`, comments.ts), so only
    // the reason tells it from the cascade's record.
    await deleteComment(ownerCtx(), byHand);
    const { deletedAt } = await deleteItem(ownerCtx(), t);
    await f.platform.comment.update({ where: { id: byHand }, data: { deletedAt }, select: { id: true } });
    const record = await f.platform.auditEvent.findFirstOrThrow({
      where: { tenantId: f.tenantId, targetType: "Comment", targetId: byHand, action: "comment.deleted" },
      select: { metadata: true },
    });
    expect(record.metadata).toMatchObject({ workItemId: t });

    expect(await restoreDeletedItem(ownerCtx(), t, "bin")).toMatchObject({ changed: true, comments: 1 });
    expect((await commentRow(cascaded)).deletedAt).toBeNull();
    expect((await commentRow(byHand)).deletedAt).not.toBeNull();
  }, LONG);

  it("an Undo names its deletion: after the task was brought back and deleted again, it brings back nothing", async () => {
    const t = await task("Undo after a colleague");
    const first = await deleteItem(ownerCtx(), t);
    await restoreDeletedItem(ctxOf(f.seats.manager.actor), t, "bin");
    await deleteItem(ctxOf(f.seats.manager.actor), t);
    const before = await auditIds();
    expect(await restoreDeletedItem(ownerCtx(), t, "undo", first.deletedAt)).toMatchObject({
      changed: false,
      superseded: true,
    });
    expect((await itemRow(t)).deletedAt).not.toBeNull();
    expect(await auditsSince(before)).toEqual([]);
    // Its OWN deletion it brings back.
    const second = await f.platform.workItem.findUniqueOrThrow({ where: { id: t }, select: { deletedAt: true } });
    expect(await restoreDeletedItem(ownerCtx(), t, "undo", second.deletedAt!)).toMatchObject({ changed: true });
  }, LONG);

  it("deleted, brought back, a comment deleted by hand, deleted again, brought back: the second deletion's set only", async () => {
    const t = await task("Twice deleted");
    const a = await memberComment(t, "INTERNAL", "stays with the task");
    const b = await memberComment(t, "INTERNAL", "deleted by hand in between");
    await deleteItem(ownerCtx(), t);
    expect(await restoreDeletedItem(ownerCtx(), t, "bin")).toMatchObject({ comments: 2 });
    // `b`'s FIRST cascade record still names the task — the audit key alone
    // would take it again; the stamp says it is not this deletion's.
    await deleteComment(ownerCtx(), b);
    await deleteItem(ownerCtx(), t);
    expect(await restoreDeletedItem(ownerCtx(), t, "bin")).toMatchObject({ changed: true, comments: 1 });
    expect((await commentRow(a)).deletedAt).toBeNull();
    expect((await commentRow(b)).deletedAt).not.toBeNull();
  }, LONG);
});

describe("bringing back a task the client could see (C102 (b))", () => {
  it("comes back private with its thread and files; a hand-over ends; the client reads none of it; a share returns the client's own words (C37)", async () => {
    const titleWord = word("binord");
    const s = await sharedTask(`Shared ${titleWord}`);
    await assignItemToContact(ownerCtx(), s, carol);
    const theirs = await contactComment(s, "the client's own words");
    const reply = await memberComment(s, "CLIENT_VISIBLE", "our reply to the client");
    const note = await memberComment(s, "INTERNAL", "our internal note");
    const file = await plantFile(s, "CLIENT_VISIBLE", `Delivery ${run}`);
    const onFile = await rawComment("DOCUMENT", file.documentId, "CLIENT_VISIBLE", "on the delivery");
    // The client's own words on the FILE — no contact writer exists for a
    // file yet, so planted, attributed to Carol.
    const theirsOnFile = (
      await f.platform.comment.create({
        data: {
          tenantId: f.tenantId,
          subjectType: "DOCUMENT",
          subjectId: file.documentId,
          authorContactId: carol,
          body: doc("the client's words on the file"),
          bodyText: "the client's words on the file",
          visibility: "CLIENT_VISIBLE",
        },
        select: { id: true },
      })
    ).id;
    // Positive control: while it lives, the client reads all of it by id —
    // the hand-over's history row included (a portal-safe field on a shared
    // task is written client-visible).
    expect(
      await clientReads({ items: [s], comments: [theirs, reply, onFile, theirsOnFile], documents: [file.documentId] }),
    ).toEqual({ items: 1, comments: 4, documents: 1 });
    expect(await clientHistory(s)).toBeGreaterThan(0);
    expect(await searchCount(contact(), titleWord)).toBe(1);

    await deleteItem(ownerCtx(), s);
    expect(await searchCount(contact(), titleWord)).toBe(0);

    const r = await restoreDeletedItem(ownerCtx(), s, "bin");
    expect(r).toMatchObject({ changed: true, madePrivate: true, endedContactAssignment: true, files: 1, comments: 5 });

    expect(await itemRow(s)).toEqual({
      visibility: "INTERNAL",
      deletedAt: null,
      assigneeContactId: null,
      contactCompletedAt: null,
    });
    for (const c of [theirs, reply, note, onFile, theirsOnFile]) {
      expect(await commentRow(c)).toEqual({ visibility: "INTERNAL", deletedAt: null });
    }
    expect(await docRow(file.documentId)).toEqual({ visibility: "INTERNAL", deletedAt: null });
    // THE CLIENT'S SIDE: the same reads by id find nothing — `portal_gate`
    // answers — and neither does their search; the team's does.
    expect(
      await clientReads({ items: [s], comments: [theirs, reply, note, onFile, theirsOnFile], documents: [file.documentId] }),
    ).toEqual({ items: 0, comments: 0, documents: 0 });
    // The history the client could read went private with the task (the
    // downgrade trigger, inside the restore's own UPDATE).
    expect(await clientHistory(s)).toBe(0);
    expect(await searchCount(contact(), titleWord)).toBe(0);
    expect(await searchCount(member(), titleWord)).toBe(1);
    // Every history row of the task is the team's now (the downgrade trigger
    // flipped the old ones), and the restore wrote make-private's rows.
    const history = await f.platform.workItemActivity.findMany({
      where: { tenantId: f.tenantId, workItemId: s },
      select: { field: true, visibility: true, commentId: true, newValue: true, newRef: true, oldRef: true },
    });
    expect(history.every((h) => h.visibility === "INTERNAL")).toBe(true);
    expect(history.some((h) => h.field === "visibility" && h.newValue === "INTERNAL")).toBe(true);
    expect(history.some((h) => h.field === "assigneeContactId" && h.oldRef === carol && h.newRef === null)).toBe(true);
    const lowered = history.filter((h) => h.field === "commentVisibility" && h.newValue === "INTERNAL").map((h) => h.commentId);
    expect(lowered).toEqual(expect.arrayContaining([theirs, reply]));

    // Sharing it again is a fresh decision — and it brings the client's own
    // words back with it (C37), not our reply, not the file.
    await changeItemVisibility(ownerCtx(), s, "CLIENT_VISIBLE");
    expect((await commentRow(theirs)).visibility).toBe("CLIENT_VISIBLE");
    expect((await commentRow(reply)).visibility).toBe("INTERNAL");
    expect((await docRow(file.documentId)).visibility).toBe("INTERNAL");
    // Their words on the file stay with the file, which stays private (the
    // slice-72 residual: nothing raises a client's comment on a file).
    expect((await commentRow(theirsOnFile)).visibility).toBe("INTERNAL");
    expect(await clientReads({ items: [s], comments: [theirs, reply, note, onFile, theirsOnFile] })).toEqual({
      items: 1,
      comments: 1,
      documents: 0,
    });
  }, LONG);

  it("THE DATABASE refuses bringing a task back client-visible, whoever writes it (20261030090000)", async () => {
    const s = await sharedTask("Raw restore");
    await deleteItem(ownerCtx(), s);
    await expect(
      f.platform.workItem.update({ where: { id: s }, data: { deletedAt: null }, select: { id: true } }),
    ).rejects.toThrow(/RESTORE_NOT_PRIVATE/);
    await f.platform.workItem.update({
      where: { id: s },
      data: { deletedAt: null, visibility: "INTERNAL" },
      select: { id: true },
    });
    expect((await itemRow(s)).visibility).toBe("INTERNAL");
  }, LONG);
});

describe("who may bring a task back, and when not", () => {
  it("needs the delete code and the project in scope", async () => {
    const t = await task("Gated");
    await deleteItem(ownerCtx(), t);
    // The employee may not delete (C M), so may not bring back either — the
    // code answers, not the scope (the employee reaches acme).
    expect(await refusal(restoreDeletedItem(ctxOf(f.seats.employee.actor), t, "bin"))).toBe("authz:FORBIDDEN");
    expect(await refusal(listDeletedItems(ctxOf(f.seats.employee.actor), pOn))).toBe("authz:FORBIDDEN");
    // A seat that may delete, but only beta's work, cannot see acme's.
    expect(await refusal(restoreDeletedItem(ctxOf(betaDeleter.actor), t, "bin"))).toBe("authz:NOT_FOUND");
    expect(await refusal(listDeletedItems(ctxOf(betaDeleter.actor), pOn))).toBe("authz:NOT_FOUND");
    expect((await itemRow(t)).deletedAt).not.toBeNull();
    // The manager may (C M).
    expect(await restoreDeletedItem(ctxOf(f.seats.manager.actor), t, "bin")).toMatchObject({ changed: true });
  }, LONG);

  it("a subtask waits for its parent: the row says which, the verb refuses, and parent first works", async () => {
    const parent = await task("Parent");
    const child = await task("Child", { parentId: parent });
    await deleteItem(ownerCtx(), child);
    await deleteItem(ownerCtx(), parent);
    const parentNumber = (await f.platform.workItem.findUniqueOrThrow({ where: { id: parent }, select: { number: true } })).number;
    const bin = await listDeletedItems(ownerCtx(), pOn);
    expect(bin.entries.find((e) => e.id === child)!.blocked).toEqual({ reason: "parent_in_bin", parentNumber });
    expect(bin.entries.find((e) => e.id === parent)!.blocked).toBeNull();
    expect(await refusal(restoreDeletedItem(ownerCtx(), child, "bin"))).toBe("domain:BIN_PARENT_DELETED");
    await restoreDeletedItem(ownerCtx(), parent, "bin");
    expect(await restoreDeletedItem(ownerCtx(), child, "bin")).toMatchObject({ changed: true });

    // A parent an import's undo removed comes back from the import's row:
    // the child's row says so, rather than naming a task the bin hides.
    await deleteItem(ownerCtx(), child);
    await deleteItem(ownerCtx(), parent);
    await plantUndoRecord(parent, await importJob("UNDONE"));
    const again = await listDeletedItems(ownerCtx(), pOn);
    expect(again.entries.map((e) => e.id)).not.toContain(parent);
    expect(again.entries.find((e) => e.id === child)!.blocked).toEqual({ reason: "parent_from_import" });
  }, LONG);

  it("not in an archived project", async () => {
    const pArch = randomUUID();
    await f.platform.project.create({
      data: { id: pArch, tenantId: f.tenantId, clientId: acme, key: `BNC${run.slice(0, 3).toUpperCase()}`, name: `Old ${run}` },
    });
    const t = await task("In a project that will be archived", { projectId: pArch });
    await deleteItem(ownerCtx(), t);
    await f.platform.project.update({ where: { id: pArch }, data: { status: "ARCHIVED" } });
    const bin = await listDeletedItems(ownerCtx(), pArch);
    expect(bin.archived).toBe(true);
    expect(bin.entries.find((e) => e.id === t)!.blocked).toEqual({ reason: "archived" });
    expect(await refusal(restoreDeletedItem(ownerCtx(), t, "bin"))).toBe("domain:ARCHIVED");
  }, LONG);

  it("not when a task imported from the same card is in the project now", async () => {
    const imported = {
      source: "IMPORT" as const,
      importJobId: await importJob("DONE"),
      sourceSystem: "trello",
      sourceId: `card-${run}`,
    };
    const first = await task("Imported, then deleted");
    await f.platform.workItem.update({ where: { id: first }, data: imported, select: { id: true } });
    await deleteItem(ownerCtx(), first);
    const twin = await task("Imported again");
    await f.platform.workItem.update({ where: { id: twin }, data: imported, select: { id: true } });
    expect(await refusal(restoreDeletedItem(ownerCtx(), first, "bin"))).toBe("domain:BIN_SOURCE_TWIN");
    expect((await itemRow(first)).deletedAt).not.toBeNull();
    // ...and the bin draws it disabled with the reason, before any press.
    const bin = await listDeletedItems(ownerCtx(), pOn);
    expect(bin.entries.find((e) => e.id === first)!.blocked).toEqual({ reason: "source_twin" });
  }, LONG);
});

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withTenant, type TenantDb } from "@/db";
import { setupTenant } from "@/members/dbtest-fixture";
import {
  bulkSetArchived,
  bulkSetPriority,
  changeItemVisibility,
  changeState,
  createItem,
  deleteItem,
  moveItem,
  updateItemFields,
} from "./index";
import { expectLockTimeout, settle } from "./dbtest-locks";
import { lockProjectRanks } from "./rank-lock";

/**
 * The work-tree guards of 20260911200000_work_tree_guards, against the
 * real database and the real app_runtime role:
 *
 *  - The write-skew: a CLIENT_VISIBLE child and a downgrade of its
 *    parent, committing concurrently, each used to pass a guard blind to
 *    the other's uncommitted row. Both orders are driven with a HELD
 *    transaction and `lock_timeout` on the other writer, so each test
 *    fails on the old trigger instead of passing by luck of timing:
 *    without the share lock the second writer does not wait at all.
 *  - The same lock settles a subtask racing its parent's delete, in both
 *    orders (the trigger refuses a dead new parent; createItem locks the
 *    parent before reading it; deleteItem counts children only after it
 *    holds the row).
 *  - The lock is taken ONLY where it enforces something: a subtask's
 *    make-private never waits on its parent.
 *  - Restore: a row soft-deleted under a visible item, which the item's
 *    make-private rightly ignores, can never be restored into view under
 *    the now-private item — proven under a CONTACT principal against
 *    search_index, the table a contact would find it through.
 *  - The trigger tokens reach callers as typed DomainErrors.
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
let clientId: string;
let projectId: string;
let defaultState: { id: string; category: "BACKLOG" | "TODO" | "IN_PROGRESS" | "DONE" | "CANCELLED" | "TRIAGE" };
const contactId = randomUUID();

beforeAll(async () => {
  f = await setupTenant("tree");
  clientId = randomUUID();
  projectId = randomUUID();
  await f.platform.client.create({ data: { id: clientId, tenantId: f.tenantId, name: "Treeco" } });
  await f.platform.project.create({
    data: { id: projectId, tenantId: f.tenantId, clientId, key: "TREE", name: "Tree site", portalEnabled: true },
  });
  await f.platform.contact.create({
    data: {
      id: contactId,
      tenantId: f.tenantId,
      clientId,
      name: "Client Tove",
      email: `tove-${randomUUID().slice(0, 8)}@test.invalid`,
    },
  });
  // Seeds the project's states (lazily, as the first create does).
  await createItem(ownerCtx(), { projectId, title: "Seed" });
  defaultState = await f.platform.workflowState.findFirstOrThrow({
    where: { tenantId: f.tenantId, projectId, isDefault: true },
    select: { id: true, category: true },
  });
}, 60_000);

afterAll(async () => {
  const db = f.platform;
  await db.document.deleteMany({ where: { tenantId: f.tenantId } });
  await db.comment.deleteMany({ where: { tenantId: f.tenantId } });
  await db.workItemActivity.deleteMany({ where: { tenantId: f.tenantId } });
  await db.workItem.deleteMany({ where: { tenantId: f.tenantId, parentId: { not: null } } });
  await db.workItem.deleteMany({ where: { tenantId: f.tenantId } });
  await db.workflowState.deleteMany({ where: { tenantId: f.tenantId } });
  await db.contact.deleteMany({ where: { tenantId: f.tenantId } });
  await db.project.deleteMany({ where: { tenantId: f.tenantId } });
  await db.client.deleteMany({ where: { tenantId: f.tenantId } });
  await db.tenantCounter.deleteMany({ where: { tenantId: f.tenantId } });
  await f.cleanup();
}, 60_000);

const ownerCtx = () => ({ tenantId: f.tenantId, actor: f.seats.owner.actor });
const member = () => ({ type: "member", id: f.seats.owner.memberId }) as const;
const contact = () => ({ type: "contact", id: contactId, clientId }) as const;

/** A root task, shared with the client. */
async function visibleTask(title: string): Promise<string> {
  const { id } = await createItem(ownerCtx(), { projectId, title });
  await changeItemVisibility(ownerCtx(), id, "CLIENT_VISIBLE");
  return id;
}

/** A raw subtask insert, so a test controls the transaction it runs in. */
let rawNumber = 50_000;
async function rawChild(
  tx: TenantDb,
  parentId: string,
  visibility: "INTERNAL" | "CLIENT_VISIBLE",
  title: string,
): Promise<string> {
  const id = randomUUID();
  await tx.workItem.create({
    data: {
      id,
      tenantId: f.tenantId,
      clientId,
      projectId,
      number: rawNumber++,
      type: "SUBTASK",
      title,
      stateId: defaultState.id,
      stateCategory: defaultState.category,
      parentId,
      rootId: id, // the parent guard derives the real root and depth
      // A VALID fractional key (base-62, fraction never ending in '0')
      // that sorts before every generated 'a…' key: a raw row must never
      // become the project's bottom row, or createItem's bottomRank would
      // both depend on it and lock it. (`zz-<uuid>` was invalid 1 in 16.)
      rank: `Zz${randomUUID().replace(/-/g, "")}1`,
      visibility,
      createdByMemberId: f.seats.owner.memberId,
    },
  });
  return id;
}

// `settle`, `describeError`, `expectLockTimeout`: dbtest-locks.ts (shared
// with comments.dbtest.ts since slice 10).

/**
 * Resolves once some transaction is blocked on a lock — the moment to
 * release the holder — with the lock types being waited on ('advisory'
 * for the project's rank lock; 'transactionid'/'tuple' for a row).
 */
async function waitForLockWaiter(): Promise<string[]> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const rows = await f.platform.$queryRaw<{ locktype: string }[]>`
      SELECT locktype FROM pg_locks WHERE NOT granted`;
    if (rows.length > 0) return rows.map((r) => r.locktype);
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("no transaction ever waited on a lock — the race was not exercised");
}

/**
 * A transaction that runs `body`, signals, stays open until released,
 * then runs `after` (still inside the same transaction) and commits.
 */
function holdOpen(
  principal: ReturnType<typeof member>,
  body: (tx: TenantDb) => Promise<unknown>,
  after?: (tx: TenantDb) => Promise<unknown>,
) {
  let ready!: () => void;
  let release!: () => void;
  const isReady = new Promise<void>((r) => (ready = r));
  const released = new Promise<void>((r) => (release = r));
  const done = withTenant(
    f.tenantId,
    principal,
    async (tx) => {
      await body(tx);
      ready();
      await released;
      if (after) await after(tx);
    },
    { timeoutMs: 20_000 },
  );
  return { isReady, release, done };
}

/** Lock one work_item row FOR UPDATE, as moveItem's anchor / neighbour reads do. */
const lockRow = (tx: TenantDb, id: string) =>
  tx.$queryRaw`SELECT id FROM work_item WHERE tenant_id = ${f.tenantId} AND id = ${id} FOR UPDATE`;

/** search_index matches for a term, as a principal would see them. */
async function searchCount(principal: Parameters<typeof withTenant>[1], term: string): Promise<number> {
  return withTenant(f.tenantId, principal, async (tx) => {
    const rows = await tx.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM search_index
        WHERE search @@ websearch_to_tsquery('public.fortleva_sv', $1)`,
      term,
    );
    return rows[0]?.n ?? -1;
  });
}

// Letters + digits make a `numword` token, which the text-search configs
// pass through unstemmed — so the probe matches whatever the tenant's
// search language is (the same reason work.dbtest's probe word works).
const word = (stem: string) => `${stem}${randomUUID().replace(/-/g, "").slice(0, 8)}7`;

describe("a client-visible child and its parent's downgrade serialise", () => {
  it("child first: the downgrade WAITS for the child's share lock, then refuses (HAS_VISIBLE_CHILDREN)", async () => {
    const parent = await visibleTask("Race parent, child first");
    const holder = holdOpen(member(), (tx) => rawChild(tx, parent, "CLIENT_VISIBLE", "Child in flight"));
    try {
      await holder.isReady;
      await expectLockTimeout(
        withTenant(f.tenantId, member(), async (tx) => {
          await tx.$executeRaw`SET LOCAL lock_timeout = '300ms'`;
          await tx.workItem.update({ where: { id: parent }, data: { visibility: "INTERNAL" } });
        }),
      );
    } finally {
      holder.release();
      await holder.done;
    }
    // The child is committed now, and the guard sees it.
    await expect(changeItemVisibility(ownerCtx(), parent, "INTERNAL")).rejects.toMatchObject({
      code: "HAS_VISIBLE_CHILDREN",
    });
    const row = await f.platform.workItem.findUniqueOrThrow({ where: { id: parent } });
    expect(row.visibility).toBe("CLIENT_VISIBLE");
  });

  it("downgrade first: the child insert WAITS, then re-reads the parent as private and is refused", async () => {
    const parent = await visibleTask("Race parent, downgrade first");
    const holder = holdOpen(member(), (tx) =>
      tx.workItem.update({ where: { id: parent }, data: { visibility: "INTERNAL" } }),
    );
    try {
      await holder.isReady;
      await expectLockTimeout(
        withTenant(f.tenantId, member(), async (tx) => {
          await tx.$executeRaw`SET LOCAL lock_timeout = '300ms'`;
          await rawChild(tx, parent, "CLIENT_VISIBLE", "Child that must not land");
        }),
      );
    } finally {
      holder.release();
      await holder.done;
    }
    await expect(
      withTenant(f.tenantId, member(), (tx) => rawChild(tx, parent, "CLIENT_VISIBLE", "Still refused")),
    ).rejects.toThrow(/WORK_TREE_CHILD_VISIBILITY/);
    // Positive control: a private child under the private parent is fine.
    await withTenant(f.tenantId, member(), (tx) => rawChild(tx, parent, "INTERNAL", "Private child"));
    const visibleChildren = await f.platform.workItem.count({
      where: { tenantId: f.tenantId, parentId: parent, visibility: "CLIENT_VISIBLE" },
    });
    expect(visibleChildren).toBe(0);
  });
});

describe("a subtask racing its parent's delete never ends up under a dead parent", () => {
  it("delete first, at the trigger: a raw subtask insert WAITS on the dying parent, then is refused", async () => {
    const { id: parent } = await createItem(ownerCtx(), { projectId, title: "Parent being deleted (raw)" });
    const holder = holdOpen(member(), (tx) =>
      tx.workItem.update({ where: { id: parent }, data: { deletedAt: new Date() } }),
    );
    try {
      await holder.isReady;
      // An INTERNAL child: the lock is taken for any NEW parent, not only
      // for a visible child — liveness is what it protects here.
      await expectLockTimeout(
        withTenant(f.tenantId, member(), async (tx) => {
          await tx.$executeRaw`SET LOCAL lock_timeout = '300ms'`;
          await rawChild(tx, parent, "INTERNAL", "Orphan-to-be");
        }),
      );
    } finally {
      holder.release();
      await holder.done;
    }
    await expect(
      withTenant(f.tenantId, member(), (tx) => rawChild(tx, parent, "INTERNAL", "Still an orphan")),
    ).rejects.toThrow(/WORK_TREE_PARENT_GONE/);
    expect(await f.platform.workItem.count({ where: { tenantId: f.tenantId, parentId: parent } })).toBe(0);
  });

  it("delete first, through createItem: it locks the parent before reading it, waits, and finds it gone (NOT_FOUND)", async () => {
    const { id: parent } = await createItem(ownerCtx(), { projectId, title: "Parent being deleted" });
    const holder = holdOpen(member(), (tx) =>
      tx.workItem.update({ where: { id: parent }, data: { deletedAt: new Date() } }),
    );
    let creating: Promise<unknown> = Promise.resolve(null);
    try {
      await holder.isReady;
      creating = settle(createItem(ownerCtx(), { projectId, title: "Orphan-to-be", parentId: parent }));
      await waitForLockWaiter();
    } finally {
      holder.release();
      await holder.done;
    }
    expect(await creating).toMatchObject({ name: "AuthzError", reason: "NOT_FOUND" });
    expect(await f.platform.workItem.count({ where: { tenantId: f.tenantId, parentId: parent } })).toBe(0);
  });

  it("insert first: the delete waits for the child, then counts it and refuses (HAS_CHILDREN)", async () => {
    const { id: parent } = await createItem(ownerCtx(), { projectId, title: "Parent with a child in flight" });
    const holder = holdOpen(member(), (tx) => rawChild(tx, parent, "INTERNAL", "Child in flight"));
    let deleting: Promise<unknown> = Promise.resolve(null);
    try {
      await holder.isReady;
      deleting = settle(deleteItem(ownerCtx(), parent));
      await waitForLockWaiter();
    } finally {
      holder.release();
      await holder.done;
    }
    expect(await deleting).toMatchObject({ code: "HAS_CHILDREN" });
    const row = await f.platform.workItem.findUniqueOrThrow({ where: { id: parent } });
    expect(row.deletedAt).toBeNull(); // the stamp rolled back with the refusal
  });

  it("a delete with a live child is refused as HAS_CHILDREN, not as a permission denial; once the child goes, it succeeds", async () => {
    const { id: parent } = await createItem(ownerCtx(), { projectId, title: "Parent" });
    const { id: child } = await createItem(ownerCtx(), { projectId, title: "Child", parentId: parent });
    await expect(deleteItem(ownerCtx(), parent)).rejects.toMatchObject({ code: "HAS_CHILDREN" });
    await deleteItem(ownerCtx(), child);
    await deleteItem(ownerCtx(), parent);
    const row = await f.platform.workItem.findUniqueOrThrow({ where: { id: parent } });
    expect(row.deletedAt).not.toBeNull();
  });
});

describe("the parent lock is taken only where it enforces something", () => {
  it("a subtask's make-private never waits on its parent; a raise to client-visible does", async () => {
    const parent = await visibleTask("Busy parent");
    const { id: shared } = await createItem(ownerCtx(), { projectId, title: "Shared subtask", parentId: parent });
    const { id: privateOne } = await createItem(ownerCtx(), { projectId, title: "Private subtask", parentId: parent });
    await changeItemVisibility(ownerCtx(), privateOne, "INTERNAL");
    // Another writer holds the parent's row (any no-key update — a title
    // edit, a state move, a rank neighbour lock).
    const holder = holdOpen(member(), (tx) =>
      tx.workItem.update({ where: { id: parent }, data: { title: "Busy parent, renamed" } }),
    );
    try {
      await holder.isReady;
      // The lever: through the real service, while the parent is held. A
      // wait here would hang until the transaction budget and fail.
      await changeItemVisibility(ownerCtx(), shared, "INTERNAL");
      // Positive control: a raise must wait for the parent (the lock the
      // write-skew needs), so it times out while the parent is held.
      await expectLockTimeout(
        withTenant(f.tenantId, member(), async (tx) => {
          await tx.$executeRaw`SET LOCAL lock_timeout = '300ms'`;
          await tx.workItem.update({ where: { id: privateOne }, data: { visibility: "CLIENT_VISIBLE" } });
        }),
      );
    } finally {
      holder.release();
      await holder.done;
    }
    const row = await f.platform.workItem.findUniqueOrThrow({ where: { id: shared } });
    expect(row.visibility).toBe("INTERNAL");
  });
});

describe("writers of more than one row serialise on the project's rank lock (no deadlocks)", () => {
  // A stand-in for moveItem, which takes the rank lock and then its
  // anchor and neighbour FOR UPDATE — by RANK, so in either tree order
  // depending on the drop direction. Held with one row, released, then
  // asking for the other: had the raise grabbed any row while it
  // waited, the two would deadlock here (40P01 to one side).
  for (const order of ["child then parent", "parent then child"] as const) {
    it(`a subtask's raise waits on the rank lock holding no row — mover locks ${order}`, async () => {
      const parent = await visibleTask(`Move-race parent (${order})`);
      const { id: child } = await createItem(ownerCtx(), { projectId, title: "Move-race subtask", parentId: parent });
      await changeItemVisibility(ownerCtx(), child, "INTERNAL");
      const [first, second] = order === "child then parent" ? [child, parent] : [parent, child];
      const mover = holdOpen(
        member(),
        async (tx) => {
          await lockProjectRanks(tx, projectId);
          await lockRow(tx, first);
        },
        async (tx) => {
          await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
          await lockRow(tx, second);
        },
      );
      let raising: Promise<unknown> = Promise.resolve(null);
      try {
        await mover.isReady;
        raising = settle(changeItemVisibility(ownerCtx(), child, "CLIENT_VISIBLE"));
        expect(await waitForLockWaiter()).toEqual(["advisory"]);
      } finally {
        mover.release();
        await mover.done; // throws on 40P01 or a lock timeout
      }
      expect(await raising).toBeNull();
      const row = await f.platform.workItem.findUniqueOrThrow({ where: { id: child } });
      expect(row.visibility).toBe("CLIENT_VISIBLE");
    });
  }

  it("a subtask create waits on the rank lock holding no row (createItem's lock order)", async () => {
    // Taken BEFORE the counter and the rank lock, the parent's share lock
    // would wait on the mover's row here — the order that deadlocked two
    // quick subtask creates under the project's last row.
    const parent = await visibleTask("Create-race parent");
    const mover = holdOpen(member(), async (tx) => {
      await lockProjectRanks(tx, projectId);
      await lockRow(tx, parent);
    });
    let creating: Promise<unknown> = Promise.resolve(null);
    try {
      await mover.isReady;
      creating = settle(createItem(ownerCtx(), { projectId, title: "Queued subtask", parentId: parent }));
      expect(await waitForLockWaiter()).toEqual(["advisory"]);
    } finally {
      mover.release();
      await mover.done;
    }
    expect(await creating).toBeNull();
    expect(await f.platform.workItem.count({ where: { tenantId: f.tenantId, parentId: parent } })).toBe(1);
  });

  it("a bulk edit re-reads after the wait: an item deleted meanwhile is absent, not archived", async () => {
    const { id: a } = await createItem(ownerCtx(), { projectId, title: "Bulk keep" });
    const { id: b } = await createItem(ownerCtx(), { projectId, title: "Bulk deleted meanwhile" });
    const holder = holdOpen(member(), (tx) => lockProjectRanks(tx, projectId));
    let archiving: Promise<unknown> = Promise.resolve(null);
    try {
      await holder.isReady;
      archiving = bulkSetArchived(ownerCtx(), [a, b], true);
      archiving.catch(() => undefined); // awaited below — never an unhandled rejection meanwhile
      expect(await waitForLockWaiter()).toEqual(["advisory"]);
      await deleteItem(ownerCtx(), b); // a single-row writer: it does not queue
    } finally {
      holder.release();
      await holder.done;
    }
    expect(await archiving).toEqual({ changed: 1, skipped: 0 });
    const gone = await f.platform.workItem.findUniqueOrThrow({ where: { id: b } });
    expect(gone.archivedAt).toBeNull();
    expect((await f.audits("work_item.archived")).filter((e) => e.targetId === b)).toHaveLength(0);
  });

  it("a subtask's raise re-reads after the wait: a subtask deleted meanwhile is NOT_FOUND, never raised", async () => {
    const parent = await visibleTask("Raise-race parent");
    const { id: child } = await createItem(ownerCtx(), { projectId, title: "Deleted while queued", parentId: parent });
    await changeItemVisibility(ownerCtx(), child, "INTERNAL");
    const holder = holdOpen(member(), (tx) => lockProjectRanks(tx, projectId));
    let raising: Promise<unknown> = Promise.resolve(null);
    try {
      await holder.isReady;
      raising = settle(changeItemVisibility(ownerCtx(), child, "CLIENT_VISIBLE"));
      expect(await waitForLockWaiter()).toEqual(["advisory"]);
      await deleteItem(ownerCtx(), child);
    } finally {
      holder.release();
      await holder.done;
    }
    expect(await raising).toMatchObject({ name: "AuthzError", reason: "NOT_FOUND" });
    const row = await f.platform.workItem.findUniqueOrThrow({ where: { id: child } });
    expect(row.visibility).toBe("INTERNAL");
  });

  it("a bulk edit waits on the rank lock holding none of its rows", async () => {
    const { id: a } = await createItem(ownerCtx(), { projectId, title: "Bulk A" });
    const { id: b } = await createItem(ownerCtx(), { projectId, title: "Bulk B" });
    const holder = holdOpen(
      member(),
      async (tx) => {
        await lockProjectRanks(tx, projectId);
        await lockRow(tx, a);
      },
      async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
        await lockRow(tx, b);
      },
    );
    let editing: Promise<unknown> = Promise.resolve(null);
    try {
      await holder.isReady;
      editing = settle(bulkSetPriority(ownerCtx(), [a, b], "HIGH"));
      // An updateMany over [a, b] locks in scan order; before the rank
      // lock it could have held b here and deadlocked with the holder.
      expect(await waitForLockWaiter()).toEqual(["advisory"]);
    } finally {
      holder.release();
      await holder.done;
    }
    expect(await editing).toBeNull();
    const rows = await f.platform.workItem.findMany({ where: { id: { in: [a, b] } }, select: { priority: true } });
    expect(rows.map((r) => r.priority)).toEqual(["HIGH", "HIGH"]);
  });
});

describe("tree refusals reach the caller as typed DomainErrors", () => {
  it("a subtask cannot be shared under a private parent (PARENT_NOT_VISIBLE); once the parent is shared, it can", async () => {
    const { id: parent } = await createItem(ownerCtx(), { projectId, title: "Private parent" });
    const { id: child } = await createItem(ownerCtx(), { projectId, title: "Subtask", parentId: parent });
    await expect(changeItemVisibility(ownerCtx(), child, "CLIENT_VISIBLE")).rejects.toMatchObject({
      code: "PARENT_NOT_VISIBLE",
    });
    await changeItemVisibility(ownerCtx(), parent, "CLIENT_VISIBLE");
    await changeItemVisibility(ownerCtx(), child, "CLIENT_VISIBLE");
    const row = await f.platform.workItem.findUniqueOrThrow({ where: { id: child } });
    expect(row.visibility).toBe("CLIENT_VISIBLE");
  });

  it("a subtask cannot have subtasks (CANNOT_NEST); a task can", async () => {
    const { id: task } = await createItem(ownerCtx(), { projectId, title: "Task" });
    const { id: subtask } = await createItem(ownerCtx(), { projectId, title: "Subtask", parentId: task });
    await expect(
      createItem(ownerCtx(), { projectId, title: "Too deep", parentId: subtask }),
    ).rejects.toMatchObject({ code: "CANNOT_NEST" });
    expect(await f.platform.workItem.count({ where: { tenantId: f.tenantId, parentId: subtask } })).toBe(0);
  });
});

describe("a row deleted under a shared item cannot be restored into view once the item is private", () => {
  it("subtask, comment and attachment: make-private ignores the dead rows, and restoring them visible is refused", async () => {
    const parent = await visibleTask("Shared then private");
    const childWord = word("barnord");
    const commentWord = word("kommord");
    const docWord = word("filord");

    const { id: child } = await createItem(ownerCtx(), { projectId, title: `Subtask ${childWord}`, parentId: parent });
    const comment = await f.platform.comment.create({
      data: {
        tenantId: f.tenantId,
        subjectType: "WORK_ITEM",
        subjectId: parent,
        authorMemberId: f.seats.owner.memberId,
        body: {},
        bodyText: `Delivered ${commentWord}`,
        visibility: "CLIENT_VISIBLE",
      },
    });
    const document = await f.platform.document.create({
      data: {
        tenantId: f.tenantId,
        clientId,
        projectId,
        name: `Leverans ${docWord}`,
        visibility: "CLIENT_VISIBLE",
        attachedToType: "WORK_ITEM",
        attachedToId: parent,
      },
    });
    const childRow = await f.platform.workItem.findUniqueOrThrow({ where: { id: child } });
    expect(childRow.visibility).toBe("CLIENT_VISIBLE"); // inherited

    // Positive control: while alive, the client finds all three.
    for (const w of [childWord, commentWord, docWord]) expect(await searchCount(contact(), w)).toBe(1);

    // Delete all three; the feeds evict their index rows.
    await deleteItem(ownerCtx(), child);
    await f.platform.comment.update({ where: { id: comment.id }, data: { deletedAt: new Date() } });
    await f.platform.document.update({ where: { id: document.id }, data: { deletedAt: new Date() } });
    for (const w of [childWord, commentWord, docWord]) expect(await searchCount(contact(), w)).toBe(0);

    // Dead rows do not block the item's make-private...
    await changeItemVisibility(ownerCtx(), parent, "INTERNAL");

    // ...and none of them can be restored as they were.
    await expect(
      f.platform.workItem.update({ where: { id: child }, data: { deletedAt: null } }),
    ).rejects.toThrow(/RESTORE_VISIBILITY/);
    await expect(
      f.platform.comment.update({ where: { id: comment.id }, data: { deletedAt: null } }),
    ).rejects.toThrow(/RESTORE_VISIBILITY/);
    await expect(
      f.platform.document.update({ where: { id: document.id }, data: { deletedAt: null } }),
    ).rejects.toThrow(/RESTORE_VISIBILITY/);
    for (const w of [childWord, commentWord, docWord]) expect(await searchCount(contact(), w)).toBe(0);

    // Restoring them PRIVATE is always allowed — the path a future undo
    // takes. They come back to the team and stay invisible to the client.
    await f.platform.workItem.update({ where: { id: child }, data: { deletedAt: null, visibility: "INTERNAL" } });
    await f.platform.comment.update({ where: { id: comment.id }, data: { deletedAt: null, visibility: "INTERNAL" } });
    await f.platform.document.update({
      where: { id: document.id },
      data: { deletedAt: null, visibility: "INTERNAL" },
    });
    for (const w of [childWord, commentWord, docWord]) {
      expect(await searchCount(member(), w)).toBe(1);
      expect(await searchCount(contact(), w)).toBe(0);
    }
  });

  it("a restore needs a live parent — and the guard never stands in the way of a soft delete", async () => {
    const { id: parent } = await createItem(ownerCtx(), { projectId, title: "Parent that dies" });
    const { id: child } = await createItem(ownerCtx(), { projectId, title: "Child", parentId: parent });
    // Kill the parent past the service (the state an old race could
    // leave), then soft-delete the child under it: the restore guard
    // must not run on a delete, or this — a safety-positive write —
    // would be refused for want of a live parent.
    await f.platform.workItem.update({ where: { id: parent }, data: { deletedAt: new Date() } });
    await f.platform.workItem.update({ where: { id: child }, data: { deletedAt: new Date() } });

    await expect(
      f.platform.workItem.update({ where: { id: child }, data: { deletedAt: null } }),
    ).rejects.toThrow(/RESTORE_PARENT_GONE/);
    // Positive control: parent first, then the child.
    await f.platform.workItem.update({ where: { id: parent }, data: { deletedAt: null } });
    await f.platform.workItem.update({ where: { id: child }, data: { deletedAt: null } });
    const row = await f.platform.workItem.findUniqueOrThrow({ where: { id: child } });
    expect(row.deletedAt).toBeNull();
  });
});

/**
 * The schema belts of 20260912120000_work_schema_belts: the search feed
 * fires only for the columns it reads, a history row cannot be
 * CLIENT_VISIBLE about a field the portal never shows, the checklist
 * counters cannot lie, and a milestone stays inside its project.
 */
describe("schema belts", () => {
  /** The index row's own columns — never `SELECT *`: tsvector and regconfig do not deserialize. */
  const indexRow = async (entityId: string) => {
    const rows = await f.platform.$queryRaw<
      { updated_at: Date; title: string; state_category: string | null; body_text: string | null }[]
    >`SELECT updated_at, title, state_category, body_text FROM search_index
       WHERE tenant_id = ${f.tenantId} AND entity_type = 'WORK_ITEM' AND entity_id = ${entityId}`;
    return rows[0]!;
  };

  it("a rank-only move leaves the index alone; a title, a state and a description all re-feed it", async () => {
    const anchor = await createItem(ownerCtx(), { projectId, title: "Feed anchor" });
    const { id } = await createItem(ownerCtx(), { projectId, title: "Feed subject" });
    const before = await indexRow(id);
    expect(before.title).toBe("Feed subject");

    // Rank only: the feed reads no rank, so it must not fire — this is
    // what stops a drag re-tokenising a 100k-character description.
    await moveItem(ownerCtx(), { itemId: id, beforeId: anchor.id });
    expect((await indexRow(id)).updated_at).toEqual(before.updated_at);

    // …while every column it DOES read re-feeds the row.
    await updateItemFields(ownerCtx(), id, { title: "Feed subject, renamed" });
    const renamed = await indexRow(id);
    expect(renamed.title).toBe("Feed subject, renamed");
    expect(renamed.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());

    const inProgress = await f.platform.workflowState.findFirstOrThrow({
      where: { tenantId: f.tenantId, projectId, category: "IN_PROGRESS" },
      orderBy: { rank: "asc" },
    });
    await changeState(ownerCtx(), id, inProgress.id);
    expect((await indexRow(id)).state_category).toBe("IN_PROGRESS");

    await f.platform.workItem.update({ where: { id }, data: { descriptionText: "beskrivning i flödet" } });
    expect((await indexRow(id)).body_text).toBe("beskrivning i flödet");
  });

  it("a history row can only be client-visible about a portal-safe field", async () => {
    const item = await visibleTask("History subject");
    const base = { tenantId: f.tenantId, clientId, projectId, workItemId: item };
    // Positive control: `title` is on the pinned list.
    const ok = await f.platform.workItemActivity.create({
      data: { ...base, field: "title", visibility: "CLIENT_VISIBLE" },
    });
    expect(ok.visibility).toBe("CLIENT_VISIBLE");
    // …and `priority` is not, on the same visible item.
    await expect(
      f.platform.workItemActivity.create({
        data: { ...base, field: "priority", visibility: "CLIENT_VISIBLE" },
      }),
    ).rejects.toThrow(/work_item_activity_portal_safe_field/);
    // The same row is fine while it stays INTERNAL.
    await f.platform.workItemActivity.create({
      data: { ...base, field: "priority", visibility: "INTERNAL" },
    });
  });

  it("a move WITHIN a category writes internal history; a move that changes the category does not", async () => {
    const item = await visibleTask("Category walk");
    const states = await f.platform.workflowState.findMany({
      where: { tenantId: f.tenantId, projectId },
      orderBy: { rank: "asc" },
    });
    const inProgress = states.filter((s) => s.category === "IN_PROGRESS");
    expect(inProgress.length).toBe(2); // In progress, then In review

    // TODO → IN_PROGRESS: the client is shown the category, so the row is theirs.
    await changeState(ownerCtx(), item, inProgress[0]!.id);
    const crossing = await f.platform.workItemActivity.findFirstOrThrow({
      where: { tenantId: f.tenantId, workItemId: item, field: "stateCategory" },
      orderBy: { createdAt: "desc" },
    });
    expect(crossing.visibility).toBe("CLIENT_VISIBLE");

    // In progress → In review: same category, and the row carries two
    // workflow-state ids the portal must never show.
    await changeState(ownerCtx(), item, inProgress[1]!.id);
    const within = await f.platform.workItemActivity.findFirstOrThrow({
      where: { tenantId: f.tenantId, workItemId: item, field: "stateCategory" },
      orderBy: { createdAt: "desc" },
    });
    expect(within.visibility).toBe("INTERNAL");
    await withTenant(f.tenantId, contact(), async (tx) => {
      expect(await tx.workItemActivity.count({ where: { workItemId: item, id: within.id } })).toBe(0);
    });
  });

  it("the checklist counters cannot go negative or past the total", async () => {
    const { id } = await createItem(ownerCtx(), { projectId, title: "Checklist bounds" });
    await expect(
      f.platform.workItem.update({ where: { id }, data: { checklistTotal: 2, checklistDone: 3 } }),
    ).rejects.toThrow(/work_item_checklist_bounds/);
    await expect(
      f.platform.workItem.update({ where: { id }, data: { checklistDone: -1 } }),
    ).rejects.toThrow(/work_item_checklist_bounds/);
    // Positive control: a real count is accepted.
    const ok = await f.platform.workItem.update({
      where: { id },
      data: { checklistTotal: 3, checklistDone: 2 },
    });
    expect(ok.checklistDone).toBe(2);
  });

  it("a milestone must belong to the item's own project", async () => {
    const { id } = await createItem(ownerCtx(), { projectId, title: "Milestone subject" });
    const mine = await f.platform.milestone.create({
      data: { tenantId: f.tenantId, clientId, projectId, name: "Launch", rank: "a1" },
    });
    // A milestone of ANOTHER project of the same tenant: the composite FK
    // binds only the tenant, so nothing else would have refused it.
    const otherProjectId = randomUUID();
    await f.platform.project.create({
      data: { id: otherProjectId, tenantId: f.tenantId, clientId, key: "MILE", name: "Other site" },
    });
    const theirs = await f.platform.milestone.create({
      data: { tenantId: f.tenantId, clientId, projectId: otherProjectId, name: "Their launch", rank: "a1" },
    });
    await expect(
      f.platform.workItem.update({ where: { id }, data: { milestoneId: theirs.id } }),
    ).rejects.toThrow(/WORK_MILESTONE_PROJECT/);
    // Positive control: this project's own milestone is accepted.
    const ok = await f.platform.workItem.update({ where: { id }, data: { milestoneId: mine.id } });
    expect(ok.milestoneId).toBe(mine.id);
    await f.platform.workItem.update({ where: { id }, data: { milestoneId: null } });
  });
});

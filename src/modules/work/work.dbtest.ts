import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { dateColumn } from "@/lib/duration";
import { setupTenant } from "@/members/dbtest-fixture";
import {
  ACTIVITY_PAGE_SIZE,
  assignItem,
  bulkChangeState,
  bulkSetPriority,
  changeItemVisibility,
  changeState,
  createItem,
  deleteItem,
  getItemDetail,
  listItems,
  moveItem,
  setItemArchived,
  updateItemFields,
} from "./index";
import { transitionState } from "./states";

/**
 * 2W core-slice behaviour against the real database and the real
 * app_runtime role: numbering + rank under concurrency, the state
 * machine, the §6.14 triggers, deny-default scoping, the contact
 * comment census (WITH CHECK), the search lexeme probe, and the
 * notify.emit fan-out with dedupe.
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
let clientId: string;
let projectId: string;
const contact = { id: randomUUID() };

beforeAll(async () => {
  f = await setupTenant("work");
  clientId = randomUUID();
  projectId = randomUUID();
  await f.platform.client.create({ data: { id: clientId, tenantId: f.tenantId, name: "Acme" } });
  await f.platform.project.create({
    data: { id: projectId, tenantId: f.tenantId, clientId, key: "ACME", name: "Acme site" },
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
}, 60_000);

afterAll(async () => {
  // A failed beforeAll leaves `f` unassigned, and Prisma drops an
  // undefined where-filter: every delete below would be unscoped.
  if (!f?.tenantId) return;
  const db = f.platform;
  await db.notification.deleteMany({ where: { tenantId: f.tenantId } });
  await db.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
  await db.mention.deleteMany({ where: { tenantId: f.tenantId } });
  await db.comment.deleteMany({ where: { tenantId: f.tenantId } });
  await db.workItemActivity.deleteMany({ where: { tenantId: f.tenantId } });
  await db.workItem.deleteMany({ where: { tenantId: f.tenantId, parentId: { not: null } } });
  await db.workItem.deleteMany({ where: { tenantId: f.tenantId } });
  await db.workflowState.deleteMany({ where: { tenantId: f.tenantId } });
  await db.memberClient.deleteMany({ where: { tenantId: f.tenantId } });
  await db.contact.deleteMany({ where: { tenantId: f.tenantId } });
  await db.project.deleteMany({ where: { tenantId: f.tenantId } });
  await db.client.deleteMany({ where: { tenantId: f.tenantId } });
  await db.tenantCounter.deleteMany({ where: { tenantId: f.tenantId } }); // work_item:<project> counters
  await f.cleanup();
}, 60_000);

const ownerCtx = () => ({ tenantId: f.tenantId, actor: f.seats.owner.actor });
const employeeCtx = () => ({ tenantId: f.tenantId, actor: f.seats.employee.actor });

describe("numbering + rank under concurrency", () => {
  it("10 concurrent creates get unique monotonic numbers and unique ranks", async () => {
    const created = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        createItem(ownerCtx(), { projectId, title: `Task ${i}` }),
      ),
    );
    const numbers = created.map((c) => c.number).sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const rows = await f.platform.workItem.findMany({
      where: { tenantId: f.tenantId, projectId },
      select: { rank: true },
    });
    expect(new Set(rows.map((r) => r.rank)).size).toBe(rows.length);
  });

  it("lazy state seeding created the default seven exactly once — Done gated, In review not (2W-R)", async () => {
    const states = await f.platform.workflowState.findMany({
      where: { tenantId: f.tenantId, projectId },
      orderBy: { rank: "asc" },
    });
    expect(states).toHaveLength(7);
    expect(states.filter((s) => s.isDefault)).toHaveLength(1);
    expect(states.find((s) => s.category === "TRIAGE")?.isHidden).toBe(true);
    const inProgress = states.filter((s) => s.category === "IN_PROGRESS");
    expect(inProgress).toHaveLength(2); // "In progress" then "In review", by rank
    expect(inProgress.every((s) => !s.requiresApproval)).toBe(true);
    expect(states.find((s) => s.category === "DONE")?.requiresApproval).toBe(true);
    expect(states.filter((s) => s.requiresApproval)).toHaveLength(1);
  });
});

describe("state machine", () => {
  it("stamps startedAt on first IN_PROGRESS, completedAt on DONE, clears on regression; audits the transition", async () => {
    const { id } = await createItem(ownerCtx(), { projectId, title: "State walk" });
    const states = await f.platform.workflowState.findMany({
      where: { tenantId: f.tenantId, projectId },
      orderBy: { rank: "asc" }, // two IN_PROGRESS states since 2W-R — first by rank
    });
    const byCat = (c: string) => states.find((s) => s.category === c)!.id;

    await changeState(ownerCtx(), id, byCat("IN_PROGRESS"));
    let item = await f.platform.workItem.findUniqueOrThrow({ where: { id } });
    expect(item.stateCategory).toBe("IN_PROGRESS");
    expect(item.startedAt).not.toBeNull();

    await changeState(ownerCtx(), id, byCat("DONE"));
    item = await f.platform.workItem.findUniqueOrThrow({ where: { id } });
    expect(item.completedAt).not.toBeNull();
    expect(item.startedAt).not.toBeNull();

    await changeState(ownerCtx(), id, byCat("TODO"));
    item = await f.platform.workItem.findUniqueOrThrow({ where: { id } });
    expect(item.stateCategory).toBe("TODO");
    expect(item.startedAt).toBeNull();
    expect(item.completedAt).toBeNull();

    const audit = await f.audits("work_item.state_changed");
    expect(audit.length).toBeGreaterThanOrEqual(3);
    const activity = await f.platform.workItemActivity.findMany({
      where: { tenantId: f.tenantId, workItemId: id, field: "stateCategory" },
    });
    expect(activity).toHaveLength(3);
  });

  it("returns a row that equals a fresh read of every field it carries", async () => {
    // UI.md §7.2: a mutation returns the row, so an optimistic slice is
    // REPLACED rather than merged. Before this slice `transitionState`
    // returned void and there was nothing to replace it with.
    const { id } = await createItem(ownerCtx(), { projectId, title: "Canonical row" });
    const states = await f.platform.workflowState.findMany({
      where: { tenantId: f.tenantId, projectId },
      orderBy: { rank: "asc" },
    });
    const progress = states.find((s) => s.category === "IN_PROGRESS")!;

    const change = await changeState(ownerCtx(), id, progress.id);
    const fresh = await f.platform.workItem.findUniqueOrThrow({ where: { id } });

    expect(change.changed).toBe(true);
    expect(change.itemId).toBe(id);
    expect(change.stateId).toBe(fresh.stateId);
    // `stateCategory` is derived by a BEFORE trigger. Be honest about
    // what this proves: on the happy path the value the service computes
    // and the value the trigger derives AGREE, so this assertion cannot
    // by itself distinguish `RETURNING` from an echo of the input. It is
    // here because it is the field a caller most wants to trust, and the
    // trigger's independent behaviour is covered where it can actually
    // be isolated (`tree-guards.dbtest.ts`). The load-bearing assertions
    // for THIS test are the two stamps below, which the service reads
    // back rather than computes on a regression.
    expect(change.stateCategory).toBe(fresh.stateCategory);
    expect(change.startedAt).toEqual(fresh.startedAt);
    expect(change.completedAt).toEqual(fresh.completedAt);
    // The name pair comes back RAW: this module has no locale, and a
    // seeded state carries a null name plus its seedKey (2026-09-01).
    expect(change.stateName).toBe(progress.name);
    expect(change.stateSeedKey).toBe(progress.seedKey);
  });

  it("a move to the state the item is ALREADY in writes nothing at all and says so", async () => {
    const { id } = await createItem(ownerCtx(), { projectId, title: "No-op move" });
    const states = await f.platform.workflowState.findMany({
      where: { tenantId: f.tenantId, projectId },
      orderBy: { rank: "asc" },
    });
    const review = states.find((s) => s.seedKey === "IN_REVIEW")!;
    await changeState(ownerCtx(), id, review.id);

    const countRows = async () => ({
      activity: await f.platform.workItemActivity.count({
        where: { tenantId: f.tenantId, workItemId: id, field: "stateCategory" },
      }),
      audit: (await f.audits("work_item.state_changed")).length,
    });
    const before = await countRows();
    const beforeRow = await f.platform.workItem.findUniqueOrThrow({ where: { id } });

    const again = await changeState(ownerCtx(), id, review.id);

    expect(again.changed).toBe(false);
    // Still the truth about where the item IS, so a caller can render it.
    expect(again.stateId).toBe(review.id);
    expect(again.stateCategory).toBe(beforeRow.stateCategory);
    // ZERO new rows: a "saved" for a write that did not happen is a lie,
    // and `updatedAt` untouched keeps it off every other board's poll.
    expect(await countRows()).toEqual(before);
    const afterRow = await f.platform.workItem.findUniqueOrThrow({ where: { id } });
    expect(afterRow.updatedAt).toEqual(beforeRow.updatedAt);
  });
});

describe("updateItemFields returns the canonical row (panel slice 6, UI.md §7.2)", () => {
  it("updateItemFields returns what the column stored, not what was sent", async () => {
    const { id } = await createItem(ownerCtx(), { projectId, title: "Stored, not sent" });

    const row = await updateItemFields(ownerCtx(), id, {
      priority: "HIGH",
      estimateMinutes: 90,
      // An afternoon instant for a `@db.Date` column: the database keeps
      // the DAY. An echo of the input would still say 13:45.
      targetDate: new Date("2026-09-15T13:45:00.000Z"),
    });
    const fresh = await f.platform.workItem.findUniqueOrThrow({ where: { id } });

    expect(row.changed).toBe(true);
    expect(row.priority).toBe(fresh.priority);
    expect(row.estimateMinutes).toBe(fresh.estimateMinutes);
    // The load-bearing assertion: this is the RETURNING, not the patch.
    expect(row.targetDate?.toISOString()).toBe("2026-09-15T00:00:00.000Z");
    expect(row.targetDate).toEqual(fresh.targetDate);
    // Exactly the select — never the 512 KB description, never the row.
    expect(Object.keys(row).sort()).toEqual([
      "changed",
      "estimateMinutes",
      "id",
      "priority",
      "targetDate",
      "title",
    ]);
  });

  it("a patch that changes nothing writes nothing and says so", async () => {
    const { id } = await createItem(ownerCtx(), { projectId, title: "Nothing to write" });
    await updateItemFields(ownerCtx(), id, {
      priority: "HIGH",
      estimateMinutes: 90,
      targetDate: dateColumn("2026-09-15"),
    });

    const countRows = async () => ({
      // The estimate's activity field is "estimate", not the column name (items.ts).
      activity: await f.platform.workItemActivity.count({
        where: { tenantId: f.tenantId, workItemId: id, field: { in: ["priority", "estimate", "targetDate"] } },
      }),
      // By target, not by action: `f.audits` filters by tenant + action only.
      audit: await f.platform.auditEvent.count({ where: { tenantId: f.tenantId, targetId: id } }),
    });
    const before = await countRows();
    const beforeRow = await f.platform.workItem.findUniqueOrThrow({ where: { id } });

    const patches = [
      { priority: "HIGH" as const },
      { estimateMinutes: 90 },
      // A different instant on the SAME day is the same stored value.
      { targetDate: new Date("2026-09-15T22:00:00.000Z") },
    ];
    for (const patch of patches) {
      const again = await updateItemFields(ownerCtx(), id, patch);
      expect(again.changed).toBe(false);
      // Still the truth about the item, so a caller can render it.
      expect(again.priority).toBe("HIGH");
      expect(again.estimateMinutes).toBe(90);
      expect(again.targetDate?.toISOString()).toBe("2026-09-15T00:00:00.000Z");
    }

    expect(await countRows()).toEqual(before);
    const afterRow = await f.platform.workItem.findUniqueOrThrow({ where: { id } });
    expect(afterRow.updatedAt).toEqual(beforeRow.updatedAt);
  });
});

/**
 * The race harness for the two describes below (review 2026-09-13). A
 * colleague's write is held open after it ran (tree-guards.dbtest.ts's
 * pattern); the write under test must be SEEN waiting on it before the
 * colleague is released, because that ordering is what makes an unlocked
 * implementation read the row version the colleague is about to replace.
 */

/**
 * A colleague's transaction: runs `body`, signals with what it returned
 * and its transaction id, then holds its row locks open until released,
 * and commits. A body that throws never signals, so the wait fails with
 * its error instead of hanging the test.
 */
function holdOpen<T>(body: (tx: TenantDb) => Promise<T>) {
  let ready!: (held: { result: T; xid: string }) => void;
  let release!: () => void;
  const signalled = new Promise<{ result: T; xid: string }>((r) => (ready = r));
  const released = new Promise<void>((r) => (release = r));
  const done = withTenant(
    f.tenantId,
    { type: "member", id: f.seats.owner.memberId },
    async (tx) => {
      const result = await body(tx);
      // pg_locks shows the 32-bit xid; txid_current() carries the epoch above it.
      const rows = await tx.$queryRaw<{ xid: string }[]>`SELECT (txid_current() % 4294967296)::text AS xid`;
      const xid = rows[0]?.xid;
      if (!xid) throw new Error("the colleague's transaction reported no id");
      ready({ result, xid });
      await released;
    },
    { timeoutMs: 20_000 },
  );
  const isReady = Promise.race([
    signalled,
    done.then((): never => {
      throw new Error("the colleague committed without signalling");
    }),
  ]);
  return { isReady, release, done };
}

/**
 * Resolves once a transaction is blocked on the colleague's own
 * transaction id — the lock a writer of a row the colleague wrote waits
 * on — and throws if none ever is. Scoped to that id: the probe used to
 * accept ANY ungranted lock in the cluster, so a waiter in another
 * session on the shared dev database released the colleague before the
 * write under test had read anything, and an unlocked implementation
 * passed too. A wait on the project's rank lock is 'advisory', never this.
 */
async function waitForWaiterOn(xid: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const rows = await f.platform.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_locks
       WHERE NOT granted AND locktype = 'transactionid' AND transactionid::text = ${xid}`;
    if ((rows[0]?.n ?? 0) > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("nothing ever waited on the colleague's transaction — the race was not exercised");
}

/**
 * The race itself, ONCE for every writer under test: the colleague's
 * `body` runs and holds its row locks; `writer` is started and must be
 * SEEN waiting on the colleague's transaction before the colleague is
 * released — that ordering is what makes an unlocked implementation read
 * the row version the colleague is about to replace. Returns what the
 * colleague's body returned and the writer's promise, still pending, for
 * the test to await and assert on; the colleague is released and
 * committed before this returns, whether the probe passed or threw.
 */
async function raceBehind<T, W>(
  body: (tx: TenantDb) => Promise<T>,
  writer: () => Promise<W>,
): Promise<{ held: T; result: Promise<W> }> {
  const colleague = holdOpen(body);
  try {
    const { result: held, xid } = await colleague.isReady;
    const result = writer();
    result.catch(() => undefined); // awaited by the test — never an unhandled rejection meanwhile
    // The probe races the writer itself: a writer that refuses or returns
    // BEFORE it waits — a scope refusal, a bad id, or an unlocked read
    // that calls the write a no-op (the make-private race below; in the
    // other races an unlocked implementation still blocks at its UPDATE
    // and is caught by the assertions that follow) — surfaces as its own
    // error, or as "finished without waiting", at once, not as a
    // ten-second probe timeout that hides the cause.
    await Promise.race([
      waitForWaiterOn(xid),
      result.then(
        () => {
          throw new Error("the writer finished without waiting on the colleague — the race was not exercised");
        },
        (e: unknown) => {
          throw e;
        },
      ),
    ]);
    return { held, result };
  } finally {
    colleague.release();
    await colleague.done;
  }
}

/**
 * The diff is taken under the row lock (review 2026-09-13). Read
 * unlocked, an edit that WAITED on another at its UPDATE still diffed
 * against the row as it was before the other committed, so its `changed`
 * and its history described a version it never replaced. What the edit
 * reports afterwards proves which version it read. Both fail on the
 * unlocked read.
 */
describe("updateItemFields diffs the row version it replaces (review 2026-09-13)", () => {
  it("an edit that waited sees what the other committed: the client-visible history says 18 → 20, never 15 → 20", async () => {
    const { id } = await createItem(ownerCtx(), { projectId, title: "Two due dates at once" });
    // Shared, so the due date's history is a row the client reads (PORTAL_SAFE_FIELDS).
    await changeItemVisibility(ownerCtx(), id, "CLIENT_VISIBLE");
    await updateItemFields(ownerCtx(), id, { targetDate: dateColumn("2026-09-15") });

    // On the ROW the colleague wrote — its transaction — and never on the rank lock.
    const { result: editing } = await raceBehind(
      (tx) => tx.workItem.update({ where: { id }, data: { targetDate: dateColumn("2026-09-18") }, select: { id: true } }),
      () => updateItemFields(ownerCtx(), id, { targetDate: dateColumn("2026-09-20") }),
    );

    expect(await editing).toMatchObject({ id, targetDate: dateColumn("2026-09-20"), changed: true });
    const history = await f.platform.workItemActivity.findMany({
      where: { tenantId: f.tenantId, workItemId: id, field: "targetDate", newValue: "2026-09-20" },
      select: { oldValue: true, visibility: true },
    });
    // The colleague's raw write leaves no row of its own, so the waiting
    // edit's row must start where that commit left the item — read
    // unlocked, it said 2026-09-15.
    expect(history).toEqual([{ oldValue: "2026-09-18", visibility: "CLIENT_VISIBLE" }]);
  });

  it("an edit that waited on an IDENTICAL one finds nothing to write: changed false, no history, updatedAt untouched", async () => {
    const { id } = await createItem(ownerCtx(), { projectId, title: "Two HIGHs at once" });
    const { held: colleagueWrote, result: editing } = await raceBehind(
      (tx) => tx.workItem.update({ where: { id }, data: { priority: "HIGH" }, select: { updatedAt: true } }),
      () => updateItemFields(ownerCtx(), id, { priority: "HIGH" }),
    );

    // Still the truth about the item: HIGH, as the colleague left it.
    expect(await editing).toMatchObject({ id, priority: "HIGH", changed: false });
    expect(
      await f.platform.workItemActivity.count({ where: { tenantId: f.tenantId, workItemId: id, field: "priority" } }),
    ).toBe(0);
    // No second UPDATE: the stamp is still the colleague's, so no board's
    // poll (ARC-18) fires for a write that changed nothing.
    const fresh = await f.platform.workItem.findUniqueOrThrow({ where: { id }, select: { updatedAt: true } });
    expect(fresh.updatedAt).toEqual(colleagueWrote.updatedAt);
  });
});

/**
 * changeState diffs under the same row lock (review 2026-09-13) — the
 * service behind the panel's S picker and the backlog's state cell. Read
 * unlocked, a pick that waited on another at its UPDATE reported, audited
 * and wrote client-visible history for a row version it never replaced.
 * Each test fails on the unlocked read.
 */
describe("changeState diffs the row version it replaces (review 2026-09-13)", () => {
  const statesByRank = () =>
    f.platform.workflowState.findMany({ where: { tenantId: f.tenantId, projectId }, orderBy: { rank: "asc" } });
  const stateAudits = (id: string) =>
    f.platform.auditEvent.findMany({
      where: { tenantId: f.tenantId, targetId: id, action: "work_item.state_changed" },
      select: { metadata: true },
    });

  it("two picks of Done at once: exactly one says changed, one audit event, one history row, and the first completedAt stands", async () => {
    const { id } = await createItem(ownerCtx(), { projectId, title: "Two Dones at once" });
    // Shared, so each pick's history row would be one the client reads.
    await changeItemVisibility(ownerCtx(), id, "CLIENT_VISIBLE");
    const done = (await statesByRank()).find((s) => s.category === "DONE")!;

    // The colleague's pick runs the state machine itself, so it writes the
    // history row and the audit event the waiting pick must not repeat.
    const { held: first, result: picking } = await raceBehind(
      async (tx) => {
        const item = await tx.workItem.findFirst({
          where: { tenantId: f.tenantId, id },
          omit: { description: true, descriptionText: true },
        });
        if (!item) throw new Error("the colleague could not read the item");
        return transitionState(tx, ownerCtx(), item, done);
      },
      () => changeState(ownerCtx(), id, done.id),
    );

    expect(first.changed).toBe(true);
    expect(first.completedAt).toBeInstanceOf(Date);
    const second = await picking;
    // Still the truth about the item: Done, stamped when the colleague moved it.
    expect(second).toMatchObject({ itemId: id, stateId: done.id, stateCategory: "DONE", changed: false });
    expect(second.completedAt).toEqual(first.completedAt);
    expect(await stateAudits(id)).toHaveLength(1);
    expect(
      await f.platform.workItemActivity.count({ where: { tenantId: f.tenantId, workItemId: id, field: "stateCategory" } }),
    ).toBe(1);
    // Read unlocked, the waiting pick saw completedAt null and stamped its own.
    const fresh = await f.platform.workItem.findUniqueOrThrow({ where: { id }, select: { completedAt: true } });
    expect(fresh.completedAt).toEqual(first.completedAt);
  });

  it("a pick that waited on a colleague's Done records DONE as where it came from, never To do", async () => {
    const { id } = await createItem(ownerCtx(), { projectId, title: "Done, then In progress" });
    // Shared, so the state history is a row the client reads (PORTAL_SAFE_FIELDS).
    await changeItemVisibility(ownerCtx(), id, "CLIENT_VISIBLE");
    const states = await statesByRank();
    const done = states.find((s) => s.category === "DONE")!;
    const progress = states.find((s) => s.category === "IN_PROGRESS")!; // "In progress", first by rank

    const { result: picking } = await raceBehind(
      (tx) =>
        tx.workItem.update({
          where: { id },
          data: { stateId: done.id, stateCategory: "DONE", completedAt: new Date() },
          select: { id: true },
        }),
      () => changeState(ownerCtx(), id, progress.id),
    );

    expect(await picking).toMatchObject({
      itemId: id,
      stateId: progress.id,
      stateCategory: "IN_PROGRESS",
      completedAt: null,
      changed: true,
    });
    const history = await f.platform.workItemActivity.findMany({
      where: { tenantId: f.tenantId, workItemId: id, field: "stateCategory" },
      select: { oldValue: true, newValue: true, oldRef: true, visibility: true },
    });
    // The colleague's raw write leaves no row of its own, so the pick's
    // row is the only one, and it must start where that commit left the
    // item — read unlocked, it said TODO, and so did the audit.
    expect(history).toEqual([
      { oldValue: "DONE", newValue: "IN_PROGRESS", oldRef: done.id, visibility: "CLIENT_VISIBLE" },
    ]);
    const audits = await stateAudits(id);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.metadata).toMatchObject({ from: "DONE", to: "IN_PROGRESS" });
  });

  it("a pick that waited on a downgrade writes its history INTERNAL instead of failing at the activity guard", async () => {
    const { id } = await createItem(ownerCtx(), { projectId, title: "Made private mid-pick" });
    await changeItemVisibility(ownerCtx(), id, "CLIENT_VISIBLE");
    const progress = (await statesByRank()).find((s) => s.category === "IN_PROGRESS")!;

    const { result: picking } = await raceBehind(
      (tx) => tx.workItem.update({ where: { id }, data: { visibility: "INTERNAL" }, select: { id: true } }),
      () => changeState(ownerCtx(), id, progress.id),
    );

    // Read unlocked, the pick still believed the item shared, wrote its
    // history CLIENT_VISIBLE, and work_item_activity_denorm_guard refused
    // the whole state change with a raw trigger error.
    expect(await picking).toMatchObject({ itemId: id, stateCategory: "IN_PROGRESS", changed: true });
    const history = await f.platform.workItemActivity.findMany({
      where: { tenantId: f.tenantId, workItemId: id, field: "stateCategory" },
      select: { newValue: true, visibility: true },
    });
    expect(history).toEqual([{ newValue: "IN_PROGRESS", visibility: "INTERNAL" }]);
  });
});

/**
 * Slice 7 carried the row lock to every writer that still diffed an
 * unlocked read (slice 6's disposition 2, PLAN §0): the three single-row
 * writers below, then the multi-row ones, which lock the rows they diff
 * under the project's queue lock. The harness is the one above; each
 * test fails on the unlocked read.
 */
describe("assignItem diffs the row version it replaces (slice 7)", () => {
  const assigneeHistory = (id: string) =>
    f.platform.workItemActivity.findMany({
      where: { tenantId: f.tenantId, workItemId: id, field: "assignee" },
      select: { oldRef: true, newRef: true, visibility: true },
    });

  it("an assignment that waited on an IDENTICAL one writes nothing: changed false, no history, no notification", async () => {
    const { id } = await createItem(ownerCtx(), { projectId, title: "Two assignments at once" });
    const employee = f.seats.employee.memberId;
    const { result: assigning } = await raceBehind(
      (tx) => tx.workItem.update({ where: { id }, data: { assigneeMemberId: employee }, select: { id: true } }),
      () => assignItem(ownerCtx(), id, employee),
    );

    // Still the truth about the item: the employee's, as the colleague left it.
    expect(await assigning).toMatchObject({ id, assigneeMemberId: employee, changed: false });
    expect(await assigneeHistory(id)).toEqual([]);
    // Read unlocked, the wait ended in a second UPDATE, a history row from
    // "nobody", and a notification — with a debounced email behind it —
    // for a member who already held the task.
    expect(
      await f.platform.notification.count({
        where: { tenantId: f.tenantId, kind: "work_item.assigned", entityId: id },
      }),
    ).toBe(0);
  });

  it("an assignment that waited on a colleague's records THEIR assignee as where it came from, never nobody", async () => {
    const { id } = await createItem(ownerCtx(), { projectId, title: "Reassigned mid-wait" });
    const manager = f.seats.manager.memberId;
    // The waiting assignment is to the OWNER — the actor — whom `emit`
    // never notifies, so this test leaves no mail behind (the fan-out
    // describe below now sweeps the kind before it counts; a test that
    // needs no sweeping is still the simpler one to reason about).
    const owner = f.seats.owner.memberId;
    const { result: assigning } = await raceBehind(
      (tx) => tx.workItem.update({ where: { id }, data: { assigneeMemberId: manager }, select: { id: true } }),
      () => assignItem(ownerCtx(), id, owner),
    );

    expect(await assigning).toMatchObject({ id, assigneeMemberId: owner, changed: true });
    // The colleague's raw write leaves no row of its own, so the waiting
    // assignment's row must start where that commit left the item — read
    // unlocked, it said "from nobody".
    expect(await assigneeHistory(id)).toEqual([{ oldRef: manager, newRef: owner, visibility: "INTERNAL" }]);
  });
});

describe("changeItemVisibility diffs the row version it replaces (slice 7)", () => {
  const visibilityAudits = (id: string) =>
    f.platform.auditEvent.findMany({
      where: { tenantId: f.tenantId, targetId: id, action: "work_item.visibility_changed" },
      select: { metadata: true },
    });
  const visibilityHistory = (id: string) =>
    f.platform.workItemActivity.findMany({
      where: { tenantId: f.tenantId, workItemId: id, field: "visibility" },
      select: { oldValue: true, newValue: true, visibility: true },
    });

  it("a share that waited on an IDENTICAL share writes nothing: changed false, no history, no audit event", async () => {
    const { id } = await createItem(ownerCtx(), { projectId, title: "Two shares at once" });
    const { result: sharing } = await raceBehind(
      (tx) => tx.workItem.update({ where: { id }, data: { visibility: "CLIENT_VISIBLE" }, select: { id: true } }),
      () => changeItemVisibility(ownerCtx(), id, "CLIENT_VISIBLE"),
    );

    expect(await sharing).toMatchObject({ id, visibility: "CLIENT_VISIBLE", changed: false });
    expect(await visibilityHistory(id)).toEqual([]);
    // Read unlocked, the audit trail said "INTERNAL → CLIENT_VISIBLE" for
    // a transition this transaction never made.
    expect(await visibilityAudits(id)).toEqual([]);
  });

  it("a make-private that waited on a colleague's share still makes it private — read unlocked it was a no-op that left the task shared", async () => {
    const { id } = await createItem(ownerCtx(), { projectId, title: "Shared under a make-private" });
    // An unlocked read never waits here: it reads INTERNAL, calls the
    // flip a no-op and returns — so the harness's wait probe is itself
    // the assertion.
    const { result: hiding } = await raceBehind(
      (tx) => tx.workItem.update({ where: { id }, data: { visibility: "CLIENT_VISIBLE" }, select: { id: true } }),
      () => changeItemVisibility(ownerCtx(), id, "INTERNAL"),
    );

    // The member asked for private and got it. This is the worst-bug
    // direction, and exactly the one an unlocked diff got wrong: the
    // colleague's share stood, and the member was told nothing.
    expect(await hiding).toMatchObject({ id, visibility: "INTERNAL", changed: true });
    const fresh = await f.platform.workItem.findUniqueOrThrow({ where: { id }, select: { visibility: true } });
    expect(fresh.visibility).toBe("INTERNAL");
    expect(await visibilityHistory(id)).toEqual([
      { oldValue: "CLIENT_VISIBLE", newValue: "INTERNAL", visibility: "INTERNAL" },
    ]);
    const audits = await visibilityAudits(id);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.metadata).toMatchObject({ from: "CLIENT_VISIBLE", to: "INTERNAL" });
  });
});

describe("setItemArchived diffs the row version it replaces (slice 7)", () => {
  const archiveAudits = (id: string) =>
    f.platform.auditEvent.count({ where: { tenantId: f.tenantId, targetId: id, action: "work_item.archived" } });

  it("the positive control: an archive writes once and audits once, a repeat is a no-op, a restore writes and audits again", async () => {
    const { id } = await createItem(ownerCtx(), { projectId, title: "Archive positive control" });
    const archived = await setItemArchived(ownerCtx(), id, true);
    expect(archived).toMatchObject({ id, changed: true });
    expect(archived.archivedAt).toBeInstanceOf(Date);
    expect(await archiveAudits(id)).toBe(1);
    // Already archived: nothing written, nothing audited, the stamp stands
    // — and the caller is told so.
    expect(await setItemArchived(ownerCtx(), id, true)).toEqual({ id, archivedAt: archived.archivedAt, changed: false });
    expect(await archiveAudits(id)).toBe(1);
    expect(await setItemArchived(ownerCtx(), id, false)).toEqual({ id, archivedAt: null, changed: true });
    expect(await archiveAudits(id)).toBe(2);
  });

  it("an archive that waited on an identical one restamps nothing and audits nothing", async () => {
    const { id } = await createItem(ownerCtx(), { projectId, title: "Two archives at once" });
    const stamp = new Date(Date.now() - 60_000);
    const { result: archiving } = await raceBehind(
      (tx) => tx.workItem.update({ where: { id }, data: { archivedAt: stamp }, select: { id: true } }),
      () => setItemArchived(ownerCtx(), id, true),
    );

    // Read unlocked, the wait ended in a second stamp — "archived now", a
    // minute after it was — and a second `work_item.archived`. The answer
    // names the colleague's stamp and says nothing was written.
    expect(await archiving).toEqual({ id, archivedAt: stamp, changed: false });
    const fresh = await f.platform.workItem.findUniqueOrThrow({ where: { id }, select: { archivedAt: true } });
    expect(fresh.archivedAt).toEqual(stamp);
    expect(await archiveAudits(id)).toBe(0);
  });
});

/**
 * The multi-row writers lock the rows they diff (bulk.ts `loadSelection`,
 * ordering.ts `moveItem`) — under the project's queue lock, which
 * serialises them against each other but never against a single-row
 * writer, whose commit can land between an unlocked read and the UPDATE.
 */
describe("the multi-row writers diff the row versions they replace (slice 7)", () => {
  const statesByRank = () =>
    f.platform.workflowState.findMany({ where: { tenantId: f.tenantId, projectId }, orderBy: { rank: "asc" } });
  const stateAudits = (id: string) =>
    f.platform.auditEvent.count({
      where: { tenantId: f.tenantId, targetId: id, action: "work_item.state_changed" },
    });
  const priorityHistory = (id: string) =>
    f.platform.workItemActivity.findMany({
      where: { tenantId: f.tenantId, workItemId: id, field: "priority" },
      select: { oldValue: true, newValue: true },
    });

  it("bulkSetPriority: a row a colleague had just set is skipped, not re-written with history from a value it never held", async () => {
    const a = await createItem(ownerCtx(), { projectId, title: "Bulk priority A" });
    const b = await createItem(ownerCtx(), { projectId, title: "Bulk priority B" });
    // Waits on A's row — the colleague's transaction — with the rank lock free.
    const { result: bulk } = await raceBehind(
      (tx) => tx.workItem.update({ where: { id: a.id }, data: { priority: "HIGH" }, select: { id: true } }),
      () => bulkSetPriority(ownerCtx(), [a.id, b.id], "HIGH"),
    );

    // Read unlocked, both counted as changed and A got "NONE → HIGH" for
    // a value its UPDATE never replaced.
    expect(await bulk).toEqual({ changed: 1, skipped: 1 });
    expect(await priorityHistory(a.id)).toEqual([]);
    expect(await priorityHistory(b.id)).toEqual([{ oldValue: "NONE", newValue: "HIGH" }]);
  });

  it("bulkChangeState: a row a colleague had just moved to Done is skipped — one audit event, and its completedAt stands", async () => {
    const a = await createItem(ownerCtx(), { projectId, title: "Bulk state A" });
    const b = await createItem(ownerCtx(), { projectId, title: "Bulk state B" });
    const done = (await statesByRank()).find((s) => s.category === "DONE")!;
    // The colleague's move runs the state machine itself, so it writes
    // the history row and the audit event the waiting bulk must not repeat.
    const { held: first, result: bulk } = await raceBehind(
      async (tx) => {
        const item = await tx.workItem.findFirst({
          where: { tenantId: f.tenantId, id: a.id },
          omit: { description: true, descriptionText: true },
        });
        if (!item) throw new Error("the colleague could not read the item");
        return transitionState(tx, ownerCtx(), item, done);
      },
      () => bulkChangeState(ownerCtx(), [a.id, b.id], done.id),
    );

    expect(await bulk).toEqual({ changed: 1, skipped: 1 });
    // A: the colleague's event and nothing more — read unlocked, a second
    // one, a second history row, and a restamped completedAt.
    expect(await stateAudits(a.id)).toBe(1);
    expect(await stateAudits(b.id)).toBe(1);
    const fresh = await f.platform.workItem.findUniqueOrThrow({ where: { id: a.id }, select: { completedAt: true } });
    expect(first.completedAt).toBeInstanceOf(Date);
    expect(fresh.completedAt).toEqual(first.completedAt);
  });

  it("moveItem: a state leg that waited on a colleague's Done records DONE as where it came from, never To do", async () => {
    const { id } = await createItem(ownerCtx(), { projectId, title: "Moved mid-wait" });
    const states = await statesByRank();
    const done = states.find((s) => s.category === "DONE")!;
    const progress = states.find((s) => s.category === "IN_PROGRESS")!;
    // The item as its own anchor: a state-only move that keeps its
    // position. It waits on its own row (FOR UPDATE, the rank UPDATE's
    // mode) — the colleague's transaction — never on the rank lock.
    const { result: moving } = await raceBehind(
      (tx) =>
        tx.workItem.update({
          where: { id },
          data: { stateId: done.id, stateCategory: "DONE", completedAt: new Date() },
          select: { id: true },
        }),
      () => moveItem(ownerCtx(), { itemId: id, stateId: progress.id, afterId: id }),
    );

    expect(await moving).toMatchObject({ id, stateId: progress.id, stateCategory: "IN_PROGRESS" });
    const history = await f.platform.workItemActivity.findMany({
      where: { tenantId: f.tenantId, workItemId: id, field: "stateCategory" },
      select: { oldValue: true, newValue: true },
    });
    // The colleague's raw write leaves no row of its own; read unlocked,
    // the move said "TODO → IN_PROGRESS", and so did its audit.
    expect(history).toEqual([{ oldValue: "DONE", newValue: "IN_PROGRESS" }]);
    const audits = await f.platform.auditEvent.findMany({
      where: { tenantId: f.tenantId, targetId: id, action: "work_item.state_changed" },
      select: { metadata: true },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]?.metadata).toMatchObject({ from: "DONE", to: "IN_PROGRESS" });
  });
});

describe("stage names follow the viewer's language until renamed (§6.14, 2026-09-01)", () => {
  it("seeds the seven defaults with NO name and a durable seed key, in board order", async () => {
    // A NULL name is the whole mechanism: it is what tells the UI this
    // state is still wearing its default and must render in the
    // VIEWER's locale. If seeding ever writes a name again, every
    // account silently goes back to reading the tenant's language.
    const states = await f.platform.workflowState.findMany({
      where: { tenantId: f.tenantId, projectId },
      orderBy: { rank: "asc" },
      select: { name: true, seedKey: true, category: true },
    });
    expect(states.map((s) => s.seedKey)).toEqual([
      "BACKLOG",
      "TODO",
      "IN_PROGRESS",
      "IN_REVIEW",
      "DONE",
      "CANCELLED",
      "TRIAGE",
    ]);
    expect(states.every((s) => s.name === null)).toBe(true);
    // Seven keys, six categories — the two IN_PROGRESS states are
    // distinguishable ONLY by seed key, which is why this column is not
    // just a mirror of `category`.
    expect(states.filter((s) => s.category === "IN_PROGRESS").map((s) => s.seedKey)).toEqual([
      "IN_PROGRESS",
      "IN_REVIEW",
    ]);
  });

  it("hands listItems the raw pair, never a resolved string — the service has no locale", async () => {
    const { id } = await createItem(ownerCtx(), { projectId, title: "Unnamed state" });
    const data = await listItems(ownerCtx(), projectId);
    const entry = data.items.find((i) => i.id === id)!;
    expect(entry.stateName).toBeNull();
    expect(entry.stateSeedKey).toBe("TODO");
    expect(data.states.every((s) => s.name === null && s.seedKey !== null)).toBe(true);
  });

  it("a rename is a ONE-WAY DOOR: writing a name makes the state tenant text, and re-seeding never undoes it", async () => {
    const todo = await f.platform.workflowState.findFirstOrThrow({
      where: { tenantId: f.tenantId, projectId, seedKey: "TODO" },
    });
    // finally, not a trailing statement: this renames a state on the
    // SHARED fixture project, and a failure below would leave it named
    // for every later test in this file.
    try {
      await f.platform.workflowState.update({
        where: { id: todo.id },
        data: { name: "Redo att göra" },
      });

      // ensureProjectStates runs on every work read; it must not resurrect
      // the default over a name the tenant chose.
      await listItems(ownerCtx(), projectId);
      const after = await f.platform.workflowState.findUniqueOrThrow({ where: { id: todo.id } });
      expect(after.name).toBe("Redo att göra");
      expect(after.seedKey).toBe("TODO"); // identity survives the rename
    } finally {
      await f.platform.workflowState.update({ where: { id: todo.id }, data: { name: null } });
    }
  });

  it("the database refuses a state that is neither named nor seeded", async () => {
    await expect(
      f.platform.workflowState.create({
        data: {
          tenantId: f.tenantId,
          projectId,
          name: null,
          seedKey: null,
          category: "BACKLOG",
          rank: "zzz1",
        },
      }),
    ).rejects.toThrow(/workflow_state_name_or_seed_key/);
  });

  it("the database refuses two of the same default in one project", async () => {
    // This unique is also what makes the lazy seed's `skipDuplicates`
    // race-safe now that seeded names are NULL and no longer collide.
    await expect(
      f.platform.workflowState.create({
        data: {
          tenantId: f.tenantId,
          projectId,
          name: null,
          seedKey: "DONE",
          category: "DONE",
          rank: "zzz2",
        },
      }),
    ).rejects.toThrow(/seed_key/);
  });

  it("the MIGRATION'S OWN backfill keys pre-2026-09-01 rows correctly — run against real rows, not an empty table", async () => {
    // CI applies this migration to an EMPTY database, so its backfill
    // touches ZERO rows there and its correctness against real data is
    // otherwise never exercised. This runs the migration's ACTUAL
    // statement — read out of the .sql file, so it cannot drift from
    // what shipped — over a project shaped like a pre-migration one.
    const sql = readFileSync(
      join(process.cwd(), "prisma/migrations/20260901180000_workflow_state_seed_key/migration.sql"),
      "utf8",
    );
    const backfill = sql.slice(sql.indexOf("WITH canonical AS"));
    const statement = backfill.slice(0, backfill.indexOf(";") + 1);
    expect(statement).toContain("row_number()");

    // A canonical seven-state project as it looked BEFORE this slice:
    // every state named, none keyed. Names are deliberately English —
    // the naxdor case, where a hand-rename is byte-identical to the seed
    // table, so a name-matching backfill could not tell them apart.
    const legacyProject = randomUUID();
    await f.platform.project.create({
      data: { id: legacyProject, tenantId: f.tenantId, clientId, key: "LEG", name: "Legacy" },
    });
    const legacy = [
      { name: "Backlog", category: "BACKLOG", rank: "a0" },
      { name: "To do", category: "TODO", rank: "a1" },
      { name: "In progress", category: "IN_PROGRESS", rank: "a2" },
      { name: "In review", category: "IN_PROGRESS", rank: "a3" },
      { name: "Done", category: "DONE", rank: "a4" },
      { name: "Cancelled", category: "CANCELLED", rank: "a5" },
      { name: "Triage", category: "TRIAGE", rank: "a6" },
    ] as const;
    // A NON-canonical project too: the backfill must skip it entirely
    // rather than mis-key it positionally.
    const oddProject = randomUUID();
    await f.platform.project.create({
      data: { id: oddProject, tenantId: f.tenantId, clientId, key: "ODD", name: "Odd" },
    });

    try {
      await f.platform.workflowState.createMany({
        data: legacy.map((s) => ({
          tenantId: f.tenantId,
          projectId: legacyProject,
          name: s.name,
          category: s.category,
          rank: s.rank,
        })),
      });
      await f.platform.workflowState.create({
        data: {
          tenantId: f.tenantId,
          projectId: oddProject,
          name: "Only state",
          category: "TODO",
          rank: "a0",
        },
      });

      await f.platform.$executeRawUnsafe(statement);

      const keyed = await f.platform.workflowState.findMany({
        where: { tenantId: f.tenantId, projectId: legacyProject },
        orderBy: { rank: "asc" },
        select: { name: true, seedKey: true },
      });
      // Positional, and the two IN_PROGRESS states are told apart by rank
      // order — the whole reason the key is (category, rank-order).
      expect(keyed.map((s) => s.seedKey)).toEqual([
        "BACKLOG",
        "TODO",
        "IN_PROGRESS",
        "IN_REVIEW",
        "DONE",
        "CANCELLED",
        "TRIAGE",
      ]);
      // IDENTITY ONLY: not one name may be touched, or a tenant loses
      // wording it chose (naxdor's English renames, most of all).
      expect(keyed.map((s) => s.name)).toEqual(legacy.map((s) => s.name));

      const odd = await f.platform.workflowState.findMany({
        where: { tenantId: f.tenantId, projectId: oddProject },
        select: { name: true, seedKey: true },
      });
      expect(odd).toEqual([{ name: "Only state", seedKey: null }]);

      // The statement is deliberately UNSCOPED — a migration has to be —
      // so pin the blast radius rather than assume it: a project that is
      // ALREADY keyed comes out identical, because the positional key
      // recomputes the same values. That is what makes it idempotent,
      // and it is the reason running it twice is safe.
      const shared = await f.platform.workflowState.findMany({
        where: { tenantId: f.tenantId, projectId },
        orderBy: { rank: "asc" },
        select: { name: true, seedKey: true },
      });
      expect(shared.map((s) => s.seedKey)).toEqual([
        "BACKLOG",
        "TODO",
        "IN_PROGRESS",
        "IN_REVIEW",
        "DONE",
        "CANCELLED",
        "TRIAGE",
      ]);
      expect(shared.every((s) => s.name === null)).toBe(true);
    } finally {
      await f.platform.workflowState.deleteMany({
        where: { tenantId: f.tenantId, projectId: { in: [legacyProject, oddProject] } },
      });
      await f.platform.project.deleteMany({
        where: { tenantId: f.tenantId, id: { in: [legacyProject, oddProject] } },
      });
    }
  });

  it("lets a tenant add its own state, which carries a name and no seed key", async () => {
    // These land at ranks zzz3/zzz4, i.e. AFTER every seeded a* rank, so
    // a leak would make "Blocked" the last IN_PROGRESS state — which is
    // exactly what the 2W-R approval-gate test below picks as "In
    // review". It would still pass, while testing the wrong column.
    // Hence finally, on the shared fixture project.
    const ids: string[] = [];
    try {
      const own = await f.platform.workflowState.create({
        data: {
          tenantId: f.tenantId,
          projectId,
          name: "Waiting on client",
          seedKey: null,
          category: "IN_PROGRESS",
          rank: "zzz3",
        },
      });
      ids.push(own.id);
      expect(own.seedKey).toBeNull();
      // A second one must be allowed — NULL seed keys do not collide.
      const another = await f.platform.workflowState.create({
        data: {
          tenantId: f.tenantId,
          projectId,
          name: "Blocked",
          seedKey: null,
          category: "IN_PROGRESS",
          rank: "zzz4",
        },
      });
      ids.push(another.id);
      expect(another.seedKey).toBeNull();
    } finally {
      await f.platform.workflowState.deleteMany({
        where: { tenantId: f.tenantId, id: { in: ids } },
      });
    }
  });
});

describe("§6.14 triggers (raw writes against the DB)", () => {
  it("a state's category is immutable", async () => {
    const state = await f.platform.workflowState.findFirstOrThrow({
      where: { tenantId: f.tenantId, projectId, category: "TODO" },
    });
    await expect(
      f.platform.workflowState.update({ where: { id: state.id }, data: { category: "DONE" } }),
    ).rejects.toThrow(/immutable/);
  });

  it("a CLIENT_VISIBLE child under an INTERNAL parent is rejected", async () => {
    const parent = await createItem(ownerCtx(), { projectId, title: "Internal parent" });
    const state = await f.platform.workflowState.findFirstOrThrow({
      where: { tenantId: f.tenantId, projectId, isDefault: true },
    });
    await expect(
      f.platform.workItem.create({
        data: {
          id: randomUUID(),
          tenantId: f.tenantId,
          clientId,
          projectId,
          number: 900,
          type: "SUBTASK",
          title: "child",
          stateId: state.id,
          stateCategory: state.category,
          parentId: parent.id,
          rootId: "ignored",
          rank: `zz-${randomUUID().slice(0, 6)}`,
          visibility: "CLIENT_VISIBLE",
        },
      }),
    ).rejects.toThrow(/CLIENT_VISIBLE under an INTERNAL parent/);
  });

  it("the parent guard derives depth and rootId", async () => {
    const parent = await createItem(ownerCtx(), { projectId, title: "Epic-ish parent" });
    const child = await createItem(ownerCtx(), { projectId, title: "Child", parentId: parent.id });
    const row = await f.platform.workItem.findUniqueOrThrow({ where: { id: child.id } });
    expect(row.depth).toBe(1);
    expect(row.rootId).toBe(parent.id);
    expect(row.type).toBe("SUBTASK");
  });

  it("downgrading an item with a CLIENT_VISIBLE comment is refused; after deleting the comment it succeeds", async () => {
    await f.platform.project.update({ where: { id: projectId }, data: { portalEnabled: true } });
    const { id } = await createItem(ownerCtx(), { projectId, title: "Shared task" });
    await changeItemVisibility(ownerCtx(), id, "CLIENT_VISIBLE");
    const comment = await f.platform.comment.create({
      data: {
        tenantId: f.tenantId,
        subjectType: "WORK_ITEM",
        subjectId: id,
        authorMemberId: f.seats.owner.memberId,
        body: {},
        bodyText: "visible reply",
        visibility: "CLIENT_VISIBLE",
      },
    });
    await expect(changeItemVisibility(ownerCtx(), id, "INTERNAL")).rejects.toMatchObject({
      code: "HAS_VISIBLE_CHILDREN",
    });
    await f.platform.comment.delete({ where: { id: comment.id } });
    await changeItemVisibility(ownerCtx(), id, "INTERNAL");
    const row = await f.platform.workItem.findUniqueOrThrow({ where: { id } });
    expect(row.visibility).toBe("INTERNAL");
  });
});

describe("deny-default scoping", () => {
  it("an unassigned employee gets NOT_FOUND; a client assignment lifts it", async () => {
    await expect(listItems(employeeCtx(), projectId)).rejects.toThrow(AuthzError);
    await f.platform.memberClient.create({
      data: { tenantId: f.tenantId, memberId: f.seats.employee.memberId, clientId },
    });
    const list = await listItems(employeeCtx(), projectId);
    expect(list.items.length).toBeGreaterThan(0);
    expect(list.caps.canDelete).toBe(false); // employee lacks work_item:delete
  });
});

/**
 * The panel's one read. Its denial is NOT covered by the browser test —
 * there `loadProject` 404s first, so the item-level scope check would
 * pass a deleted `assertInScope` unnoticed (2026-09-12 review). This
 * block puts the seam under test directly. It runs AFTER the scoping
 * block above, which is what assigns the employee to this client.
 */
describe("getItemDetail — the panel's one scoped read", () => {
  it("returns an archived item, refuses a soft-deleted one, and shows no soft-deleted parent", async () => {
    const parent = await createItem(ownerCtx(), { projectId, title: "Detail parent" });
    const child = await createItem(ownerCtx(), { projectId, title: "Detail child", parentId: parent.id });

    const { item } = await getItemDetail(ownerCtx(), projectId, child.number);
    expect(item.id).toBe(child.id);
    expect(item.type).toBe("SUBTASK");
    expect(item.parent).toMatchObject({ number: parent.number, title: "Detail parent" });

    // The board's list has no archived rows; the panel must still open one.
    await setItemArchived(ownerCtx(), child.id, true);
    expect((await getItemDetail(ownerCtx(), projectId, child.number)).item.archivedAt).not.toBeNull();
    await setItemArchived(ownerCtx(), child.id, false);

    // A soft-deleted parent is no reference to show — the panel would
    // link a key that 404s — and the parent itself is gone from it.
    await f.platform.workItem.update({ where: { id: parent.id }, data: { deletedAt: new Date() } });
    expect((await getItemDetail(ownerCtx(), projectId, child.number)).item.parent).toBeNull();
    await expect(getItemDetail(ownerCtx(), projectId, parent.number)).rejects.toThrow(AuthzError);
    await f.platform.workItem.update({ where: { id: parent.id }, data: { deletedAt: null } });
  });

  it("a project the member is not assigned to answers exactly as a number that exists nowhere", async () => {
    const otherClientId = randomUUID();
    const otherProjectId = randomUUID();
    await f.platform.client.create({
      data: { id: otherClientId, tenantId: f.tenantId, name: "Other Co" },
    });
    await f.platform.project.create({
      data: { id: otherProjectId, tenantId: f.tenantId, clientId: otherClientId, key: "OTHER", name: "Other site" },
    });
    const strangers = await createItem(ownerCtx(), { projectId: otherProjectId, title: "Not the employee's" });

    // Positive control FIRST: in the project they hold, the same call resolves.
    const mine = await createItem(ownerCtx(), { projectId, title: "The employee's own project" });
    expect((await getItemDetail(employeeCtx(), projectId, mine.number)).item.id).toBe(mine.id);

    // The other client's project: an AuthzError, the same shape a
    // number that exists nowhere gets (AUTHZ §4 — existence never leaks).
    await expect(getItemDetail(employeeCtx(), otherProjectId, strangers.number)).rejects.toThrow(AuthzError);
    await expect(getItemDetail(employeeCtx(), projectId, 999_999)).rejects.toThrow(AuthzError);
    // And a number of THIS project cannot be read through another project's id.
    await expect(getItemDetail(ownerCtx(), otherProjectId, mine.number)).rejects.toThrow(AuthzError);
  });

  it("carries the project's states by rank, the caps the pickers need, and the members the A picker lists", async () => {
    const { number } = await createItem(ownerCtx(), { projectId, title: "Picker data" });
    const { states, canEdit, canApprove, canChangeVisibility, members } = await getItemDetail(
      ownerCtx(),
      projectId,
      number,
    );

    // By RANK, not by name or insertion — the picker's group order is
    // the project's order and nothing downstream re-sorts it.
    const ranked = await f.platform.workflowState.findMany({
      where: { tenantId: f.tenantId, projectId },
      orderBy: { rank: "asc" },
      select: { id: true },
    });
    expect(states.map((s) => s.id)).toEqual(ranked.map((s) => s.id));

    // The RAW pair, resolved at the page boundary and never here.
    const seeded = states.find((s) => s.seedKey === "DONE")!;
    expect(seeded.name).toBeNull();
    expect(seeded.requiresApproval).toBe(true);

    expect(canEdit).toBe(true);
    expect(canApprove).toBe(true);
    expect(canChangeVisibility).toBe(true);

    // The A picker's rows: every ACTIVE member, the owner first (joined
    // first), each with a name to show — the same read listItems makes.
    const ids = members.map((m) => m.id);
    expect(ids[0]).toBe(f.seats.owner.memberId);
    expect(ids).toEqual(expect.arrayContaining([f.seats.manager.memberId, f.seats.employee.memberId]));
    expect(members.every((m) => m.name.length > 0)).toBe(true);
  });

  it("an employee gets canApprove and canChangeVisibility false — the gated Done and the V picker stay out of reach", async () => {
    const { number } = await createItem(ownerCtx(), { projectId, title: "Employee caps" });
    const r = await getItemDetail(employeeCtx(), projectId, number);
    expect(r.canEdit).toBe(true);
    expect(r.canApprove).toBe(false);
    expect(r.canChangeVisibility).toBe(false);
    // The states themselves are not filtered server-side: hiding the
    // target is UX (`enterableStates`), and `transitionState` is the belt.
    expect(r.states.some((s) => s.requiresApproval)).toBe(true);
  });
});

describe("getItemDetail carries the item's history (panel slice 8)", () => {
  const nameOf = async (memberId: string): Promise<string> =>
    (
      await f.platform.member.findUniqueOrThrow({
        where: { id: memberId },
        select: { user: { select: { name: true } } },
      })
    ).user.name;

  it("newest first in write order, the writers' encodings, the actor and both assignee refs named, INTERNAL on a private task, no cursor under one page", async () => {
    const { id, number } = await createItem(ownerCtx(), { projectId, title: "History" });
    // THREE rows in ONE transaction, in the writer's field order: the
    // display order rests on Prisma minting uuid(7) in sequence within a
    // millisecond, and this is where that assumption is pinned. The
    // values are the encodings activity-copy.ts parses — digits, an ISO
    // day — pinned here against the real writer.
    await updateItemFields(ownerCtx(), id, {
      priority: "HIGH",
      estimateMinutes: 90,
      targetDate: new Date("2026-09-20T00:00:00.000Z"),
    });
    await assignItem(ownerCtx(), id, f.seats.manager.memberId);
    await assignItem(ownerCtx(), id, f.seats.employee.memberId);
    const doing = await f.platform.workflowState.findFirstOrThrow({
      where: { tenantId: f.tenantId, projectId, category: "IN_PROGRESS" },
      orderBy: { rank: "asc" },
    });
    await changeState(ownerCtx(), id, doing.id);

    const { activity } = await getItemDetail(ownerCtx(), projectId, number);
    expect(activity.rows.map((r) => r.field)).toEqual([
      "stateCategory",
      "assignee",
      "assignee",
      "targetDate",
      "estimate",
      "priority",
      "created",
    ]);
    expect(activity.before).toBeNull();
    expect(activity.nextCursor).toBeNull();
    // The keyset's order IS the display order: ids strictly descending,
    // the same-transaction trio included.
    const ids = activity.rows.map((r) => r.id);
    expect([...ids].sort().reverse()).toEqual(ids);

    const owner = await nameOf(f.seats.owner.memberId);
    for (const r of activity.rows) {
      expect(r.actor).toEqual({ kind: "member", memberId: f.seats.owner.memberId, contactId: null, name: owner });
      expect(r.visibility).toBe("INTERNAL");
    }
    const [state, reassign, assign, targetDate, estimate, priority] = activity.rows;
    expect(state).toMatchObject({
      oldValue: "TODO",
      newValue: "IN_PROGRESS",
      newRef: doing.id,
      // Refs are named for the assignee field ONLY — a state ref is the
      // page's to resolve, against the states it already holds.
      oldRefName: null,
      newRefName: null,
    });
    expect(state!.oldRef).toEqual(expect.any(String));
    expect(reassign).toMatchObject({
      oldRef: f.seats.manager.memberId,
      newRef: f.seats.employee.memberId,
      oldRefName: await nameOf(f.seats.manager.memberId),
      newRefName: await nameOf(f.seats.employee.memberId),
    });
    expect(assign).toMatchObject({
      oldRef: null,
      newRef: f.seats.manager.memberId,
      oldRefName: null,
      newRefName: await nameOf(f.seats.manager.memberId),
    });
    expect(targetDate).toMatchObject({ oldValue: null, newValue: "2026-09-20", oldRef: null, newRef: null });
    expect(estimate).toMatchObject({ oldValue: null, newValue: "90", oldRef: null, newRef: null });
    expect(priority).toMatchObject({ oldValue: "NONE", newValue: "HIGH", oldRef: null, newRef: null });
  });

  it("pages by keyset on the row id without a gap or an overlap; a cursor that is not one of THIS item's rows is the newest page", async () => {
    const { id, number } = await createItem(ownerCtx(), { projectId, title: "Long history" });
    const other = await createItem(ownerCtx(), { projectId, title: "Somebody else's history" });
    // ACTIVITY_PAGE_SIZE + 5 raw rows on top of the creation row: two
    // pages, the second short. Raw, so the test costs one statement
    // rather than 55 locked writes.
    const extra = ACTIVITY_PAGE_SIZE + 5;
    await f.platform.workItemActivity.createMany({
      data: Array.from({ length: extra }, (_, i) => ({
        tenantId: f.tenantId,
        clientId,
        projectId,
        workItemId: id,
        actorMemberId: f.seats.owner.memberId,
        field: "priority",
        oldValue: i % 2 ? "HIGH" : "LOW",
        newValue: i % 2 ? "LOW" : "HIGH",
        visibility: "INTERNAL" as const,
      })),
    });

    const first = (await getItemDetail(ownerCtx(), projectId, number)).activity;
    expect(first.rows).toHaveLength(ACTIVITY_PAGE_SIZE);
    expect(first.before).toBeNull();
    expect(first.nextCursor).toBe(first.rows.at(-1)!.id);

    const second = (await getItemDetail(ownerCtx(), projectId, number, { activityBefore: first.nextCursor })).activity;
    expect(second.before).toBe(first.nextCursor);
    expect(second.rows).toHaveLength(extra + 1 - ACTIVITY_PAGE_SIZE);
    expect(second.nextCursor).toBeNull();
    expect(second.rows.at(-1)!.field).toBe("created");

    const all = [...first.rows, ...second.rows].map((r) => r.id);
    expect(new Set(all).size).toBe(extra + 1);
    expect([...all].sort().reverse()).toEqual(all);

    // The same row id in upper case IS that row: the parser lowercases,
    // because the column compares byte-wise.
    const upper = (await getItemDetail(ownerCtx(), projectId, number, { activityBefore: first.nextCursor!.toUpperCase() })).activity;
    expect(upper.before).toBe(first.nextCursor);
    expect(upper.rows.map((r) => r.id)).toEqual(second.rows.map((r) => r.id));

    // Not one of THIS item's rows: the newest page, unpaged — never an
    // error, never a 404, and never a filter. Garbage, an injection, a
    // well-formed id that is no row, the item's own id, and a row of
    // ANOTHER item — a bare `id <` bound would have filtered this item's
    // history by that stranger and, for an older one, answered "no older
    // activity" to a member looking at a full history.
    const otherRow = await f.platform.workItemActivity.findFirstOrThrow({
      where: { workItemId: other.id },
      select: { id: true },
    });
    for (const cursor of ["", "abc", "not-a-uuid", `${first.nextCursor} OR 1=1`, randomUUID(), id, otherRow.id]) {
      const page = (await getItemDetail(ownerCtx(), projectId, number, { activityBefore: cursor })).activity;
      expect(page.before, cursor).toBeNull();
      expect(page.rows.map((r) => r.id), cursor).toEqual(first.rows.map((r) => r.id));
    }
  });

  it("a suspended member keeps their name, a contact actor has one, and an id that resolves to nobody has none", async () => {
    const { id, number } = await createItem(ownerCtx(), { projectId, title: "Names" });
    await assignItem(ownerCtx(), id, f.seats.employee.memberId);
    const employee = await nameOf(f.seats.employee.memberId);
    await f.platform.member.update({ where: { id: f.seats.employee.memberId }, data: { status: "SUSPENDED" } });
    try {
      const { activity } = await getItemDetail(ownerCtx(), projectId, number);
      expect(activity.rows[0]).toMatchObject({ field: "assignee", newRef: f.seats.employee.memberId, newRefName: employee });
    } finally {
      await f.platform.member.update({ where: { id: f.seats.employee.memberId }, data: { status: "ACTIVE" } });
    }

    // Phase 3's contact-caused row, and the two kinds of nobody: an
    // actor id that resolves to no member (the UI's "Unknown"), and a row
    // with no actor at all (the system). Three round trips, so three ids
    // in order.
    const ghost = randomUUID();
    const base = { tenantId: f.tenantId, clientId, projectId, workItemId: id, field: "title", oldValue: "a", newValue: "b", visibility: "INTERNAL" as const };
    await f.platform.workItemActivity.create({ data: { ...base, actorContactId: contact.id } });
    await f.platform.workItemActivity.create({ data: { ...base, actorMemberId: ghost } });
    await f.platform.workItemActivity.create({ data: { ...base } });
    const { activity } = await getItemDetail(ownerCtx(), projectId, number);
    expect(activity.rows.slice(0, 3).map((r) => r.actor)).toEqual([
      { kind: "system", memberId: null, contactId: null, name: null },
      { kind: "member", memberId: ghost, contactId: null, name: null },
      { kind: "contact", memberId: null, contactId: contact.id, name: "Client Carol" },
    ]);
  });
});

describe("contact comment census (the one direct contact INSERT)", () => {
  let visibleItemId: string;

  beforeAll(async () => {
    const { id } = await createItem(ownerCtx(), { projectId, title: "Fönsterputsning offert" });
    await changeItemVisibility(ownerCtx(), id, "CLIENT_VISIBLE");
    visibleItemId = id;
  });

  it("a contact can INSERT a CLIENT_VISIBLE comment as themselves on a visible item", async () => {
    await withTenant(
      f.tenantId,
      { type: "contact", id: contact.id, clientId },
      async (tx) => {
        const c = await tx.comment.create({
          data: {
            tenantId: f.tenantId,
            subjectType: "WORK_ITEM",
            subjectId: visibleItemId,
            authorContactId: contact.id,
            body: {},
            bodyText: "Tack, ser bra ut!",
            visibility: "CLIENT_VISIBLE",
          },
        });
        expect(c.clientId).toBe(clientId); // denormalised by the trigger
        expect(c.projectId).toBe(projectId);
        expect(c.portalEnabled).toBe(true);
      },
    );
  });

  it("an INTERNAL comment or a forged author is rejected by WITH CHECK", async () => {
    await expect(
      withTenant(f.tenantId, { type: "contact", id: contact.id, clientId }, async (tx) => {
        await tx.comment.create({
          data: {
            tenantId: f.tenantId,
            subjectType: "WORK_ITEM",
            subjectId: visibleItemId,
            authorContactId: contact.id,
            body: {},
            bodyText: "smuggled internal",
            visibility: "INTERNAL",
          },
        });
      }),
    ).rejects.toThrow();
    await expect(
      withTenant(f.tenantId, { type: "contact", id: contact.id, clientId }, async (tx) => {
        await tx.comment.create({
          data: {
            tenantId: f.tenantId,
            subjectType: "WORK_ITEM",
            subjectId: visibleItemId,
            authorContactId: randomUUID(), // not the principal
            body: {},
            bodyText: "forged author",
            visibility: "CLIENT_VISIBLE",
          },
        });
      }),
    ).rejects.toThrow();
  });

  it("a contact cannot UPDATE work_item — the readable row is still unwritable (WITH CHECK)", async () => {
    await expect(
      withTenant(f.tenantId, { type: "contact", id: contact.id, clientId }, async (tx) => {
        await tx.workItem.updateMany({
          where: { id: visibleItemId },
          data: { title: "defaced" },
        });
      }),
    ).rejects.toThrow(/row-level security/);
    const row = await f.platform.workItem.findUniqueOrThrow({ where: { id: visibleItemId } });
    expect(row.title).not.toBe("defaced");
  });
});

describe("search: the lexeme probe", () => {
  it("an INTERNAL body word never matches under a contact principal; a CLIENT_VISIBLE title does", async () => {
    const secret = `hemlighet${randomUUID().slice(0, 6)}`;
    const { id } = await createItem(ownerCtx(), { projectId, title: "Internt arbete" });
    await f.platform.workItem.update({
      where: { id },
      data: { descriptionText: `${secret} får aldrig synas` },
    });

    const probe = async (principal: Parameters<typeof withTenant>[1], term: string) =>
      withTenant(f.tenantId, principal, async (tx) => {
        const rows = await tx.$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM search_index
            WHERE search @@ websearch_to_tsquery('public.fortleva_sv', $1)`,
          term,
        );
        return rows[0]?.n ?? -1;
      });

    const member = { type: "member", id: f.seats.owner.memberId } as const;
    const contactP = { type: "contact", id: contact.id, clientId } as const;
    expect(await probe(member, secret)).toBe(1);
    expect(await probe(contactP, secret)).toBe(0);
    // The shared item's title matches for its own client's contact…
    expect(await probe(contactP, "fönsterputsning")).toBe(1);
    // …and stops matching when the project's portal is switched off.
    await f.platform.project.update({ where: { id: projectId }, data: { portalEnabled: false } });
    expect(await probe(contactP, "fönsterputsning")).toBe(0);
    await f.platform.project.update({ where: { id: projectId }, data: { portalEnabled: true } });
  });
});

describe("notify.emit: assignment fan-out with dedupe", () => {
  // This describe counts the tenant's assignment notifications and
  // outbox rows BY KIND, so it starts from none: the describes above
  // hand tasks over freely and leave their mail behind (the inbox
  // suite's rule — sweep at the counter, not at every writer).
  beforeAll(async () => {
    await f.platform.emailOutbox.deleteMany({ where: { tenantId: f.tenantId, kind: "work_item.assigned" } });
    await f.platform.notification.deleteMany({ where: { tenantId: f.tenantId, kind: "work_item.assigned" } });
  });

  it("assigning creates one notification + one debounced outbox row; reassigning while unread collapses", async () => {
    const { id } = await createItem(ownerCtx(), { projectId, title: "Assigned work" });
    await assignItem(ownerCtx(), id, f.seats.employee.memberId);

    const notifications = await f.platform.notification.findMany({
      where: { tenantId: f.tenantId, kind: "work_item.assigned", entityId: id },
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.receiverId).toBe(f.seats.employee.memberId);
    const outbox = await f.platform.emailOutbox.findMany({
      where: { tenantId: f.tenantId, kind: "work_item.assigned" },
    });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.status).toBe("QUEUED");
    expect(outbox[0]!.sendAfter.getTime()).toBeGreaterThan(Date.now() + 60_000);

    // Unassign + reassign while the first notification is unread: the
    // dedupeKey collapses the repeat — still exactly one of each.
    await assignItem(ownerCtx(), id, null);
    await assignItem(ownerCtx(), id, f.seats.employee.memberId);
    expect(
      await f.platform.notification.count({
        where: { tenantId: f.tenantId, kind: "work_item.assigned", entityId: id },
      }),
    ).toBe(1);
    expect(
      await f.platform.emailOutbox.count({
        where: { tenantId: f.tenantId, kind: "work_item.assigned" },
      }),
    ).toBe(1);
  });

  it("the receiver reads their own notification under their principal; another member reads none", async () => {
    const employee = { type: "member", id: f.seats.employee.memberId } as const;
    const manager = { type: "member", id: f.seats.manager.memberId } as const;
    const mine = await withTenant(f.tenantId, employee, (tx) =>
      tx.notification.count({ where: { kind: "work_item.assigned" } }),
    );
    const theirs = await withTenant(f.tenantId, manager, (tx) =>
      tx.notification.count({ where: { kind: "work_item.assigned" } }),
    );
    expect(mine).toBe(1);
    expect(theirs).toBe(0); // principal_scope binds SELECT to the receiver
  });
});

describe("review 2026-08-21 — history follows the item behind the gate", () => {
  it("downgrading an item flips its CLIENT_VISIBLE activity rows to INTERNAL; a CLIENT_VISIBLE activity row on an INTERNAL item is refused at the database", async () => {
    await f.platform.project.update({ where: { id: projectId }, data: { portalEnabled: true } });
    const { id } = await createItem(ownerCtx(), { projectId, title: "Shared then private" });
    await changeItemVisibility(ownerCtx(), id, "CLIENT_VISIBLE");
    await updateItemFields(ownerCtx(), id, { title: "Shared, renamed" }); // title is portal-safe ⇒ CLIENT_VISIBLE history
    const visibleBefore = await f.platform.workItemActivity.count({ where: { tenantId: f.tenantId, workItemId: id, visibility: "CLIENT_VISIBLE" } });
    expect(visibleBefore).toBeGreaterThan(0);
    await withTenant(f.tenantId, { type: "contact", id: contact.id, clientId }, async (tx) => {
      expect(await tx.workItemActivity.count({ where: { workItemId: id } })).toBe(visibleBefore);
    });

    await changeItemVisibility(ownerCtx(), id, "INTERNAL");
    expect(await f.platform.workItemActivity.count({ where: { tenantId: f.tenantId, workItemId: id, visibility: "CLIENT_VISIBLE" } })).toBe(0);
    await withTenant(f.tenantId, { type: "contact", id: contact.id, clientId }, async (tx) => {
      expect(await tx.workItemActivity.count({ where: { workItemId: id } })).toBe(0);
    });

    // The guard: no writer — not even the owner role — can stamp a visible history row on a private item.
    await expect(
      f.platform.workItemActivity.create({
        data: { tenantId: f.tenantId, clientId, projectId, workItemId: id, field: "title", visibility: "CLIENT_VISIBLE" },
      }),
    ).rejects.toThrow(/cannot be CLIENT_VISIBLE on an item the client cannot see/);
    // And client_id / project_id are derived from the item, not trusted from the writer.
    const other = randomUUID();
    await f.platform.client.create({ data: { id: other, tenantId: f.tenantId, name: "Other" } });
    const row = await f.platform.workItemActivity.create({
      data: { tenantId: f.tenantId, clientId: other, projectId, workItemId: id, field: "title", visibility: "INTERNAL" },
    });
    expect(row.clientId).toBe(clientId);
    await f.platform.workItemActivity.delete({ where: { id: row.id } });
    await f.platform.client.delete({ where: { id: other } });
  });
});

describe("the approval gate (2W-R)", () => {
  it("an employee cannot enter Done by any path; an approver can; reopening is free; caps agree", async () => {
    // Scope the employee to the project's client (idempotent — the
    // scoping suite above may already have done it).
    await f.platform.memberClient.createMany({
      data: [{ tenantId: f.tenantId, memberId: f.seats.employee.memberId, clientId }],
      skipDuplicates: true,
    });
    const { id } = await createItem(ownerCtx(), { projectId, title: "Gate walk" });
    const states = await f.platform.workflowState.findMany({
      where: { tenantId: f.tenantId, projectId },
      orderBy: { rank: "asc" },
    });
    const inProgress = states.filter((s) => s.category === "IN_PROGRESS");
    const review = inProgress.at(-1)!; // "In review" — the last IN_PROGRESS by rank
    const done = states.find((s) => s.category === "DONE")!;

    // The employee works the item up to review…
    await changeState(employeeCtx(), id, review.id);
    // …but not into the gated Done — inline path, board path, or a
    // create straight into the column. transitionState is ONE gate.
    await expect(changeState(employeeCtx(), id, done.id)).rejects.toThrow(/APPROVAL_REQUIRED/);
    await expect(moveItem(employeeCtx(), { itemId: id, stateId: done.id })).rejects.toThrow(
      /APPROVAL_REQUIRED/,
    );
    await expect(
      createItem(employeeCtx(), { projectId, title: "Sneaks into Done", stateId: done.id }),
    ).rejects.toThrow(/APPROVAL_REQUIRED/);
    // Nothing moved, nothing was created.
    const item = await f.platform.workItem.findUniqueOrThrow({ where: { id } });
    expect(item.stateId).toBe(review.id);
    expect(
      await f.platform.workItem.count({
        where: { tenantId: f.tenantId, projectId, title: "Sneaks into Done" },
      }),
    ).toBe(0);

    // The approver completes it; the audit row marks the privileged leg.
    await changeState(ownerCtx(), id, done.id);
    const audits = await f.audits("work_item.state_changed");
    expect(
      audits.some((a) => (a.metadata as { approval?: boolean } | null)?.approval === true),
    ).toBe(true);

    // Reopening is free — the gate never traps an item — and the
    // Done → In review leg clears completedAt while keeping startedAt
    // (the review flow's most common reopen; the review pass found this
    // stamp leg unpinned by any test).
    await changeState(employeeCtx(), id, review.id);
    const reopened = await f.platform.workItem.findUniqueOrThrow({ where: { id } });
    expect(reopened.stateId).toBe(review.id);
    expect(reopened.completedAt).toBeNull();
    expect(reopened.startedAt).not.toBeNull();

    // caps tell the UI the same story the service enforces.
    expect((await listItems(employeeCtx(), projectId)).caps.canApprove).toBe(false);
    expect((await listItems(ownerCtx(), projectId)).caps.canApprove).toBe(true);
  });
});

describe("planning-field activity visibility (2W-G — targetDate's first UI exposure)", () => {
  it("priority and estimate activity stay INTERNAL while targetDate follows a CLIENT_VISIBLE item; none of it audits", async () => {
    const { id } = await createItem(ownerCtx(), { projectId, title: "Groomed task" });
    await changeItemVisibility(ownerCtx(), id, "CLIENT_VISIBLE");
    // Counted AFTER the visibility flip, which IS audited: only the
    // routine edit below must add nothing.
    const auditBefore = await f.platform.auditEvent.count({ where: { tenantId: f.tenantId, targetId: id } });
    await updateItemFields(ownerCtx(), id, {
      priority: "HIGH",
      estimateMinutes: 60,
      targetDate: dateColumn("2026-09-15"),
    });
    const rows = await f.platform.workItemActivity.findMany({
      where: { tenantId: f.tenantId, workItemId: id, field: { in: ["priority", "estimate", "targetDate"] } },
    });
    // The PORTAL_SAFE_FIELDS split (activity.ts): estimate/priority are
    // internal facts; the due date is part of the client-facing plan.
    expect(rows.find((r) => r.field === "priority")?.visibility).toBe("INTERNAL");
    expect(rows.find((r) => r.field === "estimate")?.visibility).toBe("INTERNAL");
    expect(rows.find((r) => r.field === "targetDate")?.visibility).toBe("CLIENT_VISIBLE");
    // Routine edits write activity, never audit (AGENTS.md).
    expect(await f.platform.auditEvent.count({ where: { tenantId: f.tenantId, targetId: id } })).toBe(auditBefore);
  });
});

describe("deleteItem cascades to the thread (comments/cascade.ts)", () => {
  /**
   * A comment's index row carries its body (`title = left(body_text,
   * 140)`) and `Comment.subjectId` has no FK, so until 2026-09-07 a
   * task's soft delete left its whole thread alive and findable. The
   * cascade takes every LIVE comment on the subject with ONE stamp, one
   * `comment.deleted {reason, workItemId}` each — and nothing else: the
   * control on a live item and the already-deleted comment both prove
   * the WHERE is exactly as wide as the subject.
   */
  const token = `kaskad${randomUUID().slice(0, 8).replace(/-/g, "")}`;
  const indexRows = async (ids: string[]): Promise<number> => {
    const r = await f.platform.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM search_index
       WHERE tenant_id = ${f.tenantId} AND entity_type = 'COMMENT' AND entity_id = ANY(${ids}::text[])`;
    // An unfiltered count() always returns exactly one row.
    return r[0]!.n;
  };
  const comment = (subjectId: string, bodyText: string, extra: { parentId?: string; deletedAt?: Date } = {}) =>
    f.platform.comment.create({
      data: {
        tenantId: f.tenantId,
        subjectType: "WORK_ITEM",
        subjectId,
        authorMemberId: f.seats.owner.memberId,
        body: {},
        bodyText,
        ...extra,
      },
      select: { id: true, deletedAt: true },
    });

  it("soft-deletes every live comment and reply on the item with one stamp, audits each with ids only, and touches nothing else", async () => {
    const doomed = await createItem(ownerCtx(), { projectId, title: "Doomed thread" });
    const survivor = await createItem(ownerCtx(), { projectId, title: "Surviving thread" });
    const root = await comment(doomed.id, `${token} root body`);
    const reply = await comment(doomed.id, `${token} reply body`, { parentId: root.id });
    const already = await comment(doomed.id, `${token} already gone`, {
      deletedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const control = await comment(survivor.id, `${token} control body`);
    const all = [root.id, reply.id, already.id, control.id];

    // Positive before-state: the feed indexed the live ones, not the
    // pre-deleted one — so "no index row afterwards" means something.
    expect(await indexRows([root.id, reply.id])).toBe(2);
    expect(await indexRows([already.id])).toBe(0);
    expect(await indexRows([control.id])).toBe(1);

    await deleteItem(ownerCtx(), doomed.id);

    const item = await f.platform.workItem.findUniqueOrThrow({
      where: { id: doomed.id },
      select: { deletedAt: true },
    });
    expect(item.deletedAt).not.toBeNull();
    const stamps = new Map(
      (await f.platform.comment.findMany({ where: { id: { in: all } }, select: { id: true, deletedAt: true } })).map(
        (c) => [c.id, c.deletedAt],
      ),
    );
    // The thread carries the item's own stamp.
    expect(stamps.get(root.id)).toEqual(item.deletedAt);
    expect(stamps.get(reply.id)).toEqual(item.deletedAt);
    // Already deleted: untouched.
    expect(stamps.get(already.id)).toEqual(already.deletedAt);
    // The control on a live item: alive and still indexed.
    expect(stamps.get(control.id)).toBeNull();
    expect(await indexRows([control.id])).toBe(1);
    // The feed removed the cascaded rows.
    expect(await indexRows([root.id, reply.id])).toBe(0);

    // Exactly the two live comments are audited — the already-deleted
    // one gets no second row under a reason it never had.
    const audits = await f.platform.auditEvent.findMany({
      where: { tenantId: f.tenantId, action: "comment.deleted", targetId: { in: all } },
    });
    expect(audits.map((a) => a.targetId).sort()).toEqual([root.id, reply.id].sort());
    for (const a of audits) {
      expect(a.targetType).toBe("Comment");
      expect(a.actorId).toBe(f.seats.owner.memberId);
      expect(a.metadata).toEqual({ reason: "work_item_deleted", workItemId: doomed.id });
      expect(JSON.stringify(a.metadata)).not.toContain(token);
    }
    // And the item's own event still lands.
    expect(
      await f.platform.auditEvent.count({
        where: { tenantId: f.tenantId, action: "work_item.deleted", targetId: doomed.id },
      }),
    ).toBe(1);
  });
});

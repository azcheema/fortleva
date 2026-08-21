import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { withTenant } from "@/db";
import { setupTenant } from "@/members/dbtest-fixture";
import {
  assignItem,
  changeItemVisibility,
  changeState,
  createItem,
  listItems,
  updateItemFields,
} from "./index";

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

  it("lazy state seeding created the default six exactly once", async () => {
    const states = await f.platform.workflowState.findMany({
      where: { tenantId: f.tenantId, projectId },
    });
    expect(states).toHaveLength(6);
    expect(states.filter((s) => s.isDefault)).toHaveLength(1);
    expect(states.find((s) => s.category === "TRIAGE")?.isHidden).toBe(true);
  });
});

describe("state machine", () => {
  it("stamps startedAt on first IN_PROGRESS, completedAt on DONE, clears on regression; audits the transition", async () => {
    const { id } = await createItem(ownerCtx(), { projectId, title: "State walk" });
    const states = await f.platform.workflowState.findMany({
      where: { tenantId: f.tenantId, projectId },
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
    await expect(changeItemVisibility(ownerCtx(), id, "INTERNAL")).rejects.toThrow(
      /client-visible children/,
    );
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

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { withTenant } from "@/db";
import { dateColumn } from "@/lib/duration";
import { setupTenant } from "@/members/dbtest-fixture";
import {
  assignItem,
  changeItemVisibility,
  changeState,
  createItem,
  deleteItem,
  listItems,
  moveItem,
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
  it("priority activity stays INTERNAL while targetDate follows a CLIENT_VISIBLE item", async () => {
    const { id } = await createItem(ownerCtx(), { projectId, title: "Groomed task" });
    await changeItemVisibility(ownerCtx(), id, "CLIENT_VISIBLE");
    await updateItemFields(ownerCtx(), id, {
      priority: "HIGH",
      targetDate: dateColumn("2026-09-15"),
    });
    const rows = await f.platform.workItemActivity.findMany({
      where: { tenantId: f.tenantId, workItemId: id, field: { in: ["priority", "targetDate"] } },
    });
    // The PORTAL_SAFE_FIELDS split (activity.ts): estimate/priority are
    // internal facts; the due date is part of the client-facing plan.
    expect(rows.find((r) => r.field === "priority")?.visibility).toBe("INTERNAL");
    expect(rows.find((r) => r.field === "targetDate")?.visibility).toBe("CLIENT_VISIBLE");
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

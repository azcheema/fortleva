import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { setupTenant } from "@/members/dbtest-fixture";
import { createItem } from "@/modules/work";

import { PER_TYPE_LIMIT, search } from "./query";

/**
 * The first reader of `search_index`, against the real database and the
 * real `app_runtime` role.
 *
 * What is at stake is not that search finds things — it is the two
 * properties nothing else in the estate can enforce:
 *
 *   1. MEMBER SCOPE IS HAND-APPLIED HERE. RLS on this table carries
 *      tenant isolation and the contact portal gate and nothing else, so
 *      a bare tenant-scoped read returns every project's rows, and the
 *      index row already holds the title. `scopeWhere` cannot be used
 *      (the table is deliberately not a Prisma model), and AUTHZ.md now
 *      says plainly that only a dbtest guards this — there is no lint
 *      rule, whatever the doc used to claim. This file IS that dbtest.
 *   2. THE CONFIG COMES FROM THE ROW. The one prior query in the repo
 *      hardcodes `fortleva_sv`; copying it would return nothing for an
 *      `en` tenant, silently.
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
/** The employee is scoped to this client only. */
let clientId: string;
let projectId: string;
/** A different client entirely — never in the employee's scope. */
let foreignClientId: string;
let foreignProjectId: string;
/** A word that exists in no dictionary, so a match is never incidental. */
const token = `zqxwv${randomUUID().slice(0, 8).replace(/-/g, "")}`;

beforeAll(async () => {
  f = await setupTenant("search");
  clientId = randomUUID();
  projectId = randomUUID();
  foreignClientId = randomUUID();
  foreignProjectId = randomUUID();
  await f.platform.client.create({ data: { id: clientId, tenantId: f.tenantId, name: "Search Co" } });
  await f.platform.project.create({
    data: { id: projectId, tenantId: f.tenantId, clientId, key: "SRCH", name: "Search project" },
  });
  await f.platform.client.create({
    data: { id: foreignClientId, tenantId: f.tenantId, name: "Not yours" },
  });
  await f.platform.project.create({
    data: {
      id: foreignProjectId,
      tenantId: f.tenantId,
      clientId: foreignClientId,
      key: "SRCHX",
      name: "Foreign project",
    },
  });
  // The employee holds ONE client. The owner holds `client:view_all`.
  await f.platform.memberClient.create({
    data: { tenantId: f.tenantId, memberId: f.seats.employee.memberId, clientId },
  });
}, 60_000);

afterAll(async () => {
  const db = f.platform;
  // search_index first and by tenant: its rows are trigger-fed with no
  // FK, so deleting the sources below reaches most of them, and nothing
  // reaches a row whose source is already gone.
  await db.$executeRaw`DELETE FROM search_index WHERE tenant_id = ${f.tenantId}`;
  // comment RESTRICTs project (comment_tenant_id_project_id_fkey), so it
  // goes before the work items and the project — the same shape as the
  // tenant_preference gap that once made a teardown fail with a 23001.
  await db.comment.deleteMany({ where: { tenantId: f.tenantId } });
  await db.workItemActivity.deleteMany({ where: { tenantId: f.tenantId } });
  await db.workItem.deleteMany({ where: { tenantId: f.tenantId, parentId: { not: null } } });
  await db.workItem.deleteMany({ where: { tenantId: f.tenantId } });
  await db.workflowState.deleteMany({ where: { tenantId: f.tenantId } });
  await db.memberClient.deleteMany({ where: { tenantId: f.tenantId } });
  await db.project.deleteMany({ where: { tenantId: f.tenantId } });
  await db.client.deleteMany({ where: { tenantId: f.tenantId } });
  await db.tenantCounter.deleteMany({ where: { tenantId: f.tenantId } });
  await f.cleanup();
}, 60_000);

const ownerCtx = () => ({ tenantId: f.tenantId, actor: f.seats.owner.actor });
const employeeCtx = () => ({ tenantId: f.tenantId, actor: f.seats.employee.actor });
const adminCtx = () => ({ tenantId: f.tenantId, actor: f.seats.admin.actor });

const hits = async (ctx: ReturnType<typeof ownerCtx>, q: string) => {
  const r = await search(ctx, q);
  return r.kind === "results" ? r.hits : [];
};
const titles = async (ctx: ReturnType<typeof ownerCtx>, q: string) =>
  (await hits(ctx, q)).map((h) => h.title).sort();

describe("search — the scope boundary", () => {
  it("A MEMBER NEVER SEES A ROW FROM A CLIENT THEY ARE NOT ON — the only thing enforcing it is this query", async () => {
    const mine = `Mine ${token}`;
    const theirs = `Theirs ${token}`;
    await createItem(ownerCtx(), { projectId, title: mine });
    await createItem(ownerCtx(), { projectId: foreignProjectId, title: theirs });

    // The owner holds client:view_all, so both.
    expect(await titles(ownerCtx(), token)).toEqual([mine, theirs].sort());
    // The employee holds one client, so one — and NOT the other's title,
    // which the index row carries in full.
    expect(await titles(employeeCtx(), token)).toEqual([mine]);
  });

  it("A SEAT WITH NO ASSIGNMENTS SEES NOTHING — deny-default, without a query reaching the table", async () => {
    // The admin template holds `client:view_all` in this product (the
    // CMA row), so the genuinely scope-limited seat is the employee.
    // This one is the employee with its assignment removed.
    await f.platform.memberClient.deleteMany({
      where: { tenantId: f.tenantId, memberId: f.seats.employee.memberId },
    });
    try {
      expect(await titles(employeeCtx(), token)).toEqual([]);
    } finally {
      await f.platform.memberClient.create({
        data: { tenantId: f.tenantId, memberId: f.seats.employee.memberId, clientId },
      });
    }
  });

  it("admin holds client:view_all, so it is NOT scope-limited — the trap a previous slice paid for", async () => {
    // AGENTS.md records this: an unassigned seat is not automatically an
    // out-of-scope one. Asserting it here stops a future reader
    // concluding from the test above that any seat without a
    // MemberClient row is blind.
    expect((await titles(adminCtx(), token)).length).toBeGreaterThan(0);
  });
});

describe("search — the permission gate", () => {
  it("SCOPE IS NOT A PERMISSION: an assignment without a read permission returns NOTHING", async () => {
    // The escalation this gate exists to stop. Assignments and roles are
    // independent axes (AUTHZ.md §4, "Permission ∧ scope"), so a member
    // can hold a MemberClient row and a role that grants no read at all.
    // Unguarded, search would still have handed them every task title,
    // every document name, every client and contact name — and the first
    // 140 characters of every internal COMMENT, because a COMMENT row's
    // title IS left(body_text, 140).
    const title = `Gated ${token}`;
    await createItem(ownerCtx(), { projectId, title });
    // Sanity: the employee CAN see it while holding the employee role.
    expect(await titles(employeeCtx(), token)).toContain(title);

    const seats = await f.platform.memberRole.findMany({
      where: { tenantId: f.tenantId, memberId: f.seats.employee.memberId },
    });
    await f.platform.memberRole.deleteMany({
      where: { tenantId: f.tenantId, memberId: f.seats.employee.memberId },
    });
    try {
      // Same member, same MemberClient assignment, no role.
      expect(await titles(employeeCtx(), token)).toEqual([]);
    } finally {
      await f.platform.memberRole.createMany({
        data: seats.map((r) => ({ tenantId: r.tenantId, memberId: r.memberId, roleId: r.roleId })),
        skipDuplicates: true,
      });
    }
  });

  it("a type whose permission is missing drops out, and the rest still answer", async () => {
    // Losing one read must narrow the answer, not empty it. The employee
    // keeps every permission except work_item:view, so the CLIENT row
    // still matches by name while the task does not.
    const named = `Uniquename${token}`;
    await f.platform.client.update({ where: { id: clientId }, data: { name: named } });
    await createItem(ownerCtx(), { projectId, title: `Task ${named}` });

    const role = await f.platform.role.findFirstOrThrow({
      where: { tenantId: f.tenantId, templateKey: "employee" },
    });
    const perm = await f.platform.permission.findFirstOrThrow({ where: { code: "work_item:view" } });
    const revoked = await f.platform.rolePermission.deleteMany({
      where: { tenantId: f.tenantId, roleId: role.id, permissionId: perm.id },
    });
    // Permission changes are cached per tenant by permissionsVersion.
    await f.platform.tenant.update({
      where: { id: f.tenantId },
      data: { permissionsVersion: { increment: 1 } },
    });
    try {
      const found = await hits(employeeCtx(), named);
      expect(found.some((h) => h.entityType === "WORK_ITEM")).toBe(false);
      expect(found.some((h) => h.entityType === "CLIENT")).toBe(true);
    } finally {
      if (revoked.count > 0) {
        await f.platform.rolePermission.create({
          data: { tenantId: f.tenantId, roleId: role.id, permissionId: perm.id },
        });
        await f.platform.tenant.update({
          where: { id: f.tenantId },
          data: { permissionsVersion: { increment: 1 } },
        });
      }
      await f.platform.client.update({ where: { id: clientId }, data: { name: "Search Co" } });
    }
  });
});

describe("search — the hydrate belt", () => {
  it("A SOFT-DELETED TASK STOPS BEING FINDABLE even if its index row lingers", async () => {
    // §6.19's second belt. The feed removes the row on a soft delete, so
    // this simulates the failure the belt exists for: an index row that
    // outlives its source, which is exactly what search_feed_document
    // did until 2026-09-06, and what a COMMENT on a deleted task did
    // until the cascade of 2026-09-07. Rows that predate either fix, and
    // hand-run maintenance paths, are what the belt still covers.
    const title = `Stale ${token}`;
    const item = await createItem(ownerCtx(), { projectId, title });
    expect(await titles(ownerCtx(), token)).toContain(title);

    // Soft-delete it — the feed removes the index row — then put the row
    // BACK. That is the state a missed feed leaves behind, and it is the
    // only way to produce it here: DISABLE TRIGGER needs table
    // ownership, which app_platform does not have.
    await f.platform.workItem.update({ where: { id: item.id }, data: { deletedAt: new Date() } });
    await f.platform.$executeRawUnsafe(
      `INSERT INTO search_index
         (id, tenant_id, entity_type, entity_id, client_id, project_id, title, lang)
       VALUES ($1, $2, 'WORK_ITEM', $3, $4, $5, $6, search_lang($2))
       ON CONFLICT (tenant_id, entity_type, entity_id) DO NOTHING`,
      randomUUID(),
      f.tenantId,
      item.id,
      clientId,
      projectId,
      title,
    );

    // The index row is still there…
    const stillIndexed = await f.platform.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM search_index
       WHERE tenant_id = ${f.tenantId} AND entity_type = 'WORK_ITEM' AND entity_id = ${item.id}`;
    expect(stillIndexed[0]?.n).toBe(1);
    // …and search does not return it.
    expect(await titles(ownerCtx(), token)).not.toContain(title);
  });
});

describe("search — the query itself", () => {
  it("finds a task by a word in its title, and reports the type and the ids", async () => {
    const title = `Fönsterputsning ${token}`;
    const created = await createItem(ownerCtx(), { projectId, title });
    const found = (await hits(ownerCtx(), token)).find((h) => h.entityId === created.id);
    expect(found).toBeDefined();
    expect(found!.entityType).toBe("WORK_ITEM");
    expect(found!.projectId).toBe(projectId);
    expect(found!.clientId).toBe(clientId);
    expect(found!.rank).toBeGreaterThan(0);
  });

  it("matches through the tenant's own config — an accent is not a different word", async () => {
    // `fortleva_sv`/`fortleva_en` both run unaccent, so the ASCII
    // spelling must find the accented title. This is the assertion that
    // fails if a future reader hardcodes a config or drops unaccent.
    const title = `Åtgärdslista ${token}`;
    await createItem(ownerCtx(), { projectId, title });
    expect(await titles(ownerCtx(), `Atgardslista ${token}`)).toContain(title);
  });

  it("a query of nothing but stop words is EMPTY-QUERY, not 'no results'", async () => {
    // The two are different answers to the member: one says the query
    // said nothing, the other says the workspace holds nothing.
    const r = await search(ownerCtx(), "och");
    expect(r.kind).toBe("empty-query");
    const blank = await search(ownerCtx(), "   ");
    expect(blank.kind).toBe("empty-query");
  });

  it("a query that matches nothing is RESULTS with none — the honest empty", async () => {
    const r = await search(ownerCtx(), `absolutelynothingmatchesthis${token}`);
    expect(r.kind).toBe("results");
    expect(r.kind === "results" && r.hits).toEqual([]);
  });

  it("caps each type, so one noisy type cannot crowd out the rest", async () => {
    const crowd = `crowd${token}`;
    for (let i = 0; i < PER_TYPE_LIMIT + 4; i++) {
      await createItem(ownerCtx(), { projectId, title: `${crowd} ${i}` });
    }
    const found = await hits(ownerCtx(), crowd);
    expect(found.length).toBe(PER_TYPE_LIMIT);
    expect(found.every((h) => h.entityType === "WORK_ITEM")).toBe(true);
  });

  it("every hit carries an address built from the LIVE source, not parsed out of a label", async () => {
    // The index has neither the project key nor the item number as a
    // field — only baked into `subtitle` as "SRCH-12". Parsing an
    // address back out of a label is how a project rename silently
    // breaks every link, so the hydrate that re-reads the source for
    // freshness returns the address too.
    const title = `Addressable ${token}`;
    const item = await createItem(ownerCtx(), { projectId, title });
    const hit = (await hits(ownerCtx(), token)).find((h) => h.entityId === item.id);
    expect(hit?.href).toBe(`/projects/SRCH/backlog?item=SRCH-${item.number}`);

    // A CLIENT row addresses its card; a PROJECT row its overview.
    const named = `Addressableclient${token}`;
    await f.platform.client.update({ where: { id: clientId }, data: { name: named } });
    try {
      const client = (await hits(ownerCtx(), named)).find((h) => h.entityType === "CLIENT");
      expect(client?.href).toBe(`/clients/${clientId}`);
    } finally {
      await f.platform.client.update({ where: { id: clientId }, data: { name: "Search Co" } });
    }
  });

  it("A COMMENT IS FINDABLE ON ITS OWN, even when its task's title matches nothing", async () => {
    // The defect this pins: the hydrate built its work-item lookup from
    // the work-item HITS only, so a comment whose parent task did not
    // also match the same query resolved to no address and was dropped
    // — silently making comments unsearchable while the page, the
    // palette and both message catalogues all promised them.
    const word = `kommentarord${token}`;
    const item = await createItem(ownerCtx(), { projectId, title: "Ett helt annat namn" });
    await f.platform.comment.create({
      data: {
        tenantId: f.tenantId,
        subjectType: "WORK_ITEM",
        subjectId: item.id,
        clientId,
        projectId,
        authorMemberId: f.seats.owner.memberId,
        body: {},
        bodyText: `${word} står i kommentaren`,
      },
    });

    const found = (await hits(ownerCtx(), word)).find((h) => h.entityType === "COMMENT");
    expect(found).toBeDefined();
    // And it addresses the task it was written on.
    expect(found!.href).toBe(`/projects/SRCH/backlog?item=SRCH-${item.number}`);
  });

  it("AN ARCHIVED TASK'S ADDRESS ASKS FOR ARCHIVED ROWS — or the link opens a backlog that hides it", async () => {
    // Archived rows stay in the index by design (the work_item feed says
    // so), but the backlog resolves `?item=` against a list that drops
    // them unless asked. Without the flag the row opens a page with no
    // peek and no explanation.
    const title = `Arkiverad ${token}`;
    const item = await createItem(ownerCtx(), { projectId, title });
    await f.platform.workItem.update({
      where: { id: item.id },
      data: { archivedAt: new Date() },
    });
    const hit = (await hits(ownerCtx(), token)).find((h) => h.entityId === item.id);
    expect(hit?.href).toBe(`/projects/SRCH/backlog?item=SRCH-${item.number}&archived=1`);
  });

  it("A RENAMED PROJECT KEY still addresses correctly — the index keeps the dead key, the hit does not", async () => {
    // The index row's subtitle is frozen at feed time, so after a key
    // change it reads "SRCH-12" forever. The href must follow the live
    // project, which is the whole reason the address is not parsed from
    // the subtitle.
    const title = `Renamed ${token}`;
    const item = await createItem(ownerCtx(), { projectId, title });
    await f.platform.project.update({ where: { id: projectId }, data: { key: "SRCH2" } });
    try {
      const hit = (await hits(ownerCtx(), token)).find((h) => h.entityId === item.id);
      expect(hit?.subtitle).toBe(`SRCH-${item.number}`); // the stale label
      expect(hit?.href).toBe(`/projects/SRCH2/backlog?item=SRCH2-${item.number}`); // the live address
    } finally {
      await f.platform.project.update({ where: { id: projectId }, data: { key: "SRCH" } });
    }
  });

  it("SELECT never names the tsvector or the regconfig — both raise in the driver", async () => {
    // Not a style point: `tsvector` (OID 3614) and `regconfig` (3734)
    // have no mapping in the pg driver adapter and throw
    // UnsupportedNativeDataType, so `SELECT *` on this table is a
    // runtime error. A green search proves the projection avoids them —
    // this asserts the failure mode exists, so the rule keeps its
    // reason.
    // Matched, not bare: a bare rejects.toThrow() would pass on a typo,
    // a dropped table or a permission error — none of which is the
    // failure this rule exists for.
    await expect(
      f.platform.$queryRawUnsafe(`SELECT * FROM search_index WHERE tenant_id = $1 LIMIT 1`, f.tenantId),
    ).rejects.toThrow(/[Uu]nsupported|tsvector|column type/);
  });
});

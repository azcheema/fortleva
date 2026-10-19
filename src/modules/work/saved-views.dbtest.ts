import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { withTenant } from "@/db";
import { DomainError } from "@/lib/domain-error";
import { SAVED_VIEW_MAX } from "@/lib/saved-view-plan";
import { actorFor, setupTenant } from "@/members/dbtest-fixture";

import {
  createSavedView,
  deleteSavedView,
  listSavedViewLinks,
  readOpenSavedView,
  renameSavedView,
  updateSavedViewQuery,
} from "./saved-views";

/**
 * SAVED VIEWS against the real database and the real app_runtime role
 * (slice 136, founder decision C113; design doc §3–§5): a member's views are
 * ONLY THEIRS — `own_view` keeps every colleague, owner included, from
 * reading, changing or writing them, whoever asks; names are unique per
 * member ignoring case (the database's fold); the filters are stored
 * canonical; a backlog view needs its project in scope to be made or
 * updated, and drops out of the menu when the member loses the project; at
 * most `SAVED_VIEW_MAX`; an impersonating operator changes nothing; every
 * write audited.
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
let clientId: string;
let reachedId: string;
let otherId: string;

const owner = () => ({ tenantId: f.tenantId, actor: f.seats.owner.actor });
const employee = () => ({ tenantId: f.tenantId, actor: f.seats.employee.actor });
const manager = () => ({ tenantId: f.tenantId, actor: f.seats.manager.actor });

const outcome = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    if (e instanceof AuthzError) return e.reason;
    throw e;
  }
  return "ok";
};

/** The constraint a raw write broke, read off the error's `meta` — never its message (the Prisma code-frame trap). */
async function brokenConstraint(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return JSON.stringify((e as { meta?: unknown }).meta ?? "");
  }
  throw new Error("expected the database to refuse");
}

const auditCount = (action: string, targetId: string) =>
  f.platform.auditEvent.count({ where: { tenantId: f.tenantId, action, targetId } });

const clearViews = () => f.platform.savedView.deleteMany({ where: { tenantId: f.tenantId } });

beforeAll(async () => {
  f = await setupTenant("sview");
  clientId = randomUUID();
  await f.platform.client.create({ data: { id: clientId, tenantId: f.tenantId, name: "Acme" } });
  reachedId = randomUUID();
  otherId = randomUUID();
  await f.platform.project.create({ data: { id: reachedId, tenantId: f.tenantId, clientId, key: "SVWEB", name: "Website" } });
  await f.platform.project.create({ data: { id: otherId, tenantId: f.tenantId, clientId, key: "SVAPP", name: "App" } });
  // The employee reaches the website project only.
  await f.platform.memberProject.create({
    data: { tenantId: f.tenantId, memberId: f.seats.employee.memberId, projectId: reachedId },
  });
}, 120_000);

afterAll(async () => {
  if (!f?.tenantId) return;
  await clearViews();
  await f.platform.memberProject.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.workflowState.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.project.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.client.deleteMany({ where: { tenantId: f.tenantId } });
  await f.cleanup();
}, 120_000);

describe("making a view", () => {
  it("stores the filters canonical, links to them, and audits", async () => {
    await clearViews();
    const made = await createSavedView(employee(), {
      kind: "TASKS",
      projectId: null,
      name: "  My   overdue ",
      query: `group=person&person=${f.seats.employee.memberId.toUpperCase()}&due=overdue&item=SVWEB-3&view=x`,
    });
    expect(made.name).toBe("My overdue");
    expect(made.href).toBe(`/tasks?due=overdue&person=me&group=person&view=${made.id}`);
    const row = await f.platform.savedView.findUniqueOrThrow({ where: { id: made.id } });
    expect(row).toMatchObject({ kind: "TASKS", projectId: null, memberId: f.seats.employee.memberId, query: "due=overdue&person=me&group=person" });
    expect(await auditCount("saved_view.created", made.id)).toBe(1);
    // The act only — never the member's words or filters: the audit log is
    // the workspace's, and an owner's export carries it (the review's M1).
    const audit = await f.platform.auditEvent.findFirstOrThrow({ where: { tenantId: f.tenantId, action: "saved_view.created", targetId: made.id } });
    expect(audit.metadata).toEqual({ kind: "TASKS" });

    const backlog = await createSavedView(employee(), { kind: "BACKLOG", projectId: reachedId, name: "Web bugs", query: "hideDone=true&priority=URGENT,HIGH" });
    expect(backlog.href).toBe(`/projects/SVWEB/backlog?priority=HIGH,URGENT&hideDone=true&view=${backlog.id}`);
  });

  it("refuses a backlog the member does not reach, as if it did not exist", async () => {
    await clearViews();
    expect(await outcome(createSavedView(employee(), { kind: "BACKLOG", projectId: otherId, name: "App", query: "" }))).toBe("NOT_FOUND");
    expect(await outcome(createSavedView(employee(), { kind: "BACKLOG", projectId: randomUUID(), name: "Gone", query: "" }))).toBe("NOT_FOUND");
    expect(await f.platform.savedView.count({ where: { tenantId: f.tenantId } })).toBe(0);
  });

  it("refuses a kind and project that do not go together, and filters a view cannot keep", async () => {
    expect(await outcome(createSavedView(employee(), { kind: "TASKS", projectId: reachedId, name: "x", query: "" }))).toBe("INVALID_INPUT");
    expect(await outcome(createSavedView(employee(), { kind: "BACKLOG", projectId: null, name: "x", query: "" }))).toBe("INVALID_INPUT");
    expect(await outcome(createSavedView(employee(), { kind: "BACKLOG", projectId: reachedId, name: "x", query: "state=todo" }))).toBe(
      "VIEW_FILTERS_INVALID",
    );
    expect(await outcome(createSavedView(employee(), { kind: "TASKS", projectId: null, name: "   ", query: "" }))).toBe("NAME_REQUIRED");
  });

  it("keeps names unique per member ignoring case — Postgres's fold — but not across members", async () => {
    await clearViews();
    await createSavedView(employee(), { kind: "TASKS", projectId: null, name: "Mine", query: "person=me" });
    expect(await outcome(createSavedView(employee(), { kind: "TASKS", projectId: null, name: "MINE", query: "" }))).toBe("VIEW_NAME_TAKEN");
    // A colleague may use the same name: their views are theirs.
    expect(await outcome(createSavedView(manager(), { kind: "TASKS", projectId: null, name: "Mine", query: "" }))).toBe("ok");
  });

  it(`holds ${SAVED_VIEW_MAX} views and refuses the next`, async () => {
    await clearViews();
    await f.platform.savedView.createMany({
      data: Array.from({ length: SAVED_VIEW_MAX }, (_, i) => ({
        id: randomUUID(),
        tenantId: f.tenantId,
        memberId: f.seats.employee.memberId,
        kind: "TASKS" as const,
        name: `View ${i}`,
      })),
    });
    expect(await outcome(createSavedView(employee(), { kind: "TASKS", projectId: null, name: "One more", query: "" }))).toBe("VIEW_LIMIT");
    // Two at once at the edge: the member's lock lets exactly one through.
    await f.platform.savedView.deleteMany({ where: { tenantId: f.tenantId, name: "View 0" } });
    const both = await Promise.all([
      outcome(createSavedView(employee(), { kind: "TASKS", projectId: null, name: "Race A", query: "" })),
      outcome(createSavedView(employee(), { kind: "TASKS", projectId: null, name: "Race B", query: "" })),
    ]);
    expect(both.sort()).toEqual(["VIEW_LIMIT", "ok"]);
    await clearViews();
  });
});

describe("only theirs (own_view)", () => {
  it("is invisible and untouchable to every colleague, the owner included — and to the system", async () => {
    await clearViews();
    const { id } = await createSavedView(employee(), { kind: "TASKS", projectId: null, name: "Private", query: "due=week" });
    for (const memberId of [f.seats.owner.memberId, f.seats.manager.memberId]) {
      const seen = await withTenant(f.tenantId, { type: "member", id: memberId }, async (tx) => ({
        rows: await tx.savedView.findMany({ where: { tenantId: f.tenantId } }),
        updated: (await tx.savedView.updateMany({ where: { id }, data: { name: "Taken over" } })).count,
        deleted: (await tx.savedView.deleteMany({ where: { id } })).count,
      }));
      expect(seen).toEqual({ rows: [], updated: 0, deleted: 0 });
    }
    expect(await withTenant(f.tenantId, { type: "system" }, (tx) => tx.savedView.count({ where: { id } }))).toBe(0);
    // Nor can anyone write a row naming someone else.
    await expect(
      withTenant(f.tenantId, { type: "member", id: f.seats.owner.memberId }, (tx) =>
        tx.savedView.createMany({ data: [{ id: randomUUID(), tenantId: f.tenantId, memberId: f.seats.employee.memberId, kind: "TASKS", name: "Planted" }] }),
      ),
    ).rejects.toThrow();
    // The services answer as if it did not exist.
    expect(await outcome(renameSavedView(owner(), id, "Mine now"))).toBe("NOT_FOUND");
    expect(await outcome(updateSavedViewQuery(owner(), id, ""))).toBe("NOT_FOUND");
    expect(await outcome(deleteSavedView(owner(), id))).toBe("NOT_FOUND");
    expect(await readOpenSavedView(owner(), id, { kind: "TASKS", projectId: null })).toBeNull();
    // The member's own positive control.
    expect(await f.platform.savedView.findUniqueOrThrow({ where: { id } })).toMatchObject({ name: "Private", query: "due=week" });
    expect(await readOpenSavedView(employee(), id, { kind: "TASKS", projectId: null })).toEqual({ id, name: "Private", query: "due=week" });
  });

  it("is not a contact's either", async () => {
    await clearViews();
    const { id } = await createSavedView(employee(), { kind: "TASKS", projectId: null, name: "Mine", query: "" });
    const asContact = { type: "contact" as const, id: randomUUID(), clientId };
    expect(await withTenant(f.tenantId, asContact, (tx) => tx.savedView.count({ where: { id } }))).toBe(0);
  });

  it("changes nothing for an impersonating operator", async () => {
    await clearViews();
    const { id } = await createSavedView(employee(), { kind: "TASKS", projectId: null, name: "Mine", query: "" });
    const as = { tenantId: f.tenantId, actor: { ...actorFor(f.seats.employee.memberId), impersonated: true } };
    expect(await outcome(createSavedView(as, { kind: "TASKS", projectId: null, name: "Op", query: "" }))).toBe("FORBIDDEN");
    expect(await outcome(renameSavedView(as, id, "Op"))).toBe("FORBIDDEN");
    expect(await outcome(updateSavedViewQuery(as, id, "due=week"))).toBe("FORBIDDEN");
    expect(await outcome(deleteSavedView(as, id))).toBe("FORBIDDEN");
    expect(await f.platform.savedView.findUniqueOrThrow({ where: { id } })).toMatchObject({ name: "Mine", query: "" });
  });
});

describe("changing a view", () => {
  it("Update view stores the new filters canonical and audits the act; the same filters write nothing", async () => {
    await clearViews();
    const { id } = await createSavedView(employee(), { kind: "BACKLOG", projectId: reachedId, name: "Web", query: "hideDone=true" });
    const same = await updateSavedViewQuery(employee(), id, "hideDone=true&archived=1");
    expect(same.changed).toBe(false);
    const r = await updateSavedViewQuery(employee(), id, "group=priority&hideDone=true");
    expect(r).toMatchObject({ changed: true, href: `/projects/SVWEB/backlog?hideDone=true&group=priority&view=${id}` });
    expect((await f.platform.savedView.findUniqueOrThrow({ where: { id } })).query).toBe("hideDone=true&group=priority");
    expect(await auditCount("saved_view.updated", id)).toBe(1);
  });

  it("renames ignoring case against the member's own names, and deletes — each audited", async () => {
    await clearViews();
    const a = await createSavedView(employee(), { kind: "TASKS", projectId: null, name: "Alpha", query: "" });
    await createSavedView(employee(), { kind: "TASKS", projectId: null, name: "Beta", query: "" });
    expect(await outcome(renameSavedView(employee(), a.id, "beta"))).toBe("VIEW_NAME_TAKEN");
    expect(await renameSavedView(employee(), a.id, "Alpha")).toEqual({ name: "Alpha", changed: false });
    expect(await renameSavedView(employee(), a.id, "alpha two")).toEqual({ name: "alpha two", changed: true });
    expect(await auditCount("saved_view.renamed", a.id)).toBe(1);
    await deleteSavedView(employee(), a.id);
    expect(await f.platform.savedView.count({ where: { id: a.id } })).toBe(0);
    expect(await auditCount("saved_view.deleted", a.id)).toBe(1);
  });
});

describe("the left menu and the open view", () => {
  it("lists the member's own views by name; a backlog they no longer reach stays, with no link and no key", async () => {
    await clearViews();
    await createSavedView(employee(), { kind: "TASKS", projectId: null, name: "zeta", query: "" });
    const web = await createSavedView(employee(), { kind: "BACKLOG", projectId: reachedId, name: "Alpha web", query: "" });
    await createSavedView(manager(), { kind: "TASKS", projectId: null, name: "Manager's", query: "" });
    const list = () =>
      withTenant(f.tenantId, { type: "member", id: f.seats.employee.memberId }, (tx) =>
        listSavedViewLinks(tx, f.tenantId, f.seats.employee.actor, "sv"),
      );
    expect((await list()).map((v) => [v.name, v.projectKey])).toEqual([
      ["Alpha web", "SVWEB"],
      ["zeta", null],
    ]);
    // Taken off the project: the view stays theirs and in the menu to rename or
    // delete, but with no link and no key — and it cannot be updated.
    await f.platform.memberProject.deleteMany({ where: { tenantId: f.tenantId, memberId: f.seats.employee.memberId } });
    try {
      expect((await list()).map((v) => [v.name, v.projectKey, v.href])).toEqual([
        ["Alpha web", null, null],
        ["zeta", null, expect.stringMatching(/^\/tasks\?view=/)],
      ]);
      expect(await outcome(renameSavedView(employee(), web.id, "Old web"))).toBe("ok");
      expect(await outcome(updateSavedViewQuery(employee(), web.id, "hideDone=true"))).toBe("NOT_FOUND");
      // …and still theirs to remove.
      expect(await outcome(deleteSavedView(employee(), web.id))).toBe("ok");
    } finally {
      await f.platform.memberProject.create({ data: { tenantId: f.tenantId, memberId: f.seats.employee.memberId, projectId: reachedId } });
    }
  });

  it("opens only a view of this list — and of this project", async () => {
    await clearViews();
    const web = await createSavedView(employee(), { kind: "BACKLOG", projectId: reachedId, name: "Web", query: "hideDone=true" });
    expect(await readOpenSavedView(employee(), web.id, { kind: "BACKLOG", projectId: reachedId })).toMatchObject({ id: web.id });
    expect(await readOpenSavedView(employee(), web.id, { kind: "BACKLOG", projectId: otherId })).toBeNull();
    expect(await readOpenSavedView(employee(), web.id, { kind: "TASKS", projectId: null })).toBeNull();
    expect(await readOpenSavedView(employee(), null, { kind: "TASKS", projectId: null })).toBeNull();
  });

  it("goes with its project", async () => {
    await clearViews();
    const gone = randomUUID();
    await f.platform.project.create({ data: { id: gone, tenantId: f.tenantId, clientId, key: "SVGONE", name: "Gone" } });
    const { id } = await createSavedView(owner(), { kind: "BACKLOG", projectId: gone, name: "Gone soon", query: "" });
    await f.platform.project.delete({ where: { id: gone } });
    expect(await f.platform.savedView.count({ where: { id } })).toBe(0);
  });
});

describe("the database's own rules", () => {
  it("refuses a blank name, a query outside the outline, and a kind without its project", async () => {
    const base = { tenantId: f.tenantId, memberId: f.seats.employee.memberId, kind: "TASKS" as const, name: "Ok" };
    expect(await brokenConstraint(f.platform.savedView.create({ data: { ...base, id: randomUUID(), name: " padded" } }))).toContain("saved_view_name_ok");
    expect(await brokenConstraint(f.platform.savedView.create({ data: { ...base, id: randomUUID(), query: "due=<script>" } }))).toContain(
      "saved_view_query_ok",
    );
    expect(await brokenConstraint(f.platform.savedView.create({ data: { ...base, id: randomUUID(), kind: "BACKLOG" } }))).toContain(
      "saved_view_kind_project",
    );
  });
});

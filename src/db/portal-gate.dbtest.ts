import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PORTAL_ENABLED_FANOUT_TARGETS, RLS_CLASSES, tableNameOf, withTenant } from "./index";
import { getPlatformClient, runtimeClient } from "./client";

/**
 * The project gate at the data layer (TENANCY.md §7.2 amendment,
 * DATA_MODEL.md §2.3 behavioural test): a contact principal reads ZERO
 * project-scoped rows while Project.portalEnabled=false — across every
 * B_projectScoped table — and flipping it exposes only the CLIENT_VISIBLE
 * (SHIPPED for versions) rows of that contact's own client. Also pins
 * the trigger contract: stamp on INSERT, fan-out in the same tx, and a
 * direct write to a child's portal_enabled is overwritten (derived, not
 * app-owned). Runs as the real app_runtime role.
 */

const run = randomUUID().slice(0, 8);
const T = randomUUID();
const user = { id: randomUUID(), email: `gate-${run}@test.invalid` };
const member = { id: randomUUID() };
const acme = randomUUID();
const beta = randomUUID();
const P = randomUUID(); // Acme's project
const PB = randomUUID(); // Beta's project (portal-enabled from the start)
const contactAcme = { type: "contact", id: randomUUID(), clientId: acme } as const;
const contactBeta = { type: "contact", id: randomUUID(), clientId: beta } as const;
const memberP = { type: "member", id: member.id } as const;

const projectScopedTables = RLS_CLASSES.B_projectScoped.map(tableNameOf);

const countProjectRows = async (
  db: { $queryRawUnsafe: typeof runtimeClient.$queryRawUnsafe },
  projectId: string,
): Promise<Record<string, number>> => {
  const out: Record<string, number> = {};
  for (const t of projectScopedTables) {
    const col = t === "project" ? "id" : "project_id";
    const rows = await db.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM ${t} WHERE ${col} = $1`,
      projectId,
    );
    out[t] = rows[0]?.n ?? -1;
  }
  return out;
};

const zeros = Object.fromEntries(projectScopedTables.map((t) => [t, 0]));

beforeAll(async () => {
  const db = getPlatformClient();
  await db.tenant.create({ data: { id: T, name: `gate-${run}`, slug: `gate-${run}`, entitlements: {} } });
  await db.user.create({ data: { id: user.id, name: user.email, email: user.email } });
  await db.member.create({ data: { id: member.id, tenantId: T, userId: user.id } });
  await db.client.createMany({
    data: [
      { id: acme, tenantId: T, name: "Acme" },
      { id: beta, tenantId: T, name: "Beta" },
    ],
  });
  await db.project.createMany({
    data: [
      { id: P, tenantId: T, clientId: acme, key: "ACME", name: "Acme site" },
      { id: PB, tenantId: T, clientId: beta, key: "BETA", name: "Beta site", portalEnabled: true, hoursSharingMode: "HOURS" },
    ],
  });
  for (const [projectId, clientId] of [
    [P, acme],
    [PB, beta],
  ] as const) {
    await db.milestone.createMany({
      data: [
        { tenantId: T, clientId, projectId, name: "Design", rank: "a0", visibility: "CLIENT_VISIBLE" },
        { tenantId: T, clientId, projectId, name: "Internal QA", rank: "a1", visibility: "INTERNAL" },
      ],
    });
    await db.projectVersion.createMany({
      data: [
        { tenantId: T, clientId, projectId, version: "1.0", status: "SHIPPED", shippedAt: new Date() },
        { tenantId: T, clientId, projectId, version: "1.1", status: "DRAFT" },
      ],
    });
    await db.service.createMany({
      data: [
        { tenantId: T, clientId, projectId, name: "Hosting", kind: "RECURRING", billingInterval: "MONTHLY", visibility: "CLIENT_VISIBLE" },
        { tenantId: T, clientId, projectId, name: "Secret retainer", kind: "RECURRING", billingInterval: "MONTHLY", visibility: "INTERNAL" },
        { tenantId: T, clientId, projectId: null, name: "SEO (client-level)", kind: "ONE_TIME", visibility: "CLIENT_VISIBLE" },
      ],
    });
    await db.document.createMany({
      data: [
        { tenantId: T, clientId, projectId, name: "Brief.pdf", visibility: "CLIENT_VISIBLE" },
        { tenantId: T, clientId, projectId, name: "Internal estimate.xlsx", visibility: "INTERNAL" },
        { tenantId: T, clientId, projectId: null, name: "Contract (client-level).pdf", visibility: "CLIENT_VISIBLE" },
      ],
    });
    // 2W rows (work_item / work_item_activity / comment joined
    // B_projectScoped — one CLIENT_VISIBLE and one INTERNAL of each, so
    // the gate walk proves the visibility term on the new tables too).
    const stateId = randomUUID();
    await db.workflowState.create({
      data: { id: stateId, tenantId: T, projectId, name: "To do", category: "TODO", rank: "a0", isDefault: true },
    });
    const wiVisible = randomUUID();
    const wiInternal = randomUUID();
    await db.workItem.create({
      data: { id: wiVisible, tenantId: T, clientId, projectId, number: 1, title: "Visible task", stateId, stateCategory: "TODO", rootId: wiVisible, rank: "a0", visibility: "CLIENT_VISIBLE" },
    });
    await db.workItem.create({
      data: { id: wiInternal, tenantId: T, clientId, projectId, number: 2, title: "Internal task", stateId, stateCategory: "TODO", rootId: wiInternal, rank: "a1", visibility: "INTERNAL" },
    });
    await db.workItemActivity.createMany({
      data: [
        { tenantId: T, clientId, projectId, workItemId: wiVisible, field: "stateCategory", visibility: "CLIENT_VISIBLE" },
        { tenantId: T, clientId, projectId, workItemId: wiInternal, field: "title", visibility: "INTERNAL" },
      ],
    });
    // 2T rows: project_time_summary (visibility DERIVED from the project's
    // hoursSharingMode — P is NONE ⇒ INTERNAL, PB is HOURS ⇒ CLIENT_VISIBLE;
    // the app-supplied value is overwritten) and time_report (one PUBLISHED
    // + CLIENT_VISIBLE, one DRAFT + INTERNAL — the 4-term gate under test).
    await db.projectTimeSummary.create({
      data: { tenantId: T, clientId, projectId, periodMonth: new Date("2026-08-01T00:00:00Z"), billableSeconds: 3600, visibility: "CLIENT_VISIBLE" },
    });
    await db.timeReport.createMany({
      data: [
        { tenantId: T, clientId, projectId, title: "August", periodStart: new Date("2026-08-01T00:00:00Z"), periodEnd: new Date("2026-08-31T00:00:00Z"), snapshot: { lines: [] }, status: "PUBLISHED", visibility: "CLIENT_VISIBLE", publishedAt: new Date() },
        { tenantId: T, clientId, projectId, title: "Draft", periodStart: new Date("2026-09-01T00:00:00Z"), periodEnd: new Date("2026-09-30T00:00:00Z"), snapshot: { lines: [] }, status: "DRAFT", visibility: "INTERNAL" },
      ],
    });
    // clientId/projectId deliberately omitted: comment_denorm_guard
    // derives them from the subject — that derivation is under test.
    await db.comment.createMany({
      data: [
        { tenantId: T, subjectType: "WORK_ITEM", subjectId: wiVisible, authorMemberId: member.id, body: {}, bodyText: "client reply", visibility: "CLIENT_VISIBLE" },
        { tenantId: T, subjectType: "WORK_ITEM", subjectId: wiInternal, authorMemberId: member.id, body: {}, bodyText: "triage note", visibility: "INTERNAL" },
      ],
    });
  }
});

afterAll(async () => {
  const db = getPlatformClient();
  await db.$transaction(async (tx) => {
    // Published time reports refuse DELETE (archive-only) unless the
    // transaction-local maintenance GUC is on — the tenant-teardown path
    // (mirrors app.audit_maintenance in members/dbtest-fixture.ts).
    await tx.$executeRaw`SELECT set_config('app.time_maintenance', 'on', true)`;
    await tx.timeReport.deleteMany({ where: { tenantId: T } });
    await tx.projectTimeSummary.deleteMany({ where: { tenantId: T } });
    await tx.comment.deleteMany({ where: { tenantId: T } });
    await tx.workItemActivity.deleteMany({ where: { tenantId: T } });
    await tx.workItem.deleteMany({ where: { tenantId: T } });
    await tx.workflowState.deleteMany({ where: { tenantId: T } });
    await tx.document.deleteMany({ where: { tenantId: T } });
    await tx.service.deleteMany({ where: { tenantId: T } });
    await tx.milestone.deleteMany({ where: { tenantId: T } });
    await tx.projectVersion.deleteMany({ where: { tenantId: T } });
    await tx.project.deleteMany({ where: { tenantId: T } });
    await tx.client.deleteMany({ where: { tenantId: T } });
    await tx.member.deleteMany({ where: { tenantId: T } });
    await tx.tenant.delete({ where: { id: T } });
    await tx.user.delete({ where: { id: user.id } });
  });
  await db.$disconnect();
  await runtimeClient.$disconnect();
});

describe("portal_enabled trigger contract", () => {
  it("stamps children from the project on INSERT (false for P, true for PB); client-level rows are true", async () => {
    await withTenant(T, memberP, async (tx) => {
      const ms = await tx.milestone.findMany({ where: { projectId: P }, select: { portalEnabled: true } });
      expect(ms.map((m) => m.portalEnabled)).toEqual([false, false]);
      const msB = await tx.milestone.findMany({ where: { projectId: PB }, select: { portalEnabled: true } });
      expect(msB.map((m) => m.portalEnabled)).toEqual([true, true]);
      const clientLevel = await tx.service.findMany({ where: { projectId: null }, select: { portalEnabled: true } });
      expect(clientLevel.map((s) => s.portalEnabled)).toEqual([true, true]);
      const docs = await tx.document.findMany({ where: { projectId: null }, select: { portalEnabled: true } });
      expect(docs.map((d) => d.portalEnabled)).toEqual([true, true]);
    });
  });

  it("a direct write to a child's portal_enabled is overwritten with the derived value", async () => {
    await withTenant(T, memberP, async (tx) => {
      const upd = await tx.milestone.updateMany({ where: { projectId: P }, data: { portalEnabled: true } });
      expect(upd.count).toBe(2);
      const ms = await tx.milestone.findMany({ where: { projectId: P }, select: { portalEnabled: true } });
      expect(ms.map((m) => m.portalEnabled)).toEqual([false, false]);
    });
  });
});

describe("portalEnabled=false ⇒ zero project rows for the contact", () => {
  it("Acme's contact sees zero rows of P across every projectScoped table", async () => {
    await withTenant(T, contactAcme, async (tx) => {
      expect(await countProjectRows(tx, P)).toEqual(zeros);
      // ...while the client-level rows (no project switch) are readable.
      expect(await tx.service.count({ where: { projectId: null } })).toBe(1);
      expect(await tx.document.count({ where: { projectId: null } })).toBe(1);
      // ...and the client's own card + contacts table are reachable.
      expect((await tx.client.findMany()).map((c) => c.id)).toEqual([acme]);
    });
  });

  it("Beta's contact sees Beta's enabled project and nothing of Acme", async () => {
    await withTenant(T, contactBeta, async (tx) => {
      expect(await countProjectRows(tx, P)).toEqual(zeros);
      const b = await countProjectRows(tx, PB);
      expect(b).toEqual({
        project: 1,
        project_version: 1,
        milestone: 1,
        service: 1,
        document: 1,
        work_item: 1, // CLIENT_VISIBLE only (2W)
        work_item_activity: 1,
        comment: 1,
        project_time_summary: 1, // PB shares hours (HOURS) ⇒ derived CLIENT_VISIBLE (2T)
        time_report: 1, // PUBLISHED + CLIENT_VISIBLE only (2T, 4-term gate)
      });
    });
  });
});

describe("flipping portalEnabled=true exposes only CLIENT_VISIBLE / SHIPPED rows of that client", () => {
  it("member flips the switch; fan-out is in the same transaction; contact sees exactly the visible rows", async () => {
    await withTenant(T, memberP, async (tx) => {
      await tx.project.update({ where: { id: P }, data: { portalEnabled: true } });
      // Same transaction: children already carry the new value.
      const ms = await tx.milestone.findMany({ where: { projectId: P }, select: { portalEnabled: true } });
      expect(ms.map((m) => m.portalEnabled)).toEqual([true, true]);
      for (const m of PORTAL_ENABLED_FANOUT_TARGETS) {
        const t = tableNameOf(m);
        const rows = await tx.$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM ${t} WHERE project_id = $1 AND NOT portal_enabled`,
          P,
        );
        expect(rows[0]?.n, `${t}: every P row fanned out`).toBe(0);
      }
    });

    await withTenant(T, contactAcme, async (tx) => {
      expect(await countProjectRows(tx, P)).toEqual({
        project: 1,
        milestone: 1, // CLIENT_VISIBLE only
        project_version: 1, // SHIPPED only
        service: 1, // CLIENT_VISIBLE only
        document: 1, // CLIENT_VISIBLE only
        work_item: 1, // CLIENT_VISIBLE only (2W)
        work_item_activity: 1,
        comment: 1,
        project_time_summary: 0, // P does not share hours (NONE) ⇒ derived INTERNAL even with the portal on
        time_report: 1, // the PUBLISHED one; the DRAFT stays invisible
      });
      expect((await tx.milestone.findMany()).map((m) => m.name)).toEqual(["Design"]);
      expect((await tx.projectVersion.findMany()).map((v) => v.version)).toEqual(["1.0"]);
      // Never another client's rows.
      expect(await countProjectRows(tx, PB)).toEqual(zeros);
    });
    // Beta's contact still cannot see Acme's now-enabled project.
    await withTenant(T, contactBeta, async (tx) => {
      expect(await countProjectRows(tx, P)).toEqual(zeros);
    });
  });

  it("a milestone inserted after enabling is stamped true and immediately visible when CLIENT_VISIBLE", async () => {
    await withTenant(T, memberP, async (tx) => {
      await tx.milestone.create({
        data: { tenantId: T, clientId: acme, projectId: P, name: "Launch", rank: "a2", visibility: "CLIENT_VISIBLE" },
      });
    });
    await withTenant(T, contactAcme, async (tx) => {
      expect((await tx.milestone.findMany({ orderBy: { rank: "asc" } })).map((m) => m.name)).toEqual([
        "Design",
        "Launch",
      ]);
    });
  });

  it("flipping back to false hides everything again", async () => {
    await withTenant(T, memberP, async (tx) => {
      await tx.project.update({ where: { id: P }, data: { portalEnabled: false } });
    });
    await withTenant(T, contactAcme, async (tx) => {
      expect(await countProjectRows(tx, P)).toEqual(zeros);
    });
  });
});

describe("contact writes are pinned to the gate", () => {
  it("a contact cannot insert a milestone (WITH CHECK: portal_enabled false ⇒ rejected)", async () => {
    await expect(
      withTenant(T, contactAcme, async (tx) => {
        await tx.milestone.create({
          data: { tenantId: T, clientId: acme, projectId: P, name: "forged", rank: "zz", visibility: "CLIENT_VISIBLE" },
        });
      }),
    ).rejects.toThrow();
  });

  it("no GUC ⇒ zero rows on every new table (fail-closed)", async () => {
    for (const t of ["client", "contact", "member_client", "member_project", ...projectScopedTables]) {
      const rows = await runtimeClient.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM ${t}`);
      expect(rows[0]?.n, t).toBe(0);
    }
  });
});

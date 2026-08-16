import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/* eslint-disable no-restricted-imports -- dbtest setup/cleanup uses the raw layer */
import { getPlatformClient } from "@/db/client";
import { withTenant } from "@/db";
import { assignMemberToProject } from "@/clients/assignments";
import { createClient, getClient } from "@/clients/service";
import { commitUpload, createUpload, listDocuments } from "@/documents/service";
import { setupTenant } from "@/members/dbtest-fixture";
import { createService, deleteService, endService, listServices, updateService } from "@/services/service";
import { LocalDiskTransport, setStorage } from "@/storage";

import {
  cancelMilestone,
  completeMilestone,
  createMilestone,
  reorderMilestone,
  updateMilestone,
} from "./milestones";
import {
  archiveProject,
  changeProjectKey,
  changeProjectStatus,
  createProject,
  getProjectByKey,
  listProjects,
  setHoursSharingMode,
  setPortalEnabled,
  updateProject,
  type ProjectCtx,
} from "./service";
import { createVersion, shipVersion, updateVersion } from "./versions";

/**
 * Projects, milestones, versions, services and project documents through
 * the service layer as app_runtime (PLAN.md Phase 2 tests): key rules,
 * MemberProject(P1) sees P1 + the client card only, rank ordering under
 * concurrent reorders, ship stamps shippedAt, the portal switch is
 * audited and fans out, and a contact principal sees CLIENT_VISIBLE
 * project documents only while portalEnabled.
 */

let t: Awaited<ReturnType<typeof setupTenant>>;
let tenantId: string;
let owner: ProjectCtx;
let manager: ProjectCtx;
let employee: ProjectCtx;
let acme = "";
let gamma = "";
let p1 = "";
let p2 = "";
let p3 = "";
let storage: LocalDiskTransport;
const storageDir = mkdtempSync(join(tmpdir(), "fortleva-projects-"));

const notFound = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ reason: "NOT_FOUND" });
const forbidden = (p: Promise<unknown>) => expect(p).rejects.toMatchObject({ reason: "FORBIDDEN" });
const domain = (p: Promise<unknown>, code: string) =>
  expect(p).rejects.toMatchObject({ name: "DomainError", code });

const milestoneOrder = async (ctx: ProjectCtx, key: string) =>
  (await getProjectByKey(ctx, key)).milestones.map((m) => m.name);

beforeAll(async () => {
  storage = new LocalDiskTransport(storageDir);
  setStorage(storage);
  t = await setupTenant("projects");
  tenantId = t.tenantId;
  owner = { tenantId, actor: t.seats.owner.actor };
  manager = { tenantId, actor: t.seats.manager.actor };
  employee = { tenantId, actor: t.seats.employee.actor };
  acme = (await createClient(owner, { name: "Acme" })).id;
  gamma = (await createClient(owner, { name: "Gamma" })).id;
});

afterAll(async () => {
  const db = getPlatformClient();
  await db.fileVersion.deleteMany({ where: { tenantId } });
  await db.document.deleteMany({ where: { tenantId } });
  await db.fileObject.deleteMany({ where: { tenantId } });
  await db.service.deleteMany({ where: { tenantId } });
  await db.milestone.deleteMany({ where: { tenantId } });
  await db.projectVersion.deleteMany({ where: { tenantId } });
  await db.memberProject.deleteMany({ where: { tenantId } });
  await db.memberClient.deleteMany({ where: { tenantId } });
  await db.contact.deleteMany({ where: { tenantId } });
  await db.project.deleteMany({ where: { tenantId } });
  await db.client.deleteMany({ where: { tenantId } });
  await t.cleanup();
  setStorage(null);
  rmSync(storageDir, { recursive: true, force: true });
});

describe("create + key rules", () => {
  it("key is uppercased and validated; unique per tenant; audited", async () => {
    const r = await createProject(owner, { clientId: acme, key: " acme ", name: "Acme site" });
    expect(r.key).toBe("ACME");
    p1 = r.id;
    p2 = (await createProject(owner, { clientId: acme, key: "ACME2", name: "Acme app" })).id;
    p3 = (await createProject(owner, { clientId: gamma, key: "GAM", name: "Gamma shop" })).id;
    await domain(createProject(owner, { clientId: acme, key: "9AB", name: "x" }), "KEY_INVALID");
    await domain(createProject(owner, { clientId: acme, key: "TOOLONGKEY", name: "x" }), "KEY_INVALID");
    await domain(createProject(owner, { clientId: acme, key: "ac-me", name: "x" }), "KEY_INVALID");
    await domain(createProject(owner, { clientId: acme, key: "acme", name: "dup" }), "KEY_TAKEN");
    await domain(createProject(owner, { clientId: acme, key: "NEW", name: " " }), "NAME_REQUIRED");
    // employee lacks project:create; manager (view_all) cannot create under an unknown client
    await forbidden(createProject(employee, { clientId: acme, key: "EMP", name: "x" }));
    await notFound(createProject(manager, { clientId: randomUUID(), key: "GHOST", name: "x" }));
    expect((await t.audits("project.created")).map((e) => e.metadata)).toContainEqual({
      key: "ACME",
      name: "Acme site",
      clientId: acme,
    });
  });

  it("changeKey: audited project.key_changed; the old key is gone (no redirect in v1)", async () => {
    await domain(changeProjectKey(owner, p2, "acme"), "KEY_TAKEN");
    await domain(changeProjectKey(owner, p2, "1x"), "KEY_INVALID");
    expect(await changeProjectKey(owner, p2, "app")).toEqual({ key: "APP", changed: true });
    expect(await changeProjectKey(owner, p2, "APP")).toEqual({ key: "APP", changed: false });
    const audits = await t.audits("project.key_changed");
    expect(audits).toHaveLength(1);
    expect(audits[0]?.metadata).toEqual({ from: "ACME2", to: "APP" });
    expect((await getProjectByKey(owner, "app")).id).toBe(p2);
    await notFound(getProjectByKey(owner, "ACME2"));
  });
});

describe("scoping through the services", () => {
  it("MemberProject(P1): list = P1 only; P2/P3 NOT_FOUND; Acme card lifted, projects tab shows P1 only", async () => {
    const e = t.seats.employee.memberId;
    expect(await listProjects(employee)).toEqual([]);
    await assignMemberToProject({ tenantId, actor: manager.actor, memberId: e, projectId: p1 });
    const groups = await listProjects(employee);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.projects.map((p) => p.key)).toEqual(["ACME"]);
    expect((await getProjectByKey(employee, "ACME")).id).toBe(p1);
    await notFound(getProjectByKey(employee, "APP"));
    await notFound(getProjectByKey(employee, "GAM"));
    const card = await getClient(employee, acme);
    expect(card.direct).toBe(false);
    expect(card.projects.map((p) => p.key)).toEqual(["ACME"]);
    expect(card.internalNotes).toBeUndefined();
    await notFound(getClient(employee, gamma));
    // Milestone/version writes on P2 (same client) are NOT_FOUND for the P1-only member.
    await notFound(createMilestone(employee, { projectId: p2, name: "sneak" }));
    await notFound(createVersion(employee, { projectId: p2, version: "0.1" }));
  });

  it("owner sees every project grouped by client", async () => {
    const groups = await listProjects(owner);
    expect(groups.map((g) => g.clientName)).toEqual(["Acme", "Gamma"]);
    expect(groups[0]?.projects.map((p) => p.key).sort()).toEqual(["ACME", "APP"]);
  });
});

describe("project fields, status, portal switch", () => {
  it("update: internal fields writable by project:edit, names only in the audit row", async () => {
    const r = await updateProject(owner, p1, {
      repoUrl: "https://git.example/acme",
      hostingNotes: "Hetzner CX22 — see vault",
      internalNotes: "Client CTO prefers Slack",
      productionUrl: "https://acme.se",
      billingCurrency: "sek",
      leadMemberId: t.seats.manager.memberId,
    });
    expect(r.changed.sort()).toEqual(
      ["billingCurrency", "hostingNotes", "internalNotes", "leadMemberId", "productionUrl", "repoUrl"].sort(),
    );
    const p = await getProjectByKey(owner, "ACME");
    expect(p.billingCurrency).toBe("SEK");
    expect(p.leadName).toMatch(/^manager-projects-/);
    await domain(updateProject(owner, p1, { billingCurrency: "kronor" }), "INVALID_INPUT");
    await domain(updateProject(owner, p1, { leadMemberId: randomUUID() }), "INVALID_INPUT");
    const audit = (await t.audits("project.updated")).at(-1);
    expect(JSON.stringify(audit?.metadata)).not.toContain("Hetzner");
    expect(JSON.stringify(audit?.metadata)).not.toContain("Slack");
  });

  it("status changes are audited; archive is project:delete", async () => {
    expect(await changeProjectStatus(owner, p1, "ACTIVE")).toEqual({ changed: true });
    expect(await changeProjectStatus(owner, p1, "ACTIVE")).toEqual({ changed: false });
    expect((await t.audits("project.status_changed"))[0]?.metadata).toEqual({ from: "PLANNED", to: "ACTIVE" });
    await forbidden(archiveProject(employee, p1));
    await archiveProject(owner, p3);
    expect((await listProjects(owner)).flatMap((g) => g.projects.map((p) => p.key))).not.toContain("GAM");
    await domain(updateProject(owner, p3, { name: "x" }), "ARCHIVED");
    expect(await t.audits("project.archived")).toHaveLength(1);
  });

  it("portal switch (project:edit for now): audited both ways and fanned out to children", async () => {
    const m = await createMilestone(owner, { projectId: p1, name: "Kickoff", visibility: "CLIENT_VISIBLE" });
    expect(await setPortalEnabled(owner, p1, true)).toEqual({ changed: true });
    expect(await setPortalEnabled(owner, p1, true)).toEqual({ changed: false });
    const db = getPlatformClient();
    expect((await db.milestone.findUniqueOrThrow({ where: { id: m.id } })).portalEnabled).toBe(true);
    expect(await setPortalEnabled(owner, p1, false)).toEqual({ changed: true });
    expect((await db.milestone.findUniqueOrThrow({ where: { id: m.id } })).portalEnabled).toBe(false);
    expect((await t.audits("project.portal_enabled")).map((e) => e.targetId)).toEqual([p1]);
    expect((await t.audits("project.portal_disabled")).map((e) => e.targetId)).toEqual([p1]);
    expect(await setHoursSharingMode(owner, p1, "HOURS")).toEqual({ changed: true });
    expect((await t.audits("project.hours_sharing_changed"))[0]?.metadata).toEqual({ from: "NONE", to: "HOURS" });
    // employee (P1, project:edit via template) may flip too; a P2 flip is NOT_FOUND
    expect(await setPortalEnabled(employee, p1, true)).toEqual({ changed: true });
    await notFound(setPortalEnabled(employee, p2, true));
  });
});

describe("milestones: rank ordering", () => {
  const names = ["Design", "Build", "QA", "Launch", "Handover"];
  const idOf: Record<string, string> = {};

  it("append order, then top / after / before moves; ranks never surface", async () => {
    for (const n of names) idOf[n] = (await createMilestone(employee, { projectId: p1, name: n })).id;
    expect(await milestoneOrder(owner, "ACME")).toEqual(["Kickoff", ...names]);
    await reorderMilestone(employee, idOf.Launch!, { position: "top" });
    expect(await milestoneOrder(owner, "ACME")).toEqual(["Launch", "Kickoff", ...names.filter((n) => n !== "Launch")]);
    await reorderMilestone(employee, idOf.Launch!, { afterId: idOf.QA! });
    expect(await milestoneOrder(owner, "ACME")).toEqual(["Kickoff", "Design", "Build", "QA", "Launch", "Handover"]);
    expect(await reorderMilestone(employee, idOf.Launch!, { beforeId: idOf.Handover! })).toEqual({ changed: false });
    await reorderMilestone(employee, idOf.Handover!, { beforeId: idOf.Design! });
    expect(await milestoneOrder(owner, "ACME")).toEqual(["Kickoff", "Handover", "Design", "Build", "QA", "Launch"]);
    await domain(reorderMilestone(employee, idOf.Design!, { afterId: randomUUID() }), "INVALID_INPUT");
    // Every rank unique per project — the DB guarantees it; assert the count matches.
    const ranks = await getPlatformClient().milestone.findMany({ where: { projectId: p1 }, select: { rank: true } });
    expect(new Set(ranks.map((r) => r.rank)).size).toBe(ranks.length);
  });

  it("concurrent reorders serialise on the neighbour lock — all succeed, ranks stay unique", async () => {
    await Promise.all([
      reorderMilestone(employee, idOf.Design!, { position: "top" }),
      reorderMilestone(employee, idOf.Build!, { position: "top" }),
      reorderMilestone(employee, idOf.QA!, { position: "top" }),
      reorderMilestone(employee, idOf.Launch!, { position: "bottom" }),
    ]);
    const rows = await getPlatformClient().milestone.findMany({
      where: { projectId: p1 },
      orderBy: { rank: "asc" },
      select: { name: true, rank: true },
    });
    expect(new Set(rows.map((r) => r.rank)).size).toBe(rows.length);
    expect(rows.at(-1)?.name).toBe("Launch");
    expect(new Set(rows.slice(0, 3).map((r) => r.name))).toEqual(new Set(["Design", "Build", "QA"]));
  });

  it("complete / cancel / update are audited; complete stamps completedAt", async () => {
    await completeMilestone(employee, idOf.Design!);
    await cancelMilestone(employee, idOf.Handover!);
    await updateMilestone(employee, idOf.QA!, { name: "QA + UAT", dueAt: new Date("2026-09-01T00:00:00Z") });
    const p = await getProjectByKey(owner, "ACME");
    const design = p.milestones.find((m) => m.id === idOf.Design)!;
    expect(design.status).toBe("DONE");
    expect(design.completedAt).toBeInstanceOf(Date);
    expect(p.milestones.find((m) => m.id === idOf.Handover)?.status).toBe("CANCELLED");
    expect(p.milestones.find((m) => m.id === idOf.QA)?.name).toBe("QA + UAT");
    expect((await t.audits("milestone.completed")).map((e) => e.targetId)).toEqual([idOf.Design]);
    const list = (await listProjects(owner))[0]!.projects.find((x) => x.key === "ACME")!;
    expect(list.milestoneTotal).toBe(5); // 6 minus the cancelled one
    expect(list.milestoneDone).toBe(1);
  });
});

describe("versions", () => {
  it("draft → ship stamps shippedAt + SHIPPED; unique per project; second ship refused", async () => {
    const v = await createVersion(employee, { projectId: p1, version: "1.0", title: "Launch" });
    await domain(createVersion(employee, { projectId: p1, version: "1.0" }), "VERSION_TAKEN");
    await updateVersion(employee, v.id, { releaseNotes: "First public release." });
    const before = Date.now();
    const shipped = await shipVersion(employee, v.id);
    expect(shipped.shippedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    const row = (await getProjectByKey(owner, "ACME")).versions.find((x) => x.id === v.id)!;
    expect(row.status).toBe("SHIPPED");
    expect(row.shippedAt).toBeInstanceOf(Date);
    await domain(shipVersion(employee, v.id), "ALREADY_SHIPPED");
    await domain(updateVersion(employee, v.id, { version: "1.0.1" }), "ALREADY_SHIPPED");
    expect((await t.audits("project_version.shipped"))[0]?.metadata).toMatchObject({ projectId: p1, version: "1.0" });
  });
});

describe("services (records)", () => {
  it("client-level and project-level rows, scoped per axis; ended/deleted audited", async () => {
    const hosting = await createService(owner, {
      clientId: acme,
      projectId: p1,
      name: "Hosting",
      kind: "RECURRING",
      billingInterval: "MONTHLY",
      priceExVat: "1 200,50",
      currency: "sek",
    });
    const seo = await createService(owner, { clientId: acme, name: "SEO retainer", kind: "RECURRING" });
    await domain(createService(owner, { clientId: gamma, projectId: p1, name: "x", kind: "ONE_TIME" }), "CLIENT_MISMATCH");
    // employee (service:create is CMA) — FORBIDDEN
    await forbidden(createService(employee, { clientId: acme, projectId: p1, name: "x", kind: "ONE_TIME" }));
    // employee: P1 rows yes; the client-level SEO row is direct-scope only ⇒ absent
    expect((await listServices(employee, { clientId: acme })).map((s) => s.name)).toEqual(["Hosting"]);
    expect((await listServices(owner, { clientId: acme })).map((s) => s.name).sort()).toEqual(["Hosting", "SEO retainer"]);
    const row = (await listServices(owner, { projectId: p1 }))[0]!;
    expect(row.priceExVat).toBe("1200.5");
    expect(row.currency).toBe("SEK");
    expect(row.projectKey).toBe("ACME");
    await updateService(owner, hosting.id, { priceExVat: "1300", internalNotes: "margin thin" });
    expect(JSON.stringify((await t.audits("service.updated"))[0]?.metadata)).not.toContain("margin");
    await endService(owner, seo.id);
    expect((await listServices(owner, { clientId: acme })).find((s) => s.id === seo.id)?.status).toBe("ENDED");
    await deleteService(owner, seo.id);
    expect((await t.audits("service.ended")).map((e) => e.targetId)).toEqual([seo.id]);
    expect((await t.audits("service.deleted")).map((e) => e.targetId)).toEqual([seo.id]);
  });
});

describe("project documents + portal gate", () => {
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const upload = async (ctx: ProjectCtx, input: { projectId?: string; clientId?: string; visibility: "INTERNAL" | "CLIENT_VISIBLE"; name: string }) => {
    const body = `${input.name}-${randomUUID()}`;
    const presign = await createUpload(ctx, {
      name: input.name,
      contentType: "text/plain",
      sizeBytes: Buffer.byteLength(body),
      sha256: sha(body),
      clientId: input.clientId,
      projectId: input.projectId,
      visibility: input.visibility,
    });
    const key = new URL(presign.uploadUrl).pathname
      .replace(/^\/api\/dev-storage\//, "")
      .split("/")
      .map(decodeURIComponent)
      .join("/");
    const res = await storage.handlePut(
      new Request(presign.uploadUrl, { method: "PUT", headers: presign.headers, body: Buffer.from(body) }),
      key,
    );
    expect(res.status).toBe(200);
    return commitUpload(ctx, {
      fileObjectId: presign.fileObjectId,
      clientId: input.clientId,
      projectId: input.projectId,
      visibility: input.visibility,
    });
  };

  it("project docs inherit portal_enabled; contact sees CLIENT_VISIBLE ones only while the portal is on", async () => {
    // P1's portal was left ON by the employee flip above; turn it off to start clean.
    await setPortalEnabled(owner, p1, false);
    const brief = await upload(employee, { projectId: p1, visibility: "CLIENT_VISIBLE", name: "Brief.pdf.txt" });
    const estimate = await upload(employee, { projectId: p1, visibility: "INTERNAL", name: "Estimate.txt" });
    // Employee (P1 only) cannot attach to P2 or to Acme's client level; owner can.
    await notFound(upload(employee, { projectId: p2, visibility: "INTERNAL", name: "sneak.txt" }));
    await notFound(upload(employee, { clientId: acme, visibility: "INTERNAL", name: "sneak2.txt" }));
    const contract = await upload(owner, { clientId: acme, visibility: "CLIENT_VISIBLE", name: "Contract.txt" });

    const db = getPlatformClient();
    const rows = await db.document.findMany({ where: { id: { in: [brief.documentId, estimate.documentId, contract.documentId] } } });
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(brief.documentId)).toMatchObject({ clientId: acme, projectId: p1, portalEnabled: false });
    expect(byId.get(contract.documentId)).toMatchObject({ clientId: acme, projectId: null, portalEnabled: true });

    // Member lists: project tab shows both project docs; the P1-only employee's client-level list is empty.
    expect((await listDocuments(employee, { projectId: p1 })).map((d) => d.name).sort()).toEqual(["Brief.pdf.txt", "Estimate.txt"]);
    expect(await listDocuments(employee, { clientId: acme })).toEqual([]);
    expect((await listDocuments(owner, { clientId: acme })).map((d) => d.name)).toEqual(["Contract.txt"]);

    const contact = { type: "contact", id: randomUUID(), clientId: acme } as const;
    const seenByContact = async () =>
      (await withTenant(tenantId, contact, (tx) => tx.document.findMany({ select: { name: true } })))
        .map((d) => d.name)
        .sort();
    // Portal off: only the client-level CLIENT_VISIBLE contract.
    expect(await seenByContact()).toEqual(["Contract.txt"]);
    await setPortalEnabled(owner, p1, true);
    expect(await seenByContact()).toEqual(["Brief.pdf.txt", "Contract.txt"]);
    await setPortalEnabled(owner, p1, false);
    expect(await seenByContact()).toEqual(["Contract.txt"]);
    // A CLIENT_VISIBLE upload with no client is still refused.
    await expect(
      createUpload(owner, { name: "x.txt", contentType: "text/plain", sizeBytes: 1, sha256: sha("x"), visibility: "CLIENT_VISIBLE" }),
    ).rejects.toMatchObject({ code: "CLIENT_REQUIRED" });
  });
});

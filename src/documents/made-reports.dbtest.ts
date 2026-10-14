import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { withTenant } from "@/db";
import { DomainError } from "@/lib/domain-error";
import { localDateString } from "@/lib/duration";
import { setupTenant } from "@/members/dbtest-fixture";
import { setTransport, type MailTransport } from "@/mailer";
import { changeItemVisibility } from "@/modules/work/items";
import { setUpdateVisibility } from "@/modules/work/updates";
import { resolvePortalModuleGates, type PortalPrincipal } from "@/portal";
import { setPortalEnabled, setPortalSection } from "@/projects/service";
import { LocalDiskTransport, setStorage } from "@/storage";

import { audienceContact } from "./made-report-check";
import { deriveMadeReportContent, nextMonth } from "./made-report-content";
import { makeReport, readMakeReportForm } from "./made-reports";
import { listPortalReports } from "./portal";
import { resolvePortalDownload } from "./portal-writes";
import { commitReportUpload, editReport, hideReport, listClientReports, publishReport } from "./reports";
import { createUpload, type DocumentCtx } from "./service";

/**
 * THE MONTHLY REPORT FORTLEVA MAKES, AGAINST THE REAL SCHEMA (Phase 7 slice
 * 119; founder decision C95; design
 * docs/research/2026-10-15-slice-119-monthly-report-design.md §7).
 *
 * What only a database can say: that the content is read AS THE CLIENT
 * through the portal's projections (an INTERNAL task, an INTERNAL update, a
 * project whose portal is off, a hidden Tasks section — none reaches the
 * content); that the month is the WORKSPACE'S month; that the making writes
 * the PDF's bytes, the REPORT document, the `made_report` row and the audit
 * row in one go; that PUBLISHING CHECKS AGAIN — a task made private, an
 * update hidden, a project's portal switched off since the making refuses
 * `MADE_REPORT_STALE` and nothing is published; that the row's CHECKs and
 * triggers hold for every writer; and that an uploaded report publishes as
 * before, unchecked.
 *
 * THE SENTINEL WALK, as in every portal suite: the INTERNAL task and the
 * INTERNAL update carry strings that appear nowhere else, and every content
 * and row is searched for them.
 *
 * Tenant slug prefix `mrpt-` is registered in `DBTEST_PREFIXES`
 * (e2e/fixtures/seed-cli.ts) so `sweep-dbtests` collects orphans.
 */

const run = randomUUID().slice(0, 8);
const up = run.slice(0, 3).toUpperCase();

let f: Awaited<ReturnType<typeof setupTenant>>;
let gates: Awaited<ReturnType<typeof resolvePortalModuleGates>>;
let storage: LocalDiskTransport;
let restoreTransport: MailTransport | undefined;
const storageDir = mkdtempSync(join(tmpdir(), "fortleva-mrpt-"));

const ids = {
  acme: randomUUID(),
  beta: randomUUID(),
  gone: randomUUID(),
  carol: randomUUID(), // Acme, main contact
  dan: randomUUID(), // Acme, collaborator — the NARROWEST, so the report is read as them
  p1: randomUUID(), // portal on
  p2: randomUUID(), // portal on, Tasks hidden in one test
  p3: randomUUID(), // portal off
  doneAug: randomUUID(),
  doneAugLate: randomUUID(), // 23:30 Stockholm on 31 August — August's
  doneSeptEarly: randomUUID(), // 00:30 Stockholm on 1 September — not August's
  doneJuly: randomUUID(),
  internalDone: randomUUID(),
  openTask: randomUUID(),
  p2Done: randomUUID(),
  p2Request: randomUUID(),
  p3Done: randomUUID(),
  uAug: randomUUID(),
  uAugInternal: randomUUID(),
  uSept: randomUUID(),
  uDraft: randomUUID(),
};
const emailOf = (who: string) => `mrpt-${who}-${run}@test.invalid`;

/** Strings a client of Acme must never read. */
const S = {
  internalTask: `SENTINELMADEINTERNALTASK-${run}`,
  internalUpdate: `SENTINELMADEINTERNALUPDATE-${run}`,
  p3Task: `SENTINELMADEPORTALOFF-${run}`,
  stateName: `SENTINELMADESTATE-${run}`,
} as const;

const T = {
  doneAug: `Launch the campaign page ${run}`,
  doneAugLate: `Late on the 31st ${run}`,
  doneSeptEarly: `Early on the 1st ${run}`,
  doneJuly: `July work ${run}`,
  openTask: `Still open ${run}`,
  p2Done: `P2 shared done ${run}`,
  p2Request: `P2 request done ${run}`,
  uAug: `August update ${run}`,
  uSept: `September update ${run}`,
} as const;

const MONTH = "2026-08";
const states: Record<string, string> = {};

const ctxOf = (seat: "owner" | "admin" | "manager" | "employee"): DocumentCtx => ({ tenantId: f.tenantId, actor: f.seats[seat].actor });
const principal = (contactId: string, clientId = ids.acme): PortalPrincipal => ({ contactId, tenantId: f.tenantId, clientId, gates });

const reason = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "resolved";
  } catch (e) {
    if (e instanceof AuthzError) return e.reason;
    if (e instanceof DomainError) return e.code;
    throw e;
  }
};

/** The error's META — a constraint's or a guard's name lives there, never trusted from the message (the code-frame trap). */
const meta = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return JSON.stringify((e as { meta?: unknown })?.meta ?? null);
  }
};

const expectNoSentinel = (value: unknown) => {
  const json = JSON.stringify(value);
  for (const [name, sentinel] of Object.entries(S)) expect(json, `sentinel ${name} leaked`).not.toContain(sentinel);
};

const made = (documentId: string) => f.platform.madeReport.findUniqueOrThrow({ where: { documentId } });

const make = (over: Partial<Parameters<typeof makeReport>[1]> = {}, seat: "owner" | "admin" | "manager" | "employee" = "owner") =>
  makeReport(ctxOf(seat), { clientId: ids.acme, month: MONTH, locale: "en", projectIds: [ids.p1, ids.p2], ...over });

let nextNumber = 1;
async function item(input: {
  projectId: string;
  id: string;
  title: string;
  category: "TODO" | "DONE";
  visibility: "INTERNAL" | "CLIENT_VISIBLE";
  kind?: "TASK" | "REQUEST";
  completedAt?: Date;
}): Promise<void> {
  await f.platform.workItem.create({
    data: {
      id: input.id,
      tenantId: f.tenantId,
      clientId: ids.acme,
      projectId: input.projectId,
      number: nextNumber++,
      title: input.title,
      stateId: states[`${input.projectId}:${input.category}`]!,
      stateCategory: input.category,
      kind: input.kind ?? "TASK",
      triageStatus: null,
      triageReason: null,
      acceptedAt: input.kind === "REQUEST" ? new Date("2026-08-01T08:00:00Z") : null,
      type: "TASK",
      rootId: input.id,
      rank: `Zz${randomUUID().replace(/-/g, "")}1`,
      visibility: input.visibility,
      completedAt: input.completedAt ?? null,
    },
  });
}

const body = (text: string) => ({
  sections: [
    { key: "SUMMARY", title: null, body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] } },
    { key: "NEXT", title: null, body: { type: "doc", content: [{ type: "taskList", content: [{ type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph", content: [{ type: "text", text: `${text} next` }] }] }] }] } },
  ],
  metrics: { include: { tasks: true, milestones: true, versions: true, requests: true, hours: true } },
});

async function update(input: {
  id: string;
  projectId: string;
  seq: number | null;
  title: string;
  status: "PUBLISHED" | "DRAFT";
  visibility: "INTERNAL" | "CLIENT_VISIBLE";
  health?: "ON_TRACK" | "AT_RISK";
  publishedAt?: Date;
}): Promise<void> {
  await f.platform.projectUpdate.create({
    data: {
      id: input.id,
      tenantId: f.tenantId,
      clientId: ids.acme,
      projectId: input.projectId,
      seq: input.seq,
      health: input.health ?? "ON_TRACK",
      title: input.title,
      body: body(input.title),
      bodyText: input.title,
      // A draft has no snapshot (the CHECK); a published one carries the
      // numbers the report must NOT draw (C95 (c)).
      ...(input.status === "PUBLISHED" ? { portalSnapshot: { version: 1, hours: { seconds: 3600 } } } : {}),
      status: input.status,
      visibility: input.visibility,
      authorMemberId: f.seats.owner.memberId,
      publishedAt: input.publishedAt ?? null,
      publishedByMemberId: input.status === "PUBLISHED" ? f.seats.owner.memberId : null,
    },
  });
}

beforeAll(async () => {
  storage = new LocalDiskTransport(storageDir);
  setStorage(storage);
  restoreTransport = setTransport(async () => undefined);
  f = await setupTenant("mrpt");
  gates = await resolvePortalModuleGates(f.tenantId);
  await f.platform.client.createMany({
    data: [
      { id: ids.acme, tenantId: f.tenantId, name: `Acme ${run}`, countryCode: "SE" },
      { id: ids.beta, tenantId: f.tenantId, name: `Beta ${run}` },
      { id: ids.gone, tenantId: f.tenantId, name: `Gone ${run}`, status: "ARCHIVED", archivedAt: new Date("2026-01-01T00:00:00Z") },
    ],
  });
  const invitedAt = new Date("2026-07-01T09:00:00Z");
  const person = (id: string, who: string, profile: "CONTACT_PRIMARY" | "CONTACT_COLLABORATOR") => ({
    id,
    tenantId: f.tenantId,
    clientId: ids.acme,
    name: who,
    email: emailOf(who),
    portalProfile: profile,
    portalStatus: "ACTIVE" as const,
    invitedAt,
    emailVerified: true,
    locale: "en",
  });
  await f.platform.contact.createMany({ data: [person(ids.carol, "carol", "CONTACT_PRIMARY"), person(ids.dan, "dan", "CONTACT_COLLABORATOR")] });
  await f.platform.project.createMany({
    data: [
      { id: ids.p1, tenantId: f.tenantId, clientId: ids.acme, key: `MA${up}`, name: `Alpha site ${run}`, portalEnabled: true },
      { id: ids.p2, tenantId: f.tenantId, clientId: ids.acme, key: `MB${up}`, name: `Beta campaign ${run}`, portalEnabled: true },
      { id: ids.p3, tenantId: f.tenantId, clientId: ids.acme, key: `MC${up}`, name: `Gamma off ${run}`, portalEnabled: false },
    ],
  });
  let rank = 0;
  for (const projectId of [ids.p1, ids.p2, ids.p3]) {
    for (const category of ["BACKLOG", "TODO", "IN_PROGRESS", "DONE", "CANCELLED", "TRIAGE"] as const) {
      const id = randomUUID();
      states[`${projectId}:${category}`] = id;
      await f.platform.workflowState.create({
        data: { id, tenantId: f.tenantId, projectId, name: `${S.stateName}-${category}`, category, rank: `a${(rank++).toString().padStart(4, "0")}`, isDefault: category === "BACKLOG" },
      });
    }
  }
  // Tasks — August 2026 in Europe/Stockholm (the fixture tenant's zone) is
  // [2026-07-31T22:00Z, 2026-08-31T22:00Z).
  await item({ projectId: ids.p1, id: ids.doneAug, title: T.doneAug, category: "DONE", visibility: "CLIENT_VISIBLE", completedAt: new Date("2026-08-15T10:00:00Z") });
  await item({ projectId: ids.p1, id: ids.doneAugLate, title: T.doneAugLate, category: "DONE", visibility: "CLIENT_VISIBLE", completedAt: new Date("2026-08-31T21:30:00Z") });
  await item({ projectId: ids.p1, id: ids.doneSeptEarly, title: T.doneSeptEarly, category: "DONE", visibility: "CLIENT_VISIBLE", completedAt: new Date("2026-08-31T22:30:00Z") });
  await item({ projectId: ids.p1, id: ids.doneJuly, title: T.doneJuly, category: "DONE", visibility: "CLIENT_VISIBLE", completedAt: new Date("2026-07-20T10:00:00Z") });
  await item({ projectId: ids.p1, id: ids.internalDone, title: S.internalTask, category: "DONE", visibility: "INTERNAL", completedAt: new Date("2026-08-10T10:00:00Z") });
  await item({ projectId: ids.p1, id: ids.openTask, title: T.openTask, category: "TODO", visibility: "CLIENT_VISIBLE" });
  await item({ projectId: ids.p2, id: ids.p2Done, title: T.p2Done, category: "DONE", visibility: "CLIENT_VISIBLE", completedAt: new Date("2026-08-05T10:00:00Z") });
  await item({ projectId: ids.p2, id: ids.p2Request, title: T.p2Request, category: "DONE", visibility: "CLIENT_VISIBLE", kind: "REQUEST", completedAt: new Date("2026-08-06T10:00:00Z") });
  await item({ projectId: ids.p3, id: ids.p3Done, title: S.p3Task, category: "DONE", visibility: "CLIENT_VISIBLE", completedAt: new Date("2026-08-07T10:00:00Z") });
  // Updates.
  await update({ id: ids.uAug, projectId: ids.p1, seq: 1, title: T.uAug, status: "PUBLISHED", visibility: "CLIENT_VISIBLE", health: "AT_RISK", publishedAt: new Date("2026-08-20T09:00:00Z") });
  await update({ id: ids.uAugInternal, projectId: ids.p1, seq: 2, title: S.internalUpdate, status: "PUBLISHED", visibility: "INTERNAL", publishedAt: new Date("2026-08-21T09:00:00Z") });
  await update({ id: ids.uSept, projectId: ids.p1, seq: 3, title: T.uSept, status: "PUBLISHED", visibility: "CLIENT_VISIBLE", publishedAt: new Date("2026-09-02T09:00:00Z") });
  await update({ id: ids.uDraft, projectId: ids.p1, seq: null, title: `Draft ${run}`, status: "DRAFT", visibility: "INTERNAL" });
});

afterAll(async () => {
  if (restoreTransport) setTransport(restoreTransport);
  if (!f) return;
  await f.platform.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.$executeRaw`DELETE FROM search_index WHERE tenant_id = ${f.tenantId}`;
  await f.platform.comment.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.fileVersion.deleteMany({ where: { tenantId: f.tenantId } });
  // `made_report` goes with its document (the FK cascade).
  await f.platform.document.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.fileObject.deleteMany({ where: { tenantId: f.tenantId } });
  // A published update is deleted only under the work-maintenance GUC (the
  // sections dbtest's teardown).
  await f.platform.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.work_maintenance', 'on', true)`;
    await tx.projectUpdate.deleteMany({ where: { tenantId: f.tenantId } });
  });
  await f.platform.workItemActivity.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.workItem.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.workflowState.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.notification.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.tenantCounter.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.project.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.contact.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.client.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.tenantPreference.deleteMany({ where: { tenantId: f.tenantId } });
  await f.cleanup();
  setStorage(null);
  rmSync(storageDir, { recursive: true, force: true });
});

describe("the content, read as the client", () => {
  it("names the August shared DONE tasks and the August shared update only — in the workspace's month", async () => {
    const content = await deriveMadeReportContent(principal(ids.dan), { month: "2026-08-01", timezone: "Europe/Stockholm", projectIds: [ids.p1, ids.p2] });
    expectNoSentinel(content);
    const p1 = content.projects[0]!;
    expect(p1.name).toBe(`Alpha site ${run}`);
    expect(p1.tasks.map((t) => t.title)).toEqual([T.doneAug, T.doneAugLate]);
    expect(p1.tasks.map((t) => t.completedOn)).toEqual(["2026-08-15", "2026-08-31"]);
    expect(p1.updates.map((u) => u.title)).toEqual([T.uAug]);
    expect(p1.updates[0]).toMatchObject({ seq: 1, health: "AT_RISK", publishedOn: "2026-08-20" });
    expect(p1.updates[0]!.sections.map((s) => s.key)).toEqual(["SUMMARY", "NEXT"]);
    expect(p1.health).toBe("AT_RISK");
    // Never the numbers strip (C95 (c)).
    expect(JSON.stringify(content)).not.toContain("hours");
    const p2 = content.projects[1]!;
    expect(p2.tasks.map((t) => t.title).sort()).toEqual([T.p2Done, T.p2Request].sort());
    expect(p2.health).toBeNull();
  });

  it("follows the Tasks switch: a hidden section leaves the client's own requests alone", async () => {
    await setPortalSection(ctxOf("owner"), ids.p2, "tasks", false);
    try {
      const content = await deriveMadeReportContent(principal(ids.dan), { month: "2026-08-01", timezone: "Europe/Stockholm", projectIds: [ids.p2] });
      expect(content.projects[0]!.tasks.map((t) => t.title)).toEqual([T.p2Request]);
    } finally {
      await setPortalSection(ctxOf("owner"), ids.p2, "tasks", true);
    }
  });

  it("refuses a project the client cannot see, and reads nothing as a main contact that the collaborator does not", async () => {
    expect(await reason(deriveMadeReportContent(principal(ids.dan), { month: "2026-08-01", timezone: "Europe/Stockholm", projectIds: [ids.p3] }))).toBe("MADE_REPORT_PROJECT_HIDDEN");
    const asCarol = await deriveMadeReportContent(principal(ids.carol), { month: "2026-08-01", timezone: "Europe/Stockholm", projectIds: [ids.p1, ids.p2] });
    const asDan = await deriveMadeReportContent(principal(ids.dan), { month: "2026-08-01", timezone: "Europe/Stockholm", projectIds: [ids.p1, ids.p2] });
    expect(JSON.stringify(asCarol)).toBe(JSON.stringify(asDan));
  });

  it("is read as the NARROWEST profile who could sign in — the collaborator", async () => {
    const who = await f.platform.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${f.tenantId}, true), set_config('app.principal', 'system', true)`;
      return audienceContact(tx as never, f.tenantId, ids.acme);
    });
    expect(who?.id).toBe(ids.dan);
    const form = await readMakeReportForm(ctxOf("owner"), ids.acme);
    expect(form).toMatchObject({ hasAudience: true, defaultLocale: "sv" });
    expect(form.projects.map((p) => p.id)).toEqual([ids.p1, ids.p2]);
    expect(await reason(readMakeReportForm(ctxOf("employee"), ids.acme))).toBe("FORBIDDEN");
  });
});

describe("making", () => {
  it("writes the PDF, the REPORT document, the made_report row, the storage count and the audit row — in one go", async () => {
    const before = await f.platform.tenant.findUniqueOrThrow({ where: { id: f.tenantId }, select: { storageUsedBytes: true } });
    const { documentId } = await make({ summary: "A good month.\r\n\r\nTwo lines.", comingNext: "Launch in September." });
    const doc = await f.platform.document.findUniqueOrThrow({ where: { id: documentId }, include: { versions: { include: { fileObject: true } } } });
    expect(doc).toMatchObject({ kind: "REPORT", visibility: "INTERNAL", clientId: ids.acme, projectId: null, name: "Monthly report August 2026" });
    expect(doc.reportMonth?.toISOString().slice(0, 10)).toBe("2026-08-01");
    const file = doc.versions[0]!.fileObject;
    expect(file).toMatchObject({ kind: "GENERAL", status: "COMMITTED", contentType: "application/pdf", originalFilename: "monthly-report-2026-08.pdf" });
    const bytes = await storage.getObject(file.r2Key);
    expect(bytes).not.toBeNull();
    expect(Buffer.from(bytes!.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
    expect(createHash("sha256").update(bytes!).digest("hex")).toBe(file.sha256);
    expect(Number(file.sizeBytes)).toBe(bytes!.byteLength);
    const row = await made(documentId);
    expect(row).toMatchObject({
      locale: "en",
      summary: "A good month.\n\nTwo lines.",
      comingNext: "Launch in September.",
      projectIds: [ids.p1, ids.p2],
      asContactId: ids.dan,
      templateVersion: 1,
      madeByMemberId: f.seats.owner.memberId,
    });
    expect(row.taskIds.sort()).toEqual([ids.doneAug, ids.doneAugLate, ids.p2Done, ids.p2Request].sort());
    expect(row.updateIds).toEqual([ids.uAug]);
    expect(row.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expectNoSentinel(row);
    const after = await f.platform.tenant.findUniqueOrThrow({ where: { id: f.tenantId }, select: { storageUsedBytes: true } });
    expect(Number(after.storageUsedBytes - before.storageUsedBytes)).toBe(bytes!.byteLength);
    const audit = (await f.audits("document.created")).find((a) => a.targetId === documentId);
    expect(audit?.metadata).toMatchObject({ kind: "REPORT", made: true, locale: "en", asContactId: ids.dan, contentSha256: row.contentSha256, reportMonth: "2026-08-01" });
    expect(JSON.stringify(audit?.metadata)).not.toContain("A good month");
    // Listed on the tab as made; Swedish names a Swedish report.
    const list = await listClientReports(ctxOf("owner"), ids.acme);
    expect(list.find((r) => r.id === documentId)).toMatchObject({ made: true, contentType: "application/pdf" });
    const sv = await make({ locale: "sv", projectIds: [ids.p1] });
    expect((await f.platform.document.findUniqueOrThrow({ where: { id: sv.documentId } })).name).toBe("Månadsrapport augusti 2026");
    expect((await made(sv.documentId)).projectIds).toEqual([ids.p1]);
  });

  it("refuses: a month not ended, a language it has not, a text too long, no project, a project the client cannot see, an employee, an archived client, a client with nobody who can sign in", async () => {
    // The month AFTER the workspace's current one: no zone can call it ended
    // (UTC's "this month" is Stockholm's ended month for two hours a month).
    const today = localDateString(new Date(), "Europe/Stockholm");
    expect(await reason(make({ month: nextMonth(`${today.slice(0, 7)}-01`).slice(0, 7) }))).toBe("INVALID_INPUT");
    expect(await reason(make({ month: today.slice(0, 7) }))).toBe("INVALID_INPUT");
    expect(await reason(make({ locale: "de" }))).toBe("INVALID_INPUT");
    expect(await reason(make({ summary: "x".repeat(2001) }))).toBe("INVALID_INPUT");
    expect(await reason(make({ projectIds: [] }))).toBe("INVALID_INPUT");
    expect(await reason(make({ projectIds: [ids.p1, ids.p3] }))).toBe("INVALID_INPUT");
    expect(await reason(make({}, "employee"))).toBe("FORBIDDEN");
    expect(await reason(make({ clientId: ids.gone, projectIds: [ids.p1] }))).toBe("ARCHIVED");
    expect(await reason(make({ clientId: ids.beta, projectIds: [ids.p1] }))).toBe("INVALID_INPUT");
    // Beta: a project of its own with the portal on, and nobody who can sign in.
    const pBeta = randomUUID();
    await f.platform.project.create({ data: { id: pBeta, tenantId: f.tenantId, clientId: ids.beta, key: `MD${up}`, name: `Beta p ${run}`, portalEnabled: true } });
    try {
      expect(await reason(make({ clientId: ids.beta, projectIds: [pBeta] }))).toBe("MADE_REPORT_NO_AUDIENCE");
      expect((await readMakeReportForm(ctxOf("owner"), ids.beta)).hasAudience).toBe(false);
    } finally {
      await f.platform.project.delete({ where: { id: pBeta } });
    }
  });
});

describe("publishing checks again, as the client", () => {
  it("publishes an unchanged report — stamped, mailed, audited as made", async () => {
    const { documentId } = await make();
    const out = await publishReport(ctxOf("manager"), documentId);
    expect(out).toMatchObject({ published: true, queued: 2, reachable: 2 });
    const row = await f.platform.document.findUniqueOrThrow({ where: { id: documentId } });
    expect(row.visibility).toBe("CLIENT_VISIBLE");
    const audit = (await f.audits("document.visibility_changed")).filter((a) => a.targetId === documentId);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.metadata).toMatchObject({ to: "CLIENT_VISIBLE", made: true, checkedAsContactId: ids.dan, contentSha256: (await made(documentId)).contentSha256 });
    // The client's Reports page lists it and its PDF resolves for the collaborator.
    const reports = await listPortalReports(principal(ids.dan));
    expect(reports.map((r) => r.id)).toContain(documentId);
    const download = await resolvePortalDownload(principal(ids.dan), documentId);
    expect(download.filename).toBe("Monthly report August 2026");
    await hideReport(ctxOf("owner"), documentId);
  });

  it("refuses MADE_REPORT_STALE when a named task was made private since — and publishes once it is shared again", async () => {
    const { documentId } = await make({ projectIds: [ids.p1] });
    await changeItemVisibility(ctxOf("owner"), ids.doneAugLate, "INTERNAL");
    try {
      expect(await reason(publishReport(ctxOf("owner"), documentId))).toBe("MADE_REPORT_STALE");
      const row = await f.platform.document.findUniqueOrThrow({ where: { id: documentId } });
      expect(row).toMatchObject({ visibility: "INTERNAL", reportPublishedAt: null });
      expect((await f.audits("document.visibility_changed")).filter((a) => a.targetId === documentId)).toHaveLength(0);
      expect(await f.platform.emailOutbox.count({ where: { tenantId: f.tenantId, idempotencyKey: { startsWith: `report:${documentId}:` } } })).toBe(0);
    } finally {
      await changeItemVisibility(ctxOf("owner"), ids.doneAugLate, "CLIENT_VISIBLE");
    }
    expect((await publishReport(ctxOf("owner"), documentId)).published).toBe(true);
    await hideReport(ctxOf("owner"), documentId);
  });

  it("refuses when an update was hidden, when a project's portal was switched off, and when the Tasks section was hidden — every publish, a republish too", async () => {
    const { documentId } = await make();
    expect((await publishReport(ctxOf("owner"), documentId)).published).toBe(true);
    await hideReport(ctxOf("owner"), documentId);
    await setUpdateVisibility(ctxOf("owner"), ids.uAug, "INTERNAL");
    try {
      expect(await reason(publishReport(ctxOf("owner"), documentId))).toBe("MADE_REPORT_STALE");
    } finally {
      await setUpdateVisibility(ctxOf("owner"), ids.uAug, "CLIENT_VISIBLE");
    }
    await setPortalEnabled(ctxOf("owner"), ids.p2, false);
    try {
      expect(await reason(publishReport(ctxOf("owner"), documentId))).toBe("MADE_REPORT_STALE");
    } finally {
      await setPortalEnabled(ctxOf("owner"), ids.p2, true);
    }
    await setPortalSection(ctxOf("owner"), ids.p2, "tasks", false);
    try {
      expect(await reason(publishReport(ctxOf("owner"), documentId))).toBe("MADE_REPORT_STALE");
    } finally {
      await setPortalSection(ctxOf("owner"), ids.p2, "tasks", true);
    }
    expect((await publishReport(ctxOf("owner"), documentId)).published).toBe(true);
    await hideReport(ctxOf("owner"), documentId);
  });

  it("checks as the main contact when the collaborator is paused, and refuses with nobody left", async () => {
    const { documentId } = await make();
    expect((await made(documentId)).asContactId).toBe(ids.dan);
    await f.platform.contact.update({ where: { id: ids.dan }, data: { portalStatus: "SUSPENDED" } });
    try {
      expect(await reason(publishReport(ctxOf("owner"), documentId))).toBe("resolved");
      const audit = (await f.audits("document.visibility_changed")).filter((a) => a.targetId === documentId);
      expect(audit[0]!.metadata).toMatchObject({ checkedAsContactId: ids.carol });
      await hideReport(ctxOf("owner"), documentId);
      await f.platform.contact.update({ where: { id: ids.carol }, data: { portalStatus: "SUSPENDED" } });
      try {
        expect(await reason(publishReport(ctxOf("owner"), documentId))).toBe("MADE_REPORT_NO_AUDIENCE");
      } finally {
        await f.platform.contact.update({ where: { id: ids.carol }, data: { portalStatus: "ACTIVE" } });
      }
    } finally {
      await f.platform.contact.update({ where: { id: ids.dan }, data: { portalStatus: "ACTIVE" } });
    }
  });

  it("a made report's name may change, its month may not — the PDF was drawn for it", async () => {
    const { documentId } = await make({ projectIds: [ids.p1] });
    await editReport(ctxOf("owner"), documentId, { name: `Renamed ${run}`, month: MONTH });
    expect((await f.platform.document.findUniqueOrThrow({ where: { id: documentId } })).name).toBe(`Renamed ${run}`);
    expect(await reason(editReport(ctxOf("owner"), documentId, { name: `Renamed ${run}`, month: "2026-07" }))).toBe("INVALID_INPUT");
    expect((await f.platform.document.findUniqueOrThrow({ where: { id: documentId } })).reportMonth?.toISOString().slice(0, 10)).toBe("2026-08-01");
  });

  it("an UPLOADED report publishes unchecked, as before", async () => {
    const text = new TextEncoder().encode(`upload ${run}\n`);
    const presigned = await createUpload(ctxOf("owner"), { name: `u-${run}.txt`, contentType: "text/plain", sizeBytes: text.byteLength, sha256: createHash("sha256").update(text).digest("hex"), clientId: ids.acme, visibility: "INTERNAL" });
    const key = new URL(presigned.uploadUrl).pathname.replace(/^\/api\/dev-storage\//, "").split("/").map(decodeURIComponent).join("/");
    await storage.handlePut(new Request(presigned.uploadUrl, { method: "PUT", headers: { ...presigned.headers }, body: Buffer.from(text) }), key);
    const { documentId } = await commitReportUpload(ctxOf("owner"), { fileObjectId: presigned.fileObjectId, clientId: ids.acme, month: MONTH, name: `Uploaded ${run}` });
    await changeItemVisibility(ctxOf("owner"), ids.doneAug, "INTERNAL");
    try {
      expect((await publishReport(ctxOf("owner"), documentId)).published).toBe(true);
      expect((await listClientReports(ctxOf("owner"), ids.acme)).find((r) => r.id === documentId)?.made).toBe(false);
    } finally {
      await changeItemVisibility(ctxOf("owner"), ids.doneAug, "CLIENT_VISIBLE");
    }
  });
});

describe("the database holds a made report's shape, for every writer", () => {
  const base = async () => {
    const { documentId } = await make();
    const row = await made(documentId);
    return { documentId, row };
  };
  const raw = (over: Record<string, unknown>) =>
    f.platform.madeReport.create({
      data: {
        documentId: randomUUID(),
        tenantId: f.tenantId,
        locale: "en",
        projectIds: [ids.p1],
        taskIds: [],
        updateIds: [],
        asContactId: ids.dan,
        contentSha256: "a".repeat(64),
        templateVersion: 1,
        madeAt: new Date(),
        ...over,
      } as never,
      select: { documentId: true },
    });

  it("refuses a row on anything but a live REPORT (the kind guard), and any change once written (frozen)", async () => {
    const plain = await f.platform.document.create({ data: { id: randomUUID(), tenantId: f.tenantId, clientId: ids.acme, name: `plain ${run}`, kind: "GENERAL" }, select: { id: true } });
    try {
      expect(await meta(raw({ documentId: plain.id }))).toContain("made_report_kind_guard");
    } finally {
      await f.platform.document.delete({ where: { id: plain.id } });
    }
    const { documentId } = await base();
    expect(await meta(f.platform.madeReport.update({ where: { documentId }, data: { summary: "changed" }, select: { documentId: true } }))).toContain("made_report_frozen");
  });

  it("refuses a language it has not, a text too long, no project, and a fingerprint that is not 64 hex digits", async () => {
    const { documentId } = await base();
    await f.platform.madeReport.delete({ where: { documentId } });
    expect(await meta(raw({ documentId, locale: "de" }))).toContain("made_report_locale");
    expect(await meta(raw({ documentId, summary: "x".repeat(2001) }))).toContain("made_report_summary_length");
    expect(await meta(raw({ documentId, projectIds: [] }))).toContain("made_report_projects_bounded");
    expect(await meta(raw({ documentId, contentSha256: "Z".repeat(64) }))).toContain("made_report_sha256_shape");
  });

  it("a contact principal reads none of it (portal_deny), a member of the tenant does", async () => {
    const { documentId } = await base();
    const asContact = await withTenant(f.tenantId, { type: "contact", id: ids.dan, clientId: ids.acme }, (tx) =>
      tx.madeReport.findMany({ where: { documentId }, select: { documentId: true } }),
    );
    expect(asContact).toEqual([]);
    const asMember = await withTenant(f.tenantId, { type: "member", id: f.seats.owner.memberId }, (tx) =>
      tx.madeReport.findMany({ where: { documentId }, select: { documentId: true } }),
    );
    expect(asMember).toEqual([{ documentId }]);
  });
});

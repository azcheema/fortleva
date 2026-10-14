import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withTenant } from "@/db";
import { setupTenant } from "@/members/dbtest-fixture";
import { setTransport, type MailTransport } from "@/mailer";
import { LocalDiskTransport, setStorage } from "@/storage";

import { makeReport, readMakeReportForm } from "./made-reports";
import { draftMonthlyReports } from "./report-drafts";
import { reportMonthDate } from "./report-month";
import { reportSubjects } from "./report-subjects";
import { listClientReports } from "./reports";
import { softDeleteDocumentsInTx, type DocumentCtx } from "./service";

/**
 * REPORTS DRAFTED BY THEMSELVES ON THE 1ST, AGAINST THE REAL SCHEMA (Phase
 * 7 slice 120; founder decision C96; design
 * docs/research/2026-10-15-slice-120-report-drafts-design.md §8).
 *
 * What only a database can say: that the drafter CONSIDERS every active
 * client of the month that just ended ONCE and records its verdict — a
 * draft made (with every maker column NULL, audited as SYSTEM, the people
 * who may publish told), a report already there, nobody who could read it,
 * nothing to show, too large, failed and tried again; that the switch and
 * the module close it; that the workspace's zone decides the month; that
 * MAKING the month by hand REPLACES the draft — under the make codes, a
 * published one never; that the inbox names the draft's client for a
 * reader the tab would open for, and nobody else; and that the ledger's
 * CHECKs hold for every writer.
 *
 * THE SENTINEL WALK, as in every portal suite: the INTERNAL task carries a
 * string that appears nowhere else, and every content and row is searched
 * for it.
 *
 * Tenant slug prefix `rdft-` is registered in `DBTEST_PREFIXES`
 * (e2e/fixtures/seed-cli.ts) so `sweep-dbtests` collects orphans.
 */

const run = randomUUID().slice(0, 8);
const up = run.slice(0, 3).toUpperCase();

let f: Awaited<ReturnType<typeof setupTenant>>;
let storage: LocalDiskTransport;
let restoreTransport: MailTransport | undefined;
const storageDir = mkdtempSync(join(tmpdir(), "fortleva-rdft-"));

/** The run's clock: 3 September 2026, 12:00 Stockholm — the month that just ended is August. */
const NOW = new Date("2026-09-03T10:00:00Z");
const MONTH = "2026-08-01";

const ids = {
  acme: randomUUID(), // an audience, August work → DRAFTED
  beta: randomUUID(), // nobody who can sign in → NO_AUDIENCE
  gamma: randomUUID(), // an audience, a portal project with nothing in August → EMPTY
  delta: randomUUID(), // an audience and an uploaded report for August → EXISTS
  echo: randomUUID(), // ARCHIVED — never considered
  foxtrot: randomUUID(), // an audience and 26 portal projects → TOO_LARGE
  hotel: randomUUID(), // a FAILED row with tries left → DRAFTED
  india: randomUUID(), // a FAILED row at its third try — left alone
  carol: randomUUID(), // Acme, main contact
  dan: randomUUID(), // Acme, collaborator — the narrowest, so the draft is read as them
  p1: randomUUID(),
  pGamma: randomUUID(),
  pHotel: randomUUID(),
  doneAug: randomUUID(),
  internalDone: randomUUID(),
  hotelDone: randomUUID(),
  uAug: randomUUID(),
  deltaUpload: randomUUID(),
};
const emailOf = (who: string) => `rdft-${who}-${run}@test.invalid`;

/** Strings a client of Acme must never read. */
const S = { internalTask: `SENTINELDRAFTINTERNALTASK-${run}`, stateName: `SENTINELDRAFTSTATE-${run}` } as const;
const T = { doneAug: `Shipped the landing page ${run}`, hotelDone: `Hotel task ${run}`, uAug: `August update ${run}` } as const;

const states: Record<string, string> = {};

const ctxOf = (seat: "owner" | "admin" | "manager" | "employee"): DocumentCtx => ({ tenantId: f.tenantId, actor: f.seats[seat].actor });

const expectNoSentinel = (value: unknown) => {
  const json = JSON.stringify(value);
  for (const [name, sentinel] of Object.entries(S)) expect(json, `sentinel ${name} leaked`).not.toContain(sentinel);
};

const ledger = (clientId: string) => f.platform.monthlyReportDraft.findMany({ where: { tenantId: f.tenantId, clientId }, orderBy: { month: "asc" } });

const liveReports = (clientId: string) =>
  f.platform.document.findMany({
    where: { tenantId: f.tenantId, clientId, kind: "REPORT", deletedAt: null },
    select: { id: true, visibility: true, reportPublishedAt: true, createdByMemberId: true, madeReport: { select: { madeByMemberId: true } } },
    orderBy: { createdAt: "asc" },
  });

let nextNumber = 1;
async function item(input: { projectId: string; clientId: string; id: string; title: string; visibility: "INTERNAL" | "CLIENT_VISIBLE"; completedAt: Date }) {
  await f.platform.workItem.create({
    data: {
      id: input.id,
      tenantId: f.tenantId,
      clientId: input.clientId,
      projectId: input.projectId,
      number: nextNumber++,
      title: input.title,
      stateId: states[`${input.projectId}:DONE`]!,
      stateCategory: "DONE",
      kind: "TASK",
      triageStatus: null,
      triageReason: null,
      acceptedAt: null,
      type: "TASK",
      rootId: input.id,
      rank: `Zz${randomUUID().replace(/-/g, "")}1`,
      visibility: input.visibility,
      completedAt: input.completedAt,
    },
  });
}

async function statesFor(projectId: string) {
  let rank = 0;
  for (const category of ["BACKLOG", "TODO", "IN_PROGRESS", "DONE", "CANCELLED", "TRIAGE"] as const) {
    const id = randomUUID();
    states[`${projectId}:${category}`] = id;
    await f.platform.workflowState.create({
      data: { id, tenantId: f.tenantId, projectId, name: `${S.stateName}-${category}`, category, rank: `a${(rank++).toString().padStart(4, "0")}`, isDefault: category === "BACKLOG" },
    });
  }
}

/** Someone at the client who could sign in now (the audience rule). */
const person = (id: string, clientId: string, who: string, profile: "CONTACT_PRIMARY" | "CONTACT_COLLABORATOR") => ({
  id,
  tenantId: f.tenantId,
  clientId,
  name: who,
  email: emailOf(who),
  portalProfile: profile,
  portalStatus: "ACTIVE" as const,
  invitedAt: new Date("2026-07-01T09:00:00Z"),
  emailVerified: true,
  locale: "en",
});

/** A job-drafted report planted by hand: every maker column NULL, INTERNAL, never published. */
async function plantDraft(clientId: string, month: string): Promise<string> {
  const bytes = new Uint8Array(Buffer.from(`%PDF-1.4\n% planted ${run}\n%%EOF\n`, "latin1"));
  const fileObjectId = randomUUID();
  const documentId = randomUUID();
  await storage.putObject(`${f.tenantId}/${fileObjectId}`, bytes);
  await f.platform.fileObject.create({
    data: {
      id: fileObjectId,
      tenantId: f.tenantId,
      r2Key: `${f.tenantId}/${fileObjectId}`,
      kind: "GENERAL",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: BigInt(bytes.byteLength),
      contentType: "application/pdf",
      originalFilename: "monthly-report.pdf",
      status: "COMMITTED",
      committedAt: NOW,
      createdByMemberId: null,
    },
  });
  await f.platform.document.create({
    data: {
      id: documentId,
      tenantId: f.tenantId,
      clientId,
      name: `Planted draft ${run}`,
      kind: "REPORT",
      visibility: "INTERNAL",
      reportMonth: reportMonthDate(month),
      createdByMemberId: null,
      versions: { create: { versionNumber: 1, fileObjectId, uploadedByMemberId: null } },
    },
  });
  await f.platform.madeReport.create({
    data: {
      documentId,
      tenantId: f.tenantId,
      locale: "en",
      projectIds: [ids.p1],
      taskIds: [],
      updateIds: [],
      asContactId: ids.dan,
      contentSha256: "0".repeat(64),
      templateVersion: 1,
      madeAt: NOW,
      madeByMemberId: null,
    },
  });
  return documentId;
}

beforeAll(async () => {
  storage = new LocalDiskTransport(storageDir);
  setStorage(storage);
  restoreTransport = setTransport(async () => undefined);
  f = await setupTenant("rdft");
  await f.platform.client.createMany({
    data: [
      { id: ids.acme, tenantId: f.tenantId, name: `Acme ${run}`, countryCode: "US" },
      { id: ids.beta, tenantId: f.tenantId, name: `Beta ${run}` },
      { id: ids.gamma, tenantId: f.tenantId, name: `Gamma ${run}` },
      { id: ids.delta, tenantId: f.tenantId, name: `Delta ${run}` },
      { id: ids.echo, tenantId: f.tenantId, name: `Echo ${run}`, status: "ARCHIVED", archivedAt: new Date("2026-01-01T00:00:00Z") },
      { id: ids.foxtrot, tenantId: f.tenantId, name: `Foxtrot ${run}` },
      { id: ids.hotel, tenantId: f.tenantId, name: `Hotel ${run}` },
      { id: ids.india, tenantId: f.tenantId, name: `India ${run}` },
    ],
  });
  await f.platform.contact.createMany({
    data: [
      person(ids.carol, ids.acme, "carol", "CONTACT_PRIMARY"),
      person(ids.dan, ids.acme, "dan", "CONTACT_COLLABORATOR"),
      person(randomUUID(), ids.gamma, "gina", "CONTACT_PRIMARY"),
      person(randomUUID(), ids.delta, "dora", "CONTACT_PRIMARY"),
      person(randomUUID(), ids.echo, "ed", "CONTACT_PRIMARY"),
      person(randomUUID(), ids.foxtrot, "fay", "CONTACT_PRIMARY"),
      person(randomUUID(), ids.hotel, "hal", "CONTACT_PRIMARY"),
      person(randomUUID(), ids.india, "ida", "CONTACT_PRIMARY"),
      // Beta's person was invited but never verified — not an audience.
      { ...person(randomUUID(), ids.beta, "bo", "CONTACT_PRIMARY"), emailVerified: false },
    ],
  });
  await f.platform.project.createMany({
    data: [
      { id: ids.p1, tenantId: f.tenantId, clientId: ids.acme, key: `DA${up}`, name: `Alpha site ${run}`, portalEnabled: true },
      { id: ids.pGamma, tenantId: f.tenantId, clientId: ids.gamma, key: `DG${up}`, name: `Gamma site ${run}`, portalEnabled: true },
      { id: ids.pHotel, tenantId: f.tenantId, clientId: ids.hotel, key: `DH${up}`, name: `Hotel site ${run}`, portalEnabled: true },
      ...Array.from({ length: 26 }, (_, i) => ({
        id: randomUUID(),
        tenantId: f.tenantId,
        clientId: ids.foxtrot,
        key: `F${i.toString(36).toUpperCase()}${up}`,
        name: `Foxtrot ${i} ${run}`,
        portalEnabled: true,
      })),
    ],
  });
  await statesFor(ids.p1);
  await statesFor(ids.pHotel);
  // August 2026 in Europe/Stockholm (the fixture tenant's zone) is
  // [2026-07-31T22:00Z, 2026-08-31T22:00Z).
  await item({ projectId: ids.p1, clientId: ids.acme, id: ids.doneAug, title: T.doneAug, visibility: "CLIENT_VISIBLE", completedAt: new Date("2026-08-15T10:00:00Z") });
  await item({ projectId: ids.p1, clientId: ids.acme, id: ids.internalDone, title: S.internalTask, visibility: "INTERNAL", completedAt: new Date("2026-08-10T10:00:00Z") });
  await item({ projectId: ids.pHotel, clientId: ids.hotel, id: ids.hotelDone, title: T.hotelDone, visibility: "CLIENT_VISIBLE", completedAt: new Date("2026-08-05T10:00:00Z") });
  await f.platform.projectUpdate.create({
    data: {
      id: ids.uAug,
      tenantId: f.tenantId,
      clientId: ids.acme,
      projectId: ids.p1,
      seq: 1,
      health: "AT_RISK",
      title: T.uAug,
      body: { sections: [{ key: "SUMMARY", title: null, body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: T.uAug }] }] } }], metrics: { include: {} } },
      bodyText: T.uAug,
      portalSnapshot: { version: 1 },
      status: "PUBLISHED",
      visibility: "CLIENT_VISIBLE",
      authorMemberId: f.seats.owner.memberId,
      publishedAt: new Date("2026-08-20T09:00:00Z"),
      publishedByMemberId: f.seats.owner.memberId,
    },
  });
  // Delta already has August's report — uploaded by hand.
  const deltaFile = randomUUID();
  await f.platform.fileObject.create({
    data: { id: deltaFile, tenantId: f.tenantId, r2Key: `${f.tenantId}/${deltaFile}`, kind: "GENERAL", sha256: "a".repeat(64), sizeBytes: 10n, contentType: "application/pdf", originalFilename: "august.pdf", status: "COMMITTED", committedAt: NOW, createdByMemberId: f.seats.owner.memberId },
  });
  await f.platform.document.create({
    data: { id: ids.deltaUpload, tenantId: f.tenantId, clientId: ids.delta, name: `Delta August ${run}`, kind: "REPORT", visibility: "INTERNAL", reportMonth: reportMonthDate(MONTH), createdByMemberId: f.seats.owner.memberId, versions: { create: { versionNumber: 1, fileObjectId: deltaFile, uploadedByMemberId: f.seats.owner.memberId } } },
  });
  // Hotel failed once before; India has had its three tries.
  await f.platform.monthlyReportDraft.createMany({
    data: [
      { tenantId: f.tenantId, clientId: ids.hotel, month: reportMonthDate(MONTH), outcome: "FAILED", attempts: 1, decidedAt: new Date("2026-09-01T01:00:00Z") },
      { tenantId: f.tenantId, clientId: ids.india, month: reportMonthDate(MONTH), outcome: "FAILED", attempts: 3, decidedAt: new Date("2026-09-01T03:00:00Z") },
    ],
  });
  // The manager and the employee are assigned to Acme — the manager may
  // publish reports, the employee may only see them.
  await f.platform.memberClient.createMany({
    data: [
      { tenantId: f.tenantId, memberId: f.seats.manager.memberId, clientId: ids.acme },
      { tenantId: f.tenantId, memberId: f.seats.employee.memberId, clientId: ids.acme },
    ],
  });
});

afterAll(async () => {
  if (restoreTransport) setTransport(restoreTransport);
  if (!f) return;
  await f.platform.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.$executeRaw`DELETE FROM search_index WHERE tenant_id = ${f.tenantId}`;
  await f.platform.comment.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.fileVersion.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.document.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.fileObject.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.monthlyReportDraft.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.work_maintenance', 'on', true)`;
    await tx.projectUpdate.deleteMany({ where: { tenantId: f.tenantId } });
  });
  await f.platform.workItemActivity.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.workItem.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.workflowState.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.notification.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.memberClient.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.tenantCounter.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.project.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.contact.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.client.deleteMany({ where: { tenantId: f.tenantId } });
  await f.cleanup();
  rmSync(storageDir, { recursive: true, force: true });
});

describe("the switch, the module, the budget", () => {
  it("does nothing, and records nothing, while the switch is off", async () => {
    await f.platform.tenantPreference.create({ data: { tenantId: f.tenantId, key: "reports.draftMonthly", value: false } });
    try {
      const r = await draftMonthlyReports(f.tenantId, NOW);
      expect(r).toMatchObject({ off: true, closed: false, considered: 0, drafted: 0, month: null });
      expect(await f.platform.monthlyReportDraft.count({ where: { tenantId: f.tenantId } })).toBe(2); // the two planted FAILED rows
    } finally {
      await f.platform.tenantPreference.deleteMany({ where: { tenantId: f.tenantId, key: "reports.draftMonthly" } });
    }
  });

  it("does nothing while the reports module is closed", async () => {
    await f.platform.tenantPreference.create({ data: { tenantId: f.tenantId, key: "module.reports.enabled", value: false } });
    try {
      const r = await draftMonthlyReports(f.tenantId, NOW);
      expect(r).toMatchObject({ closed: true, considered: 0, drafted: 0 });
    } finally {
      await f.platform.tenantPreference.deleteMany({ where: { tenantId: f.tenantId, key: "module.reports.enabled" } });
    }
  });

  it("a spent deadline considers nobody and says so", async () => {
    const r = await draftMonthlyReports(f.tenantId, NOW, { deadline: Date.now() - 1 });
    expect(r).toMatchObject({ month: MONTH, considered: 0, drafted: 0, outOfTime: true });
  });

  it("the workspace's zone decides the month: 23:30 Stockholm on 31 August is still July's run", async () => {
    const r = await draftMonthlyReports(f.tenantId, new Date("2026-08-31T21:30:00Z"), { deadline: Date.now() - 1 });
    expect(r.month).toBe("2026-07-01");
    const r2 = await draftMonthlyReports(f.tenantId, new Date("2026-08-31T22:30:00Z"), { deadline: Date.now() - 1 });
    expect(r2.month).toBe(MONTH);
  });
});

describe("the run", () => {
  let capped: string;

  it("considers at most the cap per kick, and resumes from the ledger next kick", async () => {
    const r = await draftMonthlyReports(f.tenantId, NOW, { clientCap: 1 });
    expect(r.considered).toBe(1);
    expect(r.outOfTime).toBe(false);
    const rows = await f.platform.monthlyReportDraft.findMany({ where: { tenantId: f.tenantId, month: reportMonthDate(MONTH), NOT: { outcome: "FAILED" } } });
    expect(rows).toHaveLength(1);
    capped = rows[0]!.clientId;
  });

  it("decides every other active client once, with its outcome", async () => {
    const r = await draftMonthlyReports(f.tenantId, NOW);
    expect(r.month).toBe(MONTH);
    // Six candidates in all (Echo archived, India out of tries): one went in the capped kick.
    expect(r.considered).toBe(5);
    expect(r.decidedElsewhere).toBe(0);
    expect(r.outOfTime).toBe(false);
    const expected: Record<string, string> = {
      [ids.acme]: "DRAFTED",
      [ids.beta]: "NO_AUDIENCE",
      [ids.gamma]: "EMPTY",
      [ids.delta]: "EXISTS",
      [ids.foxtrot]: "TOO_LARGE",
      [ids.hotel]: "DRAFTED",
      [ids.india]: "FAILED",
    };
    const rows = await f.platform.monthlyReportDraft.findMany({ where: { tenantId: f.tenantId, month: reportMonthDate(MONTH) } });
    expect(Object.fromEntries(rows.map((row) => [row.clientId, row.outcome]))).toEqual(expected);
    expect(rows.find((row) => row.clientId === ids.echo)).toBeUndefined();
    // A retry that reached a verdict keeps its count; the one out of tries is untouched.
    expect(rows.find((row) => row.clientId === ids.hotel)).toMatchObject({ attempts: 1 });
    expect(rows.find((row) => row.clientId === ids.india)).toMatchObject({ attempts: 3 });
    // DRAFTED iff a document.
    for (const row of rows) expect(row.documentId !== null, row.outcome).toBe(row.outcome === "DRAFTED");
    expect(r.drafted + (capped === ids.acme || capped === ids.hotel ? 1 : 0)).toBe(2);
    expectNoSentinel(rows);
  });

  it("the draft is the button's report with every maker column NULL, audited as SYSTEM, never the internal task", async () => {
    const [doc] = await liveReports(ids.acme);
    expect(doc).toMatchObject({ visibility: "INTERNAL", reportPublishedAt: null, createdByMemberId: null, madeReport: { madeByMemberId: null } });
    const row = await f.platform.document.findUniqueOrThrow({
      where: { id: doc!.id },
      select: { name: true, reportMonth: true, versions: { select: { uploadedByMemberId: true, fileObject: { select: { contentType: true, createdByMemberId: true, r2Key: true, sizeBytes: true } } } } },
    });
    expect(row.name).toBe("Monthly report August 2026"); // Acme invoices in English (a US client)
    expect(row.reportMonth?.toISOString().slice(0, 10)).toBe(MONTH);
    expect(row.versions[0]).toMatchObject({ uploadedByMemberId: null, fileObject: { contentType: "application/pdf", createdByMemberId: null } });
    const bytes = (await storage.getObject(row.versions[0]!.fileObject.r2Key))!;
    expect(Buffer.from(bytes.slice(0, 5)).toString("latin1")).toBe("%PDF-");
    expect(Number(row.versions[0]!.fileObject.sizeBytes)).toBe(bytes.byteLength);
    const made = await f.platform.madeReport.findUniqueOrThrow({ where: { documentId: doc!.id } });
    expect(made).toMatchObject({ locale: "en", summary: null, comingNext: null, projectIds: [ids.p1], asContactId: ids.dan, taskIds: [ids.doneAug], updateIds: [ids.uAug] });
    expect(made.taskIds).not.toContain(ids.internalDone);
    expectNoSentinel(made);
    const audits = await f.platform.auditEvent.findMany({ where: { tenantId: f.tenantId, action: "document.created", targetId: doc!.id }, select: { actorType: true, metadata: true } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorType: "SYSTEM", metadata: { made: true, drafted: true, kind: "REPORT", clientId: ids.acme, reportMonth: MONTH } });
    expectNoSentinel(audits);
    // The ledger names it.
    expect(await ledger(ids.acme)).toMatchObject([{ outcome: "DRAFTED", documentId: doc!.id }]);
  });

  it("tells the people who may publish Acme's reports and reach it — the owner, admin and manager, all tenant-wide — never the employee", async () => {
    const [doc] = await liveReports(ids.acme);
    const notes = await f.platform.notification.findMany({
      where: { tenantId: f.tenantId, kind: "report.drafted", entityId: doc!.id },
      select: { receiverId: true, reason: true, params: true, class: true, clientId: true },
    });
    expect(notes.map((n) => n.receiverId).sort()).toEqual([f.seats.owner.memberId, f.seats.admin.memberId, f.seats.manager.memberId].sort());
    // Every template that may publish holds `client:view_all` (tenant-wide), so the
    // reason is REPORT_ACCESS for all three — the manager's assignment to Acme is
    // beside the point, as a tenant-wide issuer's is for a renewal draft
    // (slice 113b's resolver, the same shape). CLIENT_MEMBER is for a custom role
    // that may publish without `client:view_all`.
    expect(new Set(notes.map((n) => n.reason))).toEqual(new Set(["REPORT_ACCESS"]));
    expect(notes.every((n) => n.class === "COALESCED" && n.clientId === ids.acme)).toBe(true);
    expect(notes[0]!.params).toEqual({ clientId: ids.acme, documentId: doc!.id });
    expectNoSentinel(notes);
    // No mail for a COALESCED kind.
    expect(await f.platform.emailOutbox.count({ where: { tenantId: f.tenantId } })).toBe(0);
  });

  it("a second kick changes nothing", async () => {
    const before = await f.platform.document.count({ where: { tenantId: f.tenantId, kind: "REPORT" } });
    const r = await draftMonthlyReports(f.tenantId, NOW);
    expect(r).toMatchObject({ considered: 0, drafted: 0, decidedElsewhere: 0 });
    expect(await f.platform.document.count({ where: { tenantId: f.tenantId, kind: "REPORT" } })).toBe(before);
  });

  it("the Reports tab lists the draft as drafted, and the Make card offers to replace it; Gamma's card says the month was empty", async () => {
    const rows = await listClientReports(ctxOf("owner"), ids.acme);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ made: true, drafted: true, visibility: "INTERNAL" });
    const form = await readMakeReportForm(ctxOf("owner"), ids.acme);
    expect(form.draftMonths).toEqual([MONTH]);
    expect(form.emptyMonths).toEqual([]);
    const gamma = await readMakeReportForm(ctxOf("owner"), ids.gamma);
    expect(gamma.draftMonths).toEqual([]);
    expect(gamma.emptyMonths).toEqual([MONTH]);
  });

  it("the inbox names the draft's client and links the Reports tab for a reader the tab opens for — and nobody else", async () => {
    const [acmeDoc] = await liveReports(ids.acme);
    const [hotelDoc] = await liveReports(ids.hotel);
    const refs = [
      { id: "n-acme", kind: "report.drafted", entityType: "Document", entityId: acmeDoc!.id },
      { id: "n-hotel", kind: "report.drafted", entityType: "Document", entityId: hotelDoc!.id },
      { id: "n-gone", kind: "report.drafted", entityType: "Document", entityId: randomUUID() },
      { id: "n-other", kind: "work_item.assigned", entityType: "Document", entityId: acmeDoc!.id },
    ];
    const resolve = (seat: "owner" | "manager" | "employee") =>
      withTenant(f.tenantId, { type: "member", id: f.seats[seat].memberId }, (tx) => reportSubjects(tx, f.tenantId, f.seats[seat].actor, refs));
    const owner = await resolve("owner");
    expect(owner.get("n-acme")).toEqual({ title: `Acme ${run}`, href: `/clients/${ids.acme}/reports` });
    expect(owner.get("n-hotel")).toEqual({ title: `Hotel ${run}`, href: `/clients/${ids.hotel}/reports` });
    expect(owner.has("n-gone")).toBe(false);
    expect(owner.has("n-other")).toBe(false);
    // The manager is tenant-wide: both.
    const manager = await resolve("manager");
    expect(manager.has("n-acme")).toBe(true);
    expect(manager.has("n-hotel")).toBe(true);
    // The employee may SEE Acme's reports (assigned; the tab opens), though they
    // were not told — and reaches Hotel not at all.
    const employee = await resolve("employee");
    expect(employee.has("n-acme")).toBe(true);
    expect(employee.has("n-hotel")).toBe(false);
  });
});

describe("making the month by hand replaces the draft (C96 (d))", () => {
  it("the owner's report replaces Acme's draft in the same step — never the uploaded report beside it — audited both ways", async () => {
    const [draft] = await liveReports(ids.acme);
    // An uploaded report for the same month, beside the draft: no `made_report` row.
    const uploadFile = randomUUID();
    const uploadId = randomUUID();
    await f.platform.fileObject.create({
      data: { id: uploadFile, tenantId: f.tenantId, r2Key: `${f.tenantId}/${uploadFile}`, kind: "GENERAL", sha256: "b".repeat(64), sizeBytes: 10n, contentType: "application/pdf", originalFilename: "acme-august.pdf", status: "COMMITTED", committedAt: NOW, createdByMemberId: f.seats.owner.memberId },
    });
    await f.platform.document.create({
      data: { id: uploadId, tenantId: f.tenantId, clientId: ids.acme, name: `Acme August upload ${run}`, kind: "REPORT", visibility: "INTERNAL", reportMonth: reportMonthDate(MONTH), createdByMemberId: f.seats.owner.memberId, versions: { create: { versionNumber: 1, fileObjectId: uploadFile, uploadedByMemberId: f.seats.owner.memberId } } },
    });
    const r = await makeReport(ctxOf("owner"), { clientId: ids.acme, month: "2026-08", locale: "sv", projectIds: [ids.p1], summary: `Our words ${run}` }, NOW);
    expect(r.replaced).toBe(1);
    const live = await liveReports(ids.acme);
    expect(live.map((d) => d.id).sort()).toEqual([uploadId, r.documentId].sort());
    expect(live.find((d) => d.id === r.documentId)).toMatchObject({ createdByMemberId: f.seats.owner.memberId, madeReport: { madeByMemberId: f.seats.owner.memberId } });
    const gone = await f.platform.document.findUniqueOrThrow({ where: { id: draft!.id }, select: { deletedAt: true } });
    expect(gone.deletedAt).not.toBeNull();
    const deleted = await f.platform.auditEvent.findMany({ where: { tenantId: f.tenantId, action: "document.deleted", targetId: draft!.id }, select: { actorType: true, actorId: true, metadata: true } });
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatchObject({ actorType: "MEMBER", actorId: f.seats.owner.memberId, metadata: { reason: "replaced_draft", replacedBy: r.documentId } });
    const created = await f.platform.auditEvent.findFirstOrThrow({ where: { tenantId: f.tenantId, action: "document.created", targetId: r.documentId }, select: { actorType: true, metadata: true } });
    expect(created).toMatchObject({ actorType: "MEMBER", metadata: { made: true, drafted: false, replacedDraftIds: [draft!.id] } });
    expect(JSON.stringify(created.metadata)).not.toContain("Our words");
    // The form no longer offers to replace; the ledger still says what the job did.
    expect((await readMakeReportForm(ctxOf("owner"), ids.acme)).draftMonths).toEqual([]);
    expect(await ledger(ids.acme)).toMatchObject([{ outcome: "DRAFTED", documentId: draft!.id }]);
  });

  it("a draft the client has once read is never replaced; the admin, who cannot delete reports, still replaces an unread one", async () => {
    // Hotel's draft was published, then hidden: `report_published_at` stays.
    const [hotelDraft] = await liveReports(ids.hotel);
    await f.platform.document.update({ where: { id: hotelDraft!.id }, data: { reportPublishedAt: NOW } });
    const kept = await makeReport(ctxOf("owner"), { clientId: ids.hotel, month: "2026-08", locale: "en", projectIds: [ids.pHotel] }, NOW);
    expect(kept.replaced).toBe(0);
    expect((await liveReports(ids.hotel)).map((d) => d.id).sort()).toEqual([hotelDraft!.id, kept.documentId].sort());
    // A fresh unread draft for Hotel: the admin's make replaces exactly it.
    const planted = await plantDraft(ids.hotel, MONTH);
    const byAdmin = await makeReport(ctxOf("admin"), { clientId: ids.hotel, month: "2026-08", locale: "en", projectIds: [ids.pHotel] }, NOW);
    expect(byAdmin.replaced).toBe(1);
    const live = (await liveReports(ids.hotel)).map((d) => d.id).sort();
    expect(live).toEqual([hotelDraft!.id, kept.documentId, byAdmin.documentId].sort());
    expect(live).not.toContain(planted);
    const deleted = await f.platform.auditEvent.findFirst({ where: { tenantId: f.tenantId, action: "document.deleted", targetId: planted }, select: { actorId: true, metadata: true } });
    expect(deleted).toMatchObject({ actorId: f.seats.admin.memberId, metadata: { reason: "replaced_draft", replacedBy: byAdmin.documentId } });
  });

  it("the replace's UPDATE carries the draft's own terms: a draft published after the read is not taken (the reviews' medium)", async () => {
    // The ids the button read in its prep transaction; the publish lands between
    // that read and the write. The compare-and-set must see the published row
    // and leave it — `deletedAt: null` alone would have taken it.
    const planted = await plantDraft(ids.hotel, "2026-07-01");
    await f.platform.document.update({ where: { id: planted }, data: { visibility: "CLIENT_VISIBLE", reportPublishedAt: NOW } });
    const taken = await withTenant(f.tenantId, { type: "member", id: f.seats.owner.memberId }, (tx) =>
      softDeleteDocumentsInTx(tx, f.tenantId, [planted], NOW, { reason: "replaced_draft", replacedBy: randomUUID() }, { visibility: "INTERNAL", reportPublishedAt: null }),
    );
    expect(taken).toEqual([]);
    const still = await f.platform.document.findUniqueOrThrow({ where: { id: planted }, select: { deletedAt: true, visibility: true } });
    expect(still).toMatchObject({ deletedAt: null, visibility: "CLIENT_VISIBLE" });
    expect(await f.platform.auditEvent.count({ where: { tenantId: f.tenantId, action: "document.deleted", targetId: planted } })).toBe(0);
    // Put back as the fixture had it (hidden again, the stamp kept): nothing later reads July.
    await f.platform.document.update({ where: { id: planted }, data: { visibility: "INTERNAL" } });
  });

  it("the Reports tab lists the owner's report as made, the replaced draft gone", async () => {
    const rows = await listClientReports(ctxOf("owner"), ids.acme);
    expect(rows.map((row) => ({ made: row.made, drafted: row.drafted }))).toEqual(
      expect.arrayContaining([
        { made: true, drafted: false },
        { made: false, drafted: false },
      ]),
    );
    expect(rows).toHaveLength(2);
  });
});

describe("the ledger's database", () => {
  const row = (over: Record<string, unknown>) =>
    f.platform.monthlyReportDraft.create({
      data: { tenantId: f.tenantId, clientId: ids.gamma, month: reportMonthDate("2026-05-01"), outcome: "EMPTY", attempts: 1, decidedAt: NOW, ...over },
    });

  it("refuses an unknown outcome, a document on anything but DRAFTED, a DRAFTED row without one, attempts out of range, a month not on the 1st, and a second row for one client and month", async () => {
    await expect(row({ outcome: "BOGUS" })).rejects.toThrow();
    await expect(row({ outcome: "EMPTY", documentId: randomUUID() })).rejects.toThrow();
    await expect(row({ outcome: "DRAFTED" })).rejects.toThrow();
    await expect(row({ attempts: 0 })).rejects.toThrow();
    await expect(row({ attempts: 4 })).rejects.toThrow();
    await expect(row({ month: new Date("2026-05-02T00:00:00Z") })).rejects.toThrow();
    await row({});
    await expect(row({ outcome: "NO_AUDIENCE" })).rejects.toThrow();
    expect(await f.platform.monthlyReportDraft.count({ where: { tenantId: f.tenantId, clientId: ids.gamma } })).toBe(2);
  });
});

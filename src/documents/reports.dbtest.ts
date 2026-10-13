import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { drainOutbox } from "@/jobs/outbox";
import { DomainError } from "@/lib/domain-error";
import { setTransport, type MailMessage, type MailTransport } from "@/mailer";
import { setupTenant } from "@/members/dbtest-fixture";
import { REPORT_MAIL_NOT_VISIBLE, REPORT_PUBLISHED_MAIL } from "@/notify/report-mail";
import { resolvePortalModuleGates, type PortalPrincipal } from "@/portal";
import { countClientSummary } from "@/portal/weekly-summary";
import { LocalDiskTransport, setStorage } from "@/storage";

import { countPortalReports, listPortalDocuments, listPortalReports, portalReportMonth } from "./portal";
import { resolvePortalDownload } from "./portal-writes";
import { commitReportUpload, deleteReport, editReport, hideReport, listClientReports, publishReport } from "./reports";
import {
  addVersion,
  changeVisibility,
  commitUpload,
  createUpload,
  getDownloadUrl,
  listDocuments,
  renameDocument,
  requestDocumentSignoff,
  softDeleteDocument,
  type DocumentCtx,
} from "./service";

/**
 * CLIENT REPORT FILES AGAINST THE REAL SCHEMA (Phase 6 slice 115; founder
 * decision C91; docs/research/2026-10-13-slice-115-report-files-design.md §6).
 *
 * What only a database can say: that the five CHECKs refuse a malformed report
 * from ANY writer (asserted on the error's META, never its message — the
 * code-frame trap); that a report never reaches the search index; that the
 * publish writes its stamp, its audit row and exactly one mail per person with
 * portal access in ONE transaction; that the Files paths cannot touch a report;
 * that the portal reads a published report under the contact's own principal
 * — every profile — and nothing else; and that the outbox asks again, as the
 * person, at send.
 *
 * THE SENTINEL WALK, as in every portal suite: an INTERNAL report and another
 * client's report carry strings that appear nowhere else, and every portal
 * read is searched for them.
 *
 * Tenant slug prefix `rpt-` is registered in `DBTEST_PREFIXES`
 * (e2e/fixtures/seed-cli.ts) so `sweep-dbtests` collects orphans.
 */

const run = randomUUID().slice(0, 8);

let f: Awaited<ReturnType<typeof setupTenant>>;
let gates: Awaited<ReturnType<typeof resolvePortalModuleGates>>;
let storage: LocalDiskTransport;
let restoreTransport: MailTransport | undefined;
const sent: (MailMessage & { from: string })[] = [];
const storageDir = mkdtempSync(join(tmpdir(), "fortleva-rpt-"));

const ids = {
  acme: randomUUID(),
  beta: randomUUID(),
  gone: randomUUID(),
  carol: randomUUID(), // Acme, main contact
  dan: randomUUID(), // Acme, collaborator
  pat: randomUUID(), // Acme, access paused
  una: randomUUID(), // Acme, never invited
  sid: randomUUID(), // Acme, suppressed address
  bo: randomUUID(), // Beta, main contact
};
const emailOf = (who: string) => `rpt-${who}-${run}@test.invalid`;

/** Strings a contact of Acme must never read. */
const S = {
  internal: `SENTINELREPORTINTERNAL-${run}`,
  beta: `SENTINELREPORTBETA-${run}`,
} as const;

const MONTH = "2026-08";

const ctxOf = (seat: "owner" | "admin" | "manager" | "employee"): DocumentCtx => ({
  tenantId: f.tenantId,
  actor: f.seats[seat].actor,
});

const principal = (contactId: string, clientId = ids.acme): PortalPrincipal => ({
  contactId,
  tenantId: f.tenantId,
  clientId,
  gates,
});

const sha = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");
const keyOf = (url: string): string =>
  new URL(url).pathname.replace(/^\/api\/dev-storage\//, "").split("/").map(decodeURIComponent).join("/");

/** Presign + the browser's PUT, in process; the PENDING object's id. */
const bytesFor = async (clientId: string, name = `report-${run}.txt`, seat: "owner" | "admin" | "manager" = "owner") => {
  const body = new TextEncoder().encode(`${name} ${randomUUID()}\n`);
  const presigned = await createUpload(ctxOf(seat), {
    name,
    contentType: "text/plain",
    sizeBytes: body.byteLength,
    sha256: sha(body),
    clientId,
    visibility: "INTERNAL",
  });
  const res = await storage.handlePut(
    new Request(presigned.uploadUrl, { method: "PUT", headers: { ...presigned.headers }, body: Buffer.from(body) }),
    keyOf(presigned.uploadUrl),
  );
  expect(res.status).toBe(200);
  return presigned.fileObjectId;
};

const upload = async (clientId: string, name: string, month = MONTH): Promise<string> =>
  (await commitReportUpload(ctxOf("owner"), { fileObjectId: await bytesFor(clientId), clientId, month, name })).documentId;

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

/** The error's META — a constraint's name lives there, never trusted from the message (the code-frame trap). */
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

const mailsFor = (documentId: string) =>
  f.platform.emailOutbox.findMany({
    where: { tenantId: f.tenantId, kind: REPORT_PUBLISHED_MAIL, idempotencyKey: { startsWith: `report:${documentId}:` } },
    select: { receiverId: true, status: true, lastError: true, toEmail: true, params: true },
    orderBy: { receiverId: "asc" },
  });

let internalId: string;
let betaId: string;

beforeAll(async () => {
  storage = new LocalDiskTransport(storageDir);
  setStorage(storage);
  restoreTransport = setTransport(async (msg) => {
    sent.push(msg);
  });
  f = await setupTenant("rpt");
  gates = await resolvePortalModuleGates(f.tenantId);
  await f.platform.client.createMany({
    data: [
      { id: ids.acme, tenantId: f.tenantId, name: `Acme ${run}` },
      { id: ids.beta, tenantId: f.tenantId, name: `Beta ${run}` },
      { id: ids.gone, tenantId: f.tenantId, name: `Gone ${run}`, status: "ARCHIVED", archivedAt: new Date("2026-01-01T00:00:00Z") },
    ],
  });
  const invitedAt = new Date("2026-09-01T09:00:00Z");
  const person = (id: string, who: string, clientId: string, extra: Record<string, unknown> = {}) => ({
    id,
    tenantId: f.tenantId,
    clientId,
    name: who,
    email: emailOf(who),
    portalProfile: "CONTACT_PRIMARY" as const,
    portalStatus: "ACTIVE" as const,
    invitedAt,
    emailVerified: true,
    // English, so the mails' words can be read here (the workspace's own default is Swedish).
    locale: "en",
    ...extra,
  });
  await f.platform.contact.createMany({
    data: [
      person(ids.carol, "carol", ids.acme),
      person(ids.dan, "dan", ids.acme, { portalProfile: "CONTACT_COLLABORATOR" }),
      person(ids.pat, "pat", ids.acme, { portalStatus: "SUSPENDED" }),
      person(ids.una, "una", ids.acme, { portalStatus: "NO_ACCESS", invitedAt: null }),
      person(ids.sid, "sid", ids.acme),
      person(ids.bo, "bo", ids.beta),
    ],
  });
  await f.platform.emailSuppression.create({ data: { email: emailOf("sid"), reason: "HARD_BOUNCE", source: "manual" } });

  // The sentinels: an INTERNAL Acme report, and a PUBLISHED Beta one.
  internalId = await upload(ids.acme, S.internal);
  betaId = await upload(ids.beta, S.beta);
  await publishReport(ctxOf("owner"), betaId);
});

afterEach(() => {
  sent.length = 0;
});

afterAll(async () => {
  if (restoreTransport) setTransport(restoreTransport);
  if (!f) return;
  await f.platform.emailSuppression.deleteMany({ where: { email: emailOf("sid") } });
  await f.platform.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.$executeRaw`DELETE FROM search_index WHERE tenant_id = ${f.tenantId}`;
  await f.platform.comment.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.fileVersion.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.document.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.fileObject.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.contact.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.client.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.tenantPreference.deleteMany({ where: { tenantId: f.tenantId } });
  await f.cleanup();
  setStorage(null);
  rmSync(storageDir, { recursive: true, force: true });
});

describe("the database holds a report's shape, for every writer", () => {
  const base = () => ({ id: randomUUID(), tenantId: f.tenantId, clientId: ids.acme, name: `raw ${run}` });
  const aug1 = new Date("2026-08-01T00:00:00Z");

  it("a month on, and only on, a REPORT — the first of a month", async () => {
    expect(await meta(f.platform.document.create({ data: { ...base(), kind: "REPORT" }, select: { id: true } }))).toContain(
      "document_report_month_shape",
    );
    expect(
      await meta(f.platform.document.create({ data: { ...base(), kind: "GENERAL", reportMonth: aug1 }, select: { id: true } })),
    ).toContain("document_report_month_shape");
    expect(
      await meta(
        f.platform.document.create({
          data: { ...base(), kind: "REPORT", reportMonth: new Date("2026-08-15T00:00:00Z") },
          select: { id: true },
        }),
      ),
    ).toContain("document_report_month_first");
  });

  it("an anchored REPORT is refused — the anchor guard answers before the CHECK's anchor half (its belt)", async () => {
    // `document_anchor_guard` (a BEFORE trigger) runs first and refuses any
    // anchor that is not a live work item of the row's own client AND project
    // — a REPORT has no project, so no anchor can pass it.
    expect(
      await meta(
        f.platform.document.create({
          data: { ...base(), kind: "REPORT", reportMonth: aug1, attachedToType: "WORK_ITEM", attachedToId: randomUUID() },
          select: { id: true },
        }),
      ),
      // The guard's own refusal, read from the error's META (the driver's
      // message), never its code frame.
    ).toContain("document anchor");
  });

  it("a REPORT is the client's: no project, no anchor", async () => {
    const projectId = randomUUID();
    await f.platform.project.create({
      data: { id: projectId, tenantId: f.tenantId, clientId: ids.acme, key: `RP${run.slice(0, 3).toUpperCase()}`, name: `P ${run}` },
    });
    try {
      expect(
        await meta(f.platform.document.create({ data: { ...base(), projectId, kind: "REPORT", reportMonth: aug1 }, select: { id: true } })),
      ).toContain("document_report_company_level");
    } finally {
      await f.platform.project.delete({ where: { id: projectId } });
    }
  });

  it("a publish stamp only on a REPORT, and a REPORT the client can see carries one", async () => {
    expect(
      await meta(f.platform.document.create({ data: { ...base(), kind: "GENERAL", reportPublishedAt: new Date() }, select: { id: true } })),
    ).toContain("document_report_published_shape");
    expect(
      await meta(
        f.platform.document.create({
          data: { ...base(), kind: "REPORT", reportMonth: aug1, visibility: "CLIENT_VISIBLE" },
          select: { id: true },
        }),
      ),
    ).toContain("document_report_published_when_shared");
    // …so a raw flip of a report to the client, with no stamp, is refused too.
    expect(
      await meta(f.platform.document.update({ where: { id: internalId }, data: { visibility: "CLIENT_VISIBLE" }, select: { id: true } })),
    ).toContain("document_report_published_when_shared");
  });

  it("a report never reaches the search index — a file beside it does", async () => {
    const fileId = (
      await commitUpload(ctxOf("owner"), { fileObjectId: await bytesFor(ids.acme, `plain-${run}.txt`), clientId: ids.acme })
    ).documentId;
    const rows = await f.platform.$queryRaw<{ entity_id: string }[]>`
      SELECT entity_id FROM search_index WHERE tenant_id = ${f.tenantId} AND entity_type = 'DOCUMENT'`;
    const indexed = rows.map((r) => r.entity_id);
    expect(indexed).toContain(fileId);
    expect(indexed).not.toContain(internalId);
    expect(indexed).not.toContain(betaId);
    await softDeleteDocument(ctxOf("owner"), fileId);
  });
});

describe("uploading", () => {
  it("makes an INTERNAL report of the client, for its month, audited", async () => {
    const id = await upload(ids.acme, `Upload ${run}`, "2026-07");
    const row = await f.platform.document.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ kind: "REPORT", visibility: "INTERNAL", clientId: ids.acme, projectId: null, reportPublishedAt: null });
    expect(row.reportMonth?.toISOString().slice(0, 10)).toBe("2026-07-01");
    const audit = (await f.audits("document.created")).find((a) => a.targetId === id);
    expect(audit?.metadata).toMatchObject({ kind: "REPORT", visibility: "INTERNAL", reportMonth: "2026-07-01" });
    await deleteReport(ctxOf("owner"), id);
  });

  it("is refused to an employee, for a month not yet begun, and on an archived client", async () => {
    // The employee cannot even presign without `document:upload`… they hold it
    // (CMAE), so the commit's `report:upload` (CMA) is the refusal.
    await f.platform.memberClient.create({ data: { tenantId: f.tenantId, memberId: f.seats.employee.memberId, clientId: ids.acme } });
    try {
      const body = new TextEncoder().encode(`emp ${run}\n`);
      const presigned = await createUpload(ctxOf("employee"), {
        name: `emp-${run}.txt`,
        contentType: "text/plain",
        sizeBytes: body.byteLength,
        sha256: sha(body),
        clientId: ids.acme,
      });
      await storage.handlePut(
        new Request(presigned.uploadUrl, { method: "PUT", headers: { ...presigned.headers }, body: Buffer.from(body) }),
        keyOf(presigned.uploadUrl),
      );
      expect(
        await reason(commitReportUpload(ctxOf("employee"), { fileObjectId: presigned.fileObjectId, clientId: ids.acme, month: MONTH })),
      ).toBe("FORBIDDEN");
      // …and they read the tab, being directly on the client.
      expect((await listClientReports(ctxOf("employee"), ids.acme)).map((r) => r.id)).toContain(internalId);
    } finally {
      await f.platform.memberClient.deleteMany({ where: { tenantId: f.tenantId, memberId: f.seats.employee.memberId } });
    }
    // Not on the client at all: the tab is NOT_FOUND.
    expect(await reason(listClientReports(ctxOf("employee"), ids.acme))).toBe("NOT_FOUND");
    expect(
      await reason(commitReportUpload(ctxOf("owner"), { fileObjectId: await bytesFor(ids.acme), clientId: ids.acme, month: "2099-12" })),
    ).toBe("INVALID_INPUT");
    expect(
      await reason(commitReportUpload(ctxOf("owner"), { fileObjectId: await bytesFor(ids.gone), clientId: ids.gone, month: MONTH })),
    ).toBe("ARCHIVED");
  });
});

describe("publishing", () => {
  let reportId: string;

  beforeAll(async () => {
    reportId = await upload(ids.acme, `Published ${run}`);
  });

  it("shares it, stamps it, audits it and queues ONE mail per person with portal access — in one go", async () => {
    const before = Date.now();
    const out = await publishReport(ctxOf("manager"), reportId);
    // carol, dan — not pat (paused), una (never invited), sid (suppressed), bo (Beta).
    expect(out).toEqual({ published: true, queued: 2, reachable: 3, mailable: 2 });
    const row = await f.platform.document.findUniqueOrThrow({ where: { id: reportId } });
    expect(row.visibility).toBe("CLIENT_VISIBLE");
    expect(row.reportPublishedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    const mails = await mailsFor(reportId);
    expect(mails.map((m) => m.receiverId).sort()).toEqual([ids.carol, ids.dan].sort());
    expect(mails.every((m) => m.status === "QUEUED" && JSON.stringify(m.params) === JSON.stringify({ documentId: reportId }))).toBe(true);
    const audit = (await f.audits("document.visibility_changed")).filter((a) => a.targetId === reportId);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.metadata).toMatchObject({ from: "INTERNAL", to: "CLIENT_VISIBLE", kind: "REPORT", mailed: 2 });
  });

  it("twice is once: nothing changes, nobody is mailed again", async () => {
    expect(await publishReport(ctxOf("owner"), reportId)).toEqual({ published: false, queued: 0, reachable: 0, mailable: 0 });
    expect(await mailsFor(reportId)).toHaveLength(2);
    expect((await f.audits("document.visibility_changed")).filter((a) => a.targetId === reportId)).toHaveLength(1);
  });

  it("the portal shows it to a main contact AND a collaborator — never the INTERNAL one or another client's", async () => {
    for (const who of [ids.carol, ids.dan]) {
      const reports = await listPortalReports(principal(who));
      expect(reports.map((r) => r.id)).toContain(reportId);
      expect(reports.map((r) => r.id)).not.toContain(internalId);
      expect(reports.find((r) => r.id === reportId)).toMatchObject({ name: `Published ${run}`, month: "2026-08-01" });
      expectNoSentinel(reports);
      expect(await countPortalReports(principal(who))).toBeGreaterThanOrEqual(1);
      expect(await portalReportMonth(principal(who), reportId)).toBe("2026-08-01");
      expect(await portalReportMonth(principal(who), internalId)).toBeNull();
      expect(await portalReportMonth(principal(who), betaId)).toBeNull();
    }
    // Beta's person sees Beta's report only.
    const bo = await listPortalReports(principal(ids.bo, ids.beta));
    expect(bo.map((r) => r.id)).toEqual([betaId]);
    expect(await portalReportMonth(principal(ids.bo, ids.beta), reportId)).toBeNull();
  });

  it("a report is not a file: the Files page and the member's Files lists never list one", async () => {
    const files = await listPortalDocuments(principal(ids.carol));
    expect(files.documents.map((d) => d.id)).not.toContain(reportId);
    expectNoSentinel(files);
    const staff = await listDocuments(ctxOf("owner"), { clientId: ids.acme });
    expect(staff.map((d) => d.id)).not.toContain(reportId);
    expect(staff.map((d) => d.id)).not.toContain(internalId);
  });

  it("the Files paths cannot touch a report — only its own verbs can", async () => {
    expect(await reason(changeVisibility(ctxOf("owner"), internalId, "CLIENT_VISIBLE"))).toBe("NOT_FOUND");
    expect(await reason(changeVisibility(ctxOf("owner"), reportId, "INTERNAL"))).toBe("NOT_FOUND");
    expect(await reason(renameDocument(ctxOf("owner"), reportId, "renamed"))).toBe("NOT_FOUND");
    expect(await reason(softDeleteDocument(ctxOf("owner"), reportId))).toBe("NOT_FOUND");
    const fileObjectId = await bytesFor(ids.acme, `v2-${run}.txt`);
    expect(await reason(addVersion(ctxOf("owner"), { documentId: reportId, fileObjectId }))).toBe("NOT_FOUND");
    // Sign-off answers NOT_FOUND too — never "not a deliverable", which would say it exists.
    expect(await reason(requestDocumentSignoff(ctxOf("owner"), reportId))).toBe("NOT_FOUND");
    expect((await f.platform.document.findUniqueOrThrow({ where: { id: reportId } })).visibility).toBe("CLIENT_VISIBLE");
    // The member's download goes through (it asks `report:view` too — the
    // module test below switches that off).
    expect(typeof (await getDownloadUrl(ctxOf("owner"), reportId)).url).toBe("string");
  });

  it("the contact downloads a published report, and never the INTERNAL one", async () => {
    expect(typeof (await resolvePortalDownload(principal(ids.dan), reportId)).url).toBe("string");
    expect(await reason(resolvePortalDownload(principal(ids.dan), internalId))).toBe("NOT_FOUND");
    expect(await reason(resolvePortalDownload(principal(ids.carol), betaId))).toBe("NOT_FOUND");
  });

  it("the outbox asks again at send, as the person: the month in the mail, the name nowhere", async () => {
    const out = await drainOutbox(50, { tenantId: f.tenantId });
    expect(out.sent).toBeGreaterThanOrEqual(2);
    const ours = sent.filter((m) => m.to === emailOf("carol") || m.to === emailOf("dan"));
    expect(ours).toHaveLength(2);
    for (const m of ours) {
      expect(m.subject).toBe("Your August 2026 report is ready");
      expect(m.text).toContain("/portal/reports");
      expect(m.text).not.toContain(`Published ${run}`);
      expect(m.text).not.toContain(`Acme ${run}`);
    }
    expect((await mailsFor(reportId)).every((m) => m.status === "SENT")).toBe(true);
  });

  it("the weekly summary counts it as the person, by when it was published", async () => {
    const counts = await countClientSummary(principal(ids.dan), new Date(Date.now() - 3_600_000), new Date(Date.now() + 60_000));
    expect(counts?.reports).toBeGreaterThanOrEqual(1);
    const before = await countClientSummary(principal(ids.dan), new Date("2026-01-01T00:00:00Z"), new Date("2026-01-02T00:00:00Z"));
    expect(before?.reports).toBe(0);
  });

  it("edit is audited; delete needs report:delete — an admin is refused, a manager deletes", async () => {
    await editReport(ctxOf("owner"), reportId, { name: `Edited ${run}`, month: "2026-07" });
    const row = await f.platform.document.findUniqueOrThrow({ where: { id: reportId } });
    expect(row.name).toBe(`Edited ${run}`);
    expect(row.reportMonth?.toISOString().slice(0, 10)).toBe("2026-07-01");
    const audit = (await f.audits("document.report_edited")).find((a) => a.targetId === reportId);
    expect(audit?.metadata).toMatchObject({
      from: { name: `Published ${run}`, month: "2026-08-01" },
      to: { name: `Edited ${run}`, month: "2026-07-01" },
    });
    expect(await reason(deleteReport(ctxOf("admin"), reportId))).toBe("FORBIDDEN");
    await deleteReport(ctxOf("manager"), reportId);
    expect(await portalReportMonth(principal(ids.carol), reportId)).toBeNull();
  });
});

describe("hiding, and the mail that has not gone yet", () => {
  it("a report hidden before the drain sends nothing — and publishing it again sends it after all", async () => {
    const id = await upload(ids.acme, `Hidden ${run}`);
    await publishReport(ctxOf("owner"), id);
    expect(await hideReport(ctxOf("owner"), id)).toEqual({ hidden: true });
    expect(await portalReportMonth(principal(ids.carol), id)).toBeNull();
    await drainOutbox(50, { tenantId: f.tenantId });
    expect(sent.filter((m) => m.subject.includes("report"))).toHaveLength(0);
    const dropped = await mailsFor(id);
    expect(dropped.map((m) => [m.status, m.lastError])).toEqual([
      ["SKIPPED", REPORT_MAIL_NOT_VISIBLE],
      ["SKIPPED", REPORT_MAIL_NOT_VISIBLE],
    ]);
    // Told nobody, so a second publish makes the mails again.
    expect(await publishReport(ctxOf("owner"), id)).toEqual({ published: true, queued: 2, reachable: 3, mailable: 2 });
    await drainOutbox(50, { tenantId: f.tenantId });
    expect(sent.filter((m) => m.subject === "Your August 2026 report is ready").map((m) => m.to).sort()).toEqual(
      [emailOf("carol"), emailOf("dan")].sort(),
    );
    // …and a third publish after a hide tells nobody twice.
    sent.length = 0;
    await hideReport(ctxOf("owner"), id);
    expect(await publishReport(ctxOf("owner"), id)).toEqual({ published: true, queued: 0, reachable: 3, mailable: 2 });
    await drainOutbox(50, { tenantId: f.tenantId });
    expect(sent).toHaveLength(0);
    await deleteReport(ctxOf("owner"), id);
  });

  it("a person invited between two publishes gets theirs — and nobody else is mailed twice", async () => {
    const id = await upload(ids.acme, `Invited ${run}`);
    await publishReport(ctxOf("owner"), id);
    await drainOutbox(50, { tenantId: f.tenantId });
    expect(sent.map((m) => m.to).sort()).toEqual([emailOf("carol"), emailOf("dan")].sort());
    sent.length = 0;
    await f.platform.contact.update({ where: { id: ids.una }, data: { portalStatus: "ACTIVE", invitedAt: new Date() } });
    try {
      await hideReport(ctxOf("owner"), id);
      expect(await publishReport(ctxOf("owner"), id)).toEqual({ published: true, queued: 1, reachable: 4, mailable: 3 });
      await drainOutbox(50, { tenantId: f.tenantId });
      expect(sent.map((m) => m.to)).toEqual([emailOf("una")]);
    } finally {
      await f.platform.contact.update({ where: { id: ids.una }, data: { portalStatus: "NO_ACCESS", invitedAt: null } });
    }
    await deleteReport(ctxOf("owner"), id);
  });

  it("a person paused between the publish and the drain is not mailed", async () => {
    const id = await upload(ids.acme, `Paused ${run}`);
    await publishReport(ctxOf("owner"), id);
    await f.platform.contact.update({ where: { id: ids.dan }, data: { portalStatus: "SUSPENDED" } });
    try {
      await drainOutbox(50, { tenantId: f.tenantId });
      expect(sent.map((m) => m.to)).toEqual([emailOf("carol")]);
      const dan = (await mailsFor(id)).find((m) => m.receiverId === ids.dan);
      expect(dan?.status).toBe("SKIPPED");
    } finally {
      await f.platform.contact.update({ where: { id: ids.dan }, data: { portalStatus: "ACTIVE" } });
    }
    await deleteReport(ctxOf("owner"), id);
  });

  it("the reports module switched off closes the page, the download and the mail", async () => {
    const id = await upload(ids.acme, `Module ${run}`);
    await publishReport(ctxOf("owner"), id);
    await f.platform.tenantPreference.create({ data: { tenantId: f.tenantId, key: "module.reports.enabled", value: false } });
    try {
      const off = await resolvePortalModuleGates(f.tenantId);
      const p: PortalPrincipal = { ...principal(ids.carol), gates: off };
      expect(await reason(listPortalReports(p))).toBe("DISABLED_BY_TENANT");
      expect(await countPortalReports(p)).toBe(0);
      expect(await reason(resolvePortalDownload(p, id))).toBe("DISABLED_BY_TENANT");
      // …and the member's download of a report, which asks `report:view` too.
      expect(await reason(getDownloadUrl(ctxOf("owner"), id))).toBe("DISABLED_BY_TENANT");
      // A plain shared file still downloads: only reports closed.
      const fileId = (
        await commitUpload(ctxOf("owner"), {
          fileObjectId: await bytesFor(ids.acme, `shared-${run}.txt`),
          clientId: ids.acme,
          visibility: "CLIENT_VISIBLE",
        })
      ).documentId;
      expect(typeof (await resolvePortalDownload(p, fileId)).url).toBe("string");
      expect(typeof (await getDownloadUrl(ctxOf("owner"), fileId)).url).toBe("string");
      await softDeleteDocument(ctxOf("owner"), fileId);
      await drainOutbox(50, { tenantId: f.tenantId });
      expect(sent.filter((m) => m.subject.includes("report"))).toHaveLength(0);
    } finally {
      await f.platform.tenantPreference.deleteMany({ where: { tenantId: f.tenantId, key: "module.reports.enabled" } });
    }
    await deleteReport(ctxOf("owner"), id);
  });
});

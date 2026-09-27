import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { withTenant } from "@/db";
import { DomainError } from "@/lib/domain-error";
import { setupTenant } from "@/members/dbtest-fixture";
import { listPortalTimeline } from "@/modules/work";
import { resolvePortalModuleGates, type PortalPrincipal } from "@/portal";
import { LocalDiskTransport, setStorage } from "@/storage";

import { listPortalDocuments, type PortalDocument } from "./portal";
import {
  DOWNLOAD_WINDOW_LIMIT,
  readPortalFileVersions,
  resolvePortalDownload,
} from "./portal-writes";
import { addVersion, commitUpload, createUpload, softDeleteDocument, type DocumentCtx } from "./service";

/**
 * THE PORTAL'S FILES AGAINST THE REAL SCHEMA (Phase 3, the portal
 * files-and-services slice): the documents projection under a real
 * contact principal, the file layer's BROKER — the one place the portal
 * reads class-A rows, as `system` — and the audited download.
 *
 * THE CENTRAL ASSERTION IS THE SENTINEL WALK, as in every portal suite:
 * every file a client must never read is planted as a string that
 * appears nowhere else — an INTERNAL company file, an INTERNAL
 * deliverable on the reachable project, shared files on a switched-off
 * project, an archived project and another client's project, a deleted
 * file, a file whose bytes never arrived, and a tenant EXPORT somebody
 * marked visible — and the serialised output of every read is searched
 * for each.
 *
 * WHAT ONLY A DATABASE CAN SAY: that a contact-principal read of
 * `file_version` really returns nothing (which is why the broker
 * exists), that the broker returns nothing for an id the contact's own
 * read did not prove, that the download's audit row names the CONTACT
 * under a system transaction, and that the budget refuses on the
 * database's own count.
 *
 * Tenant slug prefix `pfil-` is registered in `DBTEST_PREFIXES`
 * (e2e/fixtures/seed-cli.ts) so `sweep-dbtests` collects orphans.
 */

const run = randomUUID().slice(0, 8);

let f: Awaited<ReturnType<typeof setupTenant>>;
let gates: Awaited<ReturnType<typeof resolvePortalModuleGates>>;
let storage: LocalDiskTransport;
const storageDir = mkdtempSync(join(tmpdir(), "fortleva-pfil-"));

let acme: string;
let beta: string;
let pOn: string;
let pOff: string;
let pArchived: string;
let pBeta: string;
let carol: string;
let dan: string;
let bo: string;
let sue: string;

let companyFileId: string;
let deliverableId: string;
let projectFileId: string;
let internalDeliverableId: string;
let deletedId: string;
let pendingId: string;
let exportId: string;
let betaFileId: string;
let offFileId: string;
let archivedFileId: string;

/** Strings a contact IS meant to read. */
const SHOWN = {
  companyFile: `contract-${run}.txt`,
  deliverable: `design-${run}.txt`,
  projectFile: `notes-${run}.txt`,
} as const;

/** Strings that exist nowhere but on rows a contact must never reach. */
const S = {
  internalCompany: `SENTINELINTERNALCOMPANY-${run}.txt`,
  internalDeliverable: `SENTINELINTERNALDELIVERABLE-${run}.txt`,
  offProject: `SENTINELOFF-${run}.txt`,
  archivedProject: `SENTINELARCHIVED-${run}.txt`,
  beta: `SENTINELBETA-${run}.txt`,
  deleted: `SENTINELDELETED-${run}.txt`,
  pending: `SENTINELPENDING-${run}.txt`,
  export: `SENTINELEXPORT-${run}.txt`,
} as const;

const V1_BODY = `first draft ${run}\n`;
const V2_BODY = `final version of the design ${run}\n`;

const ctxOf = (seat: "owner" | "employee"): DocumentCtx => ({ tenantId: f.tenantId, actor: f.seats[seat].actor });

const principal = (contactId: string, clientId = acme): PortalPrincipal => ({
  contactId,
  tenantId: f.tenantId,
  clientId,
  gates,
});

const sha = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");

const keyOf = (url: string): string =>
  new URL(url).pathname.replace(/^\/api\/dev-storage\//, "").split("/").map(decodeURIComponent).join("/");

/** The browser's half of an upload, performed in process. */
const putBytes = async (uploadUrl: string, headers: Record<string, string>, body: Uint8Array) => {
  const res = await storage.handlePut(
    new Request(uploadUrl, { method: "PUT", headers, body: Buffer.from(body) }),
    keyOf(uploadUrl),
  );
  expect(res.status).toBe(200);
};

/** A document through the real service: presign → PUT → commit. */
const upload = async (
  name: string,
  visibility: "INTERNAL" | "CLIENT_VISIBLE",
  scope: { clientId?: string; projectId?: string },
  opts: { kind?: "GENERAL" | "DELIVERABLE"; body?: string } = {},
): Promise<string> => {
  const body = new TextEncoder().encode(opts.body ?? `${name}\n`);
  const presigned = await createUpload(ctxOf("owner"), {
    name,
    contentType: "text/plain",
    sizeBytes: body.byteLength,
    sha256: sha(body),
    ...scope,
    visibility,
  });
  await putBytes(presigned.uploadUrl, { ...presigned.headers }, body);
  const { documentId } = await commitUpload(ctxOf("owner"), {
    fileObjectId: presigned.fileObjectId,
    ...scope,
    visibility,
    ...(opts.kind ? { kind: opts.kind } : {}),
  });
  return documentId;
};

/** A further version of an existing document, through the real service. */
const version = async (documentId: string, scope: { clientId?: string; projectId?: string }, text: string) => {
  const body = new TextEncoder().encode(text);
  const presigned = await createUpload(ctxOf("owner"), {
    name: `v-${run}.txt`,
    contentType: "text/plain",
    sizeBytes: body.byteLength,
    sha256: sha(body),
    ...scope,
  });
  await putBytes(presigned.uploadUrl, { ...presigned.headers }, body);
  return addVersion(ctxOf("owner"), { documentId, fileObjectId: presigned.fileObjectId, note: "final" });
};

const authzReason = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "resolved";
  } catch (e) {
    if (e instanceof AuthzError) return e.reason;
    throw e;
  }
};

const domainCode = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "resolved";
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    throw e;
  }
};

/** Every string in `S`, checked against a serialised projection. */
const expectNoSentinel = (value: unknown) => {
  const json = JSON.stringify(value);
  for (const [name, sentinel] of Object.entries(S)) {
    expect(json, `sentinel ${name} leaked`).not.toContain(sentinel);
  }
};

const downloadsBy = async (contactId: string): Promise<number> =>
  f.platform.auditEvent.count({
    where: { tenantId: f.tenantId, action: "file.downloaded", actorType: "CONTACT", actorId: contactId },
  });

beforeAll(async () => {
  storage = new LocalDiskTransport(storageDir);
  setStorage(storage);
  f = await setupTenant("pfil");
  gates = await resolvePortalModuleGates(f.tenantId);
  acme = randomUUID();
  beta = randomUUID();
  pOn = randomUUID();
  pOff = randomUUID();
  pArchived = randomUUID();
  pBeta = randomUUID();
  carol = randomUUID();
  dan = randomUUID();
  bo = randomUUID();
  sue = randomUUID();
  const up = run.slice(0, 3).toUpperCase();

  await f.platform.client.createMany({
    data: [
      { id: acme, tenantId: f.tenantId, name: `Acme ${run}` },
      { id: beta, tenantId: f.tenantId, name: `Beta ${run}` },
    ],
  });
  await f.platform.project.createMany({
    data: [
      { id: pOn, tenantId: f.tenantId, clientId: acme, key: `PFL${up}`, name: `Site ${run}`, portalEnabled: true },
      { id: pOff, tenantId: f.tenantId, clientId: acme, key: `PFO${up}`, name: `Off ${run}`, portalEnabled: false },
      {
        id: pArchived,
        tenantId: f.tenantId,
        clientId: acme,
        key: `PFA${up}`,
        name: `Archived ${run}`,
        portalEnabled: true,
        status: "ARCHIVED",
        archivedAt: new Date("2026-01-01T00:00:00Z"),
      },
      { id: pBeta, tenantId: f.tenantId, clientId: beta, key: `PFB${up}`, name: `Beta site ${run}`, portalEnabled: true },
    ],
  });
  const invitedAt = new Date("2026-09-01T09:00:00Z");
  await f.platform.contact.createMany({
    data: [
      { id: carol, tenantId: f.tenantId, clientId: acme, name: "Carol", email: `pfil-carol-${run}@test.invalid`, portalProfile: "CONTACT_PRIMARY", portalStatus: "ACTIVE", invitedAt, emailVerified: true },
      { id: dan, tenantId: f.tenantId, clientId: acme, name: "Dan", email: `pfil-dan-${run}@test.invalid`, portalProfile: "CONTACT_COLLABORATOR", portalStatus: "ACTIVE", invitedAt, emailVerified: true },
      { id: bo, tenantId: f.tenantId, clientId: beta, name: "Bo", email: `pfil-bo-${run}@test.invalid`, portalProfile: "CONTACT_PRIMARY", portalStatus: "ACTIVE", invitedAt, emailVerified: true },
      { id: sue, tenantId: f.tenantId, clientId: acme, name: "Sue", email: `pfil-sue-${run}@test.invalid`, portalProfile: "CONTACT_PRIMARY", portalStatus: "SUSPENDED", invitedAt, emailVerified: true },
    ],
  });

  // ── The shared files, through the real service ─────────────────────
  companyFileId = await upload(SHOWN.companyFile, "CLIENT_VISIBLE", { clientId: acme });
  deliverableId = await upload(SHOWN.deliverable, "CLIENT_VISIBLE", { projectId: pOn }, { kind: "DELIVERABLE", body: V1_BODY });
  await version(deliverableId, { projectId: pOn }, V2_BODY);
  projectFileId = await upload(SHOWN.projectFile, "CLIENT_VISIBLE", { projectId: pOn });

  // ── Sentinels ──────────────────────────────────────────────────────
  await upload(S.internalCompany, "INTERNAL", { clientId: acme });
  internalDeliverableId = await upload(S.internalDeliverable, "INTERNAL", { projectId: pOn }, { kind: "DELIVERABLE" });
  offFileId = await upload(S.offProject, "CLIENT_VISIBLE", { projectId: pOff });
  archivedFileId = await upload(S.archivedProject, "CLIENT_VISIBLE", { projectId: pArchived });
  betaFileId = await upload(S.beta, "CLIENT_VISIBLE", { projectId: pBeta });
  deletedId = await upload(S.deleted, "CLIENT_VISIBLE", { clientId: acme });
  await softDeleteDocument(ctxOf("owner"), deletedId);
  // A file whose bytes never arrived: the document row exists and is
  // shared, its only version points at a PENDING object. Planted
  // directly — the service never creates this shape on purpose.
  pendingId = randomUUID();
  const pendingObject = randomUUID();
  await f.platform.fileObject.create({
    data: {
      id: pendingObject,
      tenantId: f.tenantId,
      r2Key: `${f.tenantId}/${pendingObject}`,
      sha256: sha("pending"),
      sizeBytes: BigInt(7),
      contentType: "text/plain",
      status: "PENDING",
    },
  });
  await f.platform.document.create({
    data: {
      id: pendingId,
      tenantId: f.tenantId,
      clientId: acme,
      name: S.pending,
      visibility: "CLIENT_VISIBLE",
      versions: { create: { versionNumber: 1, fileObjectId: pendingObject } },
    },
  });
  // A tenant EXPORT somebody marked visible: never a client's file.
  // Planted directly — `commitUpload` cannot mint the kind.
  exportId = randomUUID();
  const exportObject = randomUUID();
  await f.platform.fileObject.create({
    data: {
      id: exportObject,
      tenantId: f.tenantId,
      r2Key: `${f.tenantId}/${exportObject}`,
      sha256: sha("export"),
      sizeBytes: BigInt(6),
      contentType: "application/zip",
      status: "COMMITTED",
      committedAt: new Date(),
    },
  });
  await f.platform.document.create({
    data: {
      id: exportId,
      tenantId: f.tenantId,
      clientId: acme,
      name: S.export,
      kind: "EXPORT",
      visibility: "CLIENT_VISIBLE",
      versions: { create: { versionNumber: 1, fileObjectId: exportObject } },
    },
  });
}, 120_000);

afterAll(async () => {
  if (!f) return;
  await f.platform.$executeRaw`DELETE FROM search_index WHERE tenant_id = ${f.tenantId}`;
  await f.platform.comment.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.fileVersion.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.document.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.fileObject.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.contact.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.project.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.client.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.tenantPreference.deleteMany({ where: { tenantId: f.tenantId } });
  await f.cleanup();
  setStorage(null);
  rmSync(storageDir, { recursive: true, force: true });
}, 60_000);

describe("the files list", () => {
  it("is every shared file of the client, deliverables first, with the newest version's facts", async () => {
    const { documents, truncated } = await listPortalDocuments(principal(carol));
    expect(truncated).toBe(false);
    expect(documents.map((d) => d.name)).toEqual([SHOWN.deliverable, SHOWN.projectFile, SHOWN.companyFile]);
    const deliverable = documents[0]!;
    expect(deliverable).toMatchObject({
      id: deliverableId,
      kind: "DELIVERABLE",
      project: { id: pOn, key: `PFL${run.slice(0, 3).toUpperCase()}`, name: `Site ${run}` },
    });
    // The NEWEST version: number 2, the second body's size, the type.
    expect(deliverable.version.number).toBe(2);
    expect(deliverable.version.sizeBytes).toBe(new TextEncoder().encode(V2_BODY).byteLength);
    expect(deliverable.version.contentType).toBe("text/plain");
    expect(documents[2]).toMatchObject({ id: companyFileId, kind: "GENERAL", project: null });
    expect(documents[2]!.version.number).toBe(1);
  });

  it("carries exactly its keys — the contract a page renders — and no internal fact", async () => {
    const out = await listPortalDocuments(principal(carol));
    expectNoSentinel(out);
    const keysOf = (d: PortalDocument) => Object.keys(d).sort();
    // `approval` since the sign-off slice — the ask on a DELIVERABLE, null
    // on every other kind (`signoff.dbtest.ts` drives it).
    expect(keysOf(out.documents[0]!)).toEqual(["approval", "id", "kind", "name", "project", "version"]);
    expect(out.documents[0]!.approval).toMatchObject({ status: "NOT_REQUESTED", canDecide: false });
    expect(out.documents[2]!.approval).toBeNull();
    expect(Object.keys(out.documents[0]!.version).sort()).toEqual(["at", "contentType", "number", "sizeBytes"]);
    expect(Object.keys(out.documents[0]!.project!).sort()).toEqual(["id", "key", "name"]);
  });

  it("narrowed to one project lists that project's files only", async () => {
    const { documents } = await listPortalDocuments(principal(carol), { projectId: pOn });
    expect(documents.map((d) => d.id)).toEqual([deliverableId, projectFileId]);
  });

  it("a collaborator reads the same list as the primary contact", async () => {
    expect(await listPortalDocuments(principal(dan))).toEqual(await listPortalDocuments(principal(carol)));
  });

  it("refuses another client's project, a switched-off project and a suspended contact; an archived project is empty", async () => {
    expect(await authzReason(listPortalDocuments(principal(bo, beta), { projectId: pOn }))).toBe("NOT_FOUND");
    expect(await authzReason(listPortalDocuments(principal(carol), { projectId: pBeta }))).toBe("NOT_FOUND");
    expect(await authzReason(listPortalDocuments(principal(carol), { projectId: pOff }))).toBe("NOT_FOUND");
    expect(await authzReason(listPortalDocuments(principal(sue)))).toBe("FORBIDDEN");
    expect(await listPortalDocuments(principal(carol), { projectId: pArchived })).toEqual({
      documents: [],
      truncated: false,
    });
    // Bo's own list is Beta's one shared file and nothing of Acme's.
    const bos = await listPortalDocuments(principal(bo, beta));
    expect(bos.documents.map((d) => d.id)).toEqual([betaFileId]);
    for (const shown of Object.values(SHOWN)) expect(JSON.stringify(bos)).not.toContain(shown);
  });
});

describe("the file layer's broker", () => {
  it("a contact principal cannot read file_version at all — which is why the broker exists", async () => {
    // Under `portal_deny` the read returns nothing, whatever the document
    // says. Measured rather than assumed: if this ever returned rows the
    // broker would be redundant and the projection could read directly.
    const rows = await withTenant(
      f.tenantId,
      { type: "contact", id: carol, clientId: acme },
      (tx) => tx.fileVersion.findMany({ where: { documentId: deliverableId }, select: { id: true } }),
    );
    expect(rows).toEqual([]);
  });

  it("returns every committed version of the ids it was handed, newest first, or only the newest per document", async () => {
    const all = await readPortalFileVersions(principal(carol), [deliverableId, companyFileId]);
    expect(all.map((v) => [v.documentId, v.versionNumber])).toEqual([
      [deliverableId, 2],
      [deliverableId, 1],
      [companyFileId, 1],
    ]);
    for (let i = 1; i < all.length; i++) {
      expect(all[i - 1]!.at.getTime()).toBeGreaterThanOrEqual(all[i]!.at.getTime());
    }
    expect(Object.keys(all[0]!).sort()).toEqual(["at", "contentType", "documentId", "id", "sizeBytes", "versionNumber"]);
    const newest = await readPortalFileVersions(principal(carol), [deliverableId, companyFileId], { newestPerDocument: true });
    expect(newest.map((v) => [v.documentId, v.versionNumber]).sort()).toEqual(
      [
        [deliverableId, 2],
        [companyFileId, 1],
      ].sort(),
    );
  });

  it("returns nothing for an id the contact's own read would not have proved — whatever the caller passes", async () => {
    // Every sentinel's id, handed straight to the system read: the gate's
    // terms restated on the joined row keep each one out.
    const ids = [internalDeliverableId, offFileId, archivedFileId, betaFileId, deletedId, pendingId, exportId];
    expect(await readPortalFileVersions(principal(carol), ids)).toEqual([]);
    // …and for a bogus or empty list, no transaction is opened at all.
    expect(await readPortalFileVersions(principal(carol), [])).toEqual([]);
    expect(await readPortalFileVersions(principal(carol), ["", randomUUID()])).toEqual([]);
  });

  it("is refused before the system transaction for a contact who may not view documents at all", async () => {
    expect(await authzReason(readPortalFileVersions(principal(sue), [deliverableId]))).toBe("FORBIDDEN");
  });
});

describe("the download", () => {
  it("mints an off-origin attachment link for the newest version and audits it to the CONTACT", async () => {
    const before = await downloadsBy(carol);
    const { url, filename } = await resolvePortalDownload(principal(carol), deliverableId);
    expect(filename).toBe(SHOWN.deliverable);
    expect(url).toContain("/api/dev-storage/");
    // The link really serves the NEWEST bytes, as an attachment.
    const res = await storage.handleGet(new Request(url), keyOf(url));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(V2_BODY);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(res.headers.get("content-type")).toBe("text/plain");
    // ONE row, actor CONTACT, naming Carol — under a SYSTEM transaction.
    expect(await downloadsBy(carol)).toBe(before + 1);
    const row = await f.platform.auditEvent.findFirst({
      where: { tenantId: f.tenantId, action: "file.downloaded", actorId: carol },
      orderBy: { createdAt: "desc" },
      select: { actorType: true, targetType: true, targetId: true, metadata: true, visibility: true },
    });
    expect(row).toMatchObject({
      actorType: "CONTACT",
      targetType: "Document",
      targetId: deliverableId,
      visibility: "TENANT",
      metadata: { versionNumber: 2, clientId: acme },
    });
  });

  it("a collaborator may download too", async () => {
    const { filename } = await resolvePortalDownload(principal(dan), companyFileId);
    expect(filename).toBe(SHOWN.companyFile);
  });

  it("refuses every file the client may not have, writes no row for any of them, and names no reason a page could show", async () => {
    const before = await downloadsBy(carol);
    for (const [label, id] of [
      ["internal deliverable", internalDeliverableId],
      ["switched-off project", offFileId],
      ["archived project", archivedFileId],
      ["another client's file", betaFileId],
      ["deleted file", deletedId],
      ["file whose bytes never arrived", pendingId],
      ["tenant export", exportId],
      ["unknown id", randomUUID()],
    ] as const) {
      expect(await authzReason(resolvePortalDownload(principal(carol), id)), label).toBe("NOT_FOUND");
    }
    expect(await authzReason(resolvePortalDownload(principal(bo, beta), deliverableId))).toBe("NOT_FOUND");
    expect(await authzReason(resolvePortalDownload(principal(sue), deliverableId))).toBe("FORBIDDEN");
    // An empty id is refused before anything is authorized — the
    // undefined-`where` belt every broker carries.
    expect(await domainCode(resolvePortalDownload(principal(carol), ""))).toBe("INVALID_INPUT");
    expect(await downloadsBy(carol)).toBe(before);
  });

  it("refuses on the database's own count once the window's budget is spent, and writes no row for the refusal", async () => {
    // Plant a window's worth of downloads in Dan's name, as the
    // downloads themselves would have written them.
    const rows = Array.from({ length: DOWNLOAD_WINDOW_LIMIT }, () => ({
      tenantId: f.tenantId,
      action: "file.downloaded",
      actorType: "CONTACT" as const,
      actorId: dan,
      targetType: "Document",
      targetId: companyFileId,
      visibility: "TENANT" as const,
    }));
    await f.platform.auditEvent.createMany({ data: rows });
    const before = await downloadsBy(dan);
    expect(await domainCode(resolvePortalDownload(principal(dan), companyFileId))).toBe("DOWNLOAD_RATE_LIMITED");
    expect(await downloadsBy(dan)).toBe(before);
    // Carol's budget is her own: untouched by Dan's.
    const { filename } = await resolvePortalDownload(principal(carol), companyFileId);
    expect(filename).toBe(SHOWN.companyFile);
  });
});

describe("the timeline's document branch", () => {
  it("is one entry per delivered version of a shared deliverable, and nothing for other files", async () => {
    const { entries } = await listPortalTimeline(principal(carol), { projectId: pOn });
    const docs = entries.filter((e) => e.kind === "document_version");
    expect(docs).toHaveLength(2);
    expect(docs.map((e) => (e.kind === "document_version" ? e.versionNumber : -1))).toEqual([2, 1]);
    expect(docs[0]).toMatchObject({
      kind: "document_version",
      documentId: deliverableId,
      name: SHOWN.deliverable,
      documentKind: "DELIVERABLE",
    });
    expect(Object.keys(docs[0]!).sort()).toEqual(["at", "documentId", "documentKind", "id", "kind", "name", "versionNumber"]);
    // v2 is newer than v1, and both sit in the rail's order.
    expect(docs[0]!.at.getTime()).toBeGreaterThan(docs[1]!.at.getTime());
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i - 1]!.at.getTime()).toBeGreaterThanOrEqual(entries[i]!.at.getTime());
    }
    // The GENERAL project file is on the files list, never on the rail;
    // the INTERNAL deliverable is on neither.
    const json = JSON.stringify(entries);
    expect(json).not.toContain(SHOWN.projectFile);
    expectNoSentinel(entries);
  });

  it("is refused exactly where the files list is", async () => {
    expect(await authzReason(listPortalTimeline(principal(bo, beta), { projectId: pOn }))).toBe("NOT_FOUND");
    expect(await authzReason(listPortalTimeline(principal(carol), { projectId: pOff }))).toBe("NOT_FOUND");
    expect(await authzReason(listPortalTimeline(principal(sue), { projectId: pOn }))).toBe("FORBIDDEN");
    expect(await listPortalTimeline(principal(carol), { projectId: pArchived })).toEqual({ entries: [], truncated: false });
  });
});

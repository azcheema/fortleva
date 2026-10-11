import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { DomainError } from "@/lib/domain-error";
import { actorFor, setupTenant } from "@/members/dbtest-fixture";
import { resolvePortalModuleGates, type PortalPrincipal } from "@/portal";
import { LocalDiskTransport, setStorage } from "@/storage";

import { readContract, startContract } from "./drafts";
import { contractPdfUrl } from "./pdf-store";
import { listPortalContracts, readPortalContract } from "./portal";
import { resolvePortalContractPdf } from "./portal-writes";
import {
  commitContractUpload,
  CONTRACT_UPLOAD_MAX_BYTES,
  deleteUploadedContract,
  presignContractUpload,
  setUploadedContractShown,
  updateUploadedContract,
} from "./uploads";

/**
 * CONTRACTS SIGNED ELSEWHERE against the real database and the real
 * app_runtime role (Phase 4 slice 112c; founder decisions C84 (f), C86;
 * migration 20261014090000; the design: docs/research/2026-10-10-slice-112-
 * contracts-design.md §14):
 *   - putting one in: presign → the browser's PUT (real bytes, on a local disk)
 *     → commit, the server reading the bytes back — and every refusal;
 *   - the database's guard: never shown at birth, its file its own, its
 *     details by `contract:edit`, its showing by `contract:send`, one act at a
 *     time, its file and status never;
 *   - the portal: nothing while hidden; the row, its dates and its download
 *     once shown; nothing again once hidden;
 *   - delete: owners and managers, with the file's row, bytes and storage.
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
let acme: string;
let beta: string;
let eva: string; // acme, main contact, in the portal
let bo: string; // beta, main contact, in the portal
let gates: Awaited<ReturnType<typeof resolvePortalModuleGates>>;
let storage: LocalDiskTransport;
const storageDir = mkdtempSync(join(tmpdir(), "fortleva-contract-uploads-"));

const ctxOf = (memberId: string) => ({ tenantId: f.tenantId, actor: actorFor(memberId) });
const manager = () => ctxOf(f.seats.manager.memberId);
const principal = (contactId: string, clientId = acme): PortalPrincipal => ({ contactId, tenantId: f.tenantId, clientId, gates });
const asMember = <T>(memberId: string, fn: (tx: TenantDb) => Promise<T>) => withTenant(f.tenantId, { type: "member", id: memberId }, fn);

const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const pdf = (text: string) => new Uint8Array(Buffer.from(`%PDF-1.4\n% ${text}\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n`, "latin1"));

const outcome = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "ok";
  } catch (e) {
    if (e instanceof AuthzError) return e.reason;
    if (e instanceof DomainError) return e.code;
    throw e;
  }
};

/** What the DATABASE said — its meta, never the message, whose code frame quotes this file. */
const said = async (p: Promise<unknown>): Promise<string> => {
  try {
    const n = await p;
    return n === 0 ? "0" : "ok";
  } catch (e) {
    const meta = JSON.stringify((e as { meta?: unknown })?.meta ?? "");
    const text = meta.length > 2 ? meta : e instanceof Error ? e.message : String(e);
    const token = /\b((?:CONTRACT|PORTAL)_[A-Z_]+):/.exec(text)?.[1];
    if (token) return token;
    if (/violates check constraint/.test(text)) return "CHECK";
    if (/row-level security/.test(text)) return "RLS";
    if (/permission denied/.test(text)) return "DENIED";
    return `unexpected: ${text.slice(0, 400)}`;
  }
};

/** The browser's half: PUT the bytes to the presigned URL (the dev storage's own handler). */
const putBytes = async (uploadUrl: string, headers: Readonly<Record<string, string>>, body: Uint8Array) => {
  const key = new URL(uploadUrl, "http://localhost").pathname
    .replace(/^\/api\/dev-storage\//, "")
    .split("/")
    .map(decodeURIComponent)
    .join("/");
  const res = await storage.handlePut(new Request(new URL(uploadUrl, "http://localhost"), { method: "PUT", headers, body: Buffer.from(body) }), key);
  expect(res.status).toBe(200);
};

/** Put a signed PDF in, all three steps, as `memberId` — the contract's id. */
async function putIn(
  bytes: Uint8Array,
  opts: { memberId?: string; title?: string; signedOn?: string; endsOn?: string; announced?: string } = {},
): Promise<string> {
  const ctx = ctxOf(opts.memberId ?? f.seats.manager.memberId);
  const ticket = await presignContractUpload(ctx, {
    clientId: acme,
    fileName: "signed-agreement.pdf",
    contentType: "application/pdf",
    sizeBytes: bytes.byteLength,
    sha256: opts.announced ?? sha(bytes),
  });
  await putBytes(ticket.uploadUrl, ticket.headers, bytes);
  const { id } = await commitContractUpload(ctx, {
    fileObjectId: ticket.fileObjectId,
    clientId: acme,
    title: opts.title ?? "Support agreement 2024",
    signedOn: opts.signedOn ?? "2024-03-01",
    startsOn: "2024-03-01",
    endsOn: opts.endsOn ?? "2027-02-28",
  });
  return id;
}

const storageUsed = async (): Promise<bigint> =>
  (await f.platform.tenant.findUniqueOrThrow({ where: { id: f.tenantId }, select: { storageUsedBytes: true } })).storageUsedBytes;

beforeAll(async () => {
  f = await setupTenant("ctrupload");
  storage = new LocalDiskTransport(storageDir);
  setStorage(storage);
  gates = await resolvePortalModuleGates(f.tenantId);
  const run = randomUUID().slice(0, 8);
  acme = randomUUID();
  beta = randomUUID();
  eva = randomUUID();
  bo = randomUUID();
  await f.platform.client.createMany({
    data: [
      { id: acme, tenantId: f.tenantId, name: "Acme AB" },
      { id: beta, tenantId: f.tenantId, name: "Beta AB" },
    ],
  });
  const invitedAt = new Date("2026-09-01T09:00:00Z");
  const contact = (id: string, clientId: string, name: string) => ({
    id,
    tenantId: f.tenantId,
    clientId,
    name,
    email: `ctrupload-${name.toLowerCase()}-${run}@test.invalid`,
    portalProfile: "CONTACT_PRIMARY" as const,
    portalStatus: "ACTIVE" as const,
    invitedAt,
    emailVerified: true,
  });
  await f.platform.contact.createMany({ data: [contact(eva, acme, "Eva"), contact(bo, beta, "Bo")] });
}, 180_000);

afterAll(async () => {
  setStorage(null);
  if (!f) return;
  await f.deleteInvoices(); // contracts and their CONTRACT_PDF files (slice 112)
  await f.platform.fileObject.deleteMany({ where: { tenantId: f.tenantId } }); // the placeholders
  await f.platform.contact.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.client.deleteMany({ where: { tenantId: f.tenantId } });
  await f.platform.tenantPreference.deleteMany({ where: { tenantId: f.tenantId } });
  await f.cleanup();
}, 180_000);

describe("putting a signed PDF in", () => {
  it("SIGNED and NOT shown; the file recorded as a committed contract PDF with the server's own fingerprint; storage counted; audited", async () => {
    const bytes = pdf("the signed support agreement");
    const before = await storageUsed();
    const id = await putIn(bytes);

    const row = await f.platform.contract.findFirstOrThrow({
      where: { id },
      select: { origin: true, status: true, shownToClient: true, signedOn: true, endsOn: true, version: true, body: true, signedPdfFileId: true, sentAt: true },
    });
    expect(row).toMatchObject({ origin: "UPLOADED", status: "SIGNED", shownToClient: false, version: 1, body: null, sentAt: null });
    expect(row.signedOn?.toISOString().slice(0, 10)).toBe("2024-03-01");
    expect(row.endsOn?.toISOString().slice(0, 10)).toBe("2027-02-28");
    const file = await f.platform.fileObject.findFirstOrThrow({ where: { id: row.signedPdfFileId! } });
    expect([file.kind, file.status, file.sha256, Number(file.sizeBytes), file.contentType, file.createdByMemberId]).toEqual([
      "CONTRACT_PDF",
      "COMMITTED",
      sha(bytes),
      bytes.byteLength,
      "application/pdf",
      f.seats.manager.memberId,
    ]);
    expect(await storageUsed()).toBe(before + BigInt(bytes.byteLength));
    expect((await f.audits("contract.uploaded")).filter((a) => a.targetId === id)).toHaveLength(1);
    expect((await f.audits("file.uploaded")).filter((a) => a.targetId === row.signedPdfFileId)).toHaveLength(1);

    // The agency reads it as signed elsewhere, and downloads the file itself.
    const detail = await readContract(manager(), id);
    expect([detail.origin, detail.shownToClient, detail.status]).toEqual(["UPLOADED", false, "SIGNED"]);
    const url = await contractPdfUrl(manager(), id, "signed");
    expect(url.created).toBe(false);
    expect(await outcome(contractPdfUrl(manager(), id, "sent"))).toBe("CONTRACT_NOT_READY");
  });

  it("records the CHECKED copy at a key of its own: the presigned URL, replayed afterwards, changes nothing", async () => {
    const ctx = manager();
    const bytes = pdf("the original, as signed");
    const ticket = await presignContractUpload(ctx, { clientId: acme, fileName: "s.pdf", contentType: "application/pdf", sizeBytes: bytes.byteLength, sha256: sha(bytes) });
    await putBytes(ticket.uploadUrl, ticket.headers, bytes);
    const placeholderKey = `${f.tenantId}/${ticket.fileObjectId}`;
    const { id } = await commitContractUpload(ctx, { fileObjectId: ticket.fileObjectId, clientId: acme, title: "Replay", signedOn: "2024-04-01" });
    const { signedPdfFileId } = await f.platform.contract.findFirstOrThrow({ where: { id }, select: { signedPdfFileId: true } });
    const file = await f.platform.fileObject.findFirstOrThrow({ where: { id: signedPdfFileId! }, select: { r2Key: true, originalFilename: true } });
    expect(signedPdfFileId).not.toBe(ticket.fileObjectId);
    expect(file.r2Key).not.toBe(placeholderKey);
    // Never the uploader's own file name — the title's.
    expect(file.originalFilename).toBe("replay-signed.pdf");
    expect((await f.platform.fileObject.findFirstOrThrow({ where: { id: ticket.fileObjectId }, select: { status: true } })).status).toBe("DELETED");
    expect(await storage.getObject(placeholderKey)).toBeNull();
    // Someone replays the URL with other bytes of the same length: the record is untouched.
    await putBytes(ticket.uploadUrl, ticket.headers, pdf("the forgery, as hoped!!"));
    expect(sha((await storage.getObject(file.r2Key))!)).toBe(sha(bytes));
  });

  it("refuses what is not a PDF, too big, not the bytes announced, or another member's upload — and leaves no contract", async () => {
    const ctx = manager();
    const intent = (over: Record<string, unknown>) => ({ clientId: acme, fileName: "a.pdf", contentType: "application/pdf", sizeBytes: 100, sha256: "a".repeat(64), ...over });
    expect(await outcome(presignContractUpload(ctx, intent({ fileName: "a.docx", contentType: "" })))).toBe("CONTRACT_UPLOAD_INVALID");
    expect(await outcome(presignContractUpload(ctx, intent({ fileName: "a.png", contentType: "image/png" })))).toBe("CONTRACT_UPLOAD_INVALID");
    expect(await outcome(presignContractUpload(ctx, intent({ sizeBytes: CONTRACT_UPLOAD_MAX_BYTES + 1 })))).toBe("CONTRACT_UPLOAD_INVALID");
    expect(await outcome(presignContractUpload(ctxOf(f.seats.employee.memberId), intent({})))).toBe("FORBIDDEN");

    const before = await f.platform.contract.count({ where: { tenantId: f.tenantId } });
    // Named .pdf, but not a PDF's bytes.
    const notPdf = new Uint8Array(Buffer.from("PK\u0003\u0004 a zip pretending", "latin1"));
    expect(await outcome(putIn(notPdf))).toBe("CONTRACT_UPLOAD_INVALID");
    // A PDF, but not the one announced (same length, another fingerprint).
    const real = pdf("the real one");
    expect(await outcome(putIn(real, { announced: sha(pdf("the othr one")) }))).toBe("CONTRACT_UPLOAD_INVALID");
    expect(await f.platform.contract.count({ where: { tenantId: f.tenantId } })).toBe(before);
    // Each refused placeholder is DELETED, never left PENDING.
    expect(await f.platform.fileObject.count({ where: { tenantId: f.tenantId, status: "PENDING" } })).toBe(0);

    // Another member's placeholder is not this member's to commit.
    const bytes = pdf("presigned by the manager");
    const ticket = await presignContractUpload(ctx, { clientId: acme, fileName: "x.pdf", contentType: "application/pdf", sizeBytes: bytes.byteLength, sha256: sha(bytes) });
    await putBytes(ticket.uploadUrl, ticket.headers, bytes);
    expect(
      await outcome(commitContractUpload(ctxOf(f.seats.owner.memberId), { fileObjectId: ticket.fileObjectId, clientId: acme, title: "X", signedOn: "2024-01-01" })),
    ).toBe("NOT_FOUND");
    // A signing day still to come is refused before the bytes are even read.
    expect(await outcome(commitContractUpload(ctx, { fileObjectId: ticket.fileObjectId, clientId: acme, title: "X", signedOn: "2099-01-01" }))).toBe("INVALID_INPUT");
    // …and a commit without the day it was signed is refused before anything.
    expect(await outcome(commitContractUpload(ctx, { fileObjectId: ticket.fileObjectId, clientId: acme, title: "X", signedOn: "" }))).toBe("INVALID_INPUT");
    // Committed once, a second commit finds nothing to take.
    await commitContractUpload(ctx, { fileObjectId: ticket.fileObjectId, clientId: acme, title: "X", signedOn: "2024-01-01" });
    expect(await outcome(commitContractUpload(ctx, { fileObjectId: ticket.fileObjectId, clientId: acme, title: "X", signedOn: "2024-01-01" }))).toBe("NOT_FOUND");
  });
});

describe("the database's guard", () => {
  /** A committed contract PDF row of the manager's own, for direct inserts. */
  const contractFile = async (memberId = f.seats.manager.memberId, kind: "CONTRACT_PDF" | "GENERAL" = "CONTRACT_PDF") => {
    const id = randomUUID();
    await f.platform.fileObject.create({
      data: {
        id,
        tenantId: f.tenantId,
        r2Key: `${f.tenantId}/${id}`,
        kind,
        sha256: "b".repeat(64),
        sizeBytes: 10n,
        contentType: "application/pdf",
        status: "COMMITTED",
        committedAt: new Date(),
        createdByMemberId: memberId,
      },
    });
    return id;
  };
  const insertUploaded = (memberId: string, fileId: string, over: Record<string, unknown> = {}) =>
    asMember(memberId, (tx) =>
      tx.contract.create({
        data: {
          id: randomUUID(),
          tenantId: f.tenantId,
          clientId: acme,
          title: "Direct",
          origin: "UPLOADED",
          status: "SIGNED",
          language: "sv",
          signedOn: new Date("2024-02-01T00:00:00Z"),
          signedPdfFileId: fileId,
          createdByMemberId: memberId,
          ...over,
        },
        select: { id: true },
      }),
    );

  it("an UPLOADED contract is born not shown, with its own committed contract PDF, recorded by the member putting it in", async () => {
    const m = f.seats.manager.memberId;
    expect(await said(insertUploaded(m, await contractFile(), { shownToClient: true }))).toBe("CONTRACT_GUARD");
    expect(await said(insertUploaded(m, await contractFile(m, "GENERAL")))).toBe("CONTRACT_GUARD");
    expect(await said(insertUploaded(m, await contractFile(f.seats.owner.memberId)))).toBe("CONTRACT_GUARD");
    expect(await said(insertUploaded(m, await contractFile(), { signedOn: new Date("2099-01-01T00:00:00Z") }))).toBe("CONTRACT_GUARD");
    // Another contract's file.
    const taken = await f.platform.contract.findFirstOrThrow({ where: { tenantId: f.tenantId, origin: "UPLOADED" }, select: { signedPdfFileId: true } });
    expect(await said(insertUploaded(m, taken.signedPdfFileId!))).toBe("CONTRACT_GUARD");
    // Nothing of a written contract's life (`contract_upload_bare`).
    expect(await said(insertUploaded(m, await contractFile(), { body: { type: "doc", content: [] } }))).toBe("CHECK");
    // Without `contract:create`.
    const e = f.seats.employee.memberId;
    expect(await said(insertUploaded(e, await contractFile(e)))).toBe("CONTRACT_GUARD");
  });

  it("its details by contract:edit, its showing by contract:send — one act at a time; its file and status never", async () => {
    const id = await putIn(pdf("for the edits"));
    const m = f.seats.manager.memberId;
    await updateUploadedContract(manager(), id, { title: "Support agreement (renewed)", signedOn: "2024-03-02", startsOn: "2024-03-01", endsOn: "2028-02-29" });
    expect((await f.platform.contract.findFirstOrThrow({ where: { id }, select: { title: true } })).title).toBe("Support agreement (renewed)");
    const edited = (await f.audits("contract.uploaded_edited")).filter((a) => a.targetId === id);
    expect(edited.map((a) => (a.metadata as { fields: string[] }).fields)).toEqual([["title", "signedOn", "endsOn"]]);
    expect(await outcome(updateUploadedContract(ctxOf(f.seats.employee.memberId), id, { title: "x", signedOn: "2024-03-02" }))).toBe("FORBIDDEN");

    await setUploadedContractShown(manager(), id, true);
    await setUploadedContractShown(manager(), id, true); // no change: no second row
    expect((await f.audits("contract.shown_changed")).filter((a) => a.targetId === id).map((a) => (a.metadata as { shown: boolean }).shown)).toEqual([true]);
    expect(await outcome(setUploadedContractShown(ctxOf(f.seats.employee.memberId), id, false))).toBe("FORBIDDEN");
    await setUploadedContractShown(manager(), id, false);

    // The database, directly: both acts at once, the file, the status.
    expect(await said(asMember(m, (tx) => tx.contract.updateMany({ where: { id }, data: { title: "Both", shownToClient: true } })))).toBe("CONTRACT_GUARD");
    const other = await contractFile();
    expect(await said(asMember(m, (tx) => tx.contract.updateMany({ where: { id }, data: { signedPdfFileId: other } })))).toBe("CONTRACT_GUARD");
    expect(await said(asMember(m, (tx) => tx.contract.updateMany({ where: { id }, data: { status: "WITHDRAWN", withdrawnAt: new Date(), withdrawnByMemberId: m } })))).not.toBe("ok");

    // A written contract is not one put in.
    const { id: draft } = await startContract(manager(), { clientId: acme, templateId: null, title: "Written", signerContactId: null });
    expect(await outcome(setUploadedContractShown(manager(), draft, true))).toBe("CONTRACT_NOT_UPLOADED");
  });
});

describe("what the client reads", () => {
  it("nothing while hidden; the row, its dates and its file once shown — and nothing of a written contract's life; nothing again once hidden", async () => {
    const id = await putIn(pdf("for the portal"), { title: "Hosting agreement" });
    expect((await listPortalContracts(principal(eva))).contracts.some((c) => c.id === id)).toBe(false);
    expect(await outcome(readPortalContract(principal(eva), id))).toBe("NOT_FOUND");
    expect(await outcome(resolvePortalContractPdf(principal(eva), id, "signed"))).toBe("NOT_FOUND");

    await setUploadedContractShown(manager(), id, true);
    const row = (await listPortalContracts(principal(eva))).contracts.find((c) => c.id === id);
    expect(row).toMatchObject({ title: "Hosting agreement", status: "SIGNED", origin: "UPLOADED", sentAt: null, signedOn: "2024-03-01", waitingForYou: false });
    const detail = await readPortalContract(principal(eva), id);
    expect(detail).toMatchObject({ origin: "UPLOADED", body: null, parties: null, contentSha256: null, signatures: [], signedCopyReady: true, pdfReady: false, canSign: false });
    const text = JSON.stringify(detail);
    expect(text).not.toMatch(/@/);
    for (const seat of Object.values(f.seats)) expect(text).not.toContain(seat.memberId);
    expect((await resolvePortalContractPdf(principal(eva), id, "signed")).url).toBeTruthy();
    expect(await outcome(resolvePortalContractPdf(principal(eva), id, "sent"))).toBe("NOT_FOUND");
    expect((await f.audits("contract.pdf_downloaded")).filter((a) => a.targetId === id).map((a) => [a.actorType, a.actorId])).toEqual([["CONTACT", eva]]);
    // Another client's person: nothing of it.
    expect(await outcome(readPortalContract(principal(bo, beta), id))).toBe("NOT_FOUND");

    await setUploadedContractShown(manager(), id, false);
    expect((await listPortalContracts(principal(eva))).contracts.some((c) => c.id === id)).toBe(false);
    expect(await outcome(readPortalContract(principal(eva), id))).toBe("NOT_FOUND");
  });
});

describe("deleting one put in wrong", () => {
  it("owners and managers only; the contract, its file's row and bytes go, and the storage count comes back", async () => {
    const bytes = pdf("put in wrong");
    const before = await storageUsed();
    const id = await putIn(bytes);
    await setUploadedContractShown(manager(), id, true);
    const { signedPdfFileId } = await f.platform.contract.findFirstOrThrow({ where: { id }, select: { signedPdfFileId: true } });
    const file = await f.platform.fileObject.findFirstOrThrow({ where: { id: signedPdfFileId! }, select: { r2Key: true } });

    expect(await outcome(deleteUploadedContract(ctxOf(f.seats.admin.memberId), id))).toBe("FORBIDDEN");
    expect(await outcome(deleteUploadedContract(ctxOf(f.seats.employee.memberId), id))).toBe("FORBIDDEN");
    await deleteUploadedContract(manager(), id);

    expect(await f.platform.contract.count({ where: { id } })).toBe(0);
    expect(await f.platform.fileObject.count({ where: { id: signedPdfFileId! } })).toBe(0);
    expect(await storage.getObject(file.r2Key)).toBeNull();
    expect(await storageUsed()).toBe(before);
    const audit = (await f.audits("contract.uploaded_deleted")).filter((a) => a.targetId === id);
    expect(audit.map((a) => (a.metadata as { wasShown: boolean; fileObjectId: string }))).toEqual([{ clientId: acme, fileObjectId: signedPdfFileId, wasShown: true }]);
  });
});

import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/* eslint-disable no-restricted-imports -- dbtest setup/cleanup uses the raw layer */
import { getPlatformClient, runtimeClient } from "@/db/client";
import { withTenant } from "@/db";
import { AuthzError } from "@/authz/errors";
import { provisionTenant } from "@/members/provisioning";
import { expirePendingUploads } from "@/jobs/expire-pending-uploads";
import { LocalDiskTransport, setStorage } from "@/storage";

import { UploadRejectedError } from "./allowlist";
import {
  addVersion,
  changeVisibility,
  commitUpload,
  createUpload,
  DocumentError,
  getDownloadUrl,
  listDocuments,
  resolveDownload,
  softDeleteDocument,
  type DocumentCtx,
} from "./service";

/**
 * Documents service against the real DB as app_runtime (RLS live) with
 * the local-disk transport in a temp dir. Covers: allowlist, quota,
 * presign→PUT→commit, size mismatch → DELETED, storageUsedBytes,
 * versions, CLIENT_VISIBLE-needs-client, download + audit, and the
 * file-visibility family (contact principal sees no INTERNAL rows).
 */

const run = randomUUID().slice(0, 8);
const owner = { id: randomUUID(), email: `docs-${run}@test.invalid` };
let tenantId: string;
let ctx: DocumentCtx;
let storage: LocalDiskTransport;
const storageDir = mkdtempSync(join(tmpdir(), "fortleva-docs-"));

const platform = () => getPlatformClient();

const sha = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");

/** Perform the browser's half: PUT the bytes to the presigned URL. */
const putBytes = async (uploadUrl: string, headers: Record<string, string>, body: Uint8Array) => {
  const key = new URL(uploadUrl).pathname
    .replace(/^\/api\/dev-storage\//, "")
    .split("/")
    .map(decodeURIComponent)
    .join("/");
  const res = await storage.handlePut(new Request(uploadUrl, { method: "PUT", headers, body: Buffer.from(body) }), key);
  expect(res.status).toBe(200);
};

const storageUsed = async (): Promise<bigint> =>
  (await platform().tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { storageUsedBytes: true } }))
    .storageUsedBytes;

const auditActions = async (targetId: string): Promise<string[]> =>
  (
    await platform().auditEvent.findMany({
      where: { tenantId, targetId },
      orderBy: { createdAt: "asc" },
      select: { action: true },
    })
  ).map((e) => e.action);

beforeAll(async () => {
  storage = new LocalDiskTransport(storageDir);
  setStorage(storage);
  await platform().user.create({ data: { id: owner.id, name: owner.email, email: owner.email } });
  const result = await provisionTenant({
    name: `Docs ${run}`,
    slug: `docs-${run}`,
    ownerUserId: owner.id,
  });
  tenantId = result.tenantId;
  ctx = { tenantId, actor: { memberId: result.ownerMemberId } };
});

afterAll(async () => {
  const p = platform();
  await p.fileVersion.deleteMany({ where: { tenantId } });
  await p.document.deleteMany({ where: { tenantId } });
  await p.fileObject.deleteMany({ where: { tenantId } });
  await p.memberRole.deleteMany({ where: { tenantId } });
  await p.rolePermission.deleteMany({ where: { tenantId } });
  await p.role.deleteMany({ where: { tenantId } });
  await p.member.deleteMany({ where: { tenantId } });
  await p.tenant.delete({ where: { id: tenantId } });
  await p.user.deleteMany({ where: { id: owner.id } });
  await p.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.audit_maintenance', 'on', true)`;
    await tx.auditEvent.deleteMany({ where: { tenantId } });
  });
  await p.$disconnect();
  await runtimeClient.$disconnect();
  setStorage(null);
  rmSync(storageDir, { recursive: true, force: true });
});

describe("presign gates", () => {
  it("rejects disallowed types server-side before any row is written", async () => {
    await expect(
      createUpload(ctx, { name: "evil.html", contentType: "text/html", sizeBytes: 10, sha256: sha("x") }),
    ).rejects.toBeInstanceOf(UploadRejectedError);
    await expect(
      createUpload(ctx, { name: "logo.svg", contentType: "image/svg+xml", sizeBytes: 10, sha256: sha("x") }),
    ).rejects.toBeInstanceOf(UploadRejectedError);
    expect(await platform().fileObject.count({ where: { tenantId } })).toBe(0);
  });

  it("blocks presign when the upload would exceed maxStorageBytes (NOT_ENTITLED)", async () => {
    await platform().tenant.update({
      where: { id: tenantId },
      data: { entitlements: { limits: { maxStorageBytes: 100 } } },
    });
    try {
      await expect(
        createUpload(ctx, { name: "big.txt", contentType: "text/plain", sizeBytes: 101, sha256: sha("x") }),
      ).rejects.toMatchObject({ reason: "NOT_ENTITLED" });
      // Under the limit: allowed, and the PENDING reservation now counts.
      const ok = await createUpload(ctx, {
        name: "small.txt",
        contentType: "text/plain",
        sizeBytes: 60,
        sha256: sha("x"),
      });
      expect(ok.fileObjectId).toMatch(/^[0-9a-f-]{36}$/);
      await expect(
        createUpload(ctx, { name: "second.txt", contentType: "text/plain", sizeBytes: 60, sha256: sha("x") }),
      ).rejects.toMatchObject({ reason: "NOT_ENTITLED" });
      // Release the reservation so later tests are unaffected.
      await platform().fileObject.update({ where: { id: ok.fileObjectId }, data: { status: "DELETED" } });
    } finally {
      await platform().tenant.update({ where: { id: tenantId }, data: { entitlements: {} } });
    }
  });

  it("CLIENT_VISIBLE without a client is refused at presign", async () => {
    await expect(
      createUpload(ctx, {
        name: "shared.pdf",
        contentType: "application/pdf",
        sizeBytes: 10,
        sha256: sha("x"),
        visibility: "CLIENT_VISIBLE",
      }),
    ).rejects.toMatchObject({ code: "CLIENT_REQUIRED" });
  });
});

describe("presign → PUT → commit", () => {
  const body = new TextEncoder().encode("first version\n");
  let documentId: string;
  let fileObjectId: string;

  it("creates PENDING, then COMMITTED + Document + FileVersion 1 with quota metered", async () => {
    const before = await storageUsed();
    const presign = await createUpload(ctx, {
      name: "report.txt",
      contentType: "text/plain",
      sizeBytes: body.byteLength,
      sha256: sha(body),
    });
    fileObjectId = presign.fileObjectId;
    const pending = await platform().fileObject.findUniqueOrThrow({ where: { id: fileObjectId } });
    expect(pending.status).toBe("PENDING");
    expect(pending.r2Key).toBe(`${tenantId}/${fileObjectId}`);
    expect(pending.contentType).toBe("text/plain");

    // Commit before the bytes exist → UPLOAD_MISSING is NOT the path here:
    // we upload first, like the browser does.
    await putBytes(presign.uploadUrl, { ...presign.headers }, body);
    ({ documentId } = await commitUpload(ctx, { fileObjectId }));

    const committed = await platform().fileObject.findUniqueOrThrow({ where: { id: fileObjectId } });
    expect(committed.status).toBe("COMMITTED");
    expect(committed.committedAt).not.toBeNull();
    expect((await storageUsed()) - before).toBe(BigInt(body.byteLength));

    const doc = await platform().document.findUniqueOrThrow({
      where: { id: documentId },
      include: { versions: true },
    });
    expect(doc.name).toBe("report.txt");
    expect(doc.visibility).toBe("INTERNAL"); // the default, everywhere
    expect(doc.clientId).toBeNull();
    expect(doc.versions.map((v) => v.versionNumber)).toEqual([1]);
    expect(doc.versions[0]!.fileObjectId).toBe(fileObjectId);

    expect(await auditActions(fileObjectId)).toEqual(["file.uploaded"]);
    expect(await auditActions(documentId)).toEqual(["document.created"]);
  });

  it("commit is not repeatable (NOT_PENDING)", async () => {
    await expect(commitUpload(ctx, { fileObjectId })).rejects.toMatchObject({ code: "NOT_PENDING" });
  });

  it("addVersion appends version 2 and lists versionCount 2", async () => {
    const v2 = new TextEncoder().encode("second version, longer\n");
    const presign = await createUpload(ctx, {
      name: "report.txt",
      contentType: "text/plain",
      sizeBytes: v2.byteLength,
      sha256: sha(v2),
    });
    await putBytes(presign.uploadUrl, { ...presign.headers }, v2);
    const { versionNumber } = await addVersion(ctx, {
      documentId,
      fileObjectId: presign.fileObjectId,
      note: "revised",
    });
    expect(versionNumber).toBe(2);
    const list = await listDocuments(ctx);
    const item = list.find((d) => d.id === documentId)!;
    expect(item.versionCount).toBe(2);
    expect(item.latestVersion).toBe(2);
    expect(item.sizeBytes).toBe(v2.byteLength);
  });

  it("size mismatch at commit → object DELETED, quota untouched, error surfaced", async () => {
    const before = await storageUsed();
    const presign = await createUpload(ctx, {
      name: "lie.txt",
      contentType: "text/plain",
      sizeBytes: 100,
      sha256: sha("lie"),
    });
    // Bypass the signed PUT (which would refuse) and plant 5 bytes directly.
    const path = storage.pathFor(`${tenantId}/${presign.fileObjectId}`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "12345");
    await expect(commitUpload(ctx, { fileObjectId: presign.fileObjectId })).rejects.toMatchObject({
      code: "UPLOAD_SIZE_MISMATCH",
    });
    const obj = await platform().fileObject.findUniqueOrThrow({ where: { id: presign.fileObjectId } });
    expect(obj.status).toBe("DELETED");
    expect(await storageUsed()).toBe(before);
    expect(await storage.head(`${tenantId}/${presign.fileObjectId}`)).toBeNull();
    expect(await platform().document.count({ where: { tenantId, name: "lie.txt" } })).toBe(0);
  });

  it("missing bytes at commit → UPLOAD_MISSING and DELETED", async () => {
    const presign = await createUpload(ctx, {
      name: "ghost.txt",
      contentType: "text/plain",
      sizeBytes: 3,
      sha256: sha("abc"),
    });
    await expect(commitUpload(ctx, { fileObjectId: presign.fileObjectId })).rejects.toBeInstanceOf(
      DocumentError,
    );
    const obj = await platform().fileObject.findUniqueOrThrow({ where: { id: presign.fileObjectId } });
    expect(obj.status).toBe("DELETED");
  });

  it("getDownloadUrl → presigned attachment URL that serves the latest version + file.downloaded audit", async () => {
    const { url, filename } = await getDownloadUrl(ctx, documentId);
    expect(filename).toBe("report.txt");
    const u = new URL(url);
    expect(u.searchParams.get("response-content-disposition")).toMatch(/^attachment; filename="report\.txt"/);
    const key = u.pathname.replace(/^\/api\/dev-storage\//, "").split("/").map(decodeURIComponent).join("/");
    const res = await storage.handleGet(new Request(url), key);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("second version, longer\n");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(await auditActions(documentId)).toContain("file.downloaded");
  });

  it("changeVisibility to CLIENT_VISIBLE is refused without a client (schema CHECK's twin)", async () => {
    await expect(changeVisibility(ctx, documentId, "CLIENT_VISIBLE")).rejects.toMatchObject({
      code: "CLIENT_REQUIRED",
    });
    const doc = await platform().document.findUniqueOrThrow({ where: { id: documentId } });
    expect(doc.visibility).toBe("INTERNAL");
    expect(await auditActions(documentId)).not.toContain("document.visibility_changed");
  });

  it("changeVisibility INTERNAL → INTERNAL is a no-op without an audit row", async () => {
    await changeVisibility(ctx, documentId, "INTERNAL");
    expect(await auditActions(documentId)).not.toContain("document.visibility_changed");
  });

  describe("file-visibility family: contact principal", () => {
    const contact = { type: "contact", id: randomUUID(), clientId: randomUUID() } as const;

    it("sees zero INTERNAL documents (portal_gate)", async () => {
      const count = await withTenant(tenantId, contact, (tx) => tx.document.count());
      expect(count).toBe(0);
      const rows = await withTenant(tenantId, contact, (tx) =>
        tx.document.findMany({ where: { id: documentId } }),
      );
      expect(rows).toEqual([]);
    });

    it("download resolution of an INTERNAL document is NOT_FOUND — existence never leaks", async () => {
      await expect(
        withTenant(tenantId, contact, (tx) => resolveDownload(tx, documentId)),
      ).rejects.toMatchObject({ reason: "NOT_FOUND" });
      // and no download audit row was written by that attempt
      const downloads = await platform().auditEvent.count({
        where: { tenantId, targetId: documentId, action: "file.downloaded", actorType: "CONTACT" },
      });
      expect(downloads).toBe(0);
    });

    it("the member path still resolves the same document (control)", async () => {
      const target = await withTenant(tenantId, { type: "member", id: ctx.actor.memberId }, (tx) =>
        resolveDownload(tx, documentId),
      );
      expect(target.versionNumber).toBe(2);
    });
  });

  it("softDelete hides the document from the list and download, audited", async () => {
    await softDeleteDocument(ctx, documentId);
    expect((await listDocuments(ctx)).some((d) => d.id === documentId)).toBe(false);
    await expect(getDownloadUrl(ctx, documentId)).rejects.toMatchObject({ reason: "NOT_FOUND" });
    expect(await auditActions(documentId)).toContain("document.deleted");
    // soft: rows remain
    expect(await platform().document.count({ where: { id: documentId } })).toBe(1);
  });
});

describe("authorization", () => {
  it("an actor without membership is FORBIDDEN before any storage work", async () => {
    const stranger: DocumentCtx = { tenantId, actor: { memberId: randomUUID() } };
    await expect(
      createUpload(stranger, { name: "a.txt", contentType: "text/plain", sizeBytes: 1, sha256: sha("a") }),
    ).rejects.toBeInstanceOf(AuthzError);
    await expect(listDocuments(stranger)).rejects.toMatchObject({ reason: "FORBIDDEN" });
  });
});

describe("reconciliation: expirePendingUploads", () => {
  it("marks stale PENDING objects DELETED and leaves fresh ones alone", async () => {
    const stale = await createUpload(ctx, {
      name: "stale.txt",
      contentType: "text/plain",
      sizeBytes: 5,
      sha256: sha("stale"),
    });
    const fresh = await createUpload(ctx, {
      name: "fresh.txt",
      contentType: "text/plain",
      sizeBytes: 5,
      sha256: sha("fresh"),
    });
    await platform().fileObject.update({
      where: { id: stale.fileObjectId },
      data: { createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000) },
    });
    const { expired } = await expirePendingUploads(60);
    expect(expired).toBeGreaterThanOrEqual(1);
    const [s, f] = await Promise.all([
      platform().fileObject.findUniqueOrThrow({ where: { id: stale.fileObjectId } }),
      platform().fileObject.findUniqueOrThrow({ where: { id: fresh.fileObjectId } }),
    ]);
    expect(s.status).toBe("DELETED");
    expect(f.status).toBe("PENDING");
  });
});

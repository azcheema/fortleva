import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/* eslint-disable no-restricted-imports -- dbtest setup/cleanup uses the raw layer */
import { getPlatformClient, runtimeClient } from "@/db/client";
import { withTenant } from "@/db";
import { AuthzError } from "@/authz/errors";
import { createClient } from "@/clients/service";
import { provisionTenant } from "@/members/provisioning";
import { changeItemVisibility, createItem, deleteItem, listItems } from "@/modules/work";
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
  // beforeAll threw before tenantId was assigned (e.g. an unseeded
  // catalog): there is nothing tenant-scoped to clean, and running the
  // deletes would hand Prisma undefined filters it silently DROPS —
  // the 2026-08-31 dev-DB wipe. The platform client's undefined-where
  // guard is the belt; this is the per-hook belt.
  if (tenantId === undefined) return;
  const p = platform();
  // search_index by tenant first (no FK — nothing below reaches a row
  // whose source is gone), then comments: a soft-deleted comment is
  // still a row, and comment.tenant_id RESTRICTs the tenant delete.
  // Mentions cascade from comments.
  await p.$executeRaw`DELETE FROM search_index WHERE tenant_id = ${tenantId}`;
  await p.comment.deleteMany({ where: { tenantId } });
  await p.fileVersion.deleteMany({ where: { tenantId } });
  await p.document.deleteMany({ where: { tenantId } });
  await p.fileObject.deleteMany({ where: { tenantId } });
  await p.memberClient.deleteMany({ where: { tenantId } });
  await p.client.deleteMany({ where: { tenantId } });
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

  it("softDelete hides the document from the list and download, audited — and takes a comment on its version with it", async () => {
    // Order-coupling guard: an undefined documentId would make Prisma
    // drop the filter below and pick SOME version.
    expect(documentId).toBeDefined();
    const version = await platform().fileVersion.findFirstOrThrow({
      where: { tenantId, documentId },
      orderBy: { versionNumber: "desc" },
    });
    expect(version.documentId).toBe(documentId);
    // A comment on a FILE_VERSION of a tenant-internal document: the
    // denorm guard copies NULL client/project from the document.
    const onVersion = await platform().comment.create({
      data: {
        tenantId,
        subjectType: "FILE_VERSION",
        subjectId: version.id,
        authorMemberId: ctx.actor.memberId,
        body: {},
        bodyText: "a note on version two",
      },
      select: { id: true },
    });

    await softDeleteDocument(ctx, documentId);
    expect((await listDocuments(ctx)).some((d) => d.id === documentId)).toBe(false);
    await expect(getDownloadUrl(ctx, documentId)).rejects.toMatchObject({ reason: "NOT_FOUND" });
    expect(await auditActions(documentId)).toContain("document.deleted");
    // soft: rows remain
    const row = await platform().document.findUniqueOrThrow({ where: { id: documentId } });
    expect(row.deletedAt).not.toBeNull();

    // The version's comment went with the document, on the SAME stamp,
    // audited with the reason and the document's id — nothing else.
    const comment = await platform().comment.findUniqueOrThrow({ where: { id: onVersion.id } });
    expect(comment.deletedAt).toEqual(row.deletedAt);
    const audit = await platform().auditEvent.findFirst({
      where: { tenantId, targetId: onVersion.id, action: "comment.deleted" },
    });
    expect(audit?.targetType).toBe("Comment");
    expect(audit?.metadata).toEqual({ reason: "document_deleted", documentId });
  });
});

describe("the visibility lever on a client document (both directions persist)", () => {
  /**
   * The browser harness caught a client-side revert here (the control
   * showed the old value while the row held the new one), so the
   * service-level half is pinned too: each flip is stored, audited with
   * from/to, and the next read returns the value that was written —
   * never the previous one.
   */
  const body = new TextEncoder().encode("client-facing offer");
  let documentId: string;

  it("CLIENT_VISIBLE ⇄ INTERNAL is stored and audited, in both directions", async () => {
    const { id: clientId } = await createClient(ctx, { name: "Visibility Co" });
    const presign = await createUpload(ctx, {
      name: "offer.txt",
      contentType: "text/plain",
      sizeBytes: body.byteLength,
      sha256: sha(body),
      clientId,
      visibility: "CLIENT_VISIBLE",
    });
    await putBytes(presign.uploadUrl, { ...presign.headers }, body);
    ({ documentId } = await commitUpload(ctx, {
      fileObjectId: presign.fileObjectId,
      clientId,
      visibility: "CLIENT_VISIBLE",
    }));

    const stored = async () =>
      (await platform().document.findUniqueOrThrow({ where: { id: documentId } })).visibility;
    const listed = async () => (await listDocuments(ctx)).find((d) => d.id === documentId)!.visibility;

    expect(await stored()).toBe("CLIENT_VISIBLE");

    await changeVisibility(ctx, documentId, "INTERNAL");
    expect(await stored()).toBe("INTERNAL");
    expect(await listed()).toBe("INTERNAL");

    await changeVisibility(ctx, documentId, "CLIENT_VISIBLE");
    expect(await stored()).toBe("CLIENT_VISIBLE");
    expect(await listed()).toBe("CLIENT_VISIBLE");

    const changes = await platform().auditEvent.findMany({
      where: { tenantId, targetId: documentId, action: "document.visibility_changed" },
      orderBy: { createdAt: "asc" },
      select: { metadata: true },
    });
    expect(changes.map((e) => e.metadata)).toEqual([
      { from: "CLIENT_VISIBLE", to: "INTERNAL" },
      { from: "INTERNAL", to: "CLIENT_VISIBLE" },
    ]);
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

describe("work-item attachments (2W-A ship gates)", () => {
  const att = { clientId: randomUUID(), projectId: randomUUID(), contactId: randomUUID() };
  let internalItemId: string;
  let visibleItemId: string;

  const uploadAttached = async (name: string, itemId: string, visibility?: "INTERNAL" | "CLIENT_VISIBLE") => {
    const body = new TextEncoder().encode(`attach ${name}\n`);
    const presign = await createUpload(ctx, {
      name,
      contentType: "text/plain",
      sizeBytes: body.byteLength,
      sha256: sha(body),
      visibility,
      attachedToType: "WORK_ITEM",
      attachedToId: itemId,
    });
    await putBytes(presign.uploadUrl, { ...presign.headers }, body);
    const { documentId } = await commitUpload(ctx, {
      fileObjectId: presign.fileObjectId,
      visibility,
      attachedToType: "WORK_ITEM",
      attachedToId: itemId,
    });
    return documentId;
  };

  beforeAll(async () => {
    const p = platform();
    await p.client.create({ data: { id: att.clientId, tenantId, name: "Attach client" } });
    await p.project.create({
      data: {
        id: att.projectId,
        tenantId,
        clientId: att.clientId,
        key: "ATT",
        name: "Attachment project",
        portalEnabled: true,
      },
    });
    await p.contact.create({
      data: {
        id: att.contactId,
        tenantId,
        clientId: att.clientId,
        name: "Attach Carol",
        email: `attach-${run}@test.invalid`,
      },
    });
    internalItemId = (await createItem(ctx, { projectId: att.projectId, title: "Internal feature" })).id;
    visibleItemId = (await createItem(ctx, { projectId: att.projectId, title: "Visible feature" })).id;
    await changeItemVisibility(ctx, visibleItemId, "CLIENT_VISIBLE");
  }, 60_000);

  afterAll(async () => {
    const p = platform();
    // FIRST, and by tenant: this block inserts a search_index row whose
    // entity_id matches no document, so no feed trigger can ever remove
    // it — deleting the source rows below cleans up everything EXCEPT
    // that one, and search_index has no FK to tenant either, so the
    // tenant teardown would leave it behind unattributable. Same class
    // as the orphaned dbtest tenants swept in a73cd12.
    // `e2e/fixtures/seed-cli.ts` does exactly this for the same reason.
    await p.$executeRaw`DELETE FROM search_index WHERE tenant_id = ${tenantId}`;
    // Comments RESTRICT both the project and the client; the cascade
    // only soft-deletes them, so the rows are still here.
    await p.comment.deleteMany({ where: { tenantId } });
    await p.fileVersion.deleteMany({ where: { tenantId } });
    await p.document.deleteMany({ where: { tenantId } });
    await p.fileObject.deleteMany({ where: { tenantId } });
    await p.workItemActivity.deleteMany({ where: { tenantId } });
    await p.workItem.deleteMany({ where: { tenantId } });
    await p.workflowState.deleteMany({ where: { tenantId } });
    await p.contact.deleteMany({ where: { tenantId } });
    await p.project.deleteMany({ where: { tenantId } });
    await p.tenantCounter.deleteMany({ where: { tenantId } });
  }, 60_000);

  it("an anchored upload derives client + project from the item, records the anchor, and the paperclip counts it", async () => {
    const documentId = await uploadAttached("spec.txt", internalItemId);
    const doc = await platform().document.findUniqueOrThrow({ where: { id: documentId } });
    expect(doc.clientId).toBe(att.clientId);
    expect(doc.projectId).toBe(att.projectId);
    expect(doc.attachedToType).toBe("WORK_ITEM");
    expect(doc.attachedToId).toBe(internalItemId);
    // Visibility inherited from the INTERNAL parent (no explicit choice).
    expect(doc.visibility).toBe("INTERNAL");
    const audit = await platform().auditEvent.findFirst({
      where: { tenantId, targetId: documentId, action: "document.created" },
    });
    expect(audit?.metadata).toMatchObject({ attachedToType: "WORK_ITEM", attachedToId: internalItemId });
    const list = await listDocuments(ctx, { attachedToWorkItemId: internalItemId });
    expect(list.map((d) => d.id)).toContain(documentId);
    const items = await listItems(ctx, att.projectId);
    expect(items.items.find((i) => i.id === internalItemId)?.attachmentCount).toBe(1);
  });

  let inheritedVisibleId: string;
  it("visibility inherits CLIENT_VISIBLE from a visible parent", async () => {
    inheritedVisibleId = await uploadAttached("delivered.txt", visibleItemId);
    const doc = await platform().document.findUniqueOrThrow({ where: { id: inheritedVisibleId } });
    expect(doc.visibility).toBe("CLIENT_VISIBLE");
  });

  it("a CLIENT_VISIBLE attachment on an INTERNAL item is refused at the seam AND by the trigger", async () => {
    // Service seam: presign refuses before any row.
    await expect(
      createUpload(ctx, {
        name: "leak.txt",
        contentType: "text/plain",
        sizeBytes: 5,
        sha256: sha("leak"),
        visibility: "CLIENT_VISIBLE",
        attachedToType: "WORK_ITEM",
        attachedToId: internalItemId,
      }),
    ).rejects.toMatchObject({ code: "ANCHOR_INTERNAL" });
    // Raw write past the service: the DB refuses (the belt).
    await expect(
      platform().document.create({
        data: {
          id: randomUUID(),
          tenantId,
          clientId: att.clientId,
          projectId: att.projectId,
          name: "raw-leak.txt",
          visibility: "CLIENT_VISIBLE",
          attachedToType: "WORK_ITEM",
          attachedToId: internalItemId,
        },
      }),
    ).rejects.toThrow(/cannot be CLIENT_VISIBLE on an item/);
    // And mismatched authorization columns are refused, never rewritten.
    await expect(
      platform().document.create({
        data: {
          id: randomUUID(),
          tenantId,
          clientId: att.clientId,
          projectId: null,
          name: "wrong-project.txt",
          visibility: "INTERNAL",
          attachedToType: "WORK_ITEM",
          attachedToId: internalItemId,
        },
      }),
    ).rejects.toThrow(/must carry its work item/);
  });

  it("a visible attachment blocks the item's downgrade until soft-deleted; an INTERNAL item locks its attachments", async () => {
    // Guard against the order-coupling failure mode: if the inherit test
    // did not run, softDeleteDocument(undefined) would silently soft-
    // delete an ARBITRARY document (Prisma drops undefined filters).
    expect(inheritedVisibleId).toBeDefined();
    const onVisible = await uploadAttached("to-flip.txt", visibleItemId, "CLIENT_VISIBLE");
    // The item cannot go INTERNAL while a visible attachment lives...
    await expect(changeItemVisibility(ctx, visibleItemId, "INTERNAL")).rejects.toThrow(
      /client-visible children exist/,
    );
    // ...soft-deleted attachments no longer block it (the deleted_at
    // fix) — the earlier test's inherited-visible attachment included.
    await softDeleteDocument(ctx, onVisible);
    await softDeleteDocument(ctx, inheritedVisibleId);
    await changeItemVisibility(ctx, visibleItemId, "INTERNAL");
    // ...and with the item INTERNAL, a surviving attachment cannot be
    // flipped visible either — the TYPED refusal at the seam (the raw
    // trigger belt is pinned by the raw-insert test above).
    const stillAttached = await uploadAttached("stays.txt", visibleItemId);
    await expect(changeVisibility(ctx, stillAttached, "CLIENT_VISIBLE")).rejects.toMatchObject({
      code: "ANCHOR_INTERNAL",
    });
    // Restore for the portal test below.
    await changeItemVisibility(ctx, visibleItemId, "CLIENT_VISIBLE");
  });

  it("A SOFT-DELETED DOCUMENT LEAVES THE SEARCH INDEX — and does not become the newest hit", async () => {
    // `search_feed_document` used to branch on `TG_OP = 'DELETE'` alone,
    // while the work_item and comment feeds branch on
    // `TG_OP = 'DELETE' OR NEW.deleted_at IS NOT NULL`. Documents are
    // ONLY ever soft-deleted (`softDeleteDocument` is the sole path), so
    // the delete arrived as an UPDATE, the trigger took the upsert path,
    // and the index row SURVIVED — with a refreshed `updated_at`, which
    // on a CLIENT_VISIBLE document inside `portal_gate` made a deleted
    // file the most recent thing a contact could find.
    //
    // Nothing queries search_index yet, so this was unreachable rather
    // than exploitable. It is asserted here because the row is wrong in
    // the database NOW, and the moment /search ships it is a leak.
    const name = `soft-deleted-${run}.txt`;
    const documentId = await uploadAttached(name, visibleItemId, "CLIENT_VISIBLE");

    // Counted under the platform client, deliberately: this asserts the
    // ROW's existence, not what any principal can see through the gate.
    // `count(*)::int` because an uncast count comes back a BigInt.
    const indexRows = async () => {
      const rows = await platform().$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM search_index
         WHERE tenant_id = ${tenantId} AND entity_type = 'DOCUMENT' AND entity_id = ${documentId}`;
      return rows[0]?.n ?? -1;
    };

    // It is indexed while it exists…
    expect(await indexRows()).toBe(1);

    await softDeleteDocument(ctx, documentId);

    // …and gone once it does not.
    expect(await indexRows()).toBe(0);
  });

  it("THE MIGRATION'S OWN SWEEP evicts the rows the old trigger left — run against real rows, not an empty table", async () => {
    // CI applies this migration to an EMPTY database, so both DELETEs
    // touch zero rows there and their correctness is otherwise never
    // exercised — the trap PLAN §0 already records for the seed_key
    // backfill. This runs the migration's ACTUAL statements, read out of
    // the .sql file so they cannot drift from what shipped, over the two
    // shapes of orphan the old trigger could leave.
    const sql = readFileSync(
      join(process.cwd(), "prisma/migrations/20260906150000_search_feed_soft_delete/migration.sql"),
      "utf8",
    );
    // Anchored on the `si` ALIAS, which appears only in the two DML
    // statements. The obvious `indexOf("DELETE FROM search_index")`
    // finds the TRIGGER BODY's delete first — a statement referencing
    // NEW/OLD, which outside a trigger raises "missing FROM-clause entry
    // for table new" — and splitting on ";" then drops both real sweeps,
    // because after trimming they begin with their comment blocks. A
    // test that ran the wrong statement would have proved nothing while
    // looking rigorous.
    const sweeps = sql
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part.includes("DELETE FROM search_index si"))
      .map((part) => `${part.slice(part.indexOf("DELETE FROM search_index si"))};`);
    expect(sweeps).toHaveLength(2);
    expect(sweeps[0]).toContain("deleted_at IS NOT NULL");
    expect(sweeps[1]).toContain("NOT EXISTS");
    // Neither may carry a trigger-only reference.
    for (const statement of sweeps) expect(statement).not.toMatch(/NEW\.|OLD\./);

    const p = platform();
    // Orphan A: a document that IS soft-deleted, with an index row —
    // exactly what the old trigger produced on every delete.
    const softDeletedName = `sweep-soft-${run}.txt`;
    const softDeletedId = await uploadAttached(softDeletedName, visibleItemId, "CLIENT_VISIBLE");
    await softDeleteDocument(ctx, softDeletedId);
    // Put the row back to recreate the pre-migration state this sweep
    // exists to clean up. ON CONFLICT DO NOTHING because whether it is
    // still there depends on which side of the trigger fix the database
    // is on — with the fix it was just removed, without it the old
    // trigger left it and the insert would collide. What this test
    // asserts is the SWEEP, so all it needs is that a row exists.
    await p.$executeRawUnsafe(
      `INSERT INTO search_index
         (id, tenant_id, entity_type, entity_id, client_id, project_id,
          visibility, portal_enabled, title, lang)
       VALUES ($1, $2, 'DOCUMENT', $3, $4, $5, 'CLIENT_VISIBLE', true, $6, 'public.fortleva_sv')
       ON CONFLICT (tenant_id, entity_type, entity_id) DO NOTHING`,
      randomUUID(),
      tenantId,
      softDeletedId,
      att.clientId,
      att.projectId,
      softDeletedName,
    );
    // Orphan B: an index row whose document does not exist at all — what
    // a hard-delete sweep would leave behind, since the table has no FK.
    const ghostId = randomUUID();
    await p.$executeRawUnsafe(
      `INSERT INTO search_index
         (id, tenant_id, entity_type, entity_id, client_id, project_id,
          visibility, portal_enabled, title, lang)
       VALUES ($1, $2, 'DOCUMENT', $3, $4, $5, 'CLIENT_VISIBLE', true, 'ghost', 'public.fortleva_sv')
       ON CONFLICT (tenant_id, entity_type, entity_id) DO NOTHING`,
      randomUUID(),
      tenantId,
      ghostId,
      att.clientId,
      att.projectId,
    );

    const rowsFor = async (entityId: string) => {
      const rows = await p.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM search_index
         WHERE tenant_id = ${tenantId} AND entity_type = 'DOCUMENT' AND entity_id = ${entityId}`;
      return rows[0]?.n ?? -1;
    };
    // A live document's row, which the sweep must NOT touch.
    const keptName = `sweep-kept-${run}.txt`;
    const keptId = await uploadAttached(keptName, visibleItemId, "CLIENT_VISIBLE");

    expect(await rowsFor(softDeletedId)).toBe(1);
    expect(await rowsFor(ghostId)).toBe(1);
    expect(await rowsFor(keptId)).toBe(1);

    // THE STATEMENTS ARE DELIBERATELY UNSCOPED — a migration has to be —
    // so the blast radius is pinned rather than assumed, which a DELETE
    // needs more than the seed_key backfill's UPDATE did. Every row of
    // every OTHER entity type, in every tenant, must come through
    // untouched: both predicates are pinned to entity_type = 'DOCUMENT',
    // and this is what proves it rather than reading it.
    //
    // Running them here does perform the migration's own cleanup early
    // on this database. That is harmless by construction: the only rows
    // either statement can remove are ones whose document is soft
    // deleted or absent, which is precisely the defect being repaired.
    const otherTypes = async () => {
      const rows = await p.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM search_index WHERE entity_type <> 'DOCUMENT'`;
      return rows[0]?.n ?? -1;
    };
    const othersBefore = await otherTypes();

    for (const statement of sweeps) await p.$executeRawUnsafe(statement);

    expect(await otherTypes()).toBe(othersBefore);

    expect(await rowsFor(softDeletedId)).toBe(0);
    expect(await rowsFor(ghostId)).toBe(0);
    // The live one survives — a sweep that took it would be worse than
    // the leak it fixes.
    expect(await rowsFor(keptId)).toBe(1);
  });

  it("the contact principal never sees an attachment on an INTERNAL item — and existence does not leak", async () => {
    const hidden = await uploadAttached("internal-only.txt", internalItemId);
    const shown = await uploadAttached("client-copy.txt", visibleItemId, "CLIENT_VISIBLE");
    const contactPrincipal = { type: "contact", id: att.contactId, clientId: att.clientId } as const;
    await withTenant(tenantId, contactPrincipal, async (tx) => {
      const visibleIds = (await tx.document.findMany({ select: { id: true } })).map((d) => d.id);
      expect(visibleIds).toContain(shown);
      expect(visibleIds).not.toContain(hidden);
      // BOTH downloads deny identically: the hidden one at the document
      // gate, the visible one at the class-A file layer (portal_deny —
      // a contact NEVER queries files directly; portal downloads are
      // brokered in Phase 3). Same error either way ⇒ no existence leak.
      await expect(resolveDownload(tx, hidden)).rejects.toMatchObject({ reason: "NOT_FOUND" });
      await expect(resolveDownload(tx, shown)).rejects.toMatchObject({ reason: "NOT_FOUND" });
    });
  });

  it("an anchor to a missing item is NOT_FOUND at presign — no PENDING row is written", async () => {
    const before = await platform().fileObject.count({ where: { tenantId, status: "PENDING" } });
    await expect(
      createUpload(ctx, {
        name: "orphan.txt",
        contentType: "text/plain",
        sizeBytes: 5,
        sha256: sha("o"),
        attachedToType: "WORK_ITEM",
        attachedToId: randomUUID(),
      }),
    ).rejects.toMatchObject({ reason: "NOT_FOUND" });
    expect(await platform().fileObject.count({ where: { tenantId, status: "PENDING" } })).toBe(before);
  });

  it("an explicit clientId/projectId disagreeing with the anchor is CLIENT_MISMATCH", async () => {
    await expect(
      createUpload(ctx, {
        name: "mismatch.txt",
        contentType: "text/plain",
        sizeBytes: 5,
        sha256: sha("m"),
        projectId: randomUUID(),
        attachedToType: "WORK_ITEM",
        attachedToId: internalItemId,
      }),
    ).rejects.toMatchObject({ code: "CLIENT_MISMATCH" });
  });

  it("flipping an anchored doc visible under an INTERNAL item is the typed ANCHOR_INTERNAL at the seam", async () => {
    const doc = await uploadAttached("seam-flip.txt", internalItemId);
    await expect(changeVisibility(ctx, doc, "CLIENT_VISIBLE")).rejects.toMatchObject({
      code: "ANCHOR_INTERNAL",
    });
  });

  it("deleting the item takes its attachments with it (DATA_MODEL §10 — life of the parent), audited — and every comment on the item, the attachment and its version", async () => {
    const { id: itemId } = await createItem(ctx, { projectId: att.projectId, title: "Doomed feature" });
    await changeItemVisibility(ctx, itemId, "CLIENT_VISIBLE");
    const doc = await uploadAttached("goes-with-it.txt", itemId, "CLIENT_VISIBLE");
    const version = await platform().fileVersion.findFirstOrThrow({ where: { tenantId, documentId: doc } });
    const comment = (
      subjectType: "WORK_ITEM" | "DOCUMENT" | "FILE_VERSION",
      subjectId: string,
      bodyText: string,
    ) =>
      platform().comment.create({
        data: { tenantId, subjectType, subjectId, authorMemberId: ctx.actor.memberId, body: {}, bodyText },
        select: { id: true },
      });
    const onItem = await comment("WORK_ITEM", itemId, "on the item");
    const onDoc = await comment("DOCUMENT", doc, "on the attachment");
    const onVersion = await comment("FILE_VERSION", version.id, "on the version");
    // The negative control: a comment on a LIVE item must be untouched,
    // or an over-broad cascade would pass every assertion below.
    const control = await comment("WORK_ITEM", visibleItemId, "on another item");

    await deleteItem(ctx, itemId);

    const row = await platform().document.findUniqueOrThrow({ where: { id: doc } });
    expect(row.deletedAt).not.toBeNull();
    const audit = await platform().auditEvent.findFirst({
      where: { tenantId, targetId: doc, action: "document.deleted" },
    });
    expect(audit?.metadata).toMatchObject({ reason: "work_item_deleted", workItemId: itemId });

    // All three comments carry the ONE stamp the cascade used; the
    // control is alive.
    const ids = [onItem.id, onDoc.id, onVersion.id, control.id];
    const stamps = new Map(
      (await platform().comment.findMany({ where: { id: { in: ids } }, select: { id: true, deletedAt: true } })).map(
        (c) => [c.id, c.deletedAt],
      ),
    );
    for (const id of [onItem.id, onDoc.id, onVersion.id]) expect(stamps.get(id)).toEqual(row.deletedAt);
    expect(stamps.get(control.id)).toBeNull();

    // One comment.deleted each, naming the reason and the subject —
    // and, for the attachment's comments, the item that started it.
    const metaOf = new Map(
      (
        await platform().auditEvent.findMany({
          where: { tenantId, action: "comment.deleted", targetId: { in: ids } },
          select: { targetId: true, metadata: true },
        })
      ).map((a) => [a.targetId, a.metadata]),
    );
    expect(metaOf.size).toBe(3);
    expect(metaOf.get(onItem.id)).toEqual({ reason: "work_item_deleted", workItemId: itemId });
    expect(metaOf.get(onDoc.id)).toEqual({ reason: "document_deleted", documentId: doc, workItemId: itemId });
    expect(metaOf.get(onVersion.id)).toEqual({ reason: "document_deleted", documentId: doc, workItemId: itemId });
  });

  it("a dangling anchor never blocks the restrict lever, and never permits the widen one (guard v2)", async () => {
    const { id: itemId } = await createItem(ctx, { projectId: att.projectId, title: "Swept feature" });
    await changeItemVisibility(ctx, itemId, "CLIENT_VISIBLE");
    const doc = await uploadAttached("orphaned.txt", itemId, "CLIENT_VISIBLE");
    // Simulate the maintenance state guard v2 exists for: the item soft-
    // deleted RAW (no service cascade — legacy/sweep shape).
    await platform().workItem.update({ where: { id: itemId }, data: { deletedAt: new Date() } });
    // The safety-positive flip works…
    await platform().document.update({ where: { id: doc }, data: { visibility: "INTERNAL" } });
    // …the widening one is still refused.
    await expect(
      platform().document.update({ where: { id: doc }, data: { visibility: "CLIENT_VISIBLE" } }),
    ).rejects.toThrow(/work item not found/);
  });
});

import { record } from "@/audit/record";
import { requireAccess, parseEntitlements } from "@/entitlements/resolver";
import type { MemberActor } from "@/authz/authorize";
import { deny } from "@/authz/errors";
import { withPlatform, withTenant, type TenantDb } from "@/db";
import { newId } from "@/lib/ids";
import { getStorage } from "@/storage";

import { validateUpload } from "./allowlist";

/**
 * Documents & files (DATA_MODEL.md §6.8, SECURITY.md §5). Three layers:
 * FileObject (immutable blob, quota unit) → FileVersion → Document
 * (visibility-carrying). Upload = presign (PENDING, quota reserved) →
 * browser PUTs to the bucket → commit (HEAD-verify, COMMITTED +
 * storageUsedBytes + Document/FileVersion in ONE transaction). The
 * portal_gate policy on document is the data-layer guard; this module
 * adds the permission gates and the audit trail.
 */

export type Visibility = "INTERNAL" | "CLIENT_VISIBLE";

export type DocumentCtx = {
  readonly tenantId: string;
  /** From requireTenantContext() — never from form params. */
  readonly actor: MemberActor;
};

export class DocumentError extends Error {
  constructor(
    readonly code:
      | "CLIENT_REQUIRED" // CLIENT_VISIBLE without a client — the schema CHECK's twin
      | "UPLOAD_MISSING" // commit: no bytes at the key
      | "UPLOAD_SIZE_MISMATCH" // commit: HEAD size ≠ presigned size
      | "NOT_PENDING", // commit: object already committed/deleted
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "DocumentError";
  }
}

const PUT_EXPIRES_SEC = 15 * 60;
const GET_EXPIRES_SEC = 60;

const memberPrincipal = (ctx: DocumentCtx) =>
  ({ type: "member", id: ctx.actor.memberId }) as const;

const storageKeyFor = (tenantId: string, fileObjectId: string): string =>
  `${tenantId}/${fileObjectId}`;

/** RFC 6266 attachment disposition with an ASCII fallback + UTF-8 name. */
export const attachmentDisposition = (filename: string): string => {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const utf8 = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
};

// ── Quota ────────────────────────────────────────────────────────────

/**
 * Creation-time storage limit (AUTHZ.md §5 read-only grandfathering):
 * COMMITTED bytes + PENDING reservations + this upload must fit under
 * entitlements.limits.maxStorageBytes. Unlimited (null) always passes.
 */
async function enforceStorageQuota(
  tx: TenantDb,
  tenantId: string,
  incomingBytes: number,
): Promise<void> {
  const tenant = await tx.tenant.findFirst({
    where: { id: tenantId },
    select: { entitlements: true, storageUsedBytes: true },
  });
  const max = parseEntitlements(tenant?.entitlements).limits.maxStorageBytes;
  if (max === null) return;
  const pending = await tx.fileObject.aggregate({
    where: { status: "PENDING" },
    _sum: { sizeBytes: true },
  });
  const used =
    Number(tenant?.storageUsedBytes ?? 0n) + Number(pending._sum.sizeBytes ?? 0n);
  if (used + incomingBytes > max) {
    deny("NOT_ENTITLED", `maxStorageBytes reached (${used + incomingBytes}/${max})`);
  }
}

// ── Upload: presign → commit ─────────────────────────────────────────

export type CreateUploadInput = {
  name: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  clientId?: string | null;
  projectId?: string | null;
  visibility?: Visibility;
};

export type CreateUploadResult = {
  fileObjectId: string;
  uploadUrl: string;
  headers: Readonly<Record<string, string>>;
  /** Canonical type the object was presigned with — send it verbatim. */
  contentType: string;
};

const assertVisibilityTarget = (
  visibility: Visibility,
  clientId: string | null | undefined,
): void => {
  if (visibility === "CLIENT_VISIBLE" && !clientId) {
    throw new DocumentError("CLIENT_REQUIRED", "a client-visible document needs a client");
  }
};

/**
 * Step 1: allowlist + quota + PENDING FileObject + presigned PUT.
 * The Document itself is NOT created yet — no row, no file (§5).
 */
export async function createUpload(
  ctx: DocumentCtx,
  input: CreateUploadInput,
): Promise<CreateUploadResult> {
  const { contentType } = validateUpload(input);
  assertVisibilityTarget(input.visibility ?? "INTERNAL", input.clientId);
  if (!/^[0-9a-f]{64}$/i.test(input.sha256)) {
    throw new Error("createUpload: sha256 must be 64 hex chars");
  }

  const fileObjectId = newId();
  const key = storageKeyFor(ctx.tenantId, fileObjectId);

  await withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "document:upload");
    await enforceStorageQuota(tx, ctx.tenantId, input.sizeBytes);
    await tx.fileObject.create({
      data: {
        id: fileObjectId,
        tenantId: ctx.tenantId,
        r2Key: key,
        sha256: input.sha256.toLowerCase(),
        sizeBytes: BigInt(input.sizeBytes),
        contentType,
        originalFilename: input.name.trim(),
        status: "PENDING",
        createdByMemberId: ctx.actor.memberId,
      },
    });
  });

  const presigned = await getStorage().presignPut(key, {
    contentType,
    contentLength: input.sizeBytes,
    expiresSec: PUT_EXPIRES_SEC,
  });
  return { fileObjectId, uploadUrl: presigned.url, headers: presigned.headers, contentType };
}

type CommittedObject = {
  id: string;
  sizeBytes: number;
  originalFilename: string | null;
  contentType: string;
};

/**
 * HEAD-verify then flip PENDING → COMMITTED inside `tx`, incrementing
 * Tenant.storageUsedBytes and recording file.uploaded. Size mismatch or
 * missing bytes ⇒ the object is marked DELETED (in its own tx) and the
 * error propagates — the presigned size is what quota was checked with.
 */
async function commitFileObject(
  ctx: DocumentCtx,
  fileObjectId: string,
  work: (tx: TenantDb, obj: CommittedObject) => Promise<void>,
): Promise<void> {
  const storage = getStorage();

  // Pass 1: authorize + find the pending object (permission before existence).
  const pending = await withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "document:upload");
    const obj = await tx.fileObject.findFirst({ where: { id: fileObjectId } });
    if (!obj) deny("NOT_FOUND");
    if (obj!.status !== "PENDING") throw new DocumentError("NOT_PENDING", obj!.status);
    return { key: obj!.r2Key, sizeBytes: Number(obj!.sizeBytes) };
  });

  // HEAD outside any transaction: network I/O never holds a tx open.
  const head = await storage.head(pending.key);
  const problem: DocumentError | null = !head
    ? new DocumentError("UPLOAD_MISSING", "no bytes at the presigned key")
    : head.sizeBytes !== pending.sizeBytes
      ? new DocumentError(
          "UPLOAD_SIZE_MISMATCH",
          `expected ${pending.sizeBytes}, found ${head.sizeBytes}`,
        )
      : null;

  if (problem) {
    await withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
      await tx.fileObject.updateMany({
        where: { id: fileObjectId, status: "PENDING" },
        data: { status: "DELETED" },
      });
    });
    // Best-effort blob cleanup; the DELETED row is the source of truth.
    await storage.delete(pending.key).catch(() => undefined);
    throw problem;
  }

  // Pass 2: commit + caller's rows + audit — ONE transaction.
  await withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "document:upload");
    const flipped = await tx.fileObject.updateMany({
      where: { id: fileObjectId, status: "PENDING" },
      data: { status: "COMMITTED", committedAt: new Date() },
    });
    if (flipped.count !== 1) throw new DocumentError("NOT_PENDING", "raced");
    const obj = await tx.fileObject.findFirstOrThrow({ where: { id: fileObjectId } });
    await tx.tenant.update({
      where: { id: ctx.tenantId },
      data: { storageUsedBytes: { increment: obj.sizeBytes } },
    });
    await record(tx, {
      action: "file.uploaded",
      targetType: "FileObject",
      targetId: obj.id,
      metadata: { sizeBytes: Number(obj.sizeBytes), contentType: obj.contentType },
    });
    await work(tx, {
      id: obj.id,
      sizeBytes: Number(obj.sizeBytes),
      originalFilename: obj.originalFilename,
      contentType: obj.contentType,
    });
  });
}

export type CommitUploadInput = {
  fileObjectId: string;
  /** Defaults to the original filename recorded at presign. */
  name?: string;
  clientId?: string | null;
  projectId?: string | null;
  /** INTERNAL is the default everywhere (§5); CLIENT_VISIBLE needs clientId. */
  visibility?: Visibility;
};

/** Step 2 (new document): COMMITTED + Document + FileVersion 1. */
export async function commitUpload(
  ctx: DocumentCtx,
  input: CommitUploadInput,
): Promise<{ documentId: string }> {
  const visibility = input.visibility ?? "INTERNAL";
  assertVisibilityTarget(visibility, input.clientId);
  const documentId = newId();

  await commitFileObject(ctx, input.fileObjectId, async (tx, obj) => {
    const name = (input.name ?? obj.originalFilename ?? "untitled").trim() || "untitled";
    await tx.document.create({
      data: {
        id: documentId,
        tenantId: ctx.tenantId,
        clientId: input.clientId ?? null,
        projectId: input.projectId ?? null,
        name,
        visibility,
        createdByMemberId: ctx.actor.memberId,
        versions: {
          create: {
            versionNumber: 1,
            fileObjectId: obj.id,
            uploadedByMemberId: ctx.actor.memberId,
          },
        },
      },
    });
    await record(tx, {
      action: "document.created",
      targetType: "Document",
      targetId: documentId,
      metadata: { name, visibility, fileObjectId: obj.id, clientId: input.clientId ?? null },
    });
  });

  return { documentId };
}

/** Step 2 (existing document): COMMITTED + FileVersion N+1. */
export async function addVersion(
  ctx: DocumentCtx,
  input: { documentId: string; fileObjectId: string; note?: string },
): Promise<{ versionNumber: number }> {
  let versionNumber = 0;
  await commitFileObject(ctx, input.fileObjectId, async (tx, obj) => {
    const doc = await tx.document.findFirst({
      where: { id: input.documentId, deletedAt: null },
      select: {
        id: true,
        versions: { orderBy: { versionNumber: "desc" }, take: 1, select: { versionNumber: true } },
      },
    });
    if (!doc) deny("NOT_FOUND");
    versionNumber = (doc!.versions[0]?.versionNumber ?? 0) + 1;
    await tx.fileVersion.create({
      data: {
        tenantId: ctx.tenantId,
        documentId: doc!.id,
        versionNumber,
        fileObjectId: obj.id,
        note: input.note?.trim() || null,
        uploadedByMemberId: ctx.actor.memberId,
      },
    });
    await tx.document.update({ where: { id: doc!.id }, data: { updatedAt: new Date() } });
  });
  return { versionNumber };
}

// ── Read side ────────────────────────────────────────────────────────

export type DocumentListItem = {
  id: string;
  name: string;
  visibility: Visibility;
  clientId: string | null;
  projectId: string | null;
  versionCount: number;
  latestVersion: number;
  sizeBytes: number;
  contentType: string;
  updatedAt: Date;
};

export async function listDocuments(ctx: DocumentCtx): Promise<DocumentListItem[]> {
  return withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "document:view");
    const rows = await tx.document.findMany({
      where: { deletedAt: null },
      orderBy: { updatedAt: "desc" },
      include: {
        _count: { select: { versions: true } },
        versions: {
          orderBy: { versionNumber: "desc" },
          take: 1,
          include: { fileObject: { select: { sizeBytes: true, contentType: true } } },
        },
      },
    });
    return rows.map((d) => {
      const latest = d.versions[0];
      return {
        id: d.id,
        name: d.name,
        visibility: d.visibility,
        clientId: d.clientId,
        projectId: d.projectId,
        versionCount: d._count.versions,
        latestVersion: latest?.versionNumber ?? 0,
        sizeBytes: Number(latest?.fileObject.sizeBytes ?? 0n),
        contentType: latest?.fileObject.contentType ?? "application/octet-stream",
        updatedAt: d.updatedAt,
      };
    });
  });
}

/**
 * Resolve the latest version of a document for download UNDER THE
 * CURRENT PRINCIPAL and record file.downloaded in the same tx. Runs on
 * whatever principal `tx` was opened with — for a contact the
 * portal_gate policy hides INTERNAL rows, so an INTERNAL document
 * resolves to NOT_FOUND (existence must not leak, AUTHZ.md §4).
 */
export async function resolveDownload(
  tx: TenantDb,
  documentId: string,
): Promise<{ key: string; filename: string; contentType: string; versionNumber: number }> {
  const doc = await tx.document.findFirst({
    where: { id: documentId, deletedAt: null },
    select: {
      id: true,
      name: true,
      versions: {
        orderBy: { versionNumber: "desc" },
        take: 1,
        select: {
          versionNumber: true,
          fileObject: { select: { r2Key: true, status: true, contentType: true } },
        },
      },
    },
  });
  const latest = doc?.versions[0];
  if (!doc || !latest || latest.fileObject.status !== "COMMITTED") deny("NOT_FOUND");
  await record(tx, {
    action: "file.downloaded",
    targetType: "Document",
    targetId: doc!.id,
    metadata: { versionNumber: latest!.versionNumber },
  });
  return {
    key: latest!.fileObject.r2Key,
    filename: doc!.name,
    contentType: latest!.fileObject.contentType,
    versionNumber: latest!.versionNumber,
  };
}

/** Short-lived, attachment-only, off-origin download link (§5). */
export async function getDownloadUrl(
  ctx: DocumentCtx,
  documentId: string,
): Promise<{ url: string; filename: string }> {
  const target = await withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "document:view");
    return resolveDownload(tx, documentId);
  });
  const url = await getStorage().presignGet(target.key, {
    expiresSec: GET_EXPIRES_SEC,
    responseContentDisposition: attachmentDisposition(target.filename),
    responseContentType: target.contentType,
  });
  return { url, filename: target.filename };
}

// ── Mutations on Document ────────────────────────────────────────────

export async function renameDocument(
  ctx: DocumentCtx,
  documentId: string,
  name: string,
): Promise<void> {
  const next = name.trim();
  if (!next || next.length > 255) throw new Error("renameDocument: invalid name");
  await withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "document:edit");
    const doc = await tx.document.findFirst({
      where: { id: documentId, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!doc) deny("NOT_FOUND");
    await tx.document.update({ where: { id: doc!.id }, data: { name: next } });
    await record(tx, {
      action: "document.renamed",
      targetType: "Document",
      targetId: doc!.id,
      metadata: { from: doc!.name, to: next },
    });
  });
}

/** Flip INTERNAL ⇄ CLIENT_VISIBLE — the audited worst-bug lever (§5). */
export async function changeVisibility(
  ctx: DocumentCtx,
  documentId: string,
  visibility: Visibility,
): Promise<void> {
  await withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "document:change_visibility");
    const doc = await tx.document.findFirst({
      where: { id: documentId, deletedAt: null },
      select: { id: true, clientId: true, visibility: true },
    });
    if (!doc) deny("NOT_FOUND");
    assertVisibilityTarget(visibility, doc!.clientId);
    if (doc!.visibility === visibility) return;
    await tx.document.update({ where: { id: doc!.id }, data: { visibility } });
    await record(tx, {
      action: "document.visibility_changed",
      targetType: "Document",
      targetId: doc!.id,
      metadata: { from: doc!.visibility, to: visibility },
    });
  });
}

/** Soft delete: the row and its versions stay (export/undo later);
 * bytes stay metered until a hard-delete job reclaims them. */
export async function softDeleteDocument(ctx: DocumentCtx, documentId: string): Promise<void> {
  await withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "document:delete");
    const doc = await tx.document.findFirst({
      where: { id: documentId, deletedAt: null },
      select: { id: true },
    });
    if (!doc) deny("NOT_FOUND");
    await tx.document.update({ where: { id: doc!.id }, data: { deletedAt: new Date() } });
    await record(tx, { action: "document.deleted", targetType: "Document", targetId: doc!.id });
  });
}

// ── Reconciliation ───────────────────────────────────────────────────

/**
 * Stale PENDING objects (presigned but never committed) release their
 * quota reservation: mark DELETED and best-effort remove any bytes.
 * Cross-tenant by nature ⇒ system job under withPlatform (audited
 * there). Called manually for now; cron in a later phase.
 */
export async function expirePendingUploads(
  olderThanMinutes: number,
): Promise<{ expired: number }> {
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);
  const keys = await withPlatform(
    { type: "system", job: "expire-pending-uploads" },
    `expire PENDING file objects older than ${olderThanMinutes} min`,
    async (tx) => {
      const stale = await tx.fileObject.findMany({
        where: { status: "PENDING", createdAt: { lt: cutoff } },
        select: { id: true, r2Key: true },
      });
      if (stale.length === 0) return [];
      await tx.fileObject.updateMany({
        where: { id: { in: stale.map((s) => s.id) }, status: "PENDING" },
        data: { status: "DELETED" },
      });
      return stale.map((s) => s.r2Key);
    },
    { readOnly: false },
  );
  const storage = getStorage();
  await Promise.all(keys.map((k) => storage.delete(k).catch(() => undefined)));
  return { expired: keys.length };
}

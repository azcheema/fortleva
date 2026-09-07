import { record, recordMany } from "@/audit/record";
import {
  softDeleteCommentsOn,
  type CascadeReason,
  type CascadeSubject,
  type WorkItemDeletedReason,
} from "@/comments/cascade";
import { requireAccess, parseEntitlements } from "@/entitlements/resolver";
import { assertInScope, scopeWhere, type MemberActor } from "@/authz/authorize";
import { deny } from "@/authz/errors";
import { fail } from "@/lib/domain-error";
import { withTenant, type TenantDb } from "@/db";
import { attachmentDisposition } from "@/lib/http-download";
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
      | "ANCHOR_INTERNAL" // CLIENT_VISIBLE attachment on an item the client cannot see (2W-A; the trigger's twin)
      | "UPLOAD_MISSING" // commit: no bytes at the key
      | "UPLOAD_SIZE_MISMATCH" // commit: HEAD size ≠ presigned size
      | "NOT_PENDING", // commit: object already committed/deleted
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "DocumentError";
  }
}

/** The one anchor type shipped so far (2W-A); the enum has more, each
 * arriving with its own slice. */
export type AttachAnchor = { type: "WORK_ITEM"; id: string };

/** Both-or-neither, refused loudly at the seam (zod refines the action
 * layer; a half-anchor reaching here is a programmer error). */
const anchorOf = (input: {
  attachedToType?: "WORK_ITEM";
  attachedToId?: string;
}): AttachAnchor | null => {
  if (!input.attachedToType && !input.attachedToId) return null;
  if (!input.attachedToType || !input.attachedToId) {
    throw new Error("attachedToType and attachedToId come together");
  }
  return { type: input.attachedToType, id: input.attachedToId };
};

const PUT_EXPIRES_SEC = 15 * 60;
const GET_EXPIRES_SEC = 60;

const memberPrincipal = (ctx: DocumentCtx) =>
  ({ type: "member", id: ctx.actor.memberId }) as const;

const storageKeyFor = (tenantId: string, fileObjectId: string): string =>
  `${tenantId}/${fileObjectId}`;

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
  /** 2W-A: anchor the document to a work item. clientId/projectId are
   * then DERIVED from the item — passing different ones is refused. */
  attachedToType?: "WORK_ITEM";
  attachedToId?: string;
};

export type CreateUploadResult = {
  fileObjectId: string;
  uploadUrl: string;
  headers: Readonly<Record<string, string>>;
  /** Canonical type the object was presigned with — send it verbatim. */
  contentType: string;
};

/**
 * Attachment target (Phase 2): a project document must sit in the
 * actor's project scope (and clientId, if given, must be the project's
 * client — else derived from it); a client-level document needs DIRECT
 * client scope. An ANCHORED document (2W-A) derives BOTH columns from
 * its work item — the anchor never authorizes anything (§10), but the
 * authorization columns must agree with it, so a caller passing
 * different ones is refused rather than silently corrected (the
 * `document_anchor_guard` trigger is the belt). Resolved inside the
 * transaction, before any row/presign.
 */
async function resolveTarget(
  tx: TenantDb,
  actor: MemberActor,
  clientId: string | null | undefined,
  projectId: string | null | undefined,
  anchor?: AttachAnchor | null,
): Promise<{ clientId: string | null; projectId: string | null; parentVisibility: Visibility | null }> {
  if (anchor) {
    const item = await tx.workItem.findFirst({
      where: { id: anchor.id, deletedAt: null },
      select: { clientId: true, projectId: true, visibility: true },
    });
    if (!item) deny("NOT_FOUND");
    await assertInScope(tx, actor, { projectId: item!.projectId });
    if (clientId && clientId !== item!.clientId) fail("CLIENT_MISMATCH");
    if (projectId && projectId !== item!.projectId) fail("CLIENT_MISMATCH");
    return { clientId: item!.clientId, projectId: item!.projectId, parentVisibility: item!.visibility };
  }
  if (projectId) {
    await assertInScope(tx, actor, { projectId });
    const p = await tx.project.findFirst({ where: { id: projectId }, select: { clientId: true } });
    if (!p) deny("NOT_FOUND");
    if (clientId && clientId !== p!.clientId) fail("CLIENT_MISMATCH");
    return { clientId: p!.clientId, projectId, parentVisibility: null };
  }
  if (clientId) {
    await assertInScope(tx, actor, { clientId });
    return { clientId, projectId: null, parentVisibility: null };
  }
  return { clientId: null, projectId: null, parentVisibility: null };
}

/** The child ≤ parent rule at the seam (2W-A): a CLIENT_VISIBLE
 * attachment needs a CLIENT_VISIBLE item; the trigger is the belt. */
const assertAnchorVisibility = (
  visibility: Visibility,
  parentVisibility: Visibility | null,
): void => {
  if (visibility === "CLIENT_VISIBLE" && parentVisibility === "INTERNAL") {
    throw new DocumentError("ANCHOR_INTERNAL", "the item is not client-visible");
  }
};

/** Member-plane scope gate for an existing document row (NOT_FOUND outside scope). */
async function assertDocumentInScope(
  tx: TenantDb,
  actor: MemberActor,
  doc: { clientId: string | null; projectId: string | null },
): Promise<void> {
  if (doc.projectId) await assertInScope(tx, actor, { projectId: doc.projectId });
  else if (doc.clientId) await assertInScope(tx, actor, { clientId: doc.clientId });
}

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
  const anchor = anchorOf(input);
  // Anchored: the client comes from the item, checked inside the tx.
  if (!anchor) assertVisibilityTarget(input.visibility ?? "INTERNAL", input.clientId ?? input.projectId);
  if (!/^[0-9a-f]{64}$/i.test(input.sha256)) {
    throw new Error("createUpload: sha256 must be 64 hex chars");
  }

  const fileObjectId = newId();
  const key = storageKeyFor(ctx.tenantId, fileObjectId);

  await withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "document:upload");
    const target = await resolveTarget(tx, ctx.actor, input.clientId, input.projectId, anchor);
    if (anchor && input.visibility) assertAnchorVisibility(input.visibility, target.parentVisibility);
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
  /** INTERNAL is the default everywhere (§5); CLIENT_VISIBLE needs
   * clientId. An ANCHORED document with no explicit choice inherits its
   * work item's visibility (DATA_MODEL §10). */
  visibility?: Visibility;
  /** 2W-A: see CreateUploadInput. */
  attachedToType?: "WORK_ITEM";
  attachedToId?: string;
};

/** Step 2 (new document): COMMITTED + Document + FileVersion 1. */
export async function commitUpload(
  ctx: DocumentCtx,
  input: CommitUploadInput,
): Promise<{ documentId: string }> {
  const anchor = anchorOf(input);
  if (!anchor) assertVisibilityTarget(input.visibility ?? "INTERNAL", input.clientId ?? input.projectId);
  const documentId = newId();

  await commitFileObject(ctx, input.fileObjectId, async (tx, obj) => {
    const target = await resolveTarget(tx, ctx.actor, input.clientId, input.projectId, anchor);
    // Defaulted from the parent AT CREATION (§10); its own column after.
    const visibility = input.visibility ?? target.parentVisibility ?? "INTERNAL";
    if (anchor) assertAnchorVisibility(visibility, target.parentVisibility);
    const name = (input.name ?? obj.originalFilename ?? "untitled").trim() || "untitled";
    await tx.document.create({
      data: {
        id: documentId,
        tenantId: ctx.tenantId,
        clientId: target.clientId,
        projectId: target.projectId,
        name,
        visibility,
        attachedToType: anchor?.type ?? null,
        attachedToId: anchor?.id ?? null,
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
      metadata: {
        name,
        visibility,
        fileObjectId: obj.id,
        clientId: target.clientId,
        projectId: target.projectId,
        ...(anchor ? { attachedToType: anchor.type, attachedToId: anchor.id } : {}),
      },
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
        clientId: true,
        projectId: true,
        versions: { orderBy: { versionNumber: "desc" }, take: 1, select: { versionNumber: true } },
      },
    });
    if (!doc) deny("NOT_FOUND");
    await assertDocumentInScope(tx, ctx.actor, doc!);
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

export type DocumentFilter = {
  /** Client-level documents of one client (projectId null). */
  clientId?: string;
  /** Documents of one project. */
  projectId?: string;
  /** Documents anchored to one work item (2W-A). The anchor never
   * authorizes — the row's own clientId/projectId compose the scope. */
  attachedToWorkItemId?: string;
};

/**
 * document:view. Tenant-internal documents (no client) are visible to
 * every holder; client/project documents compose the actor's scope
 * (AUTHZ.md §4): direct client assignment for client-level rows, the
 * project axis for project rows. Zero assignments ⇒ only tenant-internal.
 */
export async function listDocuments(
  ctx: DocumentCtx,
  filter: DocumentFilter = {},
): Promise<DocumentListItem[]> {
  return withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "document:view");
    const scope = await scopeWhere(tx, ctx.actor, {
      clientField: "clientId",
      projectField: "projectId",
    });
    const where = filter.attachedToWorkItemId
      ? { attachedToType: "WORK_ITEM" as const, attachedToId: filter.attachedToWorkItemId, ...scope }
      : filter.projectId
        ? { projectId: filter.projectId, ...scope }
        : filter.clientId
          ? { clientId: filter.clientId, projectId: null, ...scope }
          : { OR: [{ clientId: null }, { clientId: { not: null }, ...scope }] };
    const rows = await tx.document.findMany({
      where: { deletedAt: null, ...where },
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
      kind: true,
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
  // A tenant export leaving the building is a data-egress event of its
  // own (SECURITY.md §7 "export.*"), on top of the ordinary file row.
  if (doc!.kind === "EXPORT") {
    await record(tx, {
      action: "export.downloaded",
      targetType: "Document",
      targetId: doc!.id,
      metadata: { versionNumber: latest!.versionNumber },
    });
  }
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
    const doc = await tx.document.findFirst({
      where: { id: documentId, deletedAt: null },
      select: { clientId: true, projectId: true },
    });
    if (!doc) deny("NOT_FOUND");
    await assertDocumentInScope(tx, ctx.actor, doc!);
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
      select: { id: true, name: true, clientId: true, projectId: true },
    });
    if (!doc) deny("NOT_FOUND");
    await assertDocumentInScope(tx, ctx.actor, doc!);
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
      select: {
        id: true,
        clientId: true,
        projectId: true,
        visibility: true,
        attachedToType: true,
        attachedToId: true,
      },
    });
    if (!doc) deny("NOT_FOUND");
    await assertDocumentInScope(tx, ctx.actor, doc!);
    assertVisibilityTarget(visibility, doc!.clientId);
    if (doc!.visibility === visibility) return;
    // 2W-A: flipping an ATTACHMENT visible needs a visible parent — the
    // typed refusal here, the trigger as the belt (a raw P0001 would
    // rethrow past the action's message mapping).
    if (visibility === "CLIENT_VISIBLE" && doc!.attachedToType === "WORK_ITEM" && doc!.attachedToId) {
      const item = await tx.workItem.findFirst({
        where: { id: doc!.attachedToId, deletedAt: null },
        select: { visibility: true },
      });
      assertAnchorVisibility(visibility, item?.visibility ?? "INTERNAL");
    }
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
      select: { id: true, clientId: true, projectId: true },
    });
    if (!doc) deny("NOT_FOUND");
    await assertDocumentInScope(tx, ctx.actor, doc!);
    const taken = await softDeleteDocumentsInTx(tx, ctx.tenantId, [doc!.id], new Date());
    // Another transaction deleted it between the read above and here:
    // their cascade owns it. NOT_FOUND, the same answer `deleteItem`
    // gives for the same race — a delete that reports success while
    // writing no audit row would be the odd one out.
    if (taken.length === 0) deny("NOT_FOUND");
  });
}

/**
 * The transaction-level soft delete both deleters share: the member's
 * own `softDeleteDocument` above, and `deleteItem`'s attachment cascade
 * in the work module (attachments live the life of their parent,
 * DATA_MODEL §10). The caller has already gated and scoped; this only
 * mutates and records.
 *
 * The row and its versions stay. Its COMMENTS go with it — on the
 * document and on each of its versions (`comments/cascade.ts`) — because
 * a comment's index row carries its body and nothing else would remove
 * it. One `document.deleted` per document, ids only; `why` is the
 * cascade reason when a work item's delete brought us here.
 *
 * The caller stamps ONE `deletedAt` for its whole cascade set, so the
 * whole deletion reads as one event to an export and to the retention
 * sweep's cutoff. It is NOT an undo key: a timestamp cannot tell this
 * cascade's comments from another delete in the same millisecond, and
 * the per-comment audit row is the record that can (comments/cascade.ts).
 *
 * Returns the ids it actually stamped — empty when another transaction
 * got there first, which is the caller's to interpret.
 */
export async function softDeleteDocumentsInTx(
  tx: TenantDb,
  tenantId: string,
  documentIds: readonly string[],
  deletedAt: Date,
  why?: WorkItemDeletedReason,
): Promise<string[]> {
  if (documentIds.length === 0) return [];
  // THE UPDATE IS THE SELECT, for the same reason the comment cascade
  // uses one: a `document.deleted` row must name a document THIS
  // transaction actually stamped. A concurrent delete of the same
  // attachment takes its row and its comments; auditing it here as well
  // would put two actors on one deletion, and a later undo would trust
  // whichever it read.
  const taken = await tx.document.updateManyAndReturn({
    where: { tenantId, id: { in: [...documentIds] }, deletedAt: null },
    data: { deletedAt },
    select: { id: true },
  });
  if (taken.length === 0) return [];
  const ids = taken.map((d) => d.id);
  const versions = await tx.fileVersion.findMany({
    where: { tenantId, documentId: { in: ids } },
    select: { id: true, documentId: true },
  });
  await recordMany(
    tx,
    ids.map((id) => ({
      action: "document.deleted" as const,
      targetType: "Document",
      targetId: id,
      ...(why ? { metadata: why } : {}),
    })),
  );
  // ONE cascade call for every document and every version, each subject
  // carrying the document it belongs to, so the per-document metadata
  // survives without a statement per document.
  const reasonFor = (documentId: string): CascadeReason => ({
    reason: "document_deleted",
    documentId,
    ...(why ? { workItemId: why.workItemId } : {}),
  });
  const subjects: CascadeSubject[] = [
    ...ids.map((id) => ({ type: "DOCUMENT" as const, id, why: reasonFor(id) })),
    ...versions.map((v) => ({ type: "FILE_VERSION" as const, id: v.id, why: reasonFor(v.documentId) })),
  ];
  await softDeleteCommentsOn(tx, tenantId, subjects, deletedAt);
  return ids;
}

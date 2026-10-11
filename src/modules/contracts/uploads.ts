import { createHash } from "node:crypto";

import { record } from "@/audit/record";
import { assertInScope } from "@/authz/authorize";
import { deny } from "@/authz/errors";
import { isUuid } from "@/db/context";
import { withTenant, type TenantDb } from "@/db";
import { UploadRejectedError, validateUpload } from "@/documents/allowlist";
import { enforceStorageQuota } from "@/documents/service";
import { requireAccess } from "@/entitlements/resolver";
import { todayIn } from "@/lib/due-date";
import { fail } from "@/lib/domain-error";
import { newId } from "@/lib/ids";
import { readPreferences } from "@/preferences/service";
import { getStorage } from "@/storage";

import { guarded } from "./db-errors";
import { dayOf, titleOf } from "./drafts";
import { readLiveParties } from "./parties";
import { uploadedContractPdfName } from "./print";
import { memberPrincipal, type ContractsCtx } from "./templates";

/**
 * CONTRACTS SIGNED ELSEWHERE (Phase 4 slice 112c; founder decisions C84 (f),
 * C86). The design: docs/research/2026-10-10-slice-112-contracts-design.md
 * §14; the database's rules: migration 20261014090000.
 *
 * PUTTING ONE IN — the documents' upload pattern (SECURITY §5: the app never
 * streams a user's bytes), with a contract's own checks, because the file IS
 * the evidence of what was signed:
 *   1. `presignContractUpload` (`contract:create`, the client in DIRECT scope):
 *      a `.pdf` named `application/pdf` (C86 (d)), at most 20 MB, the storage
 *      quota, a PENDING placeholder `file_object`, a presigned PUT;
 *   2. the browser hashes the file and PUTs it straight to the bucket;
 *   3. `commitContractUpload`: the gates again and the placeholder this
 *      member's; OUTSIDE any transaction the stored bytes READ BACK — the size
 *      promised, a PDF's first bytes (`%PDF-`), the SHA-256 recomputed and
 *      equal to the one announced — or the placeholder is DELETED with its
 *      bytes (CONTRACT_UPLOAD_INVALID); then the checked bytes written to a
 *      key of their OWN (the presigned URL can no longer touch them), and ONE
 *      transaction: the placeholder DELETED, the copy recorded as a COMMITTED
 *      contract PDF, the workspace's storage counted, the contract inserted
 *      SIGNED and NOT SHOWN (C86 (a)), audited.
 *
 * AFTERWARDS (C86 (a), (b)): its DETAILS (title, the day signed, its term —
 * `contract:edit`), its SHOWING to the client (`contract:send`, the
 * client-facing verb), or its DELETION (`contract:delete` — owners and
 * managers), each audited; never its file. The database holds each rule again
 * (`contract_guard`).
 *
 * Reads in SEQUENCE on each transaction's one connection (AGENTS.md).
 */

/** The largest signed PDF that may be put in (C86 (d); the documents' cap is 100 MB). */
export const CONTRACT_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
const PUT_EXPIRES_SEC = 15 * 60;
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"
const SHA256 = /^[0-9a-f]{64}$/i;

const idOf = (raw: unknown, what: string): string => {
  if (typeof raw !== "string" || !isUuid(raw)) fail("INVALID_INPUT", what);
  return raw as string;
};

/** The client, put in by a member who may: `contract:create` holder, DIRECT scope, an active client. */
async function openClient(tx: TenantDb, ctx: ContractsCtx, clientId: string, code: "contract:create"): Promise<void> {
  await requireAccess(tx, ctx.tenantId, ctx.actor, code);
  await assertInScope(tx, ctx.actor, { clientId });
  const client = await tx.client.findFirst({ where: { tenantId: ctx.tenantId, id: clientId, status: "ACTIVE" }, select: { id: true } });
  if (!client) fail("INVALID_INPUT", "client");
}

export type ContractUploadIntent = {
  readonly clientId: unknown;
  readonly fileName: unknown;
  readonly contentType: unknown;
  readonly sizeBytes: unknown;
  /** The browser's SHA-256 of the file (hex): checked against the stored bytes at commit. */
  readonly sha256: unknown;
};

export type ContractUploadTicket = {
  readonly fileObjectId: string;
  readonly uploadUrl: string;
  /** Headers the browser MUST send verbatim (they are part of the signature). */
  readonly headers: Readonly<Record<string, string>>;
};

/** Step 1 — `contract:create`: a presigned PUT for one signed PDF. */
export async function presignContractUpload(ctx: ContractsCtx, input: ContractUploadIntent): Promise<ContractUploadTicket> {
  const clientId = idOf(input.clientId, "client");
  const name = typeof input.fileName === "string" ? input.fileName.trim() : "";
  const size = typeof input.sizeBytes === "number" ? input.sizeBytes : Number.NaN;
  const sha256 = typeof input.sha256 === "string" ? input.sha256.toLowerCase() : "";
  if (!SHA256.test(sha256)) fail("INVALID_INPUT", "sha256");
  let contentType: string;
  try {
    const checked = validateUpload({ name, contentType: typeof input.contentType === "string" ? input.contentType : "", sizeBytes: size });
    if (checked.extension !== "pdf") fail("CONTRACT_UPLOAD_INVALID", "not a pdf");
    contentType = checked.contentType;
  } catch (e) {
    if (e instanceof UploadRejectedError) return fail("CONTRACT_UPLOAD_INVALID", e.code);
    throw e;
  }
  if (size > CONTRACT_UPLOAD_MAX_BYTES) fail("CONTRACT_UPLOAD_INVALID", "too large");

  const fileObjectId = newId();
  const key = `${ctx.tenantId}/${fileObjectId}`;
  await withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    await openClient(tx, ctx, clientId, "contract:create");
    await enforceStorageQuota(tx, ctx.tenantId, size);
    // The placeholder: GENERAL and PENDING — the upload sweep's kind — until
    // the commit records the file in its place.
    await tx.fileObject.create({
      data: {
        id: fileObjectId,
        tenantId: ctx.tenantId,
        r2Key: key,
        sha256,
        sizeBytes: BigInt(size),
        contentType,
        originalFilename: name,
        status: "PENDING",
        createdByMemberId: ctx.actor.memberId,
      },
      select: { id: true },
    });
  });
  const presigned = await getStorage().presignPut(key, { contentType, contentLength: size, expiresSec: PUT_EXPIRES_SEC });
  return { fileObjectId, uploadUrl: presigned.url, headers: presigned.headers };
}

export type ContractUploadCommit = {
  readonly fileObjectId: unknown;
  readonly clientId: unknown;
  readonly title: unknown;
  /** `YYYY-MM-DD` — required: the day it was signed. */
  readonly signedOn: unknown;
  readonly startsOn?: unknown;
  readonly endsOn?: unknown;
};

/** Where a PDF starts: `%PDF-` within its first 1024 bytes (the PDF specification's own allowance). */
const isPdf = (bytes: Uint8Array): boolean => {
  const limit = Math.min(bytes.byteLength - PDF_MAGIC.length, 1024 - PDF_MAGIC.length);
  for (let at = 0; at <= limit; at += 1) {
    if (PDF_MAGIC.every((b, i) => bytes[at + i] === b)) return true;
  }
  return false;
};

/** The day it was signed may not be later than today in the workspace's zone (the guard holds UTC tomorrow). */
async function assertSignedByToday(tx: TenantDb, tenantId: string, signedOn: Date): Promise<void> {
  const today = todayIn((await readPreferences(tx, tenantId)).timezone);
  if (signedOn.toISOString().slice(0, 10) > today) fail("INVALID_INPUT", "signed on a day to come");
}

/**
 * Step 3 — `contract:create`: the stored bytes checked, the file recorded, the
 * contract put in (SIGNED, not shown).
 *
 * THE VERIFIED BYTES ARE WRITTEN AGAIN, TO A KEY OF THEIR OWN (the pre-apply
 * review's medium): the presigned PUT stays valid for its fifteen minutes and
 * signs only the type and length, so the placeholder's key could be written
 * over after the check — the record of what was signed would then point at
 * other bytes, unaudited. The contract's file is the copy the server checked,
 * at a key no presigned URL names; the placeholder is DELETED and its bytes
 * removed once the record stands. (A deviation from "the app never streams a
 * user's bytes" — SECURITY §5 records why: this file is evidence.)
 */
export async function commitContractUpload(ctx: ContractsCtx, input: ContractUploadCommit): Promise<{ id: string }> {
  const fileObjectId = idOf(input.fileObjectId, "file");
  const clientId = idOf(input.clientId, "client");
  const title = titleOf(input.title);
  const signedOn = dayOf(input.signedOn, "signed on");
  if (signedOn === null) fail("INVALID_INPUT", "signed on");
  const startsOn = dayOf(input.startsOn, "starts on");
  const endsOn = dayOf(input.endsOn, "ends on");
  if (startsOn && endsOn && endsOn < startsOn) fail("INVALID_INPUT", "ends before it starts");

  // This member's PENDING contract placeholder — never a document's, whose cap is larger.
  const mine = {
    tenantId: ctx.tenantId,
    id: fileObjectId,
    status: "PENDING" as const,
    kind: "GENERAL" as const,
    createdByMemberId: ctx.actor.memberId,
    contentType: "application/pdf",
    sizeBytes: { lte: BigInt(CONTRACT_UPLOAD_MAX_BYTES) },
  };
  const placeholder = await withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    await openClient(tx, ctx, clientId, "contract:create");
    await assertSignedByToday(tx, ctx.tenantId, signedOn!);
    const row = await tx.fileObject.findFirst({ where: mine, select: { r2Key: true, sizeBytes: true, sha256: true } });
    if (!row) return deny("NOT_FOUND", "upload");
    return row;
  });

  // OUTSIDE any transaction: the bytes as stored, never what the browser said
  // — their size first, then the bytes themselves.
  const storage = getStorage();
  const head = await storage.head(placeholder.r2Key);
  const bytes = head && BigInt(head.sizeBytes) === placeholder.sizeBytes ? await storage.getObject(placeholder.r2Key) : null;
  const sha256 = bytes ? createHash("sha256").update(bytes).digest("hex") : null;
  if (!bytes || BigInt(bytes.byteLength) !== placeholder.sizeBytes || !isPdf(bytes) || sha256 !== placeholder.sha256) {
    const { count } = await withTenant(ctx.tenantId, memberPrincipal(ctx), (tx) =>
      tx.fileObject.updateMany({ where: mine, data: { status: "DELETED" } }),
    );
    // Only the call that retired the placeholder removes its bytes: a
    // concurrent commit that won must keep its file (the review's low).
    if (count === 1) await storage.delete(placeholder.r2Key).catch(() => undefined);
    return fail("CONTRACT_UPLOAD_INVALID");
  }

  const fileId = newId();
  const key = `${ctx.tenantId}/${fileId}`;
  await storage.putObject(key, bytes, "application/pdf");
  let id: string;
  try {
    id = await withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) =>
      guarded(async () => {
        await openClient(tx, ctx, clientId, "contract:create");
        const retired = await tx.fileObject.updateMany({ where: mine, data: { status: "DELETED" } });
        if (retired.count !== 1) return deny("NOT_FOUND", "upload");
        await tx.fileObject.create({
          data: {
            id: fileId,
            tenantId: ctx.tenantId,
            r2Key: key,
            kind: "CONTRACT_PDF",
            sha256: sha256!,
            sizeBytes: placeholder.sizeBytes,
            contentType: "application/pdf",
            originalFilename: uploadedContractPdfName(title),
            status: "COMMITTED",
            committedAt: new Date(),
            createdByMemberId: ctx.actor.memberId,
          },
          select: { id: true },
        });
        await tx.tenant.update({
          where: { id: ctx.tenantId },
          data: { storageUsedBytes: { increment: placeholder.sizeBytes } },
          select: { id: true },
        });
        const live = await readLiveParties(tx, ctx.tenantId, clientId, null);
        const contractId = newId();
        await tx.contract.create({
          data: {
            id: contractId,
            tenantId: ctx.tenantId,
            clientId,
            title,
            origin: "UPLOADED",
            status: "SIGNED",
            language: live.clientLocale ?? live.workspaceLocale,
            signedOn: signedOn!,
            startsOn,
            endsOn,
            signedPdfFileId: fileId,
            createdByMemberId: ctx.actor.memberId,
          },
          select: { id: true },
        });
        await record(tx, {
          action: "file.uploaded",
          targetType: "FileObject",
          targetId: fileId,
          metadata: { sizeBytes: Number(placeholder.sizeBytes), contentType: "application/pdf" },
        });
        await record(tx, {
          action: "contract.uploaded",
          targetType: "Contract",
          targetId: contractId,
          // Ids and the file's fingerprint — never the title or the file's name.
          metadata: { clientId, fileObjectId: fileId, sha256: sha256!, sizeBytes: Number(placeholder.sizeBytes) },
        });
        return contractId;
      }),
    );
  } catch (e) {
    // WHAT THE DATABASE HOLDS NOW decides (the pdf stores' reasoning — the
    // security review's low): a throw can come from the COMMIT's own
    // acknowledgement, after Postgres committed. A contract that names this
    // copy means the put-in stands — keep the copy and answer with it; none
    // means nothing was recorded and the copy is nobody's (the placeholder
    // stays PENDING for another try). If even the re-read fails, keep the
    // copy: deleting the evidence of a record that may exist is the one
    // unrecoverable mistake.
    let recorded: { id: string } | null;
    try {
      recorded = await withTenant(ctx.tenantId, memberPrincipal(ctx), (tx) =>
        tx.contract.findFirst({ where: { tenantId: ctx.tenantId, signedPdfFileId: fileId }, select: { id: true } }),
      );
    } catch {
      throw e;
    }
    if (!recorded) {
      await storage.delete(key).catch(() => undefined);
      throw e;
    }
    id = recorded.id;
  }
  // The record stands: the placeholder's bytes are no longer anyone's.
  await storage.delete(placeholder.r2Key).catch(() => undefined);
  return { id };
}

type UploadedRow = { id: string; client_id: string; shown_to_client: boolean; signed_pdf_file_id: string | null };

/** The contract signed elsewhere, locked FOR UPDATE — the scope FIRST, on an unlocked read. */
async function lockUploaded(tx: TenantDb, ctx: ContractsCtx, rawId: unknown): Promise<UploadedRow> {
  const id = idOf(rawId, "contract");
  const seen = await tx.contract.findFirst({ where: { tenantId: ctx.tenantId, id }, select: { clientId: true } });
  if (!seen) return deny("NOT_FOUND", "contract");
  await assertInScope(tx, ctx.actor, { clientId: seen.clientId });
  const rows = await tx.$queryRaw<(UploadedRow & { origin: string })[]>`
    SELECT id, client_id, origin::text AS origin, shown_to_client, signed_pdf_file_id
      FROM contract WHERE tenant_id = ${ctx.tenantId} AND id = ${id} FOR UPDATE`;
  if (rows.length === 0) return deny("NOT_FOUND", "contract");
  if (rows[0]!.origin !== "UPLOADED") fail("CONTRACT_NOT_UPLOADED");
  return rows[0]!;
}

export type UploadedDetails = {
  readonly title: unknown;
  readonly signedOn: unknown;
  readonly startsOn?: unknown;
  readonly endsOn?: unknown;
};

/** `contract:edit` — a contract signed elsewhere: its title, the day signed, its term (C86 (b)). */
export async function updateUploadedContract(ctx: ContractsCtx, id: unknown, input: UploadedDetails): Promise<void> {
  const title = titleOf(input.title);
  const signedOn = dayOf(input.signedOn, "signed on");
  if (signedOn === null) fail("INVALID_INPUT", "signed on");
  const startsOn = dayOf(input.startsOn, "starts on");
  const endsOn = dayOf(input.endsOn, "ends on");
  if (startsOn && endsOn && endsOn < startsOn) fail("INVALID_INPUT", "ends before it starts");
  await withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "contract:edit");
      const row = await lockUploaded(tx, ctx, id);
      await assertSignedByToday(tx, ctx.tenantId, signedOn!);
      const before = await tx.contract.findFirstOrThrow({
        where: { tenantId: ctx.tenantId, id: row.id },
        select: { title: true, signedOn: true, startsOn: true, endsOn: true },
      });
      const same = (a: Date | null, b: Date | null) => (a?.getTime() ?? null) === (b?.getTime() ?? null);
      const fields = [
        ...(before.title !== title ? ["title"] : []),
        ...(!same(before.signedOn, signedOn) ? ["signedOn"] : []),
        ...(!same(before.startsOn, startsOn) ? ["startsOn"] : []),
        ...(!same(before.endsOn, endsOn) ? ["endsOn"] : []),
      ];
      if (fields.length === 0) return;
      await tx.contract.updateMany({ where: { tenantId: ctx.tenantId, id: row.id }, data: { title, signedOn: signedOn!, startsOn, endsOn } });
      await record(tx, {
        action: "contract.uploaded_edited",
        targetType: "Contract",
        targetId: row.id,
        metadata: { clientId: row.client_id, fields },
      });
    }),
  );
}

/**
 * `contract:send` — show a contract signed elsewhere to the client's main
 * contacts in their portal, or hide it again (C86 (a): off until someone turns
 * it on). A VISIBILITY change: always audited, both ways.
 */
export async function setUploadedContractShown(ctx: ContractsCtx, id: unknown, shown: unknown): Promise<void> {
  if (typeof shown !== "boolean") fail("INVALID_INPUT", "shown");
  await withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "contract:send");
      const row = await lockUploaded(tx, ctx, id);
      if (row.shown_to_client === shown) return;
      await tx.contract.updateMany({ where: { tenantId: ctx.tenantId, id: row.id }, data: { shownToClient: shown as boolean } });
      await record(tx, {
        action: "contract.shown_changed",
        targetType: "Contract",
        targetId: row.id,
        metadata: { clientId: row.client_id, shown: shown as boolean },
      });
    }),
  );
}

/**
 * `contract:delete` — a contract signed elsewhere that was put in wrong (C86
 * (b): delete it and put it in again): the contract, its file's row and bytes,
 * and the workspace's storage count, together. Audited with its file and
 * whether it had been shown.
 */
export async function deleteUploadedContract(ctx: ContractsCtx, id: unknown): Promise<void> {
  const gone = await withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "contract:delete");
      const row = await lockUploaded(tx, ctx, id);
      const file = row.signed_pdf_file_id
        ? await tx.fileObject.findFirst({ where: { tenantId: ctx.tenantId, id: row.signed_pdf_file_id }, select: { id: true, r2Key: true, sizeBytes: true } })
        : null;
      await tx.contract.deleteMany({ where: { tenantId: ctx.tenantId, id: row.id } });
      if (file) {
        await tx.fileObject.deleteMany({ where: { tenantId: ctx.tenantId, id: file.id, kind: "CONTRACT_PDF" } });
        await tx.tenant.update({
          where: { id: ctx.tenantId },
          data: { storageUsedBytes: { decrement: file.sizeBytes } },
          select: { id: true },
        });
      }
      await record(tx, {
        action: "contract.uploaded_deleted",
        targetType: "Contract",
        targetId: row.id,
        metadata: { clientId: row.client_id, fileObjectId: file?.id ?? null, wasShown: row.shown_to_client },
      });
      return file?.r2Key ?? null;
    }),
  );
  // After the commit: the bytes, best effort — the rows were the truth. The
  // storage itself may not even construct (no bucket configured — the
  // browser harness): a deletion that stood must never answer as a failure
  // (the code review's high).
  if (gone) {
    try {
      await getStorage().delete(gone);
    } catch (e) {
      console.error(`contract upload: a deleted contract's file bytes were not removed (${e instanceof Error ? e.name : typeof e})`);
    }
  }
}

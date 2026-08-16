import { createHash } from "node:crypto";

import { strToU8, zipSync, type Zippable } from "fflate";

import { record } from "@/audit/record";
import type { MemberActor } from "@/authz/authorize";
import { withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { newId } from "@/lib/ids";
import { getStorage } from "@/storage";

import {
  buildManifest,
  dataPathFor,
  EXPORT_MODELS,
  filePathFor,
  MAX_BUNDLED_FILE_BYTES,
  serializeRow,
  type ExportManifest,
  type ManifestFile,
  type ManifestModel,
} from "./manifest";

/**
 * Tenant export v0 (PLAN.md Phase 2; CONTINUITY_BOX.md — the export
 * path IS the continuity commitment). One JSONL file per model + a
 * schema-versioned manifest, packaged as a zip that lands through the
 * StorageTransport as a FileObject(kind=EXPORT) + Document(kind=EXPORT,
 * INTERNAL) so it downloads via the ordinary presigned path and shows
 * up in /files like any other document.
 *
 * Gate: `tenant:export` (✦ — the caller's action turns MFA_REQUIRED
 * into step-up navigation). The dump itself runs under the requesting
 * MEMBER principal inside one tenant transaction, so RLS decides what
 * leaves: exactly what that tenant can read, nothing from any other.
 *
 * Deliberately not quota-gated: an export must never be refused for
 * lack of headroom (the bytes still count in storageUsedBytes so the
 * meter stays honest).
 */

export type ExportCtx = {
  readonly tenantId: string;
  /** From requireTenantContext() — never from form params. */
  readonly actor: MemberActor;
};

export type ExportSummary = {
  documentId: string;
  fileObjectId: string;
  name: string;
  sizeBytes: number;
  sha256: string;
  manifest: ExportManifest;
};

const memberPrincipal = (ctx: ExportCtx) => ({ type: "member", id: ctx.actor.memberId }) as const;

const sha256Hex = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

/** Prisma delegate access by model name (registry-driven, DMMF-free). */
type Delegate = { findMany: (args?: unknown) => Promise<Record<string, unknown>[]> };
const delegate = (tx: TenantDb, model: string): Delegate => {
  const d = (tx as unknown as Record<string, Delegate | undefined>)[model];
  if (!d) throw new Error(`export: no Prisma delegate for model "${model}"`);
  return d;
};

type DumpedModel = ManifestModel & { bytes: Uint8Array };

type CommittedFile = {
  id: string;
  r2Key: string;
  sha256: string;
  sizeBytes: number;
  originalFilename: string | null;
  kind: string;
};

/**
 * Pass 1 (one tx): authorize, audit the request, dump every model in
 * EXPORT_MODELS as JSONL, list the committed files. RLS + where-
 * injection scope every read to this tenant.
 */
async function dumpTenant(
  ctx: ExportCtx,
): Promise<{ models: DumpedModel[]; files: CommittedFile[]; requestedAt: Date }> {
  return withTenant(
    ctx.tenantId,
    memberPrincipal(ctx),
    async (tx) => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "tenant:export");
      const requestedAt = new Date();
      await record(tx, {
        action: "export.requested",
        targetType: "Tenant",
        targetId: ctx.tenantId,
      });

      const models: DumpedModel[] = [];
      for (const spec of EXPORT_MODELS) {
        const rows = await delegate(tx, spec.model).findMany({});
        const jsonl = rows.map((r) => serializeRow(r, spec.exclude)).join("\n");
        const bytes = strToU8(jsonl.length ? `${jsonl}\n` : "");
        models.push({
          name: spec.model,
          table: spec.table,
          rowCount: rows.length,
          sha256: sha256Hex(bytes),
          path: dataPathFor(spec.table),
          excludedColumns: [...spec.exclude],
          bytes,
        });
      }

      const fileRows = await tx.fileObject.findMany({
        where: { status: "COMMITTED" },
        select: {
          id: true,
          r2Key: true,
          sha256: true,
          sizeBytes: true,
          originalFilename: true,
          kind: true,
        },
        orderBy: { createdAt: "asc" },
      });
      const files = fileRows.map((f) => ({ ...f, sizeBytes: Number(f.sizeBytes) }));
      return { models, files, requestedAt };
    },
    // A full dump is not a 5-second unit of work.
    { timeoutMs: 120_000 },
  );
}

/**
 * Generate, package and store a tenant export. Returns the Document that
 * downloads it. Three phases: dump (tx) → package + putObject (I/O, no
 * tx held) → register FileObject/Document/FileVersion + audit (tx).
 */
export async function generateTenantExport(ctx: ExportCtx): Promise<ExportSummary> {
  const storage = getStorage();
  const { models, files, requestedAt } = await dumpTenant(ctx);

  // Bundle bytes when the total fits; previous exports are pointers
  // only (an export never nests exports).
  const bundleable = files.filter((f) => f.kind !== "EXPORT");
  const totalFileBytes = bundleable.reduce((n, f) => n + f.sizeBytes, 0);
  const includesFileBytes = totalFileBytes <= MAX_BUNDLED_FILE_BYTES;

  const zipEntries: Zippable = {};
  for (const m of models) zipEntries[m.path] = m.bytes;

  const manifestFiles: ManifestFile[] = [];
  for (const f of files) {
    const entry: ManifestFile = {
      fileObjectId: f.id,
      r2Key: f.r2Key,
      sha256: f.sha256,
      sizeBytes: f.sizeBytes,
    };
    if (includesFileBytes && f.kind !== "EXPORT") {
      const bytes = await storage.getObject(f.r2Key);
      if (bytes) {
        entry.path = filePathFor(f.id, f.originalFilename);
        // Already-compressed uploads gain nothing from deflate.
        zipEntries[entry.path] = [bytes, { level: 0 }];
      }
    }
    manifestFiles.push(entry);
  }

  const generatedAt = new Date();
  const manifest = buildManifest({
    tenantId: ctx.tenantId,
    generatedAt,
    models: models.map((m) => ({
      name: m.name,
      table: m.table,
      rowCount: m.rowCount,
      sha256: m.sha256,
      path: m.path,
      excludedColumns: m.excludedColumns,
    })),
    files: manifestFiles,
    includesFileBytes,
  });
  zipEntries["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));

  const zip = zipSync(zipEntries, { level: 6, mtime: generatedAt });
  const sha256 = sha256Hex(zip);
  const fileObjectId = newId();
  const documentId = newId();
  const key = `${ctx.tenantId}/${fileObjectId}`;
  const name = `export-${generatedAt.toISOString().slice(0, 10)}.zip`;

  await storage.putObject(key, zip, "application/zip");

  try {
    await withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "tenant:export");
      await tx.fileObject.create({
        data: {
          id: fileObjectId,
          tenantId: ctx.tenantId,
          r2Key: key,
          kind: "EXPORT",
          sha256,
          sizeBytes: BigInt(zip.byteLength),
          contentType: "application/zip",
          originalFilename: name,
          status: "COMMITTED",
          committedAt: generatedAt,
          createdByMemberId: ctx.actor.memberId,
        },
      });
      await tx.tenant.update({
        where: { id: ctx.tenantId },
        data: { storageUsedBytes: { increment: BigInt(zip.byteLength) } },
      });
      await tx.document.create({
        data: {
          id: documentId,
          tenantId: ctx.tenantId,
          name,
          kind: "EXPORT",
          visibility: "INTERNAL",
          createdByMemberId: ctx.actor.memberId,
          versions: {
            create: {
              versionNumber: 1,
              fileObjectId,
              uploadedByMemberId: ctx.actor.memberId,
            },
          },
        },
      });
      await record(tx, {
        action: "export.generated",
        targetType: "Document",
        targetId: documentId,
        metadata: {
          fileObjectId,
          sizeBytes: zip.byteLength,
          sha256,
          schemaVersion: manifest.schemaVersion,
          models: manifest.models.length,
          rows: manifest.models.reduce((n, m) => n + m.rowCount, 0),
          files: manifest.files.length,
          includesFileBytes,
          requestedAt: requestedAt.toISOString(),
        },
      });
    });
  } catch (e) {
    // The rows are the source of truth; an orphaned blob is reclaimed.
    await storage.delete(key).catch(() => undefined);
    throw e;
  }

  return { documentId, fileObjectId, name, sizeBytes: zip.byteLength, sha256, manifest };
}

export type ExportListItem = {
  documentId: string;
  name: string;
  sizeBytes: number;
  createdAt: Date;
  createdByMemberId: string | null;
};

/** Previous exports (settings:view): EXPORT documents, newest first. */
export async function listExports(ctx: ExportCtx): Promise<ExportListItem[]> {
  return withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "settings:view");
    const rows = await tx.document.findMany({
      where: { kind: "EXPORT", deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        name: true,
        createdAt: true,
        createdByMemberId: true,
        versions: {
          orderBy: { versionNumber: "desc" },
          take: 1,
          select: { fileObject: { select: { sizeBytes: true } } },
        },
      },
    });
    return rows.map((d) => ({
      documentId: d.id,
      name: d.name,
      sizeBytes: Number(d.versions[0]?.fileObject.sizeBytes ?? 0n),
      createdAt: d.createdAt,
      createdByMemberId: d.createdByMemberId,
    }));
  });
}

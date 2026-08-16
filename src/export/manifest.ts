import { MODEL_CLASSES, tableNameOf } from "@/db/model-registry";

/**
 * Tenant export v0 — the continuity commitment (CONTINUITY_BOX.md,
 * PLAN.md Phase 2 "platform-continuity cheap win #2"). Prisma 7 has no
 * runtime DMMF, so the export census is a checked constant like the
 * model registry: every tenant-scoped model has an entry HERE, and
 * manifest.test.ts fails the build when MODEL_CLASSES gains a model
 * without one (the standing rule from Phase 2 on: every later phase
 * extends the manifest as part of its definition of done).
 *
 * Only what the tenant itself could read leaves: the dump runs inside
 * the tenant-scoped transaction under the requesting member (RLS live),
 * and the columns below are stripped even from that — encrypted
 * ciphertext is useless outside this deployment and the wrapped DEK
 * must never travel with the data it protects.
 */

export const EXPORT_SCHEMA_VERSION = 1 as const;

export type ExportModelSpec = {
  /** Prisma client property name (camelCase model). */
  readonly model: string;
  /** Physical table (the JSONL file is `data/<table>.jsonl`). */
  readonly table: string;
  /** Registry class the model is exported under. */
  readonly cls: "tenantRoot" | "tenant" | "audit";
  /** Columns removed from every row before serialisation. */
  readonly exclude: readonly string[];
};

/** Columns that never leave, per model — reviewed with every phase. */
export const EXPORT_EXCLUDED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  tenant: ["bankgiro", "plusgiro", "iban", "bic", "databaseUrl"],
  tenantKey: ["wrappedDek"],
};

/**
 * The census: tenant root row, every MODEL_CLASSES.tenant model, and
 * the tenant-visibility audit rows (audit_event is class `audit`; the
 * RLS select policy already hides PLATFORM rows from the tenant tx).
 * Global/auth/catalog models (User, Session, TwoFactor, Permission …)
 * are deliberately NOT tenant data and are not exported.
 */
export const EXPORT_MODELS: readonly ExportModelSpec[] = [
  ...MODEL_CLASSES.tenantRoot.map((model) => spec(model, "tenantRoot")),
  ...MODEL_CLASSES.tenant.map((model) => spec(model, "tenant")),
  ...MODEL_CLASSES.audit.map((model) => spec(model, "audit")),
];

function spec(model: string, cls: ExportModelSpec["cls"]): ExportModelSpec {
  return { model, table: tableNameOf(model), cls, exclude: EXPORT_EXCLUDED_COLUMNS[model] ?? [] };
}

/** Bytes above which file contents are NOT bundled — pointers only. */
export const MAX_BUNDLED_FILE_BYTES = 200 * 1024 * 1024;

export type ManifestModel = {
  name: string;
  table: string;
  rowCount: number;
  /** sha256 of the JSONL bytes at `path`. */
  sha256: string;
  path: string;
  excludedColumns: string[];
};

export type ManifestFile = {
  fileObjectId: string;
  r2Key: string;
  sha256: string;
  sizeBytes: number;
  /** Path inside the zip when the bytes are bundled; absent in pointer mode. */
  path?: string;
};

export type ExportManifest = {
  schemaVersion: typeof EXPORT_SCHEMA_VERSION;
  generatedAt: string;
  tenantId: string;
  models: ManifestModel[];
  files: ManifestFile[];
  /** true ⇒ every listed file's bytes are under files/; false ⇒ pointers only. */
  includesFileBytes: boolean;
  /** Why pointer mode was chosen (present only when includesFileBytes=false). */
  fileBytesOmittedReason?: "over_size_limit";
  totalFileBytes: number;
};

export const dataPathFor = (table: string): string => `data/${table}.jsonl`;

/** Zip-safe file name: opaque id directory + sanitised original name. */
export const filePathFor = (fileObjectId: string, originalFilename: string | null): string => {
  const base = (originalFilename ?? fileObjectId).replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 120);
  return `files/${fileObjectId}/${base || fileObjectId}`;
};

/**
 * JSON replacer for Prisma row values: bigint → decimal string, Bytes →
 * base64; Date/Decimal already serialise via toJSON. Objects (Json
 * columns) pass through.
 */
export const jsonReplacer = (_key: string, value: unknown): unknown => {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  return value;
};

/** One row → one JSONL line, excluded columns dropped first. */
export const serializeRow = (row: Record<string, unknown>, exclude: readonly string[]): string => {
  const copy: Record<string, unknown> = { ...row };
  for (const c of exclude) delete copy[c];
  return JSON.stringify(copy, jsonReplacer);
};

/** Pure: assemble the manifest from per-model and per-file facts. */
export function buildManifest(input: {
  tenantId: string;
  generatedAt: Date;
  models: ManifestModel[];
  files: ManifestFile[];
  includesFileBytes: boolean;
}): ExportManifest {
  const totalFileBytes = input.files.reduce((n, f) => n + f.sizeBytes, 0);
  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    generatedAt: input.generatedAt.toISOString(),
    tenantId: input.tenantId,
    models: input.models,
    files: input.files,
    includesFileBytes: input.includesFileBytes,
    ...(input.includesFileBytes ? {} : { fileBytesOmittedReason: "over_size_limit" as const }),
    totalFileBytes,
  };
}

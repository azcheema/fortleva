/**
 * The storage seam (PLAN.md Phase 1 "File storage", SECURITY.md §5).
 * The app never streams file bytes: uploads go browser → bucket via a
 * presigned PUT that has Content-Length + Content-Type signed in;
 * downloads are short-lived presigned GETs served off-origin with
 * Content-Disposition: attachment. Keys are opaque strings owned by
 * the documents service ("<tenantId>/<fileObjectId>").
 */

export type PresignPutOptions = {
  readonly contentType: string;
  readonly contentLength: number;
  readonly expiresSec: number;
};

export type PresignedPut = {
  readonly url: string;
  /** Headers the uploader MUST send verbatim (they are part of the signature). */
  readonly headers: Readonly<Record<string, string>>;
};

export type PresignGetOptions = {
  readonly expiresSec: number;
  /** e.g. `attachment; filename="report.pdf"` — always attachment (§5). */
  readonly responseContentDisposition: string;
  readonly responseContentType?: string;
};

export type HeadResult = {
  readonly sizeBytes: number;
  readonly etag?: string;
};

export interface StorageTransport {
  readonly name: "local-disk" | "r2";
  presignPut(key: string, opts: PresignPutOptions): Promise<PresignedPut>;
  /** null when the object does not exist. */
  head(key: string): Promise<HeadResult | null>;
  presignGet(key: string, opts: PresignGetOptions): Promise<string>;
  /** Idempotent: deleting a missing key is not an error. */
  delete(key: string): Promise<void>;
  /**
   * Server-side write of bytes the APP produced (tenant export zips,
   * later invoice PDFs). User uploads never come this way — they go
   * browser → bucket via presignPut so the app never streams them.
   */
  putObject(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** Server-side read (export packaging bundles file bytes); null when missing. */
  getObject(key: string): Promise<Uint8Array | null>;
  /** Multipart uploads are not issued in v1; the hook exists so the
   * reconciliation job can abort strays where the backend supports it. */
  abortMultipart?(key: string, uploadId: string): Promise<void>;
}

/** Guard against path traversal / odd keys before they reach any backend. */
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

export const assertStorageKey = (key: string): void => {
  if (!KEY_RE.test(key) || key.length > 512) {
    throw new Error(`storage: invalid key "${key}"`);
  }
};

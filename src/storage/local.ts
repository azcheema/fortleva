import { createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";

import { devStorageConfig, isProduction } from "@/config";

import {
  assertStorageKey,
  type HeadResult,
  type PresignGetOptions,
  type PresignPutOptions,
  type PresignedPut,
  type StorageTransport,
} from "./transport";

/**
 * Local-disk transport for development and tests. Bytes live under
 * .dev-storage/<key> (gitignored); "presigned" URLs are HMAC-signed
 * links to the dev-only route handler src/app/api/dev-storage/[...key].
 * Mirrors R2 semantics closely enough that the documents service does
 * not know which one it is talking to: PUT signs method + key + expiry
 * + Content-Type + Content-Length; GET signs method + key + expiry +
 * response headers. Refuses to run in production.
 */

const SIG_PARAM = "X-Dev-Signature";
const EXP_PARAM = "X-Dev-Expires";
const CT_PARAM = "X-Dev-Content-Type";
const CL_PARAM = "X-Dev-Content-Length";
const DISP_PARAM = "response-content-disposition";
const RCT_PARAM = "response-content-type";

const sign = (parts: readonly string[]): string =>
  createHmac("sha256", devStorageConfig.signingSecret).update(parts.join("\n")).digest("base64url");

const safeEqual = (a: string, b: string): boolean => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};

const assertNotProduction = (): void => {
  if (isProduction) throw new Error("LocalDiskTransport is dev-only");
};

export class LocalDiskTransport implements StorageTransport {
  readonly name = "local-disk" as const;
  private readonly root: string;

  constructor(root: string = join(process.cwd(), ".dev-storage")) {
    assertNotProduction();
    this.root = resolve(root);
  }

  /** Absolute on-disk path; the key grammar already forbids traversal. */
  pathFor(key: string): string {
    assertStorageKey(key);
    const p = resolve(this.root, ...key.split("/"));
    if (!p.startsWith(this.root)) throw new Error("storage: key escapes root");
    return p;
  }

  async presignPut(key: string, opts: PresignPutOptions): Promise<PresignedPut> {
    assertStorageKey(key);
    const exp = String(Math.floor(Date.now() / 1000) + opts.expiresSec);
    const url = devStorageConfig.urlFor(key);
    url.searchParams.set(EXP_PARAM, exp);
    url.searchParams.set(CT_PARAM, opts.contentType);
    url.searchParams.set(CL_PARAM, String(opts.contentLength));
    url.searchParams.set(
      SIG_PARAM,
      sign(["PUT", key, exp, opts.contentType, String(opts.contentLength)]),
    );
    return {
      url: url.toString(),
      headers: {
        "Content-Type": opts.contentType,
        "Content-Length": String(opts.contentLength),
      },
    };
  }

  async head(key: string): Promise<HeadResult | null> {
    try {
      const s = await stat(this.pathFor(key));
      if (!s.isFile()) return null;
      return { sizeBytes: s.size, etag: `${s.size}-${Math.floor(s.mtimeMs)}` };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  async presignGet(key: string, opts: PresignGetOptions): Promise<string> {
    assertStorageKey(key);
    const exp = String(Math.floor(Date.now() / 1000) + opts.expiresSec);
    const url = devStorageConfig.urlFor(key);
    url.searchParams.set(EXP_PARAM, exp);
    url.searchParams.set(DISP_PARAM, opts.responseContentDisposition);
    if (opts.responseContentType) url.searchParams.set(RCT_PARAM, opts.responseContentType);
    url.searchParams.set(
      SIG_PARAM,
      sign(["GET", key, exp, opts.responseContentDisposition, opts.responseContentType ?? ""]),
    );
    return url.toString();
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  // ── Route-handler halves (called by src/app/api/dev-storage) ──────

  /** Verify the signed query and store the body. 403 on any mismatch. */
  async handlePut(request: Request, key: string): Promise<Response> {
    assertNotProduction();
    const url = new URL(request.url);
    const exp = url.searchParams.get(EXP_PARAM) ?? "";
    const ct = url.searchParams.get(CT_PARAM) ?? "";
    const cl = url.searchParams.get(CL_PARAM) ?? "";
    const sig = url.searchParams.get(SIG_PARAM) ?? "";
    let expected: string;
    try {
      assertStorageKey(key);
      expected = sign(["PUT", key, exp, ct, cl]);
    } catch {
      return new Response("bad key", { status: 400 });
    }
    if (!sig || !safeEqual(sig, expected)) return new Response("bad signature", { status: 403 });
    if (Number(exp) * 1000 < Date.now()) return new Response("expired", { status: 403 });
    // Signed headers must be sent verbatim — like R2/S3 SigV4.
    if ((request.headers.get("content-type") ?? "") !== ct) {
      return new Response("content-type mismatch", { status: 403 });
    }
    const body = Buffer.from(await request.arrayBuffer());
    if (String(body.byteLength) !== cl) {
      return new Response("content-length mismatch", { status: 403 });
    }
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    return new Response(null, { status: 200 });
  }

  /** Verify the signed query and stream the bytes with the signed
   * response headers (always attachment in practice). */
  async handleGet(request: Request, key: string): Promise<Response> {
    assertNotProduction();
    const url = new URL(request.url);
    const exp = url.searchParams.get(EXP_PARAM) ?? "";
    const disp = url.searchParams.get(DISP_PARAM) ?? "";
    const rct = url.searchParams.get(RCT_PARAM) ?? "";
    const sig = url.searchParams.get(SIG_PARAM) ?? "";
    let expected: string;
    try {
      assertStorageKey(key);
      expected = sign(["GET", key, exp, disp, rct]);
    } catch {
      return new Response("bad key", { status: 400 });
    }
    if (!sig || !safeEqual(sig, expected)) return new Response("bad signature", { status: 403 });
    if (Number(exp) * 1000 < Date.now()) return new Response("expired", { status: 403 });
    const info = await this.head(key);
    if (!info) return new Response("not found", { status: 404 });
    const stream = Readable.toWeb(createReadStream(this.pathFor(key))) as ReadableStream;
    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Length": String(info.sizeBytes),
        "Content-Type": rct || "application/octet-stream",
        "Content-Disposition": disp || "attachment",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  }
}

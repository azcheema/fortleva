import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { r2Config } from "@/config";

import { LocalDiskTransport } from "./local";
import { R2Transport } from "./r2";
import { assertStorageKey, type StorageTransport } from "./transport";

/**
 * StorageTransport contract (PLAN.md 1b "storage transport contract
 * (local, and R2 when env exists)"). The same assertions run against
 * every transport; the "uploader" is a function so the local transport
 * can be exercised through its route-handler halves without HTTP and
 * R2 through a real fetch to the presigned URL.
 */

type Uploader = (url: string, headers: Record<string, string>, body: Uint8Array) => Promise<number>;
type Downloader = (url: string) => Promise<{ status: number; body: Uint8Array; headers: Headers }>;

const BODY = new TextEncoder().encode("hello, storage contract\n");

function contract(
  label: string,
  make: () => { transport: StorageTransport; upload: Uploader; download: Downloader },
) {
  describe(`StorageTransport contract: ${label}`, () => {
    const { transport, upload, download } = make();
    const key = `contract-test/${Date.now()}-${Math.random().toString(36).slice(2)}/file.txt`;

    it("head() of a missing key is null", async () => {
      expect(await transport.head(key)).toBeNull();
    });

    it("presignPut → PUT with the signed headers succeeds and head() sees the size", async () => {
      const put = await transport.presignPut(key, {
        contentType: "text/plain",
        contentLength: BODY.byteLength,
        expiresSec: 60,
      });
      expect(put.headers["Content-Type"]).toBe("text/plain");
      expect(put.headers["Content-Length"]).toBe(String(BODY.byteLength));
      const status = await upload(put.url, { ...put.headers }, BODY);
      expect(status).toBeGreaterThanOrEqual(200);
      expect(status).toBeLessThan(300);
      const head = await transport.head(key);
      expect(head?.sizeBytes).toBe(BODY.byteLength);
    });

    it("a PUT that violates the signed Content-Type or Content-Length is refused", async () => {
      const put = await transport.presignPut(`${key}.bad`, {
        contentType: "text/plain",
        contentLength: BODY.byteLength,
        expiresSec: 60,
      });
      const wrongType = await upload(put.url, { ...put.headers, "Content-Type": "text/html" }, BODY);
      expect(wrongType).toBeGreaterThanOrEqual(400);
      const wrongLength = await upload(put.url, { ...put.headers }, BODY.slice(0, 5));
      expect(wrongLength).toBeGreaterThanOrEqual(400);
      expect(await transport.head(`${key}.bad`)).toBeNull();
    });

    it("presignGet serves the bytes as an attachment with the requested type", async () => {
      const url = await transport.presignGet(key, {
        expiresSec: 60,
        responseContentDisposition: 'attachment; filename="file.txt"',
        responseContentType: "text/plain",
      });
      const res = await download(url);
      expect(res.status).toBe(200);
      expect(Buffer.from(res.body).equals(Buffer.from(BODY))).toBe(true);
      expect(res.headers.get("content-disposition")).toContain("attachment");
      expect(res.headers.get("content-type")).toContain("text/plain");
    });

    it("an expired presigned GET is refused", async () => {
      const url = await transport.presignGet(key, {
        expiresSec: -5,
        responseContentDisposition: "attachment",
      });
      const res = await download(url);
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it("delete() removes the object and is idempotent", async () => {
      await transport.delete(key);
      expect(await transport.head(key)).toBeNull();
      await expect(transport.delete(key)).resolves.toBeUndefined();
    });

    it("putObject/getObject round-trip server-produced bytes; getObject of a missing key is null", async () => {
      const k = `${key}-export`;
      const body = new TextEncoder().encode('{"schemaVersion":1}');
      await transport.putObject(k, body, "application/zip");
      expect((await transport.head(k))?.sizeBytes).toBe(body.byteLength);
      expect(Buffer.from((await transport.getObject(k))!).toString()).toBe('{"schemaVersion":1}');
      await transport.delete(k);
      expect(await transport.getObject(k)).toBeNull();
    });

    it("rejects traversal / malformed keys before touching the backend", async () => {
      for (const bad of ["../x", "a/../b", "/abs", "a//b", "", "a/.hidden"]) {
        await expect(transport.head(bad)).rejects.toThrow(/invalid key/);
      }
    });
  });
}

// ── Local disk: through the route-handler halves, no HTTP ────────────

const localDir = mkdtempSync(join(tmpdir(), "fortleva-storage-"));
afterAll(() => rmSync(localDir, { recursive: true, force: true }));

contract("LocalDiskTransport", () => {
  const transport = new LocalDiskTransport(localDir);
  const keyFromUrl = (url: string): string =>
    new URL(url).pathname
      .replace(/^\/api\/dev-storage\//, "")
      .split("/")
      .map(decodeURIComponent)
      .join("/");
  return {
    transport,
    upload: async (url, headers, body) => {
      const req = new Request(url, { method: "PUT", headers, body: Buffer.from(body) });
      return (await transport.handlePut(req, keyFromUrl(url))).status;
    },
    download: async (url) => {
      const res = await transport.handleGet(new Request(url), keyFromUrl(url));
      const body = new Uint8Array(await res.arrayBuffer());
      return { status: res.status, body, headers: res.headers };
    },
  };
});

describe("LocalDiskTransport signatures", () => {
  it("a tampered signature is refused even for a valid key", async () => {
    const t = new LocalDiskTransport(localDir);
    const put = await t.presignPut("sig/test.txt", {
      contentType: "text/plain",
      contentLength: 3,
      expiresSec: 60,
    });
    const url = new URL(put.url);
    url.searchParams.set("X-Dev-Signature", "AAAA");
    const res = await t.handlePut(
      new Request(url, { method: "PUT", headers: put.headers, body: "abc" }),
      "sig/test.txt",
    );
    expect(res.status).toBe(403);
    expect(await t.head("sig/test.txt")).toBeNull();
  });

  it("assertStorageKey accepts the documents-service key shape", () => {
    expect(() =>
      assertStorageKey("0198f0a1-1111-7000-8000-000000000000/0198f0a1-2222-7000-8000-000000000000"),
    ).not.toThrow();
  });
});

// ── R2: only when the env is present ─────────────────────────────────

if (r2Config) {
  const cfg = r2Config;
  contract("R2Transport", () => ({
    transport: new R2Transport(cfg),
    upload: async (url, headers, body) => {
      const res = await fetch(url, { method: "PUT", headers, body: Buffer.from(body) });
      return res.status;
    },
    download: async (url) => {
      const res = await fetch(url);
      return { status: res.status, body: new Uint8Array(await res.arrayBuffer()), headers: res.headers };
    },
  }));
} else {
  console.log("[storage.test] R2_* env vars absent — R2Transport contract skipped");
  describe.skip("StorageTransport contract: R2Transport (R2_* env absent)", () => {
    it("skipped", () => undefined);
  });
}

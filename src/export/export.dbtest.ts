import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/* eslint-disable no-restricted-imports -- dbtest setup/cleanup uses the raw layer */
import { getPlatformClient } from "@/db/client";
import { withTenant } from "@/db";
import { createClient } from "@/clients/service";
import { getActiveTenantDek } from "@/crypto/tenant-key";
import { commitUpload, createUpload, getDownloadUrl } from "@/documents/service";
import { setupTenant } from "@/members/dbtest-fixture";
import { createProject } from "@/projects/service";
import { LocalDiskTransport, setStorage } from "@/storage";

import { EXPORT_MODELS, type ExportManifest } from "./manifest";
import { generateTenantExport, listExports, type ExportCtx } from "./service";

/**
 * Export v0 round-trip against the real DB as app_runtime (RLS live)
 * with the local-disk transport: export → unzip in memory → the manifest
 * covers every census model, per-model row counts match what the DB
 * holds for THIS tenant, a second tenant's rows never appear, encrypted
 * columns are absent, file bytes are bundled, and the audit trail is
 * export.requested → export.generated → export.downloaded.
 */

let a: Awaited<ReturnType<typeof setupTenant>>;
let b: Awaited<ReturnType<typeof setupTenant>>;
let ctxA: ExportCtx;
let storage: LocalDiskTransport;
const storageDir = mkdtempSync(join(tmpdir(), "fortleva-export-"));
const platform = () => getPlatformClient();
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

let clientA = "";
let clientB = "";

beforeAll(async () => {
  storage = new LocalDiskTransport(storageDir);
  setStorage(storage);
  a = await setupTenant("exp-a");
  b = await setupTenant("exp-b");
  ctxA = { tenantId: a.tenantId, actor: a.seats.owner.actor };

  // Tenant A: a client, a project, an uploaded internal document; a bank
  // field on the tenant row that must NOT leave.
  clientA = (await createClient(ctxA, { name: "Acme A" })).id;
  await createProject(ctxA, { clientId: clientA, key: "ACME", name: "Acme site" });
  await platform().tenant.update({ where: { id: a.tenantId }, data: { iban: "v2.enc.SE00" } });
  // Materialise the tenant's DEK row so the wrappedDek exclusion is exercised.
  await withTenant(a.tenantId, { type: "member", id: a.seats.owner.memberId }, (tx) =>
    getActiveTenantDek(tx, a.tenantId),
  );
  const body = "hello export\n";
  const up = await createUpload(ctxA, {
    name: "notes.txt",
    contentType: "text/plain",
    sizeBytes: body.length,
    sha256: sha(body),
  });
  const key = new URL(up.uploadUrl).pathname
    .replace(/^\/api\/dev-storage\//, "")
    .split("/")
    .map(decodeURIComponent)
    .join("/");
  const put = await storage.handlePut(
    new Request(up.uploadUrl, { method: "PUT", headers: up.headers, body }),
    key,
  );
  expect(put.status).toBe(200);
  await commitUpload(ctxA, { fileObjectId: up.fileObjectId, clientId: clientA });

  // Tenant B: its own client — the canary that must never appear in A's export.
  const ctxB: ExportCtx = { tenantId: b.tenantId, actor: b.seats.owner.actor };
  clientB = (await createClient(ctxB, { name: "Beta Canary B" })).id;
});

afterAll(async () => {
  const p = platform();
  for (const tenantId of [a.tenantId, b.tenantId]) {
    await p.fileVersion.deleteMany({ where: { tenantId } });
    await p.document.deleteMany({ where: { tenantId } });
    await p.fileObject.deleteMany({ where: { tenantId } });
    await p.memberProject.deleteMany({ where: { tenantId } });
    await p.memberClient.deleteMany({ where: { tenantId } });
    await p.project.deleteMany({ where: { tenantId } });
    await p.client.deleteMany({ where: { tenantId } });
  }
  await p.tenantKey.deleteMany({ where: { tenantId: { in: [a.tenantId, b.tenantId] } } });
  await b.cleanup();
  await a.cleanup();
  setStorage(null);
  rmSync(storageDir, { recursive: true, force: true });
});

const unzip = async (r2Key: string) => {
  const bytes = await storage.getObject(r2Key);
  expect(bytes).not.toBeNull();
  const entries = unzipSync(bytes!);
  const manifest = JSON.parse(strFromU8(entries["manifest.json"]!)) as ExportManifest;
  const rows = (path: string): Record<string, unknown>[] =>
    strFromU8(entries[path]!)
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { entries, manifest, rows };
};

describe("generateTenantExport", () => {
  it("✦ tenant:export: an actor without a fresh factor is sent to step-up; an employee is FORBIDDEN", async () => {
    await expect(
      generateTenantExport({ tenantId: a.tenantId, actor: { memberId: a.seats.owner.memberId } }),
    ).rejects.toMatchObject({ reason: "MFA_REQUIRED" });
    await expect(
      generateTenantExport({ tenantId: a.tenantId, actor: a.seats.employee.actor }),
    ).rejects.toMatchObject({ reason: "FORBIDDEN" });
    expect(await platform().document.count({ where: { tenantId: a.tenantId, kind: "EXPORT" } })).toBe(0);
  });

  it("round-trips: manifest covers the census, row counts match, tenant B never appears, secrets absent, bytes bundled", async () => {
    const result = await generateTenantExport(ctxA);
    expect(result.name).toMatch(/^export-\d{4}-\d{2}-\d{2}\.zip$/);

    const fo = await platform().fileObject.findUniqueOrThrow({ where: { id: result.fileObjectId } });
    expect(fo.kind).toBe("EXPORT");
    expect(fo.status).toBe("COMMITTED");
    expect(Number(fo.sizeBytes)).toBe(result.sizeBytes);
    expect(fo.sha256).toBe(result.sha256);
    const doc = await platform().document.findUniqueOrThrow({ where: { id: result.documentId } });
    expect(doc.kind).toBe("EXPORT");
    expect(doc.visibility).toBe("INTERNAL");
    expect(doc.clientId).toBeNull();

    const { entries, manifest, rows } = await unzip(fo.r2Key);
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.tenantId).toBe(a.tenantId);

    // Every census model has a manifest entry AND a data file.
    const byName = new Map(manifest.models.map((m) => [m.name, m]));
    for (const spec of EXPORT_MODELS) {
      const m = byName.get(spec.model);
      expect(m, spec.model).toBeDefined();
      expect(entries[m!.path], m!.path).toBeDefined();
      expect(rows(m!.path).length).toBe(m!.rowCount);
      expect(m!.sha256).toBe(sha(strFromU8(entries[m!.path]!)));
    }

    // Row counts match the DB for THIS tenant (platform view = ground truth).
    const p = platform();
    const expectCount = async (name: string, n: number) => expect(byName.get(name)!.rowCount, name).toBe(n);
    await expectCount("tenant", 1);
    await expectCount("client", await p.client.count({ where: { tenantId: a.tenantId } }));
    await expectCount("project", await p.project.count({ where: { tenantId: a.tenantId } }));
    await expectCount("member", await p.member.count({ where: { tenantId: a.tenantId } }));
    await expectCount("role", await p.role.count({ where: { tenantId: a.tenantId } }));
    await expectCount("rolePermission", await p.rolePermission.count({ where: { tenantId: a.tenantId } }));
    await expectCount("tenantKey", await p.tenantKey.count({ where: { tenantId: a.tenantId } }));
    // The document dump was taken BEFORE the export document was registered.
    await expectCount("document", 1);
    await expectCount("fileObject", 1);
    expect(byName.get("client")!.rowCount).toBe(1);

    // Tenant B's canary is nowhere in the archive.
    const everything = Object.entries(entries)
      .filter(([k]) => k.endsWith(".jsonl") || k === "manifest.json")
      .map(([, v]) => strFromU8(v))
      .join("\n");
    expect(everything).not.toContain(b.tenantId);
    expect(everything).not.toContain(clientB);
    expect(everything).not.toContain("Beta Canary B");
    expect(everything).toContain(clientA);

    // Encrypted columns / key material are stripped.
    const tenantRow = rows("data/tenant.jsonl")[0]!;
    expect(tenantRow.id).toBe(a.tenantId);
    for (const c of ["iban", "bic", "bankgiro", "plusgiro", "databaseUrl"]) expect(c in tenantRow).toBe(false);
    expect(everything).not.toContain("v2.enc.SE00");
    const keyRow = rows("data/tenant_key.jsonl")[0]!;
    expect(keyRow.keyId).toBeDefined();
    expect("wrappedDek" in keyRow).toBe(false);

    // Audit rows of the tenant are included, and the export.requested row
    // written at the start of the dump is among them.
    const audit = rows("data/audit_event.jsonl");
    expect(audit.some((r) => r.action === "export.requested")).toBe(true);
    expect(audit.every((r) => r.tenantId === a.tenantId && r.visibility === "TENANT")).toBe(true);

    // File bytes: bundled (well under 200 MB), sha matches, manifest says so.
    expect(manifest.includesFileBytes).toBe(true);
    expect(manifest.files.length).toBe(1);
    const f = manifest.files[0]!;
    expect(f.path).toBeDefined();
    const bundled = strFromU8(entries[f.path!]!);
    expect(bundled).toBe("hello export\n");
    expect(sha(bundled)).toBe(f.sha256);

    // Audit trail + meter.
    const actions = (await a.audits("export.generated")).map((e) => e.action);
    expect(actions).toEqual(["export.generated"]);
    const gen = (await a.audits("export.generated"))[0]!;
    expect((gen.metadata as { includesFileBytes: boolean }).includesFileBytes).toBe(true);
    const tenant = await p.tenant.findUniqueOrThrow({ where: { id: a.tenantId } });
    expect(Number(tenant.storageUsedBytes)).toBe("hello export\n".length + result.sizeBytes);
  });

  it("a second export lists both, newest first, and does NOT bundle the earlier export's bytes", async () => {
    const second = await generateTenantExport(ctxA);
    const list = await listExports(ctxA);
    expect(list.length).toBe(2);
    expect(list[0]!.documentId).toBe(second.documentId);
    const fo = await platform().fileObject.findUniqueOrThrow({ where: { id: second.fileObjectId } });
    const { manifest } = await unzip(fo.r2Key);
    // Two committed file objects now (the upload + export #1)…
    expect(manifest.files.length).toBe(2);
    // …but only the upload's bytes are inside; export #1 is a pointer.
    const paths = manifest.files.filter((f) => f.path);
    expect(paths.length).toBe(1);
    expect(manifest.files.find((f) => !f.path)!.r2Key).toMatch(new RegExp(`^${a.tenantId}/`));
    // The document census now includes export #1's document row.
    expect(manifest.models.find((m) => m.name === "document")!.rowCount).toBe(2);
  });

  it("listExports needs settings:view (employee: FORBIDDEN); download records export.downloaded", async () => {
    await expect(
      listExports({ tenantId: a.tenantId, actor: a.seats.employee.actor }),
    ).rejects.toMatchObject({ reason: "FORBIDDEN" });
    const [latest] = await listExports(ctxA);
    const dl = await getDownloadUrl(ctxA, latest!.documentId);
    expect(dl.filename).toBe(latest!.name);
    const downloaded = await platform().auditEvent.findMany({
      where: { tenantId: a.tenantId, action: "export.downloaded", targetId: latest!.documentId },
    });
    expect(downloaded.length).toBe(1);
  });

  it("tenant B's export contains only tenant B", async () => {
    const ctxB: ExportCtx = { tenantId: b.tenantId, actor: b.seats.owner.actor };
    const r = await generateTenantExport(ctxB);
    const fo = await platform().fileObject.findUniqueOrThrow({ where: { id: r.fileObjectId } });
    const { manifest, rows } = await unzip(fo.r2Key);
    expect(manifest.tenantId).toBe(b.tenantId);
    const clients = rows("data/client.jsonl");
    expect(clients.map((c) => c.id)).toEqual([clientB]);
    expect(rows("data/project.jsonl")).toEqual([]);
    // Cross-check via a tenant-scoped read: what B can see is what B got.
    const seen = await withTenant(b.tenantId, { type: "member", id: b.seats.owner.memberId }, (tx) =>
      tx.client.count(),
    );
    expect(seen).toBe(clients.length);
  });
});

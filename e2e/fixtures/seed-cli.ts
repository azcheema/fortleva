/**
 * Fixture worker for the browser harness — the ONLY place the e2e suite
 * touches the database.
 *
 * It runs under tsx in its own process because the generated Prisma
 * client is ESM (`import.meta`) and Playwright transpiles test files to
 * CommonJS; the DB suite reaches the same code through Vite. Keeping
 * the data work here also keeps every Prisma connection out of the test
 * workers.
 *
 * DATA SAFETY (see e2e/fixtures/tenant.ts for the full contract):
 * everything is created inside a tenant this file provisions, slug
 * "e2e-" + random suffix, and `teardown` refuses any tenant whose slug
 * is not "e2e-"-prefixed. The owner password arrives in an env var,
 * lives in memory, and is never written or printed.
 *
 * Usage: tsx e2e/fixtures/seed-cli.ts <provision|teardown> <seedFile>
 *        tsx e2e/fixtures/seed-cli.ts visibility <documentId>
 *        tsx e2e/fixtures/seed-cli.ts set-visibility <documentId> <value>
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

const SLUG_PREFIX = "e2e-";
const EMAIL_DOMAIN = "@test.invalid";
/** Single-line, machine-readable result channel (stdout also carries logs). */
const MARKER = "__E2E_RESULT__";

export type E2ESeed = {
  readonly tenantId: string;
  readonly tenantSlug: string;
  readonly userId: string;
  readonly email: string;
  readonly memberId: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly projectId: string;
  readonly projectKey: string;
  readonly milestoneId: string;
  /** Seeded CLIENT_VISIBLE document — the one BUG 1 is reproduced on. */
  readonly clientVisibleDocId: string;
  readonly clientVisibleDocName: string;
  /** Seeded INTERNAL document — the reverse direction. */
  readonly internalDocId: string;
  readonly internalDocName: string;
  /** Temp dir holding the fixture's bytes; removed at teardown. */
  readonly storageDir: string;
};

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

async function provision(seedFile: string): Promise<void> {
  const password = process.env["E2E_OWNER_PASSWORD"];
  if (!password) throw new Error("E2E_OWNER_PASSWORD is not set");

  const { hashPassword } = await import("better-auth/crypto");
  const { getPlatformClient } = await import("../../src/db/client");
  const { provisionTenant } = await import("../../src/members/provisioning");
  const { createClient } = await import("../../src/clients/service");
  const { createProject } = await import("../../src/projects/service");
  const { createMilestone } = await import("../../src/projects/milestones");
  const { commitUpload, createUpload } = await import("../../src/documents/service");
  const { LocalDiskTransport, setStorage } = await import("../../src/storage");

  const run = randomUUID().slice(0, 8);
  const slug = `${SLUG_PREFIX}${run}`;
  const email = `e2e-owner-${run}${EMAIL_DOMAIN}`;
  const storageDir = join(tmpdir(), `fortleva-e2e-${run}`);
  mkdirSync(storageDir, { recursive: true });
  // Set before anything can call getStorage(): the fixture's bytes live
  // in a temp dir of their own, never in the repo's .dev-storage.
  const storage = new LocalDiskTransport(storageDir);
  setStorage(storage);

  const db = getPlatformClient();
  const user = await db.user.create({
    data: { name: "E2E Owner", email, emailVerified: true, locale: "en" },
  });
  await db.account.create({
    data: {
      userId: user.id,
      providerId: "credential",
      accountId: user.id,
      password: await hashPassword(password),
    },
  });

  const { tenantId, ownerMemberId } = await provisionTenant({
    name: `E2E ${run}`,
    slug,
    ownerUserId: user.id,
  });

  // Seeding runs as the owner would: no ✦ code is involved, so the
  // browser session (which has no TOTP) can do the same work.
  const ctx = {
    tenantId,
    actor: { memberId: ownerMemberId, mfa: { enrolled: false, verifiedAt: null } },
  };

  const clientName = `E2E Client ${run}`;
  const { id: clientId } = await createClient(ctx, { name: clientName });
  const { id: projectId, key: projectKey } = await createProject(ctx, {
    clientId,
    key: `E${run.slice(0, 3).toUpperCase()}`,
    name: `E2E Project ${run}`,
  });
  const { id: milestoneId } = await createMilestone(ctx, {
    projectId,
    name: `E2E Milestone ${run}`,
  });

  const document = async (name: string, visibility: "INTERNAL" | "CLIENT_VISIBLE") => {
    const body = new TextEncoder().encode(`${name}\n`);
    const presigned = await createUpload(ctx, {
      name,
      contentType: "text/plain",
      sizeBytes: body.byteLength,
      sha256: sha256(body),
      clientId,
      visibility,
    });
    // The browser's half of the upload, performed in process.
    const key = new URL(presigned.uploadUrl).pathname
      .replace(/^\/api\/dev-storage\//, "")
      .split("/")
      .map(decodeURIComponent)
      .join("/");
    const res = await storage.handlePut(
      new Request(presigned.uploadUrl, {
        method: "PUT",
        headers: { ...presigned.headers },
        body: Buffer.from(body),
      }),
      key,
    );
    if (res.status !== 200) throw new Error(`fixture upload failed: ${res.status}`);
    const { documentId } = await commitUpload(ctx, {
      fileObjectId: presigned.fileObjectId,
      clientId,
      visibility,
    });
    return documentId;
  };

  const clientVisibleDocName = `e2e-shared-${run}.txt`;
  const internalDocName = `e2e-private-${run}.txt`;
  const seed: E2ESeed = {
    tenantId,
    tenantSlug: slug,
    userId: user.id,
    email,
    memberId: ownerMemberId,
    clientId,
    clientName,
    projectId,
    projectKey,
    milestoneId,
    clientVisibleDocId: await document(clientVisibleDocName, "CLIENT_VISIBLE"),
    clientVisibleDocName,
    internalDocId: await document(internalDocName, "INTERNAL"),
    internalDocName,
    storageDir,
  };

  mkdirSync(dirname(seedFile), { recursive: true });
  writeFileSync(seedFile, JSON.stringify(seed, null, 2), "utf8");
  await db.$disconnect();
  process.stdout.write(`${MARKER}${JSON.stringify({ tenantSlug: slug })}\n`);
}

/**
 * Remove everything the fixture created — rows first, then the tenant,
 * the owner (sessions and credentials cascade) and the audit trail.
 */
async function teardown(seedFile: string): Promise<void> {
  let seed: E2ESeed;
  try {
    seed = JSON.parse(readFileSync(seedFile, "utf8")) as E2ESeed;
  } catch {
    process.stdout.write(`${MARKER}{"removed":false}\n`);
    return;
  }
  const { getPlatformClient } = await import("../../src/db/client");
  const db = getPlatformClient();
  const { tenantId } = seed;

  const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { slug: true } });
  if (tenant && !tenant.slug.startsWith(SLUG_PREFIX)) {
    throw new Error(`refusing to tear down non-throwaway tenant "${tenant.slug}"`);
  }

  await db.fileVersion.deleteMany({ where: { tenantId } });
  await db.document.deleteMany({ where: { tenantId } });
  await db.fileObject.deleteMany({ where: { tenantId } });
  await db.milestone.deleteMany({ where: { tenantId } });
  await db.projectVersion.deleteMany({ where: { tenantId } });
  await db.service.deleteMany({ where: { tenantId } });
  await db.memberProject.deleteMany({ where: { tenantId } });
  await db.memberClient.deleteMany({ where: { tenantId } });
  await db.contact.deleteMany({ where: { tenantId } });
  await db.project.deleteMany({ where: { tenantId } });
  await db.client.deleteMany({ where: { tenantId } });
  await db.memberInvite.deleteMany({ where: { tenantId } });
  await db.memberRole.deleteMany({ where: { tenantId } });
  await db.rolePermission.deleteMany({ where: { tenantId } });
  await db.role.deleteMany({ where: { tenantId } });
  await db.member.deleteMany({ where: { tenantId } });
  if (tenant) await db.tenant.delete({ where: { id: tenantId } });
  if (seed.email.endsWith(EMAIL_DOMAIN)) {
    await db.user.deleteMany({ where: { id: seed.userId, email: seed.email } });
  }
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.audit_maintenance', 'on', true)`;
    await tx.auditEvent.deleteMany({ where: { tenantId } });
  });
  await db.$disconnect();

  rmSync(seed.storageDir, { recursive: true, force: true });
  rmSync(seedFile, { force: true });
  process.stdout.write(`${MARKER}{"removed":true}\n`);
}

/**
 * Put a seeded document back to a known visibility so each spec starts
 * from the same fixture, whatever the previous one changed or left
 * behind after a failure. Throwaway tenant only, like everything here.
 */
async function setVisibility(documentId: string, value: string): Promise<void> {
  if (value !== "INTERNAL" && value !== "CLIENT_VISIBLE") {
    throw new Error(`bad visibility "${value}"`);
  }
  const { getPlatformClient } = await import("../../src/db/client");
  const db = getPlatformClient();
  const doc = await db.document.findUniqueOrThrow({
    where: { id: documentId },
    select: { tenantId: true },
  });
  const tenant = await db.tenant.findUniqueOrThrow({
    where: { id: doc.tenantId },
    select: { slug: true },
  });
  if (!tenant.slug.startsWith(SLUG_PREFIX)) {
    throw new Error(`refusing to write outside a throwaway tenant ("${tenant.slug}")`);
  }
  await db.document.update({ where: { id: documentId }, data: { visibility: value } });
  await db.$disconnect();
  process.stdout.write(`${MARKER}${JSON.stringify({ visibility: value })}
`);
}

/** The DB half of the visibility assertions. */
async function visibility(documentId: string): Promise<void> {
  const { getPlatformClient } = await import("../../src/db/client");
  const db = getPlatformClient();
  const doc = await db.document.findUniqueOrThrow({
    where: { id: documentId },
    select: { visibility: true },
  });
  await db.$disconnect();
  process.stdout.write(`${MARKER}${JSON.stringify({ visibility: doc.visibility })}\n`);
}

const [command, argument] = process.argv.slice(2);

const main = async (): Promise<void> => {
  if (command === "provision") return provision(argument!);
  if (command === "teardown") return teardown(argument!);
  if (command === "visibility") return visibility(argument!);
  if (command === "set-visibility") return setVisibility(argument!, process.argv[4]!);
  throw new Error(`unknown command "${command ?? ""}"`);
};

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});

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
 *        tsx e2e/fixtures/seed-cli.ts milestone <milestoneId>
 *        tsx e2e/fixtures/seed-cli.ts sweep [maxAgeMinutes]
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
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

type PlatformDb = ReturnType<typeof import("../../src/db/client").getPlatformClient>;

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
  /**
   * A milestone that HAS a due date and is CLIENT_VISIBLE — the subject
   * of hazard H1's round-trip test: editing its name through an inline
   * edit must leave both of those columns untouched.
   */
  readonly datedMilestoneId: string;
  readonly datedMilestoneName: string;
  /** Seeded CLIENT_VISIBLE document — the one BUG 1 is reproduced on. */
  readonly clientVisibleDocId: string;
  readonly clientVisibleDocName: string;
  /** Seeded INTERNAL document — the reverse direction. */
  readonly internalDocId: string;
  readonly internalDocName: string;
  /** Temp dir holding the fixture's bytes; removed at teardown. */
  readonly storageDir: string;

  /* ── Visual-sweep fixture (e2e/visual.spec.ts) ──────────────────────
   * A one-row table hides every alignment defect there is, and an
   * empty state that is empty because nothing was seeded proves
   * nothing. These rows exist so the screenshots show the app as a
   * working workspace looks: several clients (one archived, one with a
   * name long enough to truncate), projects in three statuses,
   * contacts, services, milestones with and without dates, documents
   * at both visibilities and at all three scopes, and one pending
   * invitation — which is also what /invite/[token] renders. */
  readonly longClientId: string;
  readonly longClientName: string;
  readonly archivedClientId: string;
  /** ACTIVE project, carries a production URL (header action button). */
  readonly activeProjectKey: string;
  /** COMPLETED project — the third status badge in the list. */
  readonly completedProjectKey: string;
  /** Tenant-scoped document: no client, no project, INTERNAL by law. */
  readonly tenantDocId: string;
  /** Project-scoped CLIENT_VISIBLE document (project Files tab). */
  readonly projectDocId: string;
  /**
   * Raw token of a PENDING invitation into the throwaway tenant. It is
   * worthless the moment teardown deletes the row, it is never printed,
   * and it lives only in the gitignored seed file.
   */
  readonly inviteToken: string;
  readonly inviteEmail: string;
};

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

async function provision(seedFile: string): Promise<void> {
  const password = process.env["E2E_OWNER_PASSWORD"];
  if (!password) throw new Error("E2E_OWNER_PASSWORD is not set");

  const { hashPassword } = await import("better-auth/crypto");
  const { getPlatformClient } = await import("../../src/db/client");
  const { provisionTenant } = await import("../../src/members/provisioning");
  const { archiveClient, createClient, createContact, updateClient } = await import(
    "../../src/clients/service"
  );
  const { createProject, updateProject } = await import("../../src/projects/service");
  const { createService } = await import("../../src/services/service");
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

  /**
   * `scope` is the document's owner: a client, a project, or neither
   * (tenant-wide, which the model only allows to be INTERNAL).
   */
  const document = async (
    name: string,
    visibility: "INTERNAL" | "CLIENT_VISIBLE",
    scope: { clientId?: string; projectId?: string } = { clientId },
  ) => {
    const body = new TextEncoder().encode(`${name}\n`);
    const presigned = await createUpload(ctx, {
      name,
      contentType: "text/plain",
      sizeBytes: body.byteLength,
      sha256: sha256(body),
      ...scope,
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
      ...scope,
      visibility,
    });
    return documentId;
  };

  // ── Visual-sweep fixture ───────────────────────────────────────────
  // Everything below exists so the screenshots show populated tables,
  // several statuses and a real invitation rather than a workspace of
  // one row. All of it is inside the throwaway tenant and all of it is
  // removed by teardown() below.
  await updateClient(ctx, clientId, {
    orgNr: "556677-8899",
    city: "Stockholm",
    countryCode: "SE",
    billingEmail: `billing-${run}${EMAIL_DOMAIN}`,
  });

  const longClientName = `Långnamn Förvaltning & Digital Byrå Aktiebolag ${run}`;
  const { id: longClientId } = await createClient(ctx, {
    name: longClientName,
    city: "Göteborg",
    countryCode: "SE",
  });
  const { id: archivedClientId } = await createClient(ctx, { name: `E2E Archived ${run}` });
  await archiveClient(ctx, archivedClientId);

  await createContact(ctx, clientId, {
    name: "Astrid Lindqvist",
    email: `astrid-${run}${EMAIL_DOMAIN}`,
    title: "Marknadschef",
    phone: "+46 70 123 45 67",
    portalProfile: "CONTACT_PRIMARY",
  });
  await createContact(ctx, clientId, {
    name: "Bo Nilsson",
    email: `bo-${run}${EMAIL_DOMAIN}`,
    title: "Utvecklare",
    portalProfile: "CONTACT_COLLABORATOR",
  });

  const { id: activeProjectId, key: activeProjectKey } = await createProject(ctx, {
    clientId,
    key: `A${run.slice(0, 3).toUpperCase()}`,
    name: `Webbplats ${run}`,
    type: "Website",
    status: "ACTIVE",
  });
  await updateProject(ctx, activeProjectId, {
    productionUrl: "https://example.invalid",
    scopeSummary: "Ny webbplats, tre språk, e-handel.",
  });
  const { key: completedProjectKey } = await createProject(ctx, {
    clientId: longClientId,
    key: `C${run.slice(0, 3).toUpperCase()}`,
    name: `Designsystem ${run}`,
    status: "COMPLETED",
  });

  const day = 24 * 60 * 60 * 1000;
  const datedMilestoneName = "Designgranskning";
  const { id: datedMilestoneId } = await createMilestone(ctx, {
    projectId,
    name: datedMilestoneName,
    description: "Genomgång av flöden och komponenter med kunden.",
    dueAt: new Date(Date.now() - 14 * day),
    visibility: "CLIENT_VISIBLE",
  });
  await createMilestone(ctx, {
    projectId,
    name: "Lansering",
    dueAt: new Date(Date.now() + 21 * day),
  });

  await createService(ctx, {
    clientId,
    name: "Förvaltning",
    description: "Löpande underhåll, säkerhetsuppdateringar och support.",
    kind: "RECURRING",
    billingInterval: "MONTHLY",
    priceExVat: "7500.00",
    currency: "SEK",
    startedAt: new Date(Date.now() - 200 * day),
    renewsAt: new Date(Date.now() + 30 * day),
  });
  await createService(ctx, {
    clientId,
    projectId: activeProjectId,
    name: "Migrering",
    kind: "ONE_TIME",
    priceExVat: "42000.00",
    currency: "SEK",
  });

  // The invitation row is written directly rather than through
  // createInvite(): the service also sends mail, and a fixture must not
  // leave an envelope in .dev-outbox behind. Same columns, same hash.
  const inviteToken = randomBytes(32).toString("base64url");
  const inviteEmail = `e2e-invitee-${run}${EMAIL_DOMAIN}`;
  await db.memberInvite.create({
    data: {
      tenantId,
      email: inviteEmail,
      proposedRoleIds: [],
      tokenHash: createHash("sha256").update(inviteToken).digest("hex"),
      invitedByMemberId: ownerMemberId,
      expiresAt: new Date(Date.now() + 7 * day),
    },
  });

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
    datedMilestoneId,
    datedMilestoneName,
    clientVisibleDocId: await document(clientVisibleDocName, "CLIENT_VISIBLE"),
    clientVisibleDocName,
    internalDocId: await document(internalDocName, "INTERNAL"),
    internalDocName,
    storageDir,
    longClientId,
    longClientName,
    archivedClientId,
    activeProjectKey,
    completedProjectKey,
    tenantDocId: await document(`e2e-tenant-${run}.txt`, "INTERNAL", {}),
    projectDocId: await document(`e2e-projekt-${run}.txt`, "CLIENT_VISIBLE", { projectId }),
    inviteToken,
    inviteEmail,
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
/**
 * Delete every row a throwaway tenant owns, then the tenant itself.
 * Guarded twice: the caller must have matched the slug prefix, and this
 * refuses anything else outright. Audit rows need the maintenance GUC —
 * the table is append-only to every ordinary path.
 */
async function removeTenant(
  db: PlatformDb,
  tenantId: string,
  slug: string,
): Promise<void> {
  if (!slug.startsWith(SLUG_PREFIX)) {
    throw new Error(`refusing to remove non-throwaway tenant "${slug}"`);
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
  const members = await db.member.findMany({ where: { tenantId }, select: { userId: true } });
  await db.member.deleteMany({ where: { tenantId } });
  await db.tenant.deleteMany({ where: { id: tenantId } });
  for (const { userId } of members) {
    await db.user.deleteMany({
      where: { id: userId, email: { endsWith: EMAIL_DOMAIN }, memberships: { none: {} } },
    });
  }
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.audit_maintenance', 'on', true)`;
    await tx.auditEvent.deleteMany({ where: { tenantId } });
  });

  // Prove it. Reporting a teardown that did not happen is worse than
  // failing: eight orphaned tenants accumulated in the shared dev
  // database behind a "torn down" log line before this check existed.
  const survivor = await db.tenant.findUnique({ where: { id: tenantId }, select: { slug: true } });
  if (survivor) {
    throw new Error(`teardown did not remove throwaway tenant "${survivor.slug}" (${tenantId})`);
  }
}

/**
 * Sweep throwaway tenants an interrupted run left behind. Teardown is
 * keyed on a seed file, so a killed process (or a webServer that dies
 * mid-suite) orphans its tenant; without this they accumulate in the
 * shared dev database. Only "e2e-"-prefixed tenants older than the age
 * guard are touched, so a concurrent run is never harmed.
 */
async function sweep(maxAgeMinutesRaw: string | undefined): Promise<void> {
  const maxAgeMinutes = Number(maxAgeMinutesRaw ?? 60);
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60_000);
  const { getPlatformClient } = await import("../../src/db/client");
  const db = getPlatformClient();
  const stale = await db.tenant.findMany({
    where: { slug: { startsWith: SLUG_PREFIX }, createdAt: { lt: cutoff } },
    select: { id: true, slug: true },
  });
  for (const t of stale) await removeTenant(db, t.id, t.slug);
  await db.$disconnect();
  process.stdout.write(`${MARKER}{"swept":${stale.length}}
`);
}

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

  await removeTenant(db, tenantId, tenant?.slug ?? seed.tenantSlug);
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

/**
 * The three columns an inline edit of a milestone must NOT disturb.
 *
 * Hazard H1: `AutoForm` posts the whole FormData, and `updateMilestone`
 * used to read an absent field as an erase — so editing the name alone
 * could blank the due date and reset the visibility to INTERNAL. This
 * is the read side of that regression test.
 */
async function milestone(milestoneId: string): Promise<void> {
  const { getPlatformClient } = await import("../../src/db/client");
  const db = getPlatformClient();
  const row = await db.milestone.findUniqueOrThrow({
    where: { id: milestoneId },
    select: { name: true, dueAt: true, visibility: true },
  });
  await db.$disconnect();
  process.stdout.write(
    `${MARKER}${JSON.stringify({
      name: row.name,
      dueAt: row.dueAt ? row.dueAt.toISOString() : null,
      visibility: row.visibility,
    })}
`,
  );
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
  if (command === "milestone") return milestone(argument!);
  if (command === "sweep") return sweep(argument);
  throw new Error(`unknown command "${command ?? ""}"`);
};

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});

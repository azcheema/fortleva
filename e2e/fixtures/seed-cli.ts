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
 * everything the BROWSER harness creates lives inside a tenant this file
 * provisions, slug "e2e-" + random suffix. The owner password arrives in
 * an env var, lives in memory, and is never written or printed.
 *
 * `removeTenant` — which `teardown`, `sweep` and `sweep-dbtests` all go
 * through — carries TWO guards, and it is worth being precise about
 * them because one of them used to be the only one: the slug must match
 * the "e2e-" prefix OR the explicit DBTEST_PREFIXES allow-list below,
 * AND the tenant must hold no member whose email is outside
 * "@test.invalid". The second is the guard that actually matters: a slug
 * is a naming convention, a real address is evidence.
 *
 * Usage: tsx e2e/fixtures/seed-cli.ts <provision|teardown> <seedFile>
 *        tsx e2e/fixtures/seed-cli.ts visibility <documentId>
 *        tsx e2e/fixtures/seed-cli.ts set-visibility <documentId> <value>
 *        tsx e2e/fixtures/seed-cli.ts milestone <milestoneId>
 *        tsx e2e/fixtures/seed-cli.ts big-project <tenantId> [size]
 *        tsx e2e/fixtures/seed-cli.ts drop-project <projectId>
 *        tsx e2e/fixtures/seed-cli.ts portal-requests <tenantId>
 *        tsx e2e/fixtures/seed-cli.ts clear-portal-requests <tenantId> <contactEmail>
 *        tsx e2e/fixtures/seed-cli.ts notifications <tenantId>
 *        tsx e2e/fixtures/seed-cli.ts reset-notifications <tenantId>
 *        tsx e2e/fixtures/seed-cli.ts sweep [maxAgeMinutes]
 *        tsx e2e/fixtures/seed-cli.ts sweep-dbtests [maxAgeMinutes]
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

/**
 * The vitest DB suite's throwaway tenant prefixes. Unlike the browser
 * harness, that suite has never swept its own: a crashed `beforeAll`, or
 * a run killed on a timeout, leaves the tenant behind, and fifteen had
 * accumulated on the shared dev database by 2026-09-02 — the oldest
 * three weeks old.
 *
 * An EXPLICIT list, never a wildcard, because it is one of the two
 * guards standing between a cleanup command and a real tenant.
 *
 * IT COMES FROM TWO MECHANISMS, and the first version of this list got
 * that wrong by reading dbtest FILE NAMES instead — it invented
 * `attach-`/`counters-`, which no fixture produces, and missed sixteen
 * real ones, so a sweep would have reported success while leaving most
 * orphans behind. Regenerate it with BOTH of these:
 *
 *   grep -rhoE 'setupTenant\("[^"]+"' src --include=*.ts
 *   grep -rhoE 'slug: *[`"][^`"$]*'    src --include=*.ts
 *
 * The first is `setupTenant(label)` (src/members/dbtest-fixture.ts builds
 * `${label}-${run}`); the second is the handful of suites that create a
 * tenant directly.
 *
 * **BOTH GREPS ARE BLIND TO A SHORTHAND PROPERTY** (2026-09-20,
 * regenerating this list after a review): a fixture that builds its slug
 * into a variable and passes `{ …, slug }` matches neither pattern, so it
 * is invisible to the recipe that is supposed to keep this list honest —
 * which is how `pauthz-` was missed the day it was written. A dbtest that
 * creates a tenant directly must spell the literal out at the `slug:` key
 * so the second grep can see it. That regeneration also turned up four
 * PRE-EXISTING misses (`desc-`, `portalc-`, `switch-*`, `tree-`), whose
 * orphans no sweep had ever collected — the same failure mode the
 * paragraph above records, a second time. Re-run the greps, do not trust
 * the list.
 */
const DBTEST_PREFIXES = [
  "admin-",
  "bulk-",
  "census-",
  // Phase 3, the invite slice — `src/clients/contact-access.dbtest.ts`,
  // which calls `setupTenant("cinv")` POSITIONALLY, so the first of the
  // two regeneration greps finds it unaided. (The shorthand-property
  // caveat above applies only to suites that build a tenant row
  // directly; an earlier version of this comment claimed it applied
  // here and pointed at a `slug:` key that does not exist.)
  "cinv-",
  "clients-",
  "copy-",
  "ctask-",
  "ctr-a-",
  "ctr-b-",
  "desc-",
  "docs-",
  "enc-a-",
  "enc-b-",
  "exp-a-",
  "exp-b-",
  "export-",
  "gate-",
  "inbox-",
  "iso-a-",
  "iso-b-",
  "members-",
  "mfa-",
  "money-",
  "ordering-",
  "pauthz-",
  "portalc-",
  "prefs-",
  "prefs-notify-",
  "preq-",
  // **A HISTORICAL PREFIX WITH NO LIVE CREATOR — do not delete it when
  // regenerating this list.** Nothing in `src/`, `e2e/` or `scripts/`
  // creates a `probe-` tenant today, so BOTH greps above come back
  // empty for it and a regeneration would drop it as dead. It is here
  // because an orphan was found in the dev database on 2026-09-22 (one
  // day old, from an ad-hoc script since deleted), and without the
  // entry `sweep-dbtests` could never collect it — the `pauthz-`
  // failure mode arriving by a different door: that one was invisible
  // because the grep could not see its shape, this one because its
  // creator is gone. The greps keep this list COMPLETE; they cannot
  // keep it CORRECT, and a prefix costs nothing but a `startsWith`.
  "probe-",
  "projects-",
  "pvas-",
  "pview-",
  "pwork-",
  "reports-",
  "roles-",
  "scope-",
  "search-",
  "split-",
  "switch-",
  "tadmin-",
  "time-",
  "totals-",
  "tree-",
  "triage-",
  "work-",
  "wu-",
] as const;

const isThrowawaySlug = (slug: string): boolean =>
  slug.startsWith(SLUG_PREFIX) || DBTEST_PREFIXES.some((p) => slug.startsWith(p));
/** Single-line, machine-readable result channel (stdout also carries logs). */
const MARKER = "__E2E_RESULT__";

type PlatformDb = ReturnType<typeof import("../../src/db/client").getPlatformClient>;

export type E2ESeed = {
  readonly tenantId: string;
  readonly tenantSlug: string;
  /** The workspace's display name — what the header shows, and how a
   *  spec tells the two workspaces apart after a switch. */
  readonly tenantName: string;
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

  /* ── A SECOND workspace for the same owner ─────────────────────────
   * The owner belongs to two tenants, so `/dashboard` is a picker with
   * something to pick and the account menu's "Switch workspace" item
   * (offered only above one membership, UI.md rule 8) exists at all.
   * Without it neither the offer nor the switch could be tested in a
   * browser: every assertion could only ever be an ABSENCE.
   *
   * Deliberately EMPTY — no client, project or document. It is the
   * destination of a switch, and an empty workspace makes "am I in the
   * other one?" unmistakable. It is torn down with the first. */
  readonly secondTenantId: string;
  readonly secondTenantSlug: string;
  readonly secondTenantName: string;

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
  /**
   * The same project's id. It belongs to the OTHER client, so it is out
   * of the employee's scope — which is what makes it the control in the
   * `/api/version` 404-parity probe (AUTHZ.md §4: a denial and a missing
   * row must be indistinguishable).
   */
  readonly completedProjectId: string;
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

  /* ── The portal plane's principal ──────────────────────────────────
   * The CONTACT_PRIMARY contact of `clientId`, ACTIVE, invited and
   * credentialled, so the harness can hold a real portal session. Its
   * password is never in this file: global-setup generates it, passes it
   * to the worker in an env var and signs in with it once. */
  readonly contactEmail: string;
  readonly contactName: string;

  /**
   * A LIVE PORTAL INVITATION — the raw token of a PENDING
   * `contact_invite` for a third contact of `clientId`, who sits at
   * INVITED. The acceptance page has no other stable address to be
   * photographed at, and nothing consumes this: a visit only previews.
   * Worthless the moment teardown deletes the row, never printed, and
   * it lives only in the gitignored seed file — the same contract as
   * `inviteToken`.
   */
  readonly contactInviteToken: string;
  readonly contactInviteEmail: string;

  /* ── Member-plane scoping fixture (e2e/scoping.spec.ts) ─────────────
   * An employee — the template role WITHOUT client:view_all — assigned
   * to exactly one client. The long-name client and its completed
   * project double as the forbidden targets: the employee holds no
   * assignment there, so reaching them must be a 404. The password is
   * worthless the moment teardown deletes the tenant, is never printed,
   * and lives only in the gitignored seed file (same contract as
   * inviteToken above). */
  readonly employeeEmail: string;
  readonly employeePassword: string;
};

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

async function provision(seedFile: string): Promise<void> {
  const password = process.env["E2E_OWNER_PASSWORD"];
  if (!password) throw new Error("E2E_OWNER_PASSWORD is not set");
  // BEFORE anything is written, not beside the row that needs it: this
  // check used to sit 400 lines down, next to the contact credential, so
  // a manual `tsx seed-cli.ts provision` without the new var built the
  // whole tenant and then threw — leaving an orphan for the 90-minute
  // sweep to find (review).
  const contactPassword = process.env["E2E_CONTACT_PASSWORD"];
  if (!contactPassword) throw new Error("E2E_CONTACT_PASSWORD is not set");

  const { hashPassword } = await import("better-auth/crypto");
  const { getPlatformClient } = await import("../../src/db/client");
  const { provisionTenant } = await import("../../src/members/provisioning");
  const { assignMemberToClient } = await import("../../src/clients/assignments");
  const { archiveClient, createClient, createContact, updateClient } = await import(
    "../../src/clients/service"
  );
  const { createProject, setPortalEnabled, updateProject } = await import(
    "../../src/projects/service"
  );
  const { createService } = await import("../../src/services/service");
  const { createRateCard } = await import("../../src/modules/time");
  const {
    assignItem,
    changeItemVisibility,
    changeState,
    createItem,
    createLabel,
    setItemLabel,
    setItemMilestone,
    updateItemFields,
  } = await import("../../src/modules/work");
  const { dateColumn, localDateString } = await import("../../src/lib/duration");
  const { addDays } = await import("../../src/lib/week");
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

  const tenantName = `E2E ${run}`;
  const { tenantId, ownerMemberId } = await provisionTenant({
    name: tenantName,
    slug,
    ownerUserId: user.id,
  });

  // A SECOND workspace for the same owner, left empty. It exists so the
  // browser can test the two things a single membership makes
  // untestable: that the account menu OFFERS "Switch workspace" above
  // one membership, and that choosing a row actually switches. Its slug
  // carries the same `e2e-` prefix, so every teardown guard and the
  // orphan sweep apply to it unchanged.
  const secondSlug = `${SLUG_PREFIX}${run}-b`;
  const secondTenantName = `E2E ${run} B`;
  const { tenantId: secondTenantId } = await provisionTenant({
    name: secondTenantName,
    slug: secondSlug,
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

  const contactEmail = `astrid-${run}${EMAIL_DOMAIN}`;
  const contactName = "Astrid Lindqvist";
  const { id: contactId } = await createContact(ctx, clientId, {
    name: contactName,
    email: contactEmail,
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

  // ── A contact with a LIVE INVITATION, so the acceptance page has a
  // token that stands still ──────────────────────────────────────────
  //
  // Three contacts now, one in each of the states a member can see on
  // the Contacts tab: ACTIVE (Astrid, below), NO_ACCESS (Bo) and
  // INVITED (Carina). That is the fixture doing what it is for — the
  // visual and Swedish-width walks photograph the tab, and a tab that
  // only ever showed one status was photographing a third of it.
  //
  // **THE ROW IS WRITTEN DIRECTLY, NOT THROUGH `inviteContact()`, for
  // the same reason the member invitation above is**: the service sends
  // mail after it commits, and a fixture must not leave an envelope in
  // `.dev-outbox` for a spec to trip over — `portal-invite.spec.ts`
  // reads that file and takes the LAST line for its address, and a
  // second invitation in there would be a puzzle nobody needs. Same
  // columns, same hash, both stamps (`portalStatus` and `invitedAt`, the
  // pair `authorizePortal` and the credential trigger both read).
  //
  // The raw token goes into the seed exactly as `inviteToken` does for
  // the member plane, and is what `stops.ts` points the acceptance page
  // at. Nothing consumes it — a visit only previews — so it stays
  // PENDING for the life of the fixture.
  const contactInviteEmail = `carina-${run}${EMAIL_DOMAIN}`;
  const { id: invitedContactId } = await createContact(ctx, clientId, {
    name: "Carina Ek",
    email: contactInviteEmail,
    title: "Projektledare",
    portalProfile: "CONTACT_COLLABORATOR",
  });
  const contactInviteToken = randomBytes(32).toString("base64url");
  await db.contactInvite.create({
    data: {
      tenantId,
      contactId: invitedContactId,
      email: contactInviteEmail,
      tokenHash: createHash("sha256").update(contactInviteToken).digest("hex"),
      invitedByMemberId: ownerMemberId,
      // Three days, spelled out: `day` is declared further down the file.
      expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    },
  });
  await db.contact.update({
    where: { tenantId_id: { tenantId, id: invitedContactId } },
    data: { portalStatus: "INVITED", invitedAt: new Date(), invitedById: ownerMemberId },
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
  const { id: completedProjectId, key: completedProjectKey } = await createProject(ctx, {
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

  const { id: maintenanceServiceId } = await createService(ctx, {
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

  // 2T: two BILL rate cards — the workspace default and the agreement's
  // own — so /settings/rates and the Agreements tab photograph with rows
  // and e2e/settings.spec.ts has something to assert. BILL cards are
  // rate:manage_bill (no ✦), so the owner's session could do the same.
  await createRateCard(ctx, { kind: "BILL", scope: "TENANT", amount: "950", currency: "SEK", effectiveFrom: "2026-01-01" });
  await createRateCard(ctx, {
    kind: "BILL",
    scope: "SERVICE",
    serviceId: maintenanceServiceId,
    amount: "1200",
    currency: "SEK",
    effectiveFrom: "2026-01-01",
  });

  // 2W: a handful of tasks on the main project so the board and the
  // backlog photograph as a working project (cards in three columns,
  // one assigned, one client-visible, estimates, a priority) and
  // e2e/work.spec.ts has neighbours to drop between. Written through
  // the services — numbering, rank, state machine, activity, audit —
  // exactly as the owner's session would. The first create seeds the
  // project's states lazily (ensureProjectStates); the rest read them.
  // Due dates put the owner's three assigned tasks in three of /home's
  // queue groups (overdue, next 7 days, later) for e2e/home.spec.ts and
  // the sweep. THREE DAYS each side of today, in the tenant's default
  // zone: a run that crosses midnight between this seed and the test
  // still finds each task in the same group.
  const today = localDateString(new Date(), "Europe/Stockholm");
  const dueIn = (days: number): Date => dateColumn(addDays(today, days));
  const firstTask = await createItem(ctx, { projectId, title: "Sätt upp staging-miljö" });
  await updateItemFields(ctx, firstTask.id, { priority: "HIGH", estimateMinutes: 120, targetDate: dueIn(-3) });
  await assignItem(ctx, firstTask.id, ownerMemberId);
  const workStates = await db.workflowState.findMany({
    where: { tenantId, projectId },
    select: { id: true, category: true },
    // Rank order makes stateIdOf deterministic now that IN_PROGRESS has
    // two states (In progress + In review, 2W-R): `find` takes the first
    // by rank — exactly the column the specs drag into. Keyed on
    // category and rank, never on a name: since 2026-09-01 a seeded
    // state has no stored name at all.
    orderBy: { rank: "asc" },
  });
  const stateIdOf = (category: string): string => {
    const s = workStates.find((w) => w.category === category);
    if (!s) throw new Error(`seed: no ${category} state on the project`);
    return s.id;
  };
  // The tenant's label vocabulary, so the board card and the backlog row
  // photograph WITH chips (2026-09-16). Three of them, and one task wears
  // all three: the row's cap is 2, so that task is the sweep's only view
  // of the folded `+1` chip, while two other tasks stay unlabelled and
  // keep the "no group at all" case in frame. Swedish words — this is a
  // Swedish agency's workspace, and `Label.name` is tenant data that is
  // never translated (UI.md §8).
  const labelIds: string[] = [];
  for (const name of ["Brådskande", "Design", "Väntar på kund"]) {
    labelIds.push((await createLabel(ctx, { name })).label.id);
  }

  const task = async (
    title: string,
    opts: {
      category?: string;
      priority?: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
      hours?: number;
      assign?: boolean;
      clientVisible?: boolean;
      /** How many of the tenant's labels to file it under, in name order. */
      labels?: number;
    },
  ): Promise<string> => {
    const { id } = await createItem(ctx, { projectId, title });
    if (opts.priority || opts.hours) {
      await updateItemFields(ctx, id, {
        ...(opts.priority ? { priority: opts.priority } : {}),
        ...(opts.hours ? { estimateMinutes: Math.round(opts.hours * 60) } : {}),
      });
    }
    if (opts.assign) await assignItem(ctx, id, ownerMemberId);
    if (opts.clientVisible) await changeItemVisibility(ctx, id, "CLIENT_VISIBLE");
    if (opts.category) await changeState(ctx, id, stateIdOf(opts.category));
    for (const labelId of labelIds.slice(0, opts.labels ?? 0)) {
      await setItemLabel(ctx, id, labelId, true);
    }
    return id;
  };
  // Three labels: past the row's cap of 2, so this is the one task that
  // photographs the folded `+1` chip beside a truncating name.
  await task("Skriv kravspecifikation", {
    category: "IN_PROGRESS",
    hours: 4,
    clientVisible: true,
    assign: true,
    labels: 3,
  });
  // Kept: the employee assigns this one to the owner below, which is
  // what puts a real notification in the owner's inbox.
  // One label — the common case, under the cap, nothing folded.
  const reviewTaskId = await task("Designgranskning med kunden", { priority: "MEDIUM", hours: 1.5, labels: 1 });
  await updateItemFields(ctx, reviewTaskId, { targetDate: dueIn(3) });
  const dnsTaskId = await task("Migrera DNS till ny leverantör", { category: "DONE", hours: 1 });
  const a11yTaskId = await task("Tillgänglighetsgranskning", { category: "BACKLOG" });

  // ── Phase 3: the portal fixture ────────────────────────────────────
  // Three shared tasks in three different portal categories, so the
  // `/portal` stop photographs the grouped list rather than one row, and
  // one of them carries the CLIENT_VISIBLE milestone so the "Phase:" line
  // is in frame. Everything else in this project stays INTERNAL, which is
  // what makes the stop a NEGATIVE control as well as a positive one: the
  // walk's screenshots are the only place a human ever looks at what a
  // contact sees.
  await changeItemVisibility(ctx, dnsTaskId, "CLIENT_VISIBLE");
  await changeItemVisibility(ctx, a11yTaskId, "CLIENT_VISIBLE");
  await setItemMilestone(ctx, a11yTaskId, datedMilestoneId);
  await updateItemFields(ctx, a11yTaskId, { targetDate: dueIn(10) });
  // THROUGH THE REAL SWITCH, not a column write: `setPortalEnabled` is
  // the emergency "stop showing this client our data" control, its
  // trigger fans `portal_enabled` out across ten tables, and a fixture
  // that set the column directly would leave every child row at false
  // and the portal list empty for a reason nobody could see.
  await setPortalEnabled(ctx, projectId, true);

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

  // ── Member-plane scoping fixture ───────────────────────────────────
  // A real employee: sign-in-capable (verified email + credential
  // account, exactly like the owner above), holding the Employee
  // template role — the one WITHOUT client:view_all — and one client
  // assignment, written through the real service so the fixture walks
  // the same requireAccess → assertInScope → audit path a member would.
  const employeeEmail = `e2e-employee-${run}${EMAIL_DOMAIN}`;
  const employeePassword = randomBytes(24).toString("base64url");
  const employeeUser = await db.user.create({
    data: { name: "E2E Employee", email: employeeEmail, emailVerified: true, locale: "en" },
  });
  await db.account.create({
    data: {
      userId: employeeUser.id,
      providerId: "credential",
      accountId: employeeUser.id,
      password: await hashPassword(employeePassword),
    },
  });
  const employeeMember = await db.member.create({
    data: { tenantId, userId: employeeUser.id, title: null },
  });
  const employeeRole = await db.role.findFirst({
    where: { tenantId, templateKey: "employee" },
    select: { id: true },
  });
  if (!employeeRole) throw new Error("provisionTenant seeded no employee role");
  await db.memberRole.create({
    data: { tenantId, memberId: employeeMember.id, roleId: employeeRole.id },
  });
  await assignMemberToClient({
    tenantId,
    actor: ctx.actor,
    memberId: employeeMember.id,
    clientId,
  });

  // 2W notifications: the one notification in the standing fixture, and
  // it is PRODUCED rather than inserted — the employee (who now holds
  // the client) assigns a task to the owner, so `notify.emit` runs
  // inside the same transaction the assignment does, exactly as it will
  // in production. That is what gives /inbox a row and the rail its
  // badge for e2e/inbox.spec.ts and the visual sweep. It also enqueues
  // one EmailOutbox row, which teardown removes; no worker runs here,
  // so nothing is ever sent and .dev-outbox stays empty.
  await assignItem(
    { tenantId, actor: { memberId: employeeMember.id, mfa: { enrolled: false, verifiedAt: null } } },
    reviewTaskId,
    ownerMemberId,
  );

  // ── Portal-plane fixture: a contact who can really sign in ─────────
  // The portal has no sign-up and no invite flow yet, so the credential
  // is written the way invite acceptance will write it — directly, into
  // `contact_account`, after the row is ACTIVE and STAMPED AS INVITED.
  // Both stamps are load-bearing rather than decorative: the database
  // trigger `contact_account_requires_invite` refuses a credential for a
  // contact that is neither INVITED nor ACTIVE, and `authorizePortal()`
  // requires `invitedAt` on the row — an activation path that forgets it
  // produces a contact who can hold a session and do nothing
  // (src/portal/policy.ts).
  //
  // The password is generated per run by the test worker and arrives in
  // an env var, exactly like the owner's: never written to the seed file,
  // never printed.
  await db.contact.update({
    where: { tenantId_id: { tenantId, id: contactId } },
    data: {
      emailVerified: true,
      portalStatus: "ACTIVE",
      invitedAt: new Date(Date.now() - 7 * day),
      activatedAt: new Date(Date.now() - 6 * day),
      invitedById: ownerMemberId,
    },
  });
  await db.contactAccount.create({
    data: {
      contactId,
      accountId: contactId,
      providerId: "credential",
      password: await hashPassword(contactPassword),
    },
  });

  const clientVisibleDocName = `e2e-shared-${run}.txt`;
  const internalDocName = `e2e-private-${run}.txt`;
  const seed: E2ESeed = {
    tenantId,
    tenantSlug: slug,
    tenantName,
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
    secondTenantId,
    secondTenantSlug: secondSlug,
    secondTenantName,
    longClientId,
    longClientName,
    archivedClientId,
    activeProjectKey,
    completedProjectKey,
    completedProjectId,
    tenantDocId: await document(`e2e-tenant-${run}.txt`, "INTERNAL", {}),
    projectDocId: await document(`e2e-projekt-${run}.txt`, "CLIENT_VISIBLE", { projectId }),
    inviteToken,
    inviteEmail,
    contactEmail,
    contactName,
    contactInviteToken,
    contactInviteEmail,
    employeeEmail,
    employeePassword,
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
  if (!isThrowawaySlug(slug)) {
    throw new Error(`refusing to remove non-throwaway tenant "${slug}"`);
  }
  // The BELT, and the one that actually matters: a slug is a naming
  // convention, but a member with a real address is evidence. Even if a
  // prefix above were ever wrong, a tenant holding one non-synthetic
  // user is refused outright.
  const outsider = await db.member.findFirst({
    where: { tenantId, user: { email: { not: { endsWith: EMAIL_DOMAIN } } } },
    select: { user: { select: { email: true } } },
  });
  if (outsider) {
    throw new Error(
      `refusing to remove tenant "${slug}": it has a real member (${outsider.user.email})`,
    );
  }
  // 2T: time rows reference projects/members/tenant with RESTRICT; published
  // reports and locked entries refuse deletion outside the maintenance GUCs.
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.time_maintenance', 'on', true)`;
    await tx.$executeRaw`SELECT set_config('app.time_lock_bypass', 'on', true)`;
    await tx.timeReport.deleteMany({ where: { tenantId } });
    await tx.budgetAlert.deleteMany({ where: { tenantId } });
    await tx.projectBudget.deleteMany({ where: { tenantId } });
    await tx.timeEntry.deleteMany({ where: { tenantId } });
    await tx.shiftBreak.deleteMany({ where: { tenantId } });
    await tx.shift.deleteMany({ where: { tenantId } });
    await tx.rateCard.deleteMany({ where: { tenantId } });
    await tx.projectTimeSummary.deleteMany({ where: { tenantId } });
    await tx.staffNoticeAcknowledgment.deleteMany({ where: { tenantId } });
    await tx.staffNotice.deleteMany({ where: { tenantId } });
    await tx.workType.deleteMany({ where: { tenantId } });
    await tx.tenantKey.deleteMany({ where: { tenantId } });
  });
  // 2W: tenant-scoped rows that RESTRICT the tenant (and comment/label,
  // which RESTRICT the project) — a spec that assigns a task or crosses a
  // budget threshold leaves notification + email_outbox rows behind.
  await db.comment.deleteMany({ where: { tenantId } }); // mentions cascade
  await db.label.deleteMany({ where: { tenantId } }); // work_item_label cascades
  await db.workItemActivity.deleteMany({ where: { tenantId } });
  // `work_item` has TWO self-referencing foreign keys and both must be
  // unwound before the delete. `parent_id` is handled by the two passes
  // below; `duplicate_of_id` is `ON DELETE RESTRICT`
  // (20260820170000:502) and is NOT satisfied by the referencing row
  // being deleted in the same statement, so a single DUPLICATE row left
  // in a tenant made `removeTenant` throw `23503`.
  //
  // IT HAD NO WRITER UNTIL SLICE 6b, which is why this was never
  // needed and why it is needed now: `sweepDbtests` loops over stale
  // tenants with no try/catch, so ONE orphan holding a duplicate would
  // abort the whole sweep and leave every later tenant uncollected.
  // Found by both fresh reviews; the dbtest's own teardown already did
  // exactly this and the harness was not given the same treatment.
  await db.workItem.updateMany({
    where: { tenantId, duplicateOfId: { not: null } },
    data: { triageStatus: null, triageReason: null, duplicateOfId: null },
  });
  await db.workItem.deleteMany({ where: { tenantId, parentId: { not: null } } });
  await db.workItem.deleteMany({ where: { tenantId } });
  // `assignee_contact_id` (slice 6c, its own first writer) is RESTRICT
  // too — and needs nothing here, because it points at `contact`, which
  // this function deletes LATER. Checked rather than assumed: the
  // residue above exists because a "no path reaches this" disposition
  // had not looked in `e2e/`, and the next column with a restricting FK
  // deserves the same two minutes.
  await db.workflowState.deleteMany({ where: { tenantId } });
  await db.tenantCounter.deleteMany({ where: { tenantId } }); // work_item:<project> numbering (RESTRICTs the tenant)
  await db.notification.deleteMany({ where: { tenantId } });
  await db.emailOutbox.deleteMany({ where: { tenantId } });
  await db.subscription.deleteMany({ where: { tenantId } });
  await db.notificationPreference.deleteMany({ where: { tenantId } });
  await db.workflowPreset.deleteMany({ where: { tenantId } });
  await db.projectTemplate.deleteMany({ where: { tenantId } });
  // RESTRICTs the tenant. The browser fixture never writes one, so this
  // was missing until a dbtest tenant that HAD set a preference (the
  // 2T exports suite flips `hoursSharingMode`) refused to delete on
  // 2026-09-02 with a 23001 on `tenant_preference_tenant_id_fkey`.
  await db.tenantPreference.deleteMany({ where: { tenantId } });
  await db.$executeRaw`DELETE FROM search_index WHERE tenant_id = ${tenantId}`;
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

/**
 * Remove the vitest DB suite's abandoned tenants. Manual, and age-gated
 * so it cannot take a tenant a run is still using — a local suite once
 * deleted a live CI fixture, which is why the age guard exists at all.
 *
 * Exits NON-ZERO if any tenant was refused. The deletes are not one
 * transaction, so a refusal can mean a half-emptied tenant, and a
 * cleanup that half-worked must not look the same as one that worked.
 */
async function sweepDbtests(maxAgeMinutesRaw: string | undefined): Promise<void> {
  const parsed = Number(maxAgeMinutesRaw ?? 90);
  // A floor, not just a NaN check: "" parses to 0, which would set the
  // cutoff to NOW and sweep a tenant a concurrent run is still using.
  const maxAgeMinutes = Number.isFinite(parsed) && parsed >= 30 ? parsed : 90;
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60_000);
  const { getPlatformClient } = await import("../../src/db/client");
  const db = getPlatformClient();
  // Narrowed in SQL, like `sweep` — never "every tenant, filtered in JS".
  const stale = await db.tenant.findMany({
    where: {
      createdAt: { lt: cutoff },
      OR: DBTEST_PREFIXES.map((prefix) => ({ slug: { startsWith: prefix } })),
    },
    select: { id: true, slug: true },
  });
  const removed: string[] = [];
  const refused: string[] = [];
  for (const t of stale) {
    try {
      // removeTenant carries both guards: the prefix allow-list and the
      // real-member belt. Nothing here re-implements them.
      await removeTenant(db, t.id, t.slug);
      removed.push(t.slug);
    } catch (e) {
      refused.push(`${t.slug}: ${(e as Error).message}`);
    }
  }
  await db.$disconnect();
  process.stdout.write(
    `${MARKER}${JSON.stringify({ maxAgeMinutes, removed, refused })}\n`,
  );
  if (refused.length > 0) process.exitCode = 1;
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

  // BOTH workspaces, and the main one FIRST: `removeTenant` deletes the
  // owner only once they hold no membership anywhere
  // (`memberships: { none: {} }`), so the second pass is what actually
  // removes the user. `secondTenantId` is read defensively — a seed file
  // written before this field existed would otherwise throw here and
  // strand the tenant it CAN remove.
  const ids = [tenantId, seed.secondTenantId].filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
  for (const id of ids) {
    const tenant = await db.tenant.findUnique({ where: { id }, select: { slug: true } });
    const slug = tenant?.slug ?? (id === tenantId ? seed.tenantSlug : seed.secondTenantSlug);
    if (tenant && !tenant.slug.startsWith(SLUG_PREFIX)) {
      throw new Error(`refusing to tear down non-throwaway tenant "${tenant.slug}"`);
    }
    await removeTenant(db, id, slug);
  }
  await db.$disconnect();

  rmSync(seed.storageDir, { recursive: true, force: true });
  rmSync(seedFile, { force: true });
  process.stdout.write(`${MARKER}{"removed":true}\n`);
}

/**
 * Refuse to touch anything but a throwaway tenant — an `e2e-` slug OR one
 * of the vitest suites' prefixes, the wider rule the sweeps need to clean
 * the DB suite's orphans (`removeTenant` applies the same slug rule
 * inline, plus its member-email belt). The notification helpers below
 * write and read whole-tenant, so they need it more, not less — a stale
 * `.seed` or a hand-typed id must not be able to blank a real tenant's
 * inbox state. A command a spec aims at a row or a tenant of ITS OWN
 * fixture uses the stricter `assertE2ETenant` instead.
 */
async function assertThrowawayTenant(db: PlatformDb, tenantId: string): Promise<void> {
  const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { slug: true } });
  if (!tenant) throw new Error(`no such tenant ${tenantId}`);
  if (!isThrowawaySlug(tenant.slug)) {
    throw new Error(`refusing to touch non-throwaway tenant "${tenant.slug}"`);
  }
}

/**
 * The guard of a command that WRITES into the tenant the browser harness
 * provisioned: an `e2e-` slug and nothing else — stricter than
 * `assertThrowawayTenant`, which also admits the vitest suites' prefixes
 * so the sweeps can clean their orphans. Every writing command a spec
 * can aim at a row or a tenant takes it before its first write:
 * `set-visibility`, `client-visible-comment`, `big-project` (a
 * caller-supplied tenant id) and `drop-project` (a caller-supplied
 * project id, checked through its tenant).
 */
async function assertE2ETenant(db: PlatformDb, tenantId: string): Promise<void> {
  const tenant = await db.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { slug: true } });
  if (!tenant.slug.startsWith(SLUG_PREFIX)) {
    throw new Error(`refusing to write outside a throwaway tenant ("${tenant.slug}")`);
  }
}

/**
 * The tenant's notification rows, as the database holds them.
 *
 * e2e/inbox.spec.ts asserts on THESE and not on a toast: the one
 * assertion in this suite whose timing depends on render scheduling
 * rather than a server answer is the one that has flaked twice
 * (PLAN.md §0). Read-state is a stored fact, so read the stored fact.
 */
async function notifications(tenantId: string): Promise<void> {
  const { getPlatformClient } = await import("../../src/db/client");
  const db = getPlatformClient();
  await assertThrowawayTenant(db, tenantId);
  const rows = await db.notification.findMany({
    where: { tenantId },
    select: { id: true, kind: true, readAt: true, archivedAt: true, snoozedTill: true },
    orderBy: { createdAt: "desc" },
  });
  await db.$disconnect();
  process.stdout.write(
    `${MARKER}${JSON.stringify(
      rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        read: r.readAt !== null,
        archived: r.archivedAt !== null,
        snoozed: r.snoozedTill !== null,
      })),
    )}
`,
  );
}

/**
 * Put every notification back to unread, un-archived and un-snoozed.
 * The standing fixture's one notification is what the rail badge and
 * the visual sweep photograph, so a spec that reads or files it must
 * hand it back exactly as it found it — the same doctrine work.spec.ts
 * follows for the row it drops into the photographed project.
 */
async function resetNotifications(tenantId: string): Promise<void> {
  const { getPlatformClient } = await import("../../src/db/client");
  const db = getPlatformClient();
  await assertThrowawayTenant(db, tenantId);
  const { count } = await db.notification.updateMany({
    where: { tenantId },
    data: { readAt: null, archivedAt: null, snoozedTill: null },
  });
  await db.$disconnect();
  process.stdout.write(`${MARKER}{"reset":${count}}
`);
}

/**
 * Forget one member's staff-notice acknowledgments, so the next timer
 * start is that member's FIRST again — the only state in which a task's
 * timer control shows the notice. A spec that asserts on the notice
 * calls this before it runs, which keeps it true on a retry (the first
 * attempt acknowledged). Throwaway tenant only, like every write here;
 * the member is found by email inside that tenant and nowhere else.
 */
async function forgetNotice(tenantId: string, email: string): Promise<void> {
  const { getPlatformClient } = await import("../../src/db/client");
  // An undefined filter is silently DROPPED by Prisma, which would make
  // this "the tenant's first member" — refuse a missing email outright.
  if (!email) throw new Error("forget-notice needs a member email");
  const db = getPlatformClient();
  await assertE2ETenant(db, tenantId);
  const member = await db.member.findFirstOrThrow({
    where: { tenantId, user: { email } },
    select: { id: true },
  });
  const { count } = await db.staffNoticeAcknowledgment.deleteMany({
    where: { tenantId, memberId: member.id },
  });
  await db.$disconnect();
  process.stdout.write(`${MARKER}{"forgotten":${count}}
`);
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
  await assertE2ETenant(db, doc.tenantId);
  await db.document.update({ where: { id: documentId }, data: { visibility: value } });
  await db.$disconnect();
  process.stdout.write(`${MARKER}${JSON.stringify({ visibility: value })}
`);
}

/**
 * A CLIENT_VISIBLE comment under one of the throwaway tenant's tasks —
 * the child that makes `work_item_visibility_downgrade_guard` refuse to
 * make the task private, which is the `V` picker's "explains" case.
 * Written raw, as work.dbtest.ts writes it: no comment UI exists yet.
 * The task is addressed by project id + number, which is what a spec
 * can read off the peek's URL.
 */
async function clientVisibleComment(projectId: string, number: string): Promise<void> {
  const { getPlatformClient } = await import("../../src/db/client");
  const db = getPlatformClient();
  const item = await db.workItem.findFirstOrThrow({
    where: { projectId, number: Number(number), deletedAt: null },
    select: { id: true, tenantId: true },
  });
  // The writing commands' guard: an `e2e-` slug and nothing else.
  await assertE2ETenant(db, item.tenantId);
  const author = await db.member.findFirstOrThrow({
    where: { tenantId: item.tenantId },
    orderBy: { joinedAt: "asc" },
    select: { id: true },
  });
  const comment = await db.comment.create({
    data: {
      tenantId: item.tenantId,
      subjectType: "WORK_ITEM",
      subjectId: item.id,
      authorMemberId: author.id,
      body: {},
      bodyText: "visible reply",
      visibility: "CLIENT_VISIBLE",
    },
    select: { id: true },
  });
  await db.$disconnect();
  process.stdout.write(`${MARKER}${JSON.stringify({ commentId: comment.id })}\n`);
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

/**
 * A project with more rows than the virtualisation threshold, created
 * and dropped by the ONE spec that needs it.
 *
 * It exists because virtualisation is inert at or below 200 rows, so the
 * ordinary fixture (five tasks) and all 43 visual stops exercise the
 * UNWINDOWED path and could never catch a defect in the windowed one.
 * Without this the feature would ship having never run.
 *
 * DELIBERATELY NOT THROUGH THE SERVICES, and this is the one place in
 * the harness that takes that liberty. `createItem` is one transaction
 * per row with a counter lock and a rank lock; 250 of them is minutes,
 * on every CI run, forever. This is a single `createMany` with
 * pre-computed fractional ranks — the same keys `ranksBetween` would
 * have produced — because what the spec is testing is the RENDERER, not
 * the write path, which `work.dbtest.ts` and `ordering.dbtest.ts`
 * already cover exhaustively. It lives in the throwaway `e2e-` tenant
 * and is deleted by the same command that made it.
 */
async function bigProject(tenantId: string, sizeArg: string | undefined): Promise<void> {
  const size = Number(sizeArg ?? "250");
  if (!Number.isInteger(size) || size < 1 || size > 1000) {
    throw new Error(`big-project size must be 1..1000, got "${sizeArg ?? ""}"`);
  }
  const { getPlatformClient } = await import("../../src/db/client");
  const { ranksBetween } = await import("../../src/lib/rank");
  const db = getPlatformClient();
  // A caller-supplied TENANT id, and a thousand rows to plant under it:
  // the guard first, before the first read even.
  await assertE2ETenant(db, tenantId);

  const client = await db.client.findFirstOrThrow({
    where: { tenantId },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  const owner = await db.member.findFirstOrThrow({
    where: { tenantId },
    select: { id: true },
    orderBy: { joinedAt: "asc" },
  });
  const projectId = randomUUID();
  const key = "BIG";
  await db.project.create({
    data: { id: projectId, tenantId, clientId: client.id, key, name: "Big backlog" },
  });

  // The states this project needs, seeded the way ensureProjectStates
  // would: no name, a durable seed key (DATA_MODEL §6.14).
  const shape = [
    { seedKey: "BACKLOG", category: "BACKLOG" },
    { seedKey: "TODO", category: "TODO", isDefault: true },
    { seedKey: "IN_PROGRESS", category: "IN_PROGRESS" },
    { seedKey: "IN_REVIEW", category: "IN_PROGRESS" },
    { seedKey: "DONE", category: "DONE", requiresApproval: true },
    { seedKey: "CANCELLED", category: "CANCELLED" },
    { seedKey: "TRIAGE", category: "TRIAGE", isHidden: true },
  ] as const;
  const stateRanks = ranksBetween(null, null, shape.length);
  const stateIds = shape.map(() => randomUUID());
  await db.workflowState.createMany({
    data: shape.map((st, i) => ({
      id: stateIds[i]!,
      tenantId,
      projectId,
      seedKey: st.seedKey,
      category: st.category,
      rank: stateRanks[i]!,
      isDefault: "isDefault" in st ? st.isDefault : false,
      isHidden: "isHidden" in st ? st.isHidden : false,
      requiresApproval: "requiresApproval" in st ? st.requiresApproval : false,
    })),
  });
  const todo = stateIds[1]!;

  const ranks = ranksBetween(null, null, size);
  const ids = Array.from({ length: size }, () => randomUUID());
  await db.workItem.createMany({
    data: ids.map((id, i) => ({
      id,
      tenantId,
      clientId: client.id,
      projectId,
      number: i + 1,
      type: "TASK" as const,
      // The index is IN the title so a spec can assert which slice of the
      // list is mounted without counting DOM nodes.
      title: `Row ${String(i + 1).padStart(4, "0")}`,
      stateId: todo,
      stateCategory: "TODO" as const,
      rootId: id,
      rank: ranks[i]!,
      visibility: "INTERNAL" as const,
      createdByMemberId: owner.id,
    })),
  });
  // The counter must agree, or a later create through the real service
  // would mint a duplicate number.
  await db.tenantCounter.upsert({
    where: { tenantId_key: { tenantId, key: `work_item:${projectId}` } },
    create: { tenantId, key: `work_item:${projectId}`, value: size },
    update: { value: size },
  });
  await db.$disconnect();
  process.stdout.write(`${MARKER}${JSON.stringify({ projectId, key, size })}\n`);
}

/** Remove the big project and everything under it. */
async function dropProject(projectId: string): Promise<void> {
  const { getPlatformClient } = await import("../../src/db/client");
  const db = getPlatformClient();
  const project = await db.project.findUnique({ where: { id: projectId }, select: { tenantId: true } });
  if (project) {
    // The project id came back from big-project, but nothing stops a spec
    // from passing another: the tenant is checked before the deletes.
    await assertE2ETenant(db, project.tenantId);
    await db.workItemActivity.deleteMany({ where: { projectId } });
    await db.workItem.deleteMany({ where: { projectId } });
    await db.workflowState.deleteMany({ where: { projectId } });
    await db.tenantCounter.deleteMany({
      where: { tenantId: project.tenantId, key: `work_item:${projectId}` },
    });
    await db.project.delete({ where: { id: projectId } });
  }
  await db.$disconnect();
  process.stdout.write(`${MARKER}${JSON.stringify({ dropped: Boolean(project) })}\n`);
}

/**
 * THE DB HALF OF THE PORTAL REQUEST SPEC (Phase 3 slice 6a).
 *
 * The browser can only see what the portal renders back, and the claim
 * that matters about an intake is about columns the portal never shows:
 * `kind`, `source`, `visibility`, the triage status, who it is
 * attributed to, and the actor on its audit row. Those are facts in the
 * database, so the spec asserts on them here rather than inferring them
 * from a list item.
 *
 * It reads the AUDIT row alongside, because the audit actor is the one
 * property of a brokered write that a service-level dbtest and a browser
 * test could both pass while the real HTTP path wrote SYSTEM: the
 * principal comes from a cookie, and only a real request has one.
 */
async function portalRequests(tenantId: string): Promise<void> {
  const { getPlatformClient } = await import("../../src/db/client");
  const db = getPlatformClient();
  await assertE2ETenant(db, tenantId);
  const rows = await db.workItem.findMany({
    where: { tenantId, kind: "REQUEST", source: "PORTAL" },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      number: true,
      title: true,
      descriptionText: true,
      visibility: true,
      portalEnabled: true,
      stateCategory: true,
      triageStatus: true,
      reportedByContactId: true,
      createdByMemberId: true,
      clientId: true,
      projectId: true,
    },
  });
  const events = await db.auditEvent.findMany({
    where: { tenantId, action: "portal.request_created" },
    select: { targetId: true, actorType: true, actorId: true },
  });
  const byTarget = new Map(events.map((e) => [e.targetId, e]));
  await db.$disconnect();
  process.stdout.write(
    `${MARKER}${JSON.stringify(
      rows.map((r) => ({
        ...r,
        auditActorType: byTarget.get(r.id)?.actorType ?? null,
        auditActorId: byTarget.get(r.id)?.actorId ?? null,
      })),
    )}
`,
  );
}

/**
 * Hand the fixture back the way it was provisioned.
 *
 * WITHOUT THIS, a request submitted by the browser would still be in the
 * shared tenant when `view-as.spec.ts`, `visual.spec.ts` and the Swedish
 * width walk run — all three sort after `portal-requests.spec.ts` — and
 * the portal's 204-shot stop would gain a "Requested" group whose
 * presence depended on whether the whole suite or one file had been run.
 * That is the cross-spec contamination the locale restore in
 * `view-as.spec.ts` already records, and the same rule applies to the
 * timing: the caller runs it from `afterAll`, never a `finally`, because
 * a Playwright test TIMEOUT abandons the body and every await inside a
 * `finally` then fails immediately.
 */
async function clearPortalRequests(tenantId: string, contactEmail: string): Promise<void> {
  const { getPlatformClient } = await import("../../src/db/client");
  const db = getPlatformClient();
  await assertE2ETenant(db, tenantId);
  // SCOPED BY SUBMITTER, not by kind and not by a CLOCK.
  //
  // By kind alone (the first cut) it deleted every `kind=REQUEST,
  // source=PORTAL` row of the shared tenant — safe today, because
  // nothing else in `e2e/` creates one, and silently wrong the moment
  // the triage-lane slice seeds a REQUEST fixture, at which point an
  // unrelated spec's `afterAll` would delete it (code review).
  //
  // The second cut fixed that with a `createdAt >= <the run started>`
  // window, and that was the WRONG INSTRUMENT: the rows are stamped by
  // Postgres and the cutoff came from the test runner's own clock, so a
  // few seconds of skew between this machine and Neon would have made
  // the cleanup quietly delete nothing — leaving a request in the
  // shared project's backlog for `visual` and the Swedish width walk,
  // which is precisely the cross-spec contamination the scoping exists
  // to prevent. It is the same two-clocks mistake the intake's own rate
  // budget had to fix, which is how it was spotted.
  //
  // The submitter is the honest key: this harness can sign in as exactly
  // one contact, so "requests reported by that contact" is exactly the
  // set this spec can have created — with no clock in it at all.
  const contact = await db.contact.findFirst({
    where: { tenantId, email: contactEmail },
    select: { id: true },
  });
  const rows = contact
    ? await db.workItem.findMany({
        where: { tenantId, kind: "REQUEST", source: "PORTAL", reportedByContactId: contact.id },
        select: { id: true },
      })
    : [];
  const ids = rows.map((r) => r.id);
  if (ids.length > 0) {
    await db.$executeRaw`DELETE FROM search_index WHERE tenant_id = ${tenantId} AND entity_type = 'WORK_ITEM' AND entity_id = ANY(${ids})`;
    await db.emailOutbox.deleteMany({
      where: { tenantId, kind: "work_item.request_received", notificationIds: { isEmpty: false } },
    });
    await db.notification.deleteMany({ where: { tenantId, entityId: { in: ids } } });
    await db.workItemActivity.deleteMany({ where: { tenantId, workItemId: { in: ids } } });
    await db.workItem.deleteMany({ where: { tenantId, id: { in: ids } } });
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.audit_maintenance', 'on', true)`;
      await tx.auditEvent.deleteMany({
        where: { tenantId, action: "portal.request_created", targetId: { in: ids } },
      });
    });
  }
  await db.$disconnect();
  process.stdout.write(`${MARKER}${JSON.stringify({ cleared: ids.length })}
`);
}

/**
 * ERASE A CONTACT A SPEC CREATED — `portal-invite.spec.ts`'s belt.
 *
 * The spec adds its own contact through the real form and takes its
 * access away and deletes it through the real row menu, which is the
 * coverage. This is what runs when the spec failed BEFORE getting that
 * far, and it is not optional: the Contacts tab is photographed by the
 * visual sweep and walked by `zz-swedish-widths`, both of which sort
 * after it, so a leftover row would change screenshots and column widths
 * in specs that never touched this one.
 *
 * **IT GOES ROUND `deleteContact` ON PURPOSE, unlike most of this file.**
 * The service refuses anyone who can still sign in and anyone who has
 * written in the portal — which is right for a member pressing a button
 * and wrong for a cleanup whose whole job is the case where the spec did
 * not finish. `assertE2ETenant` above it is what keeps that safe: this
 * can only ever reach a tenant the fixture provisioned.
 *
 * Scoped by ADDRESS, not by a clock and not by "contacts of this
 * client": the two seeded contacts and the seeded invitee live there too
 * and every other spec depends on them.
 */
async function removeContact(tenantId: string, email: string): Promise<void> {
  const { getPlatformClient } = await import("../../src/db/client");
  const db = getPlatformClient();
  await assertE2ETenant(db, tenantId);
  const contact = await db.contact.findFirst({
    where: { tenantId, email },
    select: { id: true },
  });
  if (contact) {
    // Sequential, never a `Promise.all` — AGENTS.md's standing trap, and
    // these run outside a transaction anyway so there is nothing to win.
    await db.contactSession.deleteMany({ where: { contactId: contact.id } });
    await db.contactAccount.deleteMany({ where: { contactId: contact.id } });
    // By `value`, not the address: Better Auth keys a reset row
    // `identifier = "reset-password:<token>"` with `value = <contact id>`
    // (the same correction `setContactPortalAccess` now carries).
    await db.contactVerification.deleteMany({
      where: { OR: [{ value: contact.id }, { identifier: email }] },
    });
    await db.contactInvite.deleteMany({ where: { tenantId, contactId: contact.id } });
    // `work_item.assignee_contact_id` is ON DELETE RESTRICT, so a task
    // the contact was handed would block the delete at the database.
    await db.workItem.updateMany({
      where: { tenantId, assigneeContactId: contact.id },
      data: { assigneeContactId: null, contactCompletedAt: null },
    });
    await db.contact.delete({ where: { tenantId_id: { tenantId, id: contact.id } } });
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.audit_maintenance', 'on', true)`;
      await tx.auditEvent.deleteMany({ where: { tenantId, targetId: contact.id } });
    });
  }
  await db.$disconnect();
  process.stdout.write(`${MARKER}${JSON.stringify({ removed: contact !== null })}\n`);
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
  if (command === "client-visible-comment") return clientVisibleComment(argument!, process.argv[4]!);
  if (command === "milestone") return milestone(argument!);
  if (command === "big-project") return bigProject(argument!, process.argv[4]);
  if (command === "drop-project") return dropProject(argument!);
  if (command === "portal-requests") return portalRequests(argument!);
  if (command === "clear-portal-requests") return clearPortalRequests(argument!, process.argv[4]!);
  if (command === "notifications") return notifications(argument!);
  if (command === "reset-notifications") return resetNotifications(argument!);
  if (command === "forget-notice") return forgetNotice(argument!, process.argv[4]!);
  if (command === "remove-contact") return removeContact(argument!, process.argv[4]!);
  if (command === "sweep") return sweep(argument);
  if (command === "sweep-dbtests") return sweepDbtests(argument);
  throw new Error(`unknown command "${command ?? ""}"`);
};

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import type { E2ESeed } from "./seed-cli";

export type { E2ESeed };

/**
 * Throwaway-tenant fixture for the browser harness (test-worker side).
 *
 * DATA SAFETY — the rules this fixture exists to obey:
 *   • every row lives in a tenant the fixture provisioned itself, slug
 *     "e2e-" + a random suffix; no other tenant is ever touched, and
 *     "naxdor" is never so much as read;
 *   • teardown runs from global-teardown.ts on success AND on failure,
 *     and goes through `removeTenant`, which refuses any tenant that is
 *     neither "e2e-"-prefixed nor on seed-cli's explicit DBTEST_PREFIXES
 *     allow-list, and refuses ANY tenant holding a member whose email is
 *     outside "@test.invalid" — the guard that does the real work
 *     (widened 2026-09-02 so the vitest suite's orphans can be swept
 *     too; before that the browser harness cleaned up and the DB suite
 *     never did);
 *   • the owner password is generated per run, handed to the fixture
 *     worker in an env var, and never written to a file or printed.
 *
 * The database work itself happens in e2e/fixtures/seed-cli.ts under
 * tsx — same platform-client provisioning as src/members/dbtest-fixture.ts.
 */

const exec = promisify(execFile);

export const AUTH_DIR = join(process.cwd(), ".auth");
export const STORAGE_STATE = join(AUTH_DIR, "member.json");
/**
 * The CONTACT plane's storage state (Phase 3). A separate jar, not a
 * second cookie in the member one: the two planes are separate tables,
 * separate secrets and separate cookie names, and a walk that carried
 * both would be testing a browser state no real person has.
 */
export const CONTACT_STORAGE_STATE = join(AUTH_DIR, "contact.json");
const SEED_FILE = join(AUTH_DIR, "seed.json");

const TSX = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(process.cwd(), "e2e", "fixtures", "seed-cli.ts");
const MARKER = "__E2E_RESULT__";

async function runCli<T>(args: string[], env: Record<string, string> = {}): Promise<T> {
  const { stdout } = await exec(process.execPath, [TSX, CLI, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    maxBuffer: 8 * 1024 * 1024,
  });
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith(MARKER));
  if (!line) throw new Error(`fixture worker produced no result:\n${stdout}`);
  return JSON.parse(line.slice(MARKER.length)) as T;
}

/**
 * Provision the throwaway tenant with an owner who can really sign in
 * (verified email + credential account), a client, a project, a
 * milestone, one CLIENT_VISIBLE and one INTERNAL document — and, since
 * Phase 3, a CONTACT_PRIMARY contact with a portal credential.
 * Both passwords are returned for the caller's memory only.
 */
export async function provisionE2ETenant(): Promise<{
  password: string;
  contactPassword: string;
  tenantSlug: string;
}> {
  const password = randomBytes(24).toString("base64url");
  const contactPassword = randomBytes(24).toString("base64url");
  const { tenantSlug } = await runCli<{ tenantSlug: string }>(["provision", SEED_FILE], {
    E2E_OWNER_PASSWORD: password,
    E2E_CONTACT_PASSWORD: contactPassword,
  });
  return { password, contactPassword, tenantSlug };
}

/** Idempotent: does nothing when the seed file is already gone. */
/** Remove throwaway tenants an interrupted run orphaned (older than
 * maxAgeMinutes). Prefix-guarded in the worker; never touches a real
 * tenant. Returns how many were removed. */
export async function sweepStaleE2ETenants(maxAgeMinutes = 60): Promise<number> {
  const { swept } = await runCli<{ swept: number }>(["sweep", String(maxAgeMinutes)]);
  return swept;
}

export async function teardownE2ETenant(): Promise<boolean> {
  const { removed } = await runCli<{ removed: boolean }>(["teardown", SEED_FILE]);
  return removed;
}

/** Read a document's stored visibility — the DB half of the assertions. */
export async function documentVisibility(documentId: string): Promise<string> {
  const { visibility } = await runCli<{ visibility: string }>(["visibility", documentId]);
  return visibility;
}

/**
 * Restore a seeded document to a known visibility. Specs call this
 * before they run so each starts from the fixture as provisioned,
 * whatever a previous (possibly failing) spec left behind.
 */
export async function setDocumentVisibility(
  documentId: string,
  value: "INTERNAL" | "CLIENT_VISIBLE",
): Promise<void> {
  await runCli(["set-visibility", documentId, value]);
}

/**
 * A CLIENT_VISIBLE comment under one of the fixture tenant's tasks, by
 * project id + number: the child that makes the `V` picker's downgrade
 * refuse and explain. Written raw — no comment UI exists yet.
 */
export async function addClientVisibleComment(projectId: string, number: number): Promise<string> {
  const { commentId } = await runCli<{ commentId: string }>([
    "client-visible-comment",
    projectId,
    String(number),
  ]);
  return commentId;
}

export type MilestoneRecord = {
  name: string;
  dueAt: string | null;
  visibility: string;
};

/**
 * The stored milestone — hazard H1's regression check. Editing one
 * field through an inline edit must leave the other two byte-identical.
 */
export async function readMilestone(milestoneId: string): Promise<MilestoneRecord> {
  return runCli<MilestoneRecord>(["milestone", milestoneId]);
}

/**
 * Make a project with more rows than the virtualisation threshold. Used
 * by exactly one spec, which drops it again — it is not part of the
 * standing fixture, so no other spec and no visual stop ever sees it.
 */
export async function createBigProject(
  tenantId: string,
  size = 250,
): Promise<{ projectId: string; key: string; size: number }> {
  return runCli(["big-project", tenantId, String(size)]);
}

export async function dropProject(projectId: string): Promise<void> {
  await runCli(["drop-project", projectId]);
}

/**
 * A portal request as the DATABASE holds it — the columns the portal
 * never renders, plus the actor on its audit row.
 *
 * The browser proves that a client can submit one; only this proves
 * what was written. The audit actor in particular can only be checked
 * through a REAL request: the contact principal comes from a cookie, so
 * a service-level test and a browser test could both be green while the
 * HTTP path attributed the row to SYSTEM.
 */
export type PortalRequestRecord = {
  id: string;
  number: number;
  title: string;
  descriptionText: string | null;
  visibility: string;
  portalEnabled: boolean;
  stateCategory: string;
  triageStatus: string | null;
  reportedByContactId: string | null;
  createdByMemberId: string | null;
  clientId: string;
  projectId: string;
  auditActorType: string | null;
  auditActorId: string | null;
};

export async function readPortalRequests(tenantId: string): Promise<PortalRequestRecord[]> {
  return runCli(["portal-requests", tenantId]);
}

/**
 * Hand the fixture back as provisioned — see the CLI's own note on why
 * this runs in `afterAll` and never in a `finally`, and why it is scoped
 * to the SUBMITTER rather than to a clock or to every request row of the
 * tenant.
 */
export async function clearPortalRequests(tenantId: string, contactEmail: string): Promise<number> {
  const { cleared } = await runCli<{ cleared: number }>([
    "clear-portal-requests",
    tenantId,
    contactEmail,
  ]);
  return cleared;
}

export type NotificationRecord = {
  id: string;
  kind: string;
  read: boolean;
  archived: boolean;
  snoozed: boolean;
};

/** The stored notification rows — inbox state is a fact in the
 * database, so the spec asserts on it rather than on a toast. */
export async function readNotifications(tenantId: string): Promise<NotificationRecord[]> {
  return runCli(["notifications", tenantId]);
}

/** Hand the standing fixture's notification back unread: the rail badge
 * is part of every screenshot the visual sweep takes. */
export async function resetNotifications(tenantId: string): Promise<number> {
  const { reset } = await runCli<{ reset: number }>(["reset-notifications", tenantId]);
  return reset;
}

/** A member's next timer start is their first again: the staff notice shows (time.spec's task-timer test). */
export async function forgetStaffNotice(tenantId: string, email: string): Promise<number> {
  const { forgotten } = await runCli<{ forgotten: number }>(["forget-notice", tenantId, email]);
  return forgotten;
}

export function readSeed(): E2ESeed | null {
  if (!existsSync(SEED_FILE)) return null;
  return JSON.parse(readFileSync(SEED_FILE, "utf8")) as E2ESeed;
}

/** For specs: the seed must exist, or global setup did not run. */
export function requireSeed(): E2ESeed {
  const seed = readSeed();
  if (!seed) throw new Error("e2e seed missing — global setup did not run");
  return seed;
}

export function clearAuthState(): void {
  rmSync(STORAGE_STATE, { force: true });
}

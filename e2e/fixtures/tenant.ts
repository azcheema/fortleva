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
 *     and refuses to delete a tenant whose slug is not "e2e-"-prefixed;
 *   • the owner password is generated per run, handed to the fixture
 *     worker in an env var, and never written to a file or printed.
 *
 * The database work itself happens in e2e/fixtures/seed-cli.ts under
 * tsx — same platform-client provisioning as src/members/dbtest-fixture.ts.
 */

const exec = promisify(execFile);

export const AUTH_DIR = join(process.cwd(), ".auth");
export const STORAGE_STATE = join(AUTH_DIR, "member.json");
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
 * milestone, one CLIENT_VISIBLE and one INTERNAL document.
 * The password is returned for the caller's memory only.
 */
export async function provisionE2ETenant(): Promise<{ password: string; tenantSlug: string }> {
  const password = randomBytes(24).toString("base64url");
  const { tenantSlug } = await runCli<{ tenantSlug: string }>(["provision", SEED_FILE], {
    E2E_OWNER_PASSWORD: password,
  });
  return { password, tenantSlug };
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

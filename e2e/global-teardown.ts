import { clearAuthState, teardownE2ETenant } from "./fixtures/tenant";

/**
 * Runs after the whole run — passed, failed or interrupted. Nothing the
 * harness created may outlive it: the throwaway tenant, its owner, the
 * seeded rows, the audit trail, the stored bytes and the session state
 * all go. Failures are reported, never swallowed silently.
 */
export default async function globalTeardown(): Promise<void> {
  try {
    const removed = await teardownE2ETenant();
    console.log(`[e2e] throwaway tenant ${removed ? "torn down" : "already gone"}`);
  } finally {
    clearAuthState();
  }
}

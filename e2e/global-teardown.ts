import { clearAuthState, sweepStaleE2ETenants, teardownE2ETenant } from "./fixtures/tenant";

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
    // Belt to the setup sweep's braces: anything a crashed earlier run
    // orphaned goes now too, so leftovers can never accumulate across
    // runs. The age guard keeps a concurrent run out of range.
    const swept = await sweepStaleE2ETenants(15);
    if (swept > 0) console.log(`[e2e] swept ${swept} orphaned throwaway tenant(s)`);
  } finally {
    clearAuthState();
  }
}

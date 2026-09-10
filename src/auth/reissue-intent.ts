import { AsyncLocalStorage } from "node:async_hooks";

/**
 * A marker saying "this call originated inside the backup-code reissue
 * action", carried across the await chain rather than over the wire.
 *
 * WHY IT EXISTS. `guardFactorMutations` has to distinguish two callers of
 * the same Better Auth endpoint: our own server action, which has just
 * verified a live second factor AND the password in this very request,
 * and an HTTP request from anyone else. The first attempt keyed that on a
 * fresh `Session.mfaVerifiedAt`, and it was too loose — EVERY member-plane
 * step-up writes that stamp, so a stolen member cookie (7 days, sameSite
 * lax) plus the password, landing within the window of an unrelated
 * step-up, could POST `/two-factor/generate-backup-codes` directly and
 * walk away with codes that redeem at the ops console. That is the weak
 * plane minting the strong plane's second factors, which is the pattern
 * the rest of the guard exists to stop.
 *
 * An AsyncLocalStorage flag cannot be set by a request. Headers, cookies
 * and bodies are all attacker-chosen; this is process-local state that
 * only `reissueBackupCodesAction` opens, so the raw endpoint stays frozen
 * for a platform principal no matter what a caller sends.
 *
 * It is an ADDITIONAL condition, never a replacement: the policy still
 * requires the fresh factor stamp beside it (src/auth/factor-policy.ts),
 * so a future caller that forgets to verify a code does not get in on the
 * strength of the marker alone.
 */
const intent = new AsyncLocalStorage<true>();

/** Run `fn` with the reissue marker set for its whole async subtree. */
export function runWithReissueIntent<T>(fn: () => Promise<T>): Promise<T> {
  return intent.run(true, fn);
}

/** True only inside `runWithReissueIntent`. Unreachable from a request. */
export function hasReissueIntent(): boolean {
  return intent.getStore() === true;
}

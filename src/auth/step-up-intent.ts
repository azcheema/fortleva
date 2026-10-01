import { AsyncLocalStorage } from "node:async_hooks";

/**
 * A marker saying "this code check is the product's own step-up", carried
 * across the await chain rather than over the wire — the reissue marker's
 * twin (./reissue-intent), for the same reason.
 *
 * WHY IT EXISTS (slice 83). Better Auth's `/two-factor/verify-totp` and
 * `/two-factor/verify-backup-code` run in one of two modes. Without a
 * session they finish a SIGN-IN, behind a per-challenge attempt counter
 * and the plugin's account lockout. WITH a live session they check a code
 * against that session's factor and count nothing at all — so a stolen
 * session alone, spread over enough addresses to outrun the per-IP
 * limiter, could ask "is 123456 right?" until the answer was yes, then
 * hand that code to the real step-up and pass it (the vault's reveal
 * among everything else). No screen in the product asks that question
 * over HTTP of an enrolled account: the step-up runs in-process, through
 * `verifyStepUpWithHeaders`, which opens this marker after spending the
 * member's step-up budget. ./factor-guard refuses the question without it.
 *
 * A request cannot set an AsyncLocalStorage flag, and only ./step-up opens
 * this one — ./factor-intent.test.ts fails the unit suite on a third.
 */
const intent = new AsyncLocalStorage<true>();

/** Run `fn` with the step-up marker set for its whole async subtree. */
export function runWithStepUpIntent<T>(fn: () => Promise<T>): Promise<T> {
  return intent.run(true, fn);
}

/** True only inside `runWithStepUpIntent`. Unreachable from a request. */
export function hasStepUpIntent(): boolean {
  return intent.getStore() === true;
}

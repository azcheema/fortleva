import { AsyncLocalStorage } from "node:async_hooks";

/**
 * A marker saying "this `enable` is the self-service factor replacement",
 * carried across the await chain rather than over the wire — the third of
 * the factor markers, beside ./reissue-intent and ./step-up-intent, and
 * for the same reason.
 *
 * WHY IT EXISTS (slice 84, founder decision C50). Better Auth's
 * `/two-factor/enable` on an enrolled account deletes the factor and its
 * backup codes and writes a new one, verified — on the password alone.
 * ./factor-guard refuses that to every request (slice 83), because a
 * password must never be able to swap anyone's second factor. A member
 * who has lost their phone still needs a way to replace it, and the one
 * caller that may is `/account`'s replacement (./factor-replace): it
 * checks the password first, then proves the CURRENT factor through the
 * step-up (a live code, or an unused backup code when the phone is gone),
 * and only then opens this marker around the call. The guard lets `enable` over an
 * enrolled factor through only inside this marker AND with the fresh
 * stamp that proof just wrote — the marker alone opens nothing.
 *
 * A request cannot set an AsyncLocalStorage flag, and only
 * ./factor-replace opens this one — ./factor-intent.test.ts fails the
 * unit suite on a second opener.
 */
const intent = new AsyncLocalStorage<true>();

/** Run `fn` with the replacement marker set for its whole async subtree. */
export function runWithReplaceIntent<T>(fn: () => Promise<T>): Promise<T> {
  return intent.run(true, fn);
}

/** True only inside `runWithReplaceIntent`. Unreachable from a request. */
export function hasReplaceIntent(): boolean {
  return intent.getStore() === true;
}

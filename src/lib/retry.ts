import { isDeadlock, isLockTimeout } from "./domain-error";

/** Attempts, not retries: the first call counts. Shared by both shapes. */
const CONTENTION_ATTEMPTS = 3;

async function retryWhile<T>(
  retryable: (e: unknown) => boolean,
  fn: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!retryable(e) || attempt + 1 >= CONTENTION_ATTEMPTS) throw e;
      await new Promise((r) => setTimeout(r, 5 + Math.random() * 20));
    }
  }
}

/**
 * Re-run a unit of work that Postgres aborted as a deadlock victim.
 *
 * A deadlock is not a bug in the caller and not a state the data is in:
 * Postgres detects the cycle, picks one transaction, aborts it and lets
 * the other finish. The victim's work is entirely undone, so redoing it
 * is the whole remedy — there is nothing to repair and nothing a member
 * could be told that would help. The jitter is so two writers that
 * collided do not collide again in lockstep.
 *
 * THE UNIT MUST BE THE WHOLE TRANSACTION. Wrapping anything narrower
 * re-runs statements inside a transaction Postgres has already rolled
 * back, which fails differently and more confusingly.
 *
 * A CURE, NOT A PREVENTION, and the difference matters when choosing
 * between them: three more chances at the same race is not a proof that
 * the race cannot happen. Where a deterministic lock ORDER is available
 * and cheap, take it instead — `src/projects/milestones.ts` and
 * `src/modules/work/rank-lock.ts` both do, with an advisory queue lock.
 * Where it is not — a fan-out across ten tables, or a control that must
 * not wait — this is the honest answer.
 *
 * TWO CALLERS since slice 43 moved `setPortalEnabled` to
 * `retryOnContention` below: `copyWeek` and `repriceRateCard`, both in
 * the time module. The file stays in `src/lib` because the pair is
 * reachable from either side of the ARC-16 import direction, and
 * because the core caller took the sibling rather than leaving.
 * Neither of those two passes `lockTimeoutMs`, so neither can raise a
 * 55P03 and neither loses anything by staying on this shape. The two `retryOnRankCollision` helpers in `milestones.ts`
 * and `ordering.ts` predate it, also handle P2002, and carry their own
 * attempt counts; folding them in is a tidy-up for its own slice, not
 * something to do on the way past.
 *
 * IT ONLY ANSWERS DEADLOCKS. Contention has another shape that looks
 * the same from a distance: a writer that merely BLOCKS on a
 * conflicting row lock never produces a cycle, so Postgres never picks
 * a victim and nothing ends the wait on its own — `isDeadlock` never
 * matches and this never retries. Reaching for it when the real problem
 * is a long lock hold will not help; `retryOnContention` below is for
 * that, and it only has anything to retry if the caller asked
 * `withTenant` for a `lockTimeoutMs`.
 */
export const retryOnDeadlock = <T>(fn: () => Promise<T>): Promise<T> =>
  retryWhile(isDeadlock, fn);

/**
 * The same, for a unit of work that may be either the victim of a cycle
 * OR simply kept waiting — a caller that passes `withTenant`'s
 * `lockTimeoutMs` and therefore gets a 55P03 where it would otherwise
 * have waited with no end in sight (`isLockTimeout` has the
 * measurement). ONE CALLER: `setPortalEnabled`.
 *
 * THE TWO ARE SEPARATE EXPORTS ON PURPOSE. A lock timeout can only
 * reach a caller that ASKED for the bound, so folding both shapes into
 * `retryOnDeadlock` would be a no-op for both of its callers today —
 * but it would also mean a future caller inherits a retry it never
 * reasoned about. Which shapes a transaction expects is part of what
 * it is, so it says which one it wants.
 *
 * AND THE ATTEMPT COUNT MEANS SOMETHING DIFFERENT HERE. A deadlock
 * retry is immediate: the victim was already rolled back, and the
 * jitter is only so two writers do not collide again in lockstep. A
 * lock-timeout retry has already WAITED `lockTimeoutMs` before it
 * failed, so the jitter is noise beside it and the real patience is
 * attempts × that bound. Size the bound, not the count.
 *
 * WHEN THEY ARE ALL SPENT the error is the caller's to translate —
 * BOTH shapes, not just the new one. A caller that translates only the
 * lock timeout leaves a spent deadlock arriving as a raw Prisma error,
 * which `messageForError` rethrows and the member meets as a 500; the
 * first cut of `setPortalEnabled` did exactly that (review). Either
 * shape means the same thing to the person who pressed the button:
 * nothing was written, nothing needs repair, and they are the only one
 * who can decide whether to press it again.
 */
export const retryOnContention = <T>(fn: () => Promise<T>): Promise<T> =>
  retryWhile((e) => isDeadlock(e) || isLockTimeout(e), fn);

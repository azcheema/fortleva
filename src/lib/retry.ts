import { isDeadlock } from "./domain-error";

/** Attempts, not retries: the first call counts. */
const DEADLOCK_ATTEMPTS = 3;

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
 * ONE CALLER TODAY (`setPortalEnabled`), and in `src/lib` anyway
 * because that is where the next one can reach it from either side of
 * the ARC-16 import direction. The two `retryOnRankCollision` helpers in
 * `milestones.ts` and `ordering.ts` predate it, also handle P2002, and
 * carry their own attempt counts — they are deliberately left alone
 * rather than folded in on a slice that is about something else.
 *
 * IT ONLY ANSWERS DEADLOCKS. Contention has another shape that looks
 * the same from a distance: a writer that merely BLOCKS on a
 * conflicting row lock never produces a cycle, so Postgres never picks
 * a victim, and the wait ends as a P2028 transaction timeout instead —
 * which `isDeadlock` does not match and this does not retry. Reaching
 * for this when the real problem is a long lock hold will not help.
 */
export async function retryOnDeadlock<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!isDeadlock(e) || attempt + 1 >= DEADLOCK_ATTEMPTS) throw e;
      await new Promise((r) => setTimeout(r, 5 + Math.random() * 20));
    }
  }
}

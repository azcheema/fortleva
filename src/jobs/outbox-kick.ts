import { drainOutbox } from "./outbox";

/**
 * ONE KICK'S DRAIN of the email outbox — shared by the full jobs run
 * (`/api/jobs/run`, hourly) and the light mail-only kick (`/api/jobs/outbox`,
 * every five minutes; slice 122, founder decision C98), so a notification, a
 * contract's mail or a published report's mail leaves within minutes instead
 * of up to an hour. Concurrent kicks are safe: the claim is the lock
 * (`outbox.ts`).
 *
 * DRAINED UNTIL IT RUNS DRY, within bounds (slice 101's design review): one
 * claim takes 50 rows, and an hourly kick that sent only those would drop
 * the rest of a Monday morning — every client person of every workspace in
 * one zone is due in the same hour, on top of that morning's team
 * summaries — as too late four hours on. Another pass only while the last
 * one claimed a full batch, at most ten (500 mails a kick), and none begun
 * after the first minute — a bound on STARTING passes, not on the route:
 * one pass of client summaries counts each one again, about ten short
 * transactions apiece. A pass that THROWS ends the drain, never the kick
 * (the code review's low): the jobs after it still run, and the next kick
 * drains again.
 */

const DRAIN_BATCH = 50;
const DRAIN_PASSES = 10;
const DRAIN_BUDGET_MS = 60_000;

export type OutboxKick = { sent: number; skipped: number; suppressed: number; failed: number; dead: number; held: number };

export async function drainOutboxKick(): Promise<OutboxKick> {
  const outbox: OutboxKick = { sent: 0, skipped: 0, suppressed: 0, failed: 0, dead: 0, held: 0 };
  const drainStarted = Date.now();
  for (let pass = 0; pass < DRAIN_PASSES; pass += 1) {
    let r: Awaited<ReturnType<typeof drainOutbox>>;
    try {
      r = await drainOutbox(DRAIN_BATCH, { sendUntil: drainStarted + DRAIN_BUDGET_MS });
    } catch (e) {
      const code = typeof e === "object" && e !== null && "code" in e ? ` (${String((e as { code: unknown }).code)})` : "";
      console.error(`jobs: outbox drain pass ${pass + 1} failed: ${e instanceof Error ? e.name : typeof e}${code}`);
      break;
    }
    for (const k of Object.keys(outbox) as (keyof OutboxKick)[]) outbox[k] += r[k];
    const claimed = r.sent + r.skipped + r.suppressed + r.failed + r.dead + r.held;
    if (claimed < DRAIN_BATCH || Date.now() - drainStarted > DRAIN_BUDGET_MS) break;
  }
  return outbox;
}

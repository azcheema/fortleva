import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { isProduction } from "@/config";
import { runClientDigests } from "@/jobs/client-digests";
import { runMemberDigests } from "@/jobs/digests";
import { runExpirationReminders } from "@/jobs/expiration-reminders";
import { drainOutbox } from "@/jobs/outbox";
import { runSealedAskMail } from "@/jobs/sealed-requests";
import { runBudgetAlerts, runTimeSweep } from "@/jobs/time-sweep";
import { runVaultRetention } from "@/jobs/vault-retention";
import { runWeeklyReminders } from "@/jobs/weekly-reminders";

/**
 * Manual job kick (ARC-21 dev fallback): drains the email outbox, runs
 * the 2T timer/shift sweep (12 h / 14 h auto-stops — the reads already
 * settle lazily, this catches members who never came back), the
 * budget-threshold check and the opt-in weekly time reminder (2T D6 —
 * once per member per ISO week, the idempotency key being the whole
 * guard) and the renewal reminders (3V slice 89 — at 60/30/14/7/1 days,
 * once per band, `ExpirationReminderSent` being the guard) and the
 * sealed asks' mail (3V slice 93 — the answerers' reminders, day 3, 6, then
 * daily, and "it has opened"; the ask's own stamps being the guard) and the
 * vault's retention (3V slice 99 — a login 30 days in the bin is erased, a
 * share link's record 12 months after it expired; THE ONE JOB HERE THAT
 * DELETES DATA, in every tenant of the database this server points at),
 * and the team's summary email (Phase 5 slice 100 — once per member per
 * period, only in the hours after their own hour; the outbox key the guard)
 * and the clients' weekly summary (slice 101 — once per client person per ISO
 * week, Monday morning in the workspace's time; the outbox key the guard),
 * until Vercel Pro crons exist. Whenever a
 * JOBS_RUN_TOKEN is configured the caller must present it (constant-time
 * compare); without one the route exists only outside production (local
 * convenience) — a preview/staging deployment without a token is closed.
 * The proxy lists this path as public: the token IS the gate.
 */
/** One outbox claim's size, the passes one kick may make, and their time budget. */
const DRAIN_BATCH = 50;
const DRAIN_PASSES = 10;
const DRAIN_BUDGET_MS = 60_000;

const tokenMatches = (given: string | null, expected: string): boolean => {
  if (given === null) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};

export async function POST(request: Request): Promise<NextResponse> {
  const token = process.env["JOBS_RUN_TOKEN"];
  if (token ? !tokenMatches(request.headers.get("x-jobs-token"), token) : isProduction) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  // DRAINED UNTIL IT RUNS DRY, within bounds (slice 101's design review): one
  // claim takes 50 rows, and an hourly kick that sent only those would drop
  // the rest of a Monday morning — every client person of every workspace in
  // one zone is due in the same hour, on top of that morning's team
  // summaries — as too late four hours on. Another pass only while the last
  // one claimed a full batch, at most ten (500 mails a kick), and none begun
  // after the first minute — a bound on STARTING passes, not on the route:
  // one pass of client summaries counts each one again, about ten short
  // transactions apiece. A pass that THROWS ends the drain, never the kick
  // (the code review's low): the jobs below — the summaries among them, whose
  // window is three hours — still run, and the next kick drains again.
  const outbox = { sent: 0, skipped: 0, suppressed: 0, failed: 0, dead: 0 };
  const drainStarted = Date.now();
  for (let pass = 0; pass < DRAIN_PASSES; pass += 1) {
    let r: Awaited<ReturnType<typeof drainOutbox>>;
    try {
      r = await drainOutbox(DRAIN_BATCH);
    } catch (e) {
      const code = typeof e === "object" && e !== null && "code" in e ? ` (${String((e as { code: unknown }).code)})` : "";
      console.error(`jobs: outbox drain pass ${pass + 1} failed: ${e instanceof Error ? e.name : typeof e}${code}`);
      break;
    }
    for (const k of Object.keys(outbox) as (keyof typeof outbox)[]) outbox[k] += r[k];
    const claimed = r.sent + r.skipped + r.suppressed + r.failed + r.dead;
    if (claimed < DRAIN_BATCH || Date.now() - drainStarted > DRAIN_BUDGET_MS) break;
  }
  const timeSweep = await runTimeSweep();
  const budgets = await runBudgetAlerts();
  // Reminders enqueue; the NEXT drain sends them. Draining again here
  // would send this minute's reminder a minute earlier and hide a bug in
  // the queue behind a convenience.
  const weeklyReminders = await runWeeklyReminders();
  const expirationReminders = await runExpirationReminders();
  const sealedAsks = await runSealedAskMail();
  const vaultRetention = await runVaultRetention();
  // Phase 5 slice 100: the team's summary email — enqueued here, sent by the
  // NEXT drain, like the reminders above.
  const digests = await runMemberDigests();
  // Phase 5 slice 101: the clients' weekly summary — Monday morning in each
  // workspace's time, enqueued here and sent by the NEXT drain.
  const clientDigests = await runClientDigests();
  return NextResponse.json({
    outbox,
    timeSweep,
    budgets,
    weeklyReminders,
    expirationReminders,
    sealedAsks,
    vaultRetention,
    digests,
    clientDigests,
  });
}

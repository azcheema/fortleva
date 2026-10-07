import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { isProduction } from "@/config";
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
 * until Vercel Pro crons exist. Whenever a
 * JOBS_RUN_TOKEN is configured the caller must present it (constant-time
 * compare); without one the route exists only outside production (local
 * convenience) — a preview/staging deployment without a token is closed.
 * The proxy lists this path as public: the token IS the gate.
 */
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
  const outbox = await drainOutbox();
  const timeSweep = await runTimeSweep();
  const budgets = await runBudgetAlerts();
  // Reminders enqueue; the NEXT drain sends them. Draining again here
  // would send this minute's reminder a minute earlier and hide a bug in
  // the queue behind a convenience.
  const weeklyReminders = await runWeeklyReminders();
  const expirationReminders = await runExpirationReminders();
  const sealedAsks = await runSealedAskMail();
  const vaultRetention = await runVaultRetention();
  return NextResponse.json({
    outbox,
    timeSweep,
    budgets,
    weeklyReminders,
    expirationReminders,
    sealedAsks,
    vaultRetention,
  });
}

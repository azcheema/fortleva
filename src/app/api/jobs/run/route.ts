import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { isProduction } from "@/config";
import { drainOutbox } from "@/jobs/outbox";
import { runBudgetAlerts, runTimeSweep } from "@/jobs/time-sweep";
import { runWeeklyReminders } from "@/jobs/weekly-reminders";

/**
 * Manual job kick (ARC-21 dev fallback): drains the email outbox, runs
 * the 2T timer/shift sweep (12 h / 14 h auto-stops — the reads already
 * settle lazily, this catches members who never came back), the
 * budget-threshold check and the opt-in weekly time reminder (2T D6 —
 * once per member per ISO week, the idempotency key being the whole
 * guard), until Vercel Pro crons exist. Whenever a
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
  return NextResponse.json({ outbox, timeSweep, budgets, weeklyReminders });
}

import { NextResponse } from "next/server";

import { isProduction } from "@/config";
import { drainOutbox } from "@/jobs/outbox";
import { runBudgetAlerts, runTimeSweep } from "@/jobs/time-sweep";

/**
 * Manual job kick (ARC-21 dev fallback): drains the email outbox, runs
 * the 2T timer/shift sweep (12 h / 14 h auto-stops — the reads already
 * settle lazily, this catches members who never came back) and the
 * budget-threshold check, until Vercel Pro crons exist. In production
 * the caller must present the JOBS_RUN_TOKEN; without one configured
 * the route does not exist. In development it is open (local
 * convenience only).
 */
export async function POST(request: Request): Promise<NextResponse> {
  if (isProduction) {
    const token = process.env["JOBS_RUN_TOKEN"];
    if (!token || request.headers.get("x-jobs-token") !== token) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
  }
  const outbox = await drainOutbox();
  const timeSweep = await runTimeSweep();
  const budgets = await runBudgetAlerts();
  return NextResponse.json({ outbox, timeSweep, budgets });
}

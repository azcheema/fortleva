import { NextResponse } from "next/server";

import { isProduction } from "@/config";
import { drainOutbox } from "@/jobs/outbox";

/**
 * Manual job kick (ARC-21 dev fallback): drains the email outbox until
 * Vercel Pro crons exist. In production the caller must present the
 * JOBS_RUN_TOKEN; without one configured the route does not exist.
 * In development it is open (local convenience only).
 */
export async function POST(request: Request): Promise<NextResponse> {
  if (isProduction) {
    const token = process.env["JOBS_RUN_TOKEN"];
    if (!token || request.headers.get("x-jobs-token") !== token) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
  }
  const outbox = await drainOutbox();
  return NextResponse.json({ outbox });
}

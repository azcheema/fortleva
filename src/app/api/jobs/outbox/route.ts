import { NextResponse } from "next/server";

import { isCronRequest } from "@/jobs/cron-auth";
import { drainOutboxKick } from "@/jobs/outbox-kick";
import { runPushes } from "@/jobs/push-sweep";

/**
 * THE LIGHT KICK (slice 122, founder decision C98 — going live): mail and
 * phone notifications only. Vercel Cron calls it every five minutes
 * (`vercel.json`), so a notification's email, a contract's mail or a
 * published report's mail leaves within minutes; everything else waits for
 * the hourly full run at `/api/jobs/run`, which drains too. Invitations,
 * password resets and an issued invoice's mail never wait for either — they
 * are sent directly.
 *
 * The pushes' backstop runs here as well, on a short budget: a push whose own
 * kick was lost is due for fifteen minutes (`push-sweep.ts`), so an hourly
 * backstop alone would miss most of them (the slice's review). Its failure
 * is its own.
 *
 * GET with `Authorization: Bearer <CRON_SECRET>` only; with no secret
 * configured there is no caller at all (`src/jobs/cron-auth.ts`). The proxy
 * lists the path as public: the secret IS the gate.
 */

/** The drain starts sends for its first minute; the pushes get twenty seconds; the rest is headroom. */
export const maxDuration = 300;

const PUSH_BUDGET_MS = 20_000;

export async function GET(request: Request): Promise<NextResponse> {
  if (!isCronRequest(request)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const outbox = await drainOutboxKick();
  let pushes: Awaited<ReturnType<typeof runPushes>> | { failed: "discovery" };
  try {
    pushes = await runPushes({ budgetMs: PUSH_BUDGET_MS });
  } catch (e) {
    const code = typeof e === "object" && e !== null && "code" in e ? ` (${String((e as { code: unknown }).code)})` : "";
    console.error(`jobs: pushes failed: ${e instanceof Error ? e.name : typeof e}${code}`);
    pushes = { failed: "discovery" };
  }
  return NextResponse.json({ outbox, pushes });
}

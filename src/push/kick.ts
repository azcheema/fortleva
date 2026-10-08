import { after } from "next/server";

import { pushTransportKind } from "@/config";
import { deliverPushes } from "@/jobs/push";

/**
 * THE KICK (Phase 5 slice 106; C74 (h): a phone buzzes AT ONCE). `notify.emit`
 * calls this with the ids of the notifications it just wrote that may push;
 * Next's `after()` runs the delivery once the response has gone — so after the
 * request's transaction committed, and the drain can see the rows.
 *
 * ONLY THOSE IDS (the design review's M1): a kick never sweeps the tenant —
 * another request's rows may not be committed yet, and the sweep is the jobs
 * route's (`runPushes`, the backstop for a kick that was lost). ONLY INSIDE A
 * REQUEST: outside one (a dbtest, a script) `after()` throws and this does
 * nothing — never the detached promise ARC-21 rejects, and never a drain
 * started inside a caller's still-open transaction. AT MOST TWO AT ONCE in a
 * process: the jobs route can emit forty renewal reminders in one run, and
 * forty concurrent drains would exhaust the connection pool; the rest wait
 * their turn inside their own `after()`. Each kick has a short budget, bounded
 * anyway by what is left of its route's `maxDuration` — a kick cut off before
 * its sends started hands its rows back; the sweep picks them up inside the
 * window.
 */

const MAX_CONCURRENT_KICKS = 2;
const KICK_BUDGET_MS = 15_000;

let running = 0;
const waiting: (() => void)[] = [];

const acquire = (): Promise<void> => {
  if (running < MAX_CONCURRENT_KICKS) {
    running += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
};

const release = (): void => {
  const next = waiting.shift();
  if (next) next();
  else running -= 1;
};

export function kickPushes(tenantId: string, notificationIds: readonly string[]): void {
  if (notificationIds.length === 0 || pushTransportKind === "none") return;
  const ids = [...notificationIds];
  const task = async (): Promise<void> => {
    await acquire();
    try {
      await deliverPushes(tenantId, { ids, budgetMs: KICK_BUDGET_MS });
    } catch (e) {
      // Ids, name and code only (a Prisma message prints its arguments).
      const code = typeof e === "object" && e !== null && "code" in e ? ` (${String((e as { code: unknown }).code)})` : "";
      console.error(`push: kick for tenant ${tenantId} failed: ${e instanceof Error ? e.name : typeof e}${code}`);
    } finally {
      release();
    }
  };
  try {
    after(task);
  } catch {
    // Outside a request scope: the jobs route's sweep delivers it.
  }
}

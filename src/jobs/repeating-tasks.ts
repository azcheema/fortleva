import { withPlatform } from "@/db";
import { addDays } from "@/lib/week";
import { dateColumn } from "@/lib/duration";
import { PROJECT_MAKES_COPIES_WHERE } from "@/modules/work/repeat";
import { makeRepeatCopies } from "@/modules/work/repeat-copies";
import { DIGEST_SENDING_TENANT_STATUSES } from "@/notify/digest";

/**
 * REPEATING TASKS (slice 127; founder decision C103 — design
 * docs/research/2026-10-17-slice-127-repeating-tasks-design.md §3.5): on
 * each repeat day, in each workspace's zone, the task a series is made from
 * gets its next copy — private, where new tasks start, due the day before
 * the next one, given to whoever held it if they still can take it. The
 * per-workspace body — the gate, the day, the copy, who is told — is the
 * work module's (`makeRepeatCopies`); this file only finds the workspaces
 * worth opening.
 *
 * Discovery is the one audited cross-tenant read (`withPlatform`, read-only)
 * and carries ids only: SENDING workspaces (the digests' set — not
 * suspended, offboarding or closed) holding a series whose next day is at
 * most TOMORROW in UTC, which covers today in every zone; each workspace then
 * decides with its own zone, inside its own transaction, under its OWN
 * system principal with RLS live, so nothing here can mix two workspaces'
 * rows.
 *
 * ONE WORKSPACE'S FAILURE DOES NOT SKIP THE REST: it is counted and logged —
 * the id and the error's name and code, never its message. Idempotent and
 * hourly-safe: a series moves past today once its copy is made, and the
 * database refuses a second copy for the same day. BOUNDED: 45 seconds a
 * kick across every workspace, in a fresh random order each kick, each
 * workspace at most 15 seconds of it and 200 series, least recently touched
 * first (`makeRepeatCopies`). So `POST /api/jobs/run` — and Vercel Cron,
 * every hour in production — now MAKES TASKS, in every sending workspace of
 * the database it runs against (AGENTS.md).
 */

/** The time one kick may spend, across every workspace. */
export const REPEATING_TASKS_BUDGET_MS = 45_000;

/** A fair order: no workspace always goes first, and none can starve the rest kick after kick. */
function shuffled<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export async function runRepeatingTasks(
  now: Date = new Date(),
  opts: { readonly budgetMs?: number } = {},
): Promise<{ tenants: number; considered: number; made: number; failed: number; outOfTime: boolean }> {
  const deadline = Date.now() + (opts.budgetMs ?? REPEATING_TASKS_BUDGET_MS);
  // Tomorrow in UTC: the furthest-east zone (UTC+14) is never more than a
  // day ahead of UTC, so this holds every workspace's today.
  const horizon = dateColumn(addDays(now.toISOString().slice(0, 10), 1));
  const tenantIds = await withPlatform(
    { type: "system", job: "repeating-tasks" },
    "list sending tenants with a repeating task due",
    async (tx) => {
      const rows = await tx.workItemRepeat.findMany({
        // A series whose newest task is deleted waits (the bin may bring it
        // back), and so does one in a project that makes no copies (paused,
        // completed, cancelled, archived, or its client archived — the
        // reviews' L-1/L3): neither opens its workspace every hour for nothing.
        where: {
          nextOn: { lte: horizon },
          workItem: { deletedAt: null, project: PROJECT_MAKES_COPIES_WHERE },
          tenant: { status: { in: [...DIGEST_SENDING_TENANT_STATUSES] } },
        },
        select: { tenantId: true },
        distinct: ["tenantId"],
      });
      return rows.map((r) => r.tenantId);
    },
  );

  const out = { tenants: tenantIds.length, considered: 0, made: 0, failed: 0, outOfTime: false };
  for (const tenantId of shuffled(tenantIds)) {
    if (Date.now() >= deadline) {
      out.outOfTime = true; // the rest are copied next kick
      break;
    }
    try {
      const r = await makeRepeatCopies(tenantId, now, { deadline });
      out.considered += r.considered;
      out.made += r.made;
      out.failed += r.failed;
      if (r.outOfTime) out.outOfTime = true;
    } catch (e) {
      out.failed += 1;
      const code = typeof e === "object" && e !== null && "code" in e ? ` (${String((e as { code: unknown }).code)})` : "";
      console.error(`repeating-tasks: tenant ${tenantId} failed: ${e instanceof Error ? e.name : typeof e}${code}`);
    }
  }
  return out;
}

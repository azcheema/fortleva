import { withPlatform } from "@/db";
import { publishScheduledUpdates } from "@/modules/work";
import { DIGEST_SENDING_TENANT_STATUSES } from "@/notify/digest";

/**
 * SCHEDULED PROGRESS UPDATES (slice 135; founder decision C112 — design
 * docs/research/2026-10-18-slice-135-scheduled-updates-design.md §4): every
 * draft whose chosen hour has come is published as the member who scheduled
 * it (C112 (c): the hour you pick, out with the hourly run a few minutes
 * after). The per-workspace body — the re-checks as the scheduler, the
 * publish, a refusal and who is told — is the work module's
 * (`publishScheduledUpdates`); this file only finds the workspaces worth
 * opening.
 *
 * Discovery is the one audited cross-tenant read (`withPlatform`, read-only,
 * ids only): SENDING workspaces (the digests' set — not suspended,
 * offboarding or closed) holding a DRAFT whose `scheduled_for` has passed
 * (the partial index `project_update_scheduled_for_idx`). Each workspace then
 * runs under its OWN system principal with RLS live.
 *
 * ONE WORKSPACE'S FAILURE DOES NOT SKIP THE REST: counted and logged — the
 * id and the error's name and code, never its message. BOUNDED: 45 seconds
 * a kick across every workspace, in a fresh random order, at most 50 posts a
 * workspace. So `POST /api/jobs/run` — and Vercel Cron, every hour in
 * production — now PUBLISHES PROGRESS UPDATES to clients, in every sending
 * workspace of the database it runs against (AGENTS.md).
 */

export const SCHEDULED_UPDATES_BUDGET_MS = 45_000;

/** A fair order: no workspace always goes first. */
function shuffled<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export async function runScheduledUpdates(
  now: Date = new Date(),
  opts: { readonly budgetMs?: number } = {},
): Promise<{ tenants: number; considered: number; published: number; refused: number; failed: number; outOfTime: boolean }> {
  const deadline = Date.now() + (opts.budgetMs ?? SCHEDULED_UPDATES_BUDGET_MS);
  const tenantIds = await withPlatform(
    { type: "system", job: "scheduled-updates" },
    "list sending tenants with a scheduled progress update due",
    async (tx) => {
      const rows = await tx.projectUpdate.findMany({
        where: {
          status: "DRAFT",
          scheduledFor: { lte: now },
          tenant: { status: { in: [...DIGEST_SENDING_TENANT_STATUSES] } },
        },
        select: { tenantId: true },
        distinct: ["tenantId"],
      });
      return rows.map((r) => r.tenantId);
    },
  );

  const out = { tenants: tenantIds.length, considered: 0, published: 0, refused: 0, failed: 0, outOfTime: false };
  for (const tenantId of shuffled(tenantIds)) {
    if (Date.now() >= deadline) {
      out.outOfTime = true; // the rest go next kick
      break;
    }
    try {
      const r = await publishScheduledUpdates(tenantId, now, { deadline });
      out.considered += r.considered;
      out.published += r.published;
      out.refused += r.refused;
      out.failed += r.failed;
      if (r.outOfTime) out.outOfTime = true;
    } catch (e) {
      out.failed += 1;
      const code = typeof e === "object" && e !== null && "code" in e ? ` (${String((e as { code: unknown }).code)})` : "";
      console.error(`scheduled-updates: tenant ${tenantId} failed: ${e instanceof Error ? e.name : typeof e}${code}`);
    }
  }
  return out;
}

import { withPlatform } from "@/db";

import { CLAIM_MARGIN_MS, deliverPushes, forgetStaleDevices, type PushRunResult } from "./push";

/**
 * The jobs route's half of phone and browser notifications (Phase 5 slice 106):
 * every workspace with a device, each delivering what a lost kick left (inside
 * the fifteen-minute window) and then forgetting stale devices
 * (`forgetStaleDevices`). The discovery is the platform door's one read here
 * (audited by `withPlatform` once a run, like every job's); the rest runs as
 * each tenant's SYSTEM principal (`./push.ts`). One tenant's failure does not
 * stop the others; each is logged by id and name.
 *
 * Its own module so that the kick's import graph (`notify.emit` → `kickPushes`
 * → `deliverPushes`) never reaches `withPlatform`: the portal's routes reach
 * `emit`.
 */
/** The error's NAME and code only — a Prisma message prints its arguments. */
const what = (e: unknown): string => {
  const code = typeof e === "object" && e !== null && "code" in e ? ` (${String((e as { code: unknown }).code)})` : "";
  return `${e instanceof Error ? e.name : typeof e}${code}`;
};

export async function runPushes(opts: { readonly budgetMs?: number } = {}): Promise<PushRunResult & { tenants: number }> {
  const total: PushRunResult & { tenants: number } = { sent: 0, dropped: 0, failed: 0, released: 0, forgotten: 0, tenants: 0 };
  const deadline = Date.now() + (opts.budgetMs ?? 60_000);
  const tenants = await withPlatform(
    { type: "system", job: "push" },
    "list tenants with phone-notification devices",
    async (tx) => (await tx.$queryRaw<{ tenant_id: string }[]>`SELECT DISTINCT tenant_id FROM push_subscription`).map((r) => r.tenant_id),
  );
  for (const tenantId of tenants) {
    total.tenants += 1;
    try {
      const left = deadline - Date.now();
      if (left > CLAIM_MARGIN_MS) {
        const r = await deliverPushes(tenantId, { budgetMs: Math.min(left, 20_000) });
        total.sent += r.sent;
        total.dropped += r.dropped;
        total.failed += r.failed;
        total.released += r.released;
        total.forgotten += r.forgotten;
      }
      total.forgotten += await forgetStaleDevices(tenantId);
    } catch (e) {
      console.error(`push: tenant ${tenantId} failed: ${what(e)}`);
    }
  }
  return total;
}

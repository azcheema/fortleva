import { fortnoxClientId } from "@/config";
import { withPlatform } from "@/db";
import { fortnoxTransport } from "@/integrations/fortnox";
import { sendToFortnox } from "@/modules/invoicing/fortnox-send";
import { DIGEST_SENDING_TENANT_STATUSES } from "@/notify/digest";

/**
 * THE NIGHTLY SEND TO FORTNOX (Phase 4 slice 114b; founder decision C89 (b),
 * (c)) — every connected workspace's bookkeeping entries booked in its
 * Fortnox company, each a voucher with its invoice's PDF; the night's file
 * made once its day has turned. The per-workspace body is the invoicing
 * module's (`sendToFortnox`, `src/modules/invoicing/fortnox-send.ts`); this
 * file only finds the workspaces worth opening.
 *
 * NOTHING AT ALL while `FORTNOX_TRANSPORT` is off — the default everywhere,
 * and production's until Fortnox's written consent (C89 (a)).
 *
 * Discovery is the one audited cross-tenant read (`withPlatform`, read-only)
 * and carries ids only: SENDING tenants (not suspended, offboarding or closed
 * — the digests' set) with a LIVE Fortnox connection made by THIS process's
 * transport and Fortnox app (a row of another environment is never sent from
 * here — the design review's S2). Each workspace then runs under its OWN
 * system principal with RLS live, and decides the rest itself (the module
 * open, a stop only a person mends, the fake transport's test workspaces).
 *
 * ONE WORKSPACE'S FAILURE DOES NOT SKIP THE REST: it is counted and logged —
 * the tenant's id and the error's name and code, never its message. BOUNDED
 * (§10.5): 45 seconds a run across every workspace, in a fresh random order;
 * while others wait, a workspace begins nothing new after a third of it (an
 * answer in flight still lands). Invoked by `POST /api/jobs/run` — so that
 * route SENDS VOUCHERS TO FORTNOX for every connected workspace of the
 * database it runs against (AGENTS.md).
 */

/** The time one run may spend, across every workspace (§10.5). */
export const FORTNOX_BUDGET_MS = 45_000;

/** A fair order: no workspace always goes first. */
function shuffled<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export type FortnoxSendJob = {
  readonly tenants: number;
  readonly booked: number;
  readonly attached: number;
  readonly files: number;
  readonly stopped: number;
  readonly skipped: number;
  readonly failed: number;
  readonly outOfTime: boolean;
};

export async function runFortnoxSend(now: Date = new Date(), opts: { readonly budgetMs?: number } = {}): Promise<FortnoxSendJob | { readonly off: true }> {
  const transport = fortnoxTransport();
  if (!transport || fortnoxClientId === null) return { off: true };
  const budget = opts.budgetMs ?? FORTNOX_BUDGET_MS;
  const deadline = Date.now() + budget;
  const tenantIds = await withPlatform(
    { type: "system", job: "fortnox-send" },
    "list workspaces with a live Fortnox connection made by this deployment",
    async (tx) => {
      const rows = await tx.integrationConnection.findMany({
        where: {
          provider: "FORTNOX",
          status: { not: "DISCONNECTED" },
          transport: transport.kind,
          appClientId: fortnoxClientId!,
          tenant: { status: { in: [...DIGEST_SENDING_TENANT_STATUSES] } },
        },
        select: { tenantId: true },
        distinct: ["tenantId"],
      });
      return rows.map((r) => r.tenantId);
    },
  );

  const out = { tenants: tenantIds.length, booked: 0, attached: 0, files: 0, stopped: 0, skipped: 0, failed: 0, outOfTime: false };
  const order = shuffled(tenantIds);
  for (const [i, tenantId] of order.entries()) {
    if (Date.now() >= deadline) {
      out.outOfTime = true; // the rest go on the next run
      break;
    }
    // While others wait, a third of the run at most (§10.5).
    const softUntil = i < order.length - 1 ? Math.min(deadline, Date.now() + Math.floor(budget / 3)) : deadline;
    try {
      const r = await sendToFortnox(tenantId, { deadline, softUntil, now });
      if (r.skipped !== null) out.skipped += 1;
      out.booked += r.booked;
      out.attached += r.attached;
      out.files += r.files;
      if (r.stopped !== null) out.stopped += 1;
      if (r.outOfTime) out.outOfTime = true;
    } catch (e) {
      out.failed += 1;
      const code = typeof e === "object" && e !== null && "code" in e ? ` (${String((e as { code: unknown }).code)})` : "";
      console.error(`fortnox-send: tenant ${tenantId} failed: ${e instanceof Error ? e.name : typeof e}${code}`);
    }
  }
  return out;
}

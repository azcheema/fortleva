import { withPlatform } from "@/db";
import { owedSealedMailWhere, sendSealedAskMail } from "@/modules/vault";

/**
 * The sealed asks' mail (Phase 3V slice 93; founder decisions C52 (f) and
 * (h)): the answerers' reminders — day 3, 6, then daily while an ask of a
 * client's to open their sealed logins is unsettled — and "it has opened"
 * once the 48 hours after a client's confirmation have run. The per-tenant
 * body — who hears, what is sent, the bookkeeping — is the vault's
 * (`sendSealedAskMail`); this file only finds the tenants worth opening.
 *
 * IT ONLY MAILS: an ask's state is derived from its stamps when it is read,
 * so this job never opens anything, and a run that is missed delays a
 * mail, never an opening.
 *
 * Discovery is the one audited cross-tenant read (`withPlatform`,
 * read-only) and carries ids only; each tenant then runs under its OWN
 * system principal with RLS live. ONE TENANT'S FAILURE DOES NOT SKIP THE
 * REST (the renewal reminders' rule): it is counted and logged — the
 * tenant's id and the error's name and code, never its message, which for
 * a Prisma error prints the query's arguments — and the next runs.
 * Invoked by `POST /api/jobs/run` until Vercel Cron exists.
 */
export async function runSealedAskMail(): Promise<{ tenants: number; reminders: number; opened: number; failed: number }> {
  const tenantIds = await withPlatform(
    { type: "system", job: "sealed-requests" },
    "list tenants with a sealed-login ask still waiting for an answer, a confirmation or its opening notice",
    async (tx) => {
      // The vault's own filter — the same asks the per-tenant body will
      // read, lapsed ones beyond the horizon left out (both reviews' low).
      const rows = await tx.sealedOpenRequest.findMany({
        where: owedSealedMailWhere(new Date()),
        select: { tenantId: true },
        distinct: ["tenantId"],
      });
      return rows.map((r) => r.tenantId);
    },
  );

  const out = { tenants: tenantIds.length, reminders: 0, opened: 0, failed: 0 };
  for (const tenantId of tenantIds) {
    try {
      const r = await sendSealedAskMail(tenantId);
      out.reminders += r.reminders;
      out.opened += r.opened;
    } catch (e) {
      out.failed += 1;
      const code = typeof e === "object" && e !== null && "code" in e ? ` (${String((e as { code: unknown }).code)})` : "";
      console.error(`sealed-requests: tenant ${tenantId} failed: ${e instanceof Error ? e.name : typeof e}${code}`);
    }
  }
  return out;
}

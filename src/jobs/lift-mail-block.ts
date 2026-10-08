import { withPlatform } from "@/db";

/**
 * Support's unblock, on its own (slice 103; the security review's nit): the
 * public webhook's writer, `mail-feedback.ts`, must not sit beside the one
 * function that REMOVES blocks. Only `scripts/lift-mail-block.ts` and its
 * dbtest may import this — pinned by `src/db/import-boundary.test.ts`.
 */

/** What `liftMailBlock` found, and whether it removed it. */
export type LiftedBlock =
  | { readonly found: false }
  | {
      readonly found: true;
      readonly removed: boolean;
      readonly reason: string;
      readonly source: string | null;
      readonly since: Date;
    };

/**
 * SUPPORT LIFTS A BLOCK (C71 (f); RUNBOOK §8) — only on the person's own
 * request, never an agency's: one agency's unblock is every agency's
 * reputation. Run by the operator through `scripts/lift-mail-block.ts`, never
 * by the product. AUDITED, unlike a hand-typed DELETE (the design review's
 * low): `withPlatform` writes the `platform.system_job` row in the same
 * transaction, and its reason names the address and support's reason — the
 * row being deleted was the only other record of it. `dryRun` reads and
 * removes nothing — its audit row still names the address and the reason
 * (a support check is itself worth a trace). Amazon's own account-level list is the operator's second
 * step (the script prints it).
 */
export async function liftMailBlock(rawEmail: string, why: string, dryRun: boolean): Promise<LiftedBlock> {
  const email = rawEmail.trim().toLowerCase();
  const reason = why.trim();
  if (email.length === 0 || !email.includes("@")) throw new Error("liftMailBlock: an address is required");
  if (reason.length === 0) throw new Error("liftMailBlock: a reason is required");
  return withPlatform(
    { type: "system", job: "lift-mail-block" },
    `${dryRun ? "check" : "lift"} the mail block on ${email} (support): ${reason}`,
    async (tx) => {
      const row = await tx.emailSuppression.findUnique({ where: { email } });
      if (row === null) return { found: false } as const;
      if (!dryRun) await tx.emailSuppression.delete({ where: { email } });
      return { found: true, removed: !dryRun, reason: row.reason, source: row.source, since: row.createdAt } as const;
    },
    { readOnly: dryRun },
  );
}

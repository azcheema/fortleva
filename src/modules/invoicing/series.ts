import { record } from "@/audit/record";
import { withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { fail } from "@/lib/domain-error";
import { newId } from "@/lib/ids";

import { guarded } from "./db-errors";
import type { InvoicingCtx } from "./drafts";

/**
 * THE WORKSPACE'S INVOICE NUMBERS (Phase 4 slice 108; founder decision C76
 * (a)–(c)). ONE series per workspace: plain numbers, counting up from the
 * first number the workspace chose and never restarting at a new year; credit
 * notes draw from it too. The first number is set on Settings → Invoicing
 * BEFORE the first invoice (Naxdor's starts well above Fortnox's, so the two
 * programs can issue side by side and never share a number) and is fixed once
 * an invoice holds a number.
 *
 * THE DATABASE OWNS THE COUNTING (migration 20261009200000): a number is
 * allocated only by the issue guard, in the issuing transaction, from the
 * series row — never a SEQUENCE, so a rolled-back issue gives its number back
 * and the series stays unbroken (Skatteverket: a löpnummer in one or more
 * series, unbroken through the fiscal year). `invoice_series_guard` refuses any
 * other change to `next_number` once a number exists. This module only reads
 * the series and sets the first number.
 *
 * `invoice:manage_series` is ✦ (owner-only by template): the step-up page
 * when the second factor is stale.
 */

/** The largest first number: room for a billion invoices under a 10-digit ceiling. */
export const FIRST_NUMBER_MAX = 999_999_999;

export type Numbering = {
  readonly seriesId: string;
  readonly firstNumber: number;
  readonly nextNumber: number;
  /** An invoice holds a number from it: the first number is fixed. */
  readonly used: boolean;
};

const memberPrincipal = (ctx: InvoicingCtx) => ({ type: "member", id: ctx.actor.memberId }) as const;

/**
 * The workspace's series, read inside an existing transaction; null before one
 * is set. "Used" is the counter itself: only an issue moves `nextNumber` past
 * `firstNumber` (the guard holds it), so no read of the invoices is needed.
 */
export async function readNumbering(tx: TenantDb, tenantId: string): Promise<Numbering | null> {
  const series = await tx.invoiceSeries.findFirst({
    where: { tenantId },
    select: { id: true, firstNumber: true, nextNumber: true },
  });
  if (!series) return null;
  return {
    seriesId: series.id,
    firstNumber: series.firstNumber,
    nextNumber: series.nextNumber,
    used: series.nextNumber !== series.firstNumber,
  };
}

/** A typed first number: digits only (spaces allowed), 1 … 999 999 999. */
export function parseFirstNumber(raw: unknown): number {
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.replace(/[\s  ]/g, "") : "";
  if (!/^\d{1,9}$/.test(text)) return fail("INVALID_INPUT", "first number");
  const n = Number(text);
  if (n < 1 || n > FIRST_NUMBER_MAX) return fail("INVALID_INPUT", "first number");
  return n;
}

/**
 * `invoice:manage_series` ✦ — set the first invoice number: the series made,
 * or its first number changed while nothing is numbered from it yet. Returns
 * whether anything changed.
 */
export async function setFirstInvoiceNumber(ctx: InvoicingCtx, raw: unknown): Promise<boolean> {
  const first = parseFirstNumber(raw);
  return guarded(() =>
    withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "invoice:manage_series");
      await requireAccess(tx, ctx.tenantId, ctx.actor, "invoice:view");
      // The first save makes the series; two at once must not both INSERT
      // into the one-per-workspace unique and turn it into an error page
      // (the design review's low — 107's terms upsert, the same race).
      const made = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO invoice_series (id, tenant_id, first_number, next_number, created_by_member_id, updated_at)
        VALUES (${newId()}, ${ctx.tenantId}, ${first}, ${first}, ${ctx.actor.memberId}, now())
        ON CONFLICT (tenant_id) DO NOTHING
        RETURNING id`;
      if (made[0]) {
        await record(tx, {
          action: "series.created",
          targetType: "InvoiceSeries",
          targetId: made[0].id,
          metadata: { firstNumber: first },
        });
        return true;
      }
      // It exists: the row locked (NO KEY — a draft's FK check takes KEY
      // SHARE and must not wait on this). The guard reads "nothing numbered
      // yet" from this locked row, so an issue racing the change either
      // committed first — refused — or waits and counts from the new number.
      const rows = await tx.$queryRaw<{ id: string; first_number: number; next_number: number }[]>`
        SELECT id, first_number, next_number FROM invoice_series WHERE tenant_id = ${ctx.tenantId} FOR NO KEY UPDATE`;
      const current = rows[0];
      if (!current) throw new Error("setFirstInvoiceNumber: the series vanished");
      if (current.first_number === first) return false;
      if (current.next_number !== current.first_number) return fail("INVOICE_SERIES_IN_USE");
      await tx.invoiceSeries.update({
        where: { id: current.id },
        data: { firstNumber: first, nextNumber: first },
        select: { id: true },
      });
      await record(tx, {
        action: "series.first_number_changed",
        targetType: "InvoiceSeries",
        targetId: current.id,
        metadata: { from: current.first_number, to: first },
      });
      return true;
    }),
  );
}

import type { TenantDb } from "@/db";
import { voucherBody } from "@/integrations/fortnox/body";
import type { FortnoxVoucherDraft } from "@/integrations/fortnox/types";

/**
 * THE NIGHTLY SEND'S PURE PIECES (Phase 4 slice 114b) — the voucher an entry
 * froze as Fortnox takes it, the marker a reconcile matches, and a stop's
 * reason as the connection keeps it. Pure, so `fortnox-voucher.test.ts` pins
 * them; `fortnox-send.ts` uses them.
 */

/** Under the FAKE transport, a workspace is sent only when every member's address ends so (S′10b). */
export const THROWAWAY_EMAIL_DOMAIN = "@test.invalid";

/**
 * Every member of the workspace has a test address (the code review of 114's
 * S′10b — the seed CLI's evidence rule): the fake transport's only
 * workspaces, so a member who connects a REAL workspace on the shared dev
 * database to its fake company never has its entries "sent" into a file.
 */
export async function isThrowawayWorkspace(tx: Pick<TenantDb, "member">, tenantId: string): Promise<boolean> {
  const real = await tx.member.findFirst({
    where: { tenantId, user: { email: { not: { endsWith: THROWAWAY_EMAIL_DOMAIN } } } },
    select: { id: true },
  });
  return real === null;
}

/** The marker in a voucher's comment — the one fact a reconcile matches. */
export const markerOf = (entryId: string): string => `Fortleva ${entryId}`;

/** Whether a voucher read back is this entry's (exactly our own words). */
export const isOurVoucher = (comments: string | null, entryId: string): boolean => comments !== null && comments.trim() === markerOf(entryId);

/** Why the line stopped, as the connection keeps it (`broken_reason`). */
export type BrokenReason = {
  readonly kind: string;
  /** Fortnox's code — or, for SERIES and ACCOUNT, "missing" / "notManual" / "inactive". */
  readonly code?: string | null;
  readonly message?: string | null;
  readonly entryId?: string;
  readonly invoice?: string;
  readonly event?: string;
  readonly day?: string;
  readonly account?: string;
};

/** A reason's Fortnox message, at most (`parse.ts` cuts it already). */
const MESSAGE_MAX = 200;

/** The voucher an entry froze, as Fortnox takes it — or null when it is out of shape (a bug to see). */
export function draftOf(o: { readonly entryId: string; readonly series: string; readonly bookedOn: string; readonly voucher: unknown }): FortnoxVoucherDraft | null {
  const v = o.voucher as { text?: unknown; rows?: unknown } | null;
  if (!v || typeof v.text !== "string" || !Array.isArray(v.rows)) return null;
  const rows: { account: string; amount: string }[] = [];
  for (const r of v.rows as { account?: unknown; amount?: unknown }[]) {
    if (typeof r?.account !== "string" || typeof r?.amount !== "string") return null;
    rows.push({ account: r.account, amount: r.amount });
  }
  const draft: FortnoxVoucherDraft = { series: o.series, date: o.bookedOn, description: v.text, comments: markerOf(o.entryId), rows };
  try {
    voucherBody(draft);
  } catch {
    return null;
  }
  return draft;
}

/** A reason as the connection keeps it: its kind and the facts it has, Fortnox's words cut. */
export function storedReason(r: BrokenReason): Record<string, string> {
  const out: Record<string, string> = { kind: r.kind };
  for (const k of ["code", "entryId", "invoice", "event", "day", "account"] as const) {
    const v = r[k];
    if (typeof v === "string" && v !== "") out[k] = v.slice(0, 64);
  }
  if (typeof r.message === "string" && r.message.trim() !== "") out.message = r.message.trim().slice(0, MESSAGE_MAX);
  return out;
}

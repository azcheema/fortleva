import type { TenantDb } from "@/db";
import { voucherBody } from "@/integrations/fortnox/body";
import type { FortnoxVoucherDraft } from "@/integrations/fortnox/types";
import { dueAt } from "@/notify/weekly-reminder";

/**
 * THE NIGHTLY SEND'S PURE PIECES (Phase 4 slice 114b) — the voucher an entry
 * froze as Fortnox takes it, the marker a reconcile matches, and a stop's
 * reason as the connection keeps it; and (slice 114c) when a stop's Monday
 * reminder is due. Pure, so `fortnox-voucher.test.ts` pins them;
 * `fortnox-send.ts` uses them.
 */

/**
 * A booked voucher whose PDF is still not attached after this is reported
 * (PDF_MISSING) — and, from then on, a person may mark it attached by hand
 * (slice 114c). Here, not in `fortnox-send.ts`, because the Bookkeeping page
 * reads it too and that module imports the page's.
 */
export const PDF_GRACE_MS = 24 * 3_600_000;

/** The Monday reminder's day and hour, on the workspace's wall clock (C89 (e); C90). */
export const STOP_REMINDER_WEEKDAY = 1;
export const STOP_REMINDER_HOUR = 8;

/**
 * Whether a stop's Monday reminder is due now (slice 114c; C89 (e)): this ISO
 * week's Monday 08:00 in the workspace's zone has passed, and the owners were
 * last told MORE THAN A DAY before it — so a stop told on Sunday evening is
 * not told again on Monday morning, and a week whose Monday the job missed
 * still gets its reminder on a later day of that week. The week's key, or null.
 */
export function stopReminderDue(now: Date, timeZone: string, lastTold: Date): { readonly week: string } | null {
  const due = dueAt(now, timeZone, STOP_REMINDER_WEEKDAY, STOP_REMINDER_HOUR);
  if (due === null || now.getTime() < due.at.getTime()) return null;
  if (lastTold.getTime() >= due.at.getTime() - 24 * 3_600_000) return null;
  return { week: `${due.isoYear}-W${String(due.isoWeek).padStart(2, "0")}` };
}

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

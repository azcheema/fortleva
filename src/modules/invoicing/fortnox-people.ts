import { record } from "@/audit/record";
import { deny } from "@/authz/errors";
import { withTenant } from "@/db";
import { fail } from "@/lib/domain-error";

import { openBookkeeping } from "./bookkeeping";
import type { InvoicingCtx } from "./drafts";
import { actsFor, type FortnoxAct } from "./fortnox-acts";
import { PDF_GRACE_MS, markerOf } from "./fortnox-voucher";
import { LIST_EVENTS, type ListEvent } from "./invoice-list";
import { isoDay } from "./print";

/**
 * THE NIGHTLY SEND'S PEOPLE'S SIDE (Phase 4 slice 114c; founder decisions C89
 * and C90; docs/research/2026-10-12-slice-114-fortnox-connection-design.md
 * §14, §10.1–§10.2 and §13). What only a person decides about an entry owed to
 * Fortnox, on the Bookkeeping page — its gates (`invoice:view`,
 * `invoice:export`, a tenant-wide scope; `openBookkeeping`), never under
 * impersonation. The database holds every rule here too
 * (`invoice_export_delivery_guard`, migration 20261020090000): a person moves a
 * delivery only as themselves, holding `invoice:export`, never while the
 * nightly send holds a live lease on a live connection.
 *
 *  - BOOKED BY HAND ("it is in Fortnox's books", or dealt with there — Fortleva
 *    will never send it). While the connection lives: ONLY the entry the line
 *    STOPPED at (the connection BROKEN naming it, the delivery QUEUED) — every
 *    other entry Fortleva still sends by itself — and a voucher whose PDFs are
 *    a day overdue ("PDF attached by hand", the same act from BOOKED). Once
 *    the connection is DISCONNECTED: any entry it still owed.
 *  - NOT IN FORTNOX: a voucher asked of Fortnox whose answer never came
 *    (SENDING) — only once its connection is DISCONNECTED (while it lives the
 *    sender reconciles it by number; a person's "not there" then could have it
 *    booked twice — 114b's pre-apply medium). Back to QUEUED, so it downloads.
 *  - HANDED OVER IN A FILE (C90 (c), (d)): a disconnected connection's
 *    QUEUED entries of one file → DOWNLOADED, as the person, audited; then the
 *    SIE of that file's handed-over entries downloads again and again
 *    (`exportFile(…, "unsent")`, a GET that changes nothing). Refused while an
 *    entry of the file may already be in Fortnox (decide it first) or an
 *    OLDER file of the connection still has entries not sent (oldest first) —
 *    which also makes it ONE hand-over per file: with none SENDING, none can
 *    become QUEUED again.
 *
 * C90 (c): a later connection — even to the same company — never sends them:
 * a delivery's connection never changes (the guard) and the sender reads its
 * own connection's only.
 */

const memberPrincipal = (ctx: InvoicingCtx) => ({ type: "member", id: ctx.actor.memberId }) as const;

const refuseImpersonation = (ctx: InvoicingCtx): void => {
  if (ctx.actor.impersonated) deny("FORBIDDEN", "impersonation never decides a bookkeeping entry");
};

/** At most this many entries are listed for a person at once (the rest are counted). */
export const NEEDS_YOU_MAX = 50;
/** At most this many files of entries not sent are listed at once. */
export const UNSENT_FILES_MAX = 20;

type OwedState = "QUEUED" | "SENDING" | "BOOKED";

/** One entry a person may decide. */
export type FortnoxNeed = {
  readonly deliveryId: string;
  readonly fileNumber: number;
  /** The invoice's or credit note's number. */
  readonly invoice: string;
  readonly event: ListEvent;
  readonly bookedOn: string;
  readonly state: OwedState;
  /** Its connection is gone (a disconnect) — or still sends (the stop it is at, a PDF overdue). */
  readonly disconnected: boolean;
  /** A SENDING one: where it would be in Fortnox if it was made — the series, from which number, and the comment to look for. */
  readonly lookIn: { readonly series: string; readonly from: number; readonly marker: string } | null;
  /** A BOOKED one: its voucher in Fortnox. */
  readonly voucher: { readonly series: string; readonly number: number } | null;
  readonly acts: readonly FortnoxAct[];
};

/** One file of a disconnected connection with entries never sent. */
export type UnsentFile = {
  readonly exportId: string;
  readonly number: number;
  /** Entries never asked of Fortnox — what a hand-over takes. */
  readonly queued: number;
  /** Entries asked whose answer never came — decided first. */
  readonly unsure: number;
  /**
   * Why it cannot be handed over yet: an entry that may be in Fortnox, or an
   * older file first — to download, or (`decide`) holding only an entry to
   * decide (the code review's L2); null when it can.
   */
  readonly waitsFor: null | { readonly kind: "UNSURE" } | { readonly kind: "OLDER"; readonly number: number; readonly decide: boolean };
};

export type FortnoxNeeds = {
  readonly rows: readonly FortnoxNeed[];
  /** Entries a person may decide beyond those listed. */
  readonly more: number;
  readonly unsent: readonly UnsentFile[];
};

const isListEvent = (v: string): v is ListEvent => (LIST_EVENTS as readonly string[]).includes(v);

type NeedRow = {
  id: string;
  state: string;
  entry_id: string;
  fortnox_series: string | null;
  fortnox_number: number | null;
  fortnox_next_before: number | null;
  overdue: boolean;
  conn_status: string;
  stopped_at: string | null;
  file_number: number;
  file_series: string;
  event: string;
  booked_on: Date;
  display_number: string | null;
  total: number;
};

/**
 * `invoice:export` (+ `invoice:view`, every client) — the entries a person may
 * decide, oldest file first, its entries by date then place (the line's own
 * order), at most `NEEDS_YOU_MAX`; and each disconnected connection's files
 * with entries never sent, with why one waits.
 */
export async function readFortnoxNeeds(ctx: InvoicingCtx, opts: { readonly now?: Date } = {}): Promise<FortnoxNeeds> {
  const cutoff = new Date((opts.now ?? new Date()).getTime() - PDF_GRACE_MS);
  return withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    await openBookkeeping(tx, ctx);
    const rows = await tx.$queryRaw<NeedRow[]>`
      SELECT d.id, d.state::text AS state, d.entry_id, d.fortnox_series, d.fortnox_number, d.fortnox_next_before,
             (d.state = 'BOOKED' AND d.booked_at < ${cutoff}) AS overdue,
             c.status::text AS conn_status,
             CASE WHEN c.status = 'BROKEN' THEN c.broken_reason ->> 'entryId' END AS stopped_at,
             f.number AS file_number, f.series AS file_series,
             x.event::text AS event, x.booked_on, i.display_number,
             (count(*) OVER ())::int AS total
        FROM invoice_export_delivery d
        JOIN integration_connection c ON c.tenant_id = d.tenant_id AND c.id = d.connection_id
        JOIN invoice_export f ON f.tenant_id = d.tenant_id AND f.id = d.export_id
        JOIN invoice_export_entry x ON x.tenant_id = d.tenant_id AND x.id = d.entry_id
        JOIN invoice i ON i.tenant_id = x.tenant_id AND i.id = x.invoice_id
       WHERE d.tenant_id = ${ctx.tenantId}
         AND d.state IN ('QUEUED', 'SENDING', 'BOOKED')
         AND (c.status = 'DISCONNECTED'
              OR (d.state = 'BOOKED' AND d.booked_at < ${cutoff})
              OR (d.state = 'QUEUED' AND c.status = 'BROKEN' AND d.entry_id = c.broken_reason ->> 'entryId'))
       ORDER BY f.number, x.booked_on, x.position
       LIMIT ${NEEDS_YOU_MAX}`;
    const needs: FortnoxNeed[] = [];
    for (const r of rows) {
      if (r.state !== "QUEUED" && r.state !== "SENDING" && r.state !== "BOOKED") continue;
      if (!isListEvent(r.event)) continue;
      const acts = actsFor({ state: r.state, entryId: r.entry_id, connStatus: r.conn_status, stoppedAt: r.stopped_at, overdue: r.overdue });
      if (acts.length === 0) continue;
      needs.push({
        deliveryId: r.id,
        fileNumber: r.file_number,
        invoice: r.display_number ?? "",
        event: r.event,
        bookedOn: isoDay(r.booked_on),
        state: r.state,
        disconnected: r.conn_status === "DISCONNECTED",
        lookIn:
          r.state === "SENDING" && r.fortnox_next_before !== null
            ? { series: r.file_series, from: r.fortnox_next_before, marker: markerOf(r.entry_id) }
            : null,
        voucher: r.fortnox_series !== null && r.fortnox_number !== null ? { series: r.fortnox_series, number: r.fortnox_number } : null,
        acts,
      });
    }
    const total = rows[0]?.total ?? 0;

    // The files a disconnect left with entries never sent, oldest first per connection.
    const files = await tx.$queryRaw<{ id: string; number: number; connection_id: string; queued: number; unsure: number }[]>`
      SELECT f.id, f.number, d.connection_id,
             (count(*) FILTER (WHERE d.state = 'QUEUED'))::int AS queued,
             (count(*) FILTER (WHERE d.state = 'SENDING'))::int AS unsure
        FROM invoice_export_delivery d
        JOIN integration_connection c ON c.tenant_id = d.tenant_id AND c.id = d.connection_id
        JOIN invoice_export f ON f.tenant_id = d.tenant_id AND f.id = d.export_id
       WHERE d.tenant_id = ${ctx.tenantId} AND c.status = 'DISCONNECTED' AND d.state IN ('QUEUED', 'SENDING')
       GROUP BY f.id, f.number, d.connection_id
       ORDER BY f.number
       LIMIT ${UNSENT_FILES_MAX}`;
    // Oldest first: each connection's oldest file with entries left comes before its others, so a cut list still knows it.
    const oldestOf = new Map<string, { readonly number: number; readonly queued: number }>();
    const unsent: UnsentFile[] = [];
    for (const f of files) {
      const older = oldestOf.get(f.connection_id);
      if (older === undefined) oldestOf.set(f.connection_id, { number: f.number, queued: f.queued });
      unsent.push({
        exportId: f.id,
        number: f.number,
        queued: f.queued,
        unsure: f.unsure,
        waitsFor:
          older !== undefined ? { kind: "OLDER", number: older.number, decide: older.queued === 0 } : f.unsure > 0 ? { kind: "UNSURE" } : null,
      });
    }
    return { rows: needs, more: Math.max(0, total - rows.length), unsent };
  });
}

/**
 * The delivery guard refused a person's act because the nightly send holds
 * the connection — its lease went live between the read and the write. Read
 * from the error's META, never its message (memory `prisma-code-frame-trap`).
 */
function isBusyRefusal(e: unknown): boolean {
  let meta = "";
  try {
    meta = JSON.stringify((e as { meta?: unknown } | null)?.meta ?? {});
  } catch {
    return false;
  }
  return meta.includes("INVOICE_EXPORT_DELIVERY_GUARD: Fortleva is sending to Fortnox right now");
}

/**
 * Booked by hand, or Not in Fortnox (see the header) — as the person, under
 * the page's gates; audited `invoice_export.entry_booked_by_hand` or
 * `invoice_export.entry_not_in_fortnox`. FORTNOX_ENTRY_NOT_STUCK for an entry
 * Fortleva still sends by itself, FORTNOX_BUSY while the nightly send holds
 * the connection, FORTNOX_ENTRY_DECIDED when it moved meanwhile.
 */
export async function markFortnoxDelivery(ctx: InvoicingCtx, deliveryId: string, asked: string, opts: { readonly now?: Date } = {}): Promise<void> {
  refuseImpersonation(ctx);
  // From a form: one of the two acts, or nothing at all.
  const act: FortnoxAct | null = asked === "BY_HAND" || asked === "NOT_IN_FORTNOX" ? asked : null;
  if (act === null) return deny("NOT_FOUND");
  const cutoff = new Date((opts.now ?? new Date()).getTime() - PDF_GRACE_MS);
  try {
    await withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
      await openBookkeeping(tx, ctx);
      const [d] = await tx.$queryRaw<
        {
          state: string;
          entry_id: string;
          export_id: string;
          overdue: boolean;
          conn_status: string;
          stopped_at: string | null;
          leased: boolean;
          file_number: number;
          event: string;
          display_number: string | null;
        }[]
      >`
        SELECT d.state::text AS state, d.entry_id, d.export_id,
               (d.state = 'BOOKED' AND d.booked_at < ${cutoff}) AS overdue,
               c.status::text AS conn_status,
               CASE WHEN c.status = 'BROKEN' THEN c.broken_reason ->> 'entryId' END AS stopped_at,
               (c.send_lease_until IS NOT NULL AND c.send_lease_until > statement_timestamp()) AS leased,
               f.number AS file_number, x.event::text AS event, i.display_number
          FROM invoice_export_delivery d
          JOIN integration_connection c ON c.tenant_id = d.tenant_id AND c.id = d.connection_id
          JOIN invoice_export f ON f.tenant_id = d.tenant_id AND f.id = d.export_id
          JOIN invoice_export_entry x ON x.tenant_id = d.tenant_id AND x.id = d.entry_id
          JOIN invoice i ON i.tenant_id = x.tenant_id AND i.id = x.invoice_id
         WHERE d.tenant_id = ${ctx.tenantId} AND d.id = ${deliveryId}
           -- The facts judged below hold until commit: no run settles a new stop, or claims the lease, meanwhile
           -- (the security review's 1). Shared, as the delivery guard's own read — never against the sender's.
           FOR SHARE OF c`;
      if (!d) return deny("NOT_FOUND");
      if (d.state !== "QUEUED" && d.state !== "SENDING" && d.state !== "BOOKED") return fail("FORTNOX_ENTRY_DECIDED");
      const acts = actsFor({ state: d.state, entryId: d.entry_id, connStatus: d.conn_status, stoppedAt: d.stopped_at, overdue: d.overdue });
      if (!acts.includes(act)) return fail("FORTNOX_ENTRY_NOT_STUCK");
      if (d.conn_status !== "DISCONNECTED" && d.leased) return fail("FORTNOX_BUSY");
      // Only from the state read: a run or another person who moved it meanwhile wins.
      const { count } = await tx.invoiceExportDelivery.updateMany({
        where: { id: deliveryId, state: d.state },
        data:
          act === "BY_HAND"
            ? { state: "BY_HAND", handledByMemberId: ctx.actor.memberId, fortnoxNextBefore: null }
            : { state: "QUEUED", fortnoxNextBefore: null },
      });
      if (count !== 1) return fail("FORTNOX_ENTRY_DECIDED");
      await record(tx, {
        action: act === "BY_HAND" ? "invoice_export.entry_booked_by_hand" : "invoice_export.entry_not_in_fortnox",
        targetType: "InvoiceExport",
        targetId: d.export_id,
        metadata: { number: d.file_number, entryId: d.entry_id, event: d.event, invoice: d.display_number ?? null, was: d.state },
      });
    });
  } catch (e) {
    if (isBusyRefusal(e)) return fail("FORTNOX_BUSY");
    throw e;
  }
}

export type HandedOver = { readonly exportId: string; readonly number: number; readonly count: number };

/**
 * Hand a disconnected connection's file of entries never sent over to the
 * person (C90 (c)): its QUEUED entries → DOWNLOADED, as them, audited
 * `invoice_export.unsent_downloaded`; the caller then downloads their SIE
 * (`exportFile(…, "unsent")`). `expected` is the count the person was shown.
 * FORTNOX_UNSURE_FIRST while an entry of the file may already be in Fortnox,
 * FORTNOX_OLDER_FIRST while an older file of the connection still has entries
 * not sent, FORTNOX_UNSENT_CHANGED when the count is no longer what was shown
 * (or the file's connection is not gone).
 */
export async function handOverUnsent(ctx: InvoicingCtx, exportId: string, expected: number): Promise<HandedOver> {
  refuseImpersonation(ctx);
  if (!Number.isInteger(expected) || expected < 1) return fail("FORTNOX_UNSENT_CHANGED");
  return withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    await openBookkeeping(tx, ctx);
    const [file] = await tx.$queryRaw<{ number: number; destination: string; connection_id: string | null; conn_status: string | null }[]>`
      SELECT f.number, f.destination::text AS destination, f.connection_id, c.status::text AS conn_status
        FROM invoice_export f
        LEFT JOIN integration_connection c ON c.tenant_id = f.tenant_id AND c.id = f.connection_id
       WHERE f.tenant_id = ${ctx.tenantId} AND f.id = ${exportId}`;
    if (!file || file.destination !== "FORTNOX" || file.connection_id === null) return deny("NOT_FOUND");
    if (file.conn_status !== "DISCONNECTED") return fail("FORTNOX_UNSENT_CHANGED");
    const [mine] = await tx.$queryRaw<{ queued: number; unsure: number }[]>`
      SELECT (count(*) FILTER (WHERE d.state = 'QUEUED'))::int AS queued,
             (count(*) FILTER (WHERE d.state = 'SENDING'))::int AS unsure
        FROM invoice_export_delivery d
       WHERE d.tenant_id = ${ctx.tenantId} AND d.export_id = ${exportId}`;
    if ((mine?.unsure ?? 0) > 0) return fail("FORTNOX_UNSURE_FIRST");
    const [older] = await tx.$queryRaw<{ n: number }[]>`
      SELECT (count(*))::int AS n
        FROM invoice_export_delivery d
        JOIN invoice_export f ON f.tenant_id = d.tenant_id AND f.id = d.export_id
       WHERE d.tenant_id = ${ctx.tenantId} AND d.connection_id = ${file.connection_id}
         AND d.state IN ('QUEUED', 'SENDING') AND f.number < ${file.number}`;
    if ((older?.n ?? 0) > 0) return fail("FORTNOX_OLDER_FIRST");
    if ((mine?.queued ?? 0) !== expected) return fail("FORTNOX_UNSENT_CHANGED");
    const { count } = await tx.invoiceExportDelivery.updateMany({
      where: { exportId, state: "QUEUED" },
      data: { state: "DOWNLOADED", handledByMemberId: ctx.actor.memberId },
    });
    // Another person's hand-over committed between the count and this: theirs stands.
    if (count !== expected) return fail("FORTNOX_UNSENT_CHANGED");
    await record(tx, {
      action: "invoice_export.unsent_downloaded",
      targetType: "InvoiceExport",
      targetId: exportId,
      metadata: { number: file.number, entries: count },
    });
    return { exportId, number: file.number, count };
  });
}

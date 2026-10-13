import { createHash, randomUUID } from "node:crypto";

import { record } from "@/audit/record";
import { fortnoxClientId } from "@/config";
import { withTenant, type TenantDb } from "@/db";
import { moduleOpenUnderSystem } from "@/entitlements/resolver";
import {
  fortnoxTransport,
  isFortnoxError,
  type FortnoxError,
  type FortnoxFinancialYear,
  type FortnoxTransport,
  type FortnoxVoucherDraft,
  type FortnoxVoucherRef,
} from "@/integrations/fortnox";
import { DomainError, isDeadlock, isLockTimeout } from "@/lib/domain-error";
import { todayIn } from "@/lib/due-date";
import { emit } from "@/notify/emit";
import type { NotificationReason } from "@/notify/reasons";
import { readPreferences } from "@/preferences/service";
import { getStorage } from "@/storage";

import { EXPORT_LOCK_WAIT_MS, EXPORT_TX_TIMEOUT_MS, makeFortnoxFile } from "./bookkeeping";
import { PDF_GRACE_MS, draftOf, isOurVoucher, isThrowawayWorkspace, stopReminderDue, storedReason, type BrokenReason } from "./fortnox-voucher";
import { orgDigitsOf } from "./org-digits";
import { errorTag } from "./pdf-store";
import { isoDay } from "./print";
import { PDF_MAX_BYTES } from "./send";

/**
 * THE NIGHTLY SEND (Phase 4 slice 114b; founder decision C89 (b), (c);
 * docs/research/2026-10-12-slice-114-fortnox-connection-design.md §5 as
 * amended by §10–§12). A connected workspace's bookkeeping entries — the same
 * entries the file holds (C89 (b)) — booked straight into its Fortnox company,
 * each a voucher with its invoice's PDF attached; nothing else in Fortnox
 * changes. Run per workspace by `src/jobs/fortnox-send.ts` (the jobs route),
 * under the workspace's OWN system principal, RLS live.
 *
 * THIS FILE ALONE OPENS THE SENDER'S RIGHT — `app.fortnox_sending` and
 * `app.fortnox_run`, set in `sending()` for its own transaction only
 * (`fortnox-census.test.ts`): the database lets SYSTEM make a Fortnox file,
 * write a connection's upkeep and move a delivery ONLY behind them
 * (migrations 20261019090000 and 20261020090000).
 *
 * ONE SENDER AT A TIME: a run claims the connection's LEASE (ten minutes, a
 * run id) by a conditional UPDATE — an advisory lock would not survive a
 * pooler — and the database refuses every delivery write that does not name
 * the live lease of a connection not disconnected (§10.1). A disconnect is
 * never refused (the kill switch): the run's next write fails and it stops.
 *
 * A RUN, in order:
 *  1. The workspace: the transport on, the invoicing module open, a live
 *     connection made by THIS process's transport and Fortnox app (a row of
 *     another environment is never sent from here — S2), not stopped for a
 *     reason only a person's reconnect mends; under the FAKE transport only a
 *     workspace whose every member has a test address (the code review's
 *     S′10b: a member could connect a real workspace on the shared dev
 *     database to its fake company).
 *  2. The lease; a token (the consent alive) and the company asked again —
 *     the same DatabaseNumber and org. number, or COMPANY_CHANGED (§10.4).
 *  3. THE VOUCHER LINE, oldest file first, each file's entries by date then
 *     place, STRICTLY IN ORDER (a reversal never reaches Fortnox before what
 *     it reverses; the accountant sees one problem, not a scatter): the first
 *     that cannot go stops the line. Each voucher made, its PDFs attached at
 *     once; PDFs owed by vouchers of earlier runs, after the line — they never
 *     hold it (Q7).
 *  4. THE NIGHT: when nothing is owed and the workspace's day has moved on
 *     since `last_night`, the next file of the connected company's entries is
 *     made as SYSTEM (`makeFortnoxFile`) and delivered — again and again until
 *     a plan picks nothing; then the night closes (§10.5).
 *  5. The connection's state: a stop's reason (BROKEN — audited only on the
 *     ACTIVE → BROKEN step), or, when nothing stopped, nothing is overdue and
 *     the line moved or nothing is owed, back to ACTIVE (`integration.restored`).
 *     Only what passes by itself is QUIET — Fortnox unreachable, its rate, an
 *     answer still on its way — and leaves the state as it is, until no run
 *     has reached Fortnox for a day (NOT_ANSWERING); a refusal or an answer
 *     Fortleva cannot read is a stop at once (the code review's medium).
 *  6. THE OWNERS TOLD (slice 114c; C89 (c), (e), C90): a stop once —
 *     `integration.fortnox_stopped` — then every Monday while it lasts —
 *     `integration.fortnox_still_stopped` — inbox and email as each owner's
 *     level allows (`tellOwners`; also for a stop only a reconnect mends,
 *     whose runs skip everything else); a restore that follows a told stop,
 *     a note in their inbox (`integration.fortnox_restored`, in `settle()`).
 *
 * ONE VOUCHER: intent first — QUEUED → SENDING with the series' next number,
 * committed — then `createVoucher` (no HTTP call inside a transaction):
 * answered → BOOKED with Fortnox's number; refused for certain → QUEUED and
 * the line stops with the reason; UNKNOWN (a timeout, a 5xx) → it stays
 * SENDING, and once over two minutes old a later run RECONCILES it by number
 * — the vouchers from the kept number on, matched on our marker
 * `Fortleva <entry id>` in their comment — before it is ever asked again: a
 * voucher is made once, never twice (§10.1, R11).
 *
 * TIME: no Fortnox call outlives the job's `deadline`, no voucher is begun
 * with under 20 s left, and nothing new is begun after `softUntil` (the job's
 * share for this workspace while others wait). Fortnox's own words reach only
 * the connection's reason (≤ 200 characters, on the Bookkeeping page); the
 * logs carry the call, the kind and Fortnox's code — never a message, a token
 * or a body.
 */

const SYSTEM = { type: "system" } as const;

/** One run holds the connection this long at most (§10.1). */
const LEASE_MINUTES = 10;
/** A SENDING row younger than this may still be answered — reconciled only after (§10.1). */
export const UNSURE_AFTER_MS = 2 * 60_000;
/** No voucher is asked for with less than this left: its call keeps its whole timeout (§10.5). */
const VOUCHER_MIN_LEFT_MS = 20_000;
/** No night file is begun with less than its whole transaction's time left (the code review's low 4). */
const FILE_MIN_LEFT_MS = EXPORT_TX_TIMEOUT_MS;
/** No PDF is begun with less than this left. */
const PDF_MIN_LEFT_MS = 8_000;
/** A booked voucher whose PDF is still not attached after this is reported (PDF_MISSING) — and a person's to attach (slice 114c). */
export { PDF_GRACE_MS };
/**
 * Runs that stop QUIETLY (Fortnox unreachable, its rate, an answer still on
 * its way) leave the connection as it is — but once none has reached Fortnox
 * cleanly for this long, it is a stop the owners must see: NOT_ANSWERING (the
 * code review's medium, the security review's 1).
 */
export const QUIET_GRACE_MS = 24 * 3_600_000;
/**
 * How far a reconcile looks from the kept number. Ours is the first voucher
 * made after that number was read — the series is Fortleva's own, manual —
 * so it is at the start of the range; forty past it, nothing is ours.
 */
export const RECONCILE_SCAN = 40;
/** The deliveries one read takes (a run books far fewer). */
const PAGE = 100;
/** The most PDFs one voucher may owe — `invoice_export_delivery_files_ok`'s cap; one owing more is reported, never written past it. */
export const FILES_MAX = 100;
/** The stops only a person's reconnect mends (`integration_connection_guard`'s list; S3). */
export const TERMINAL_KINDS: ReadonlySet<string> = new Set(["CONSENT_GONE", "NO_LICENCE", "COMPANY_CHANGED"]);
/** A reason's Fortnox message, at most (`parse.ts` cuts it already). */
const MESSAGE_MAX = 200;

export type FortnoxSendRun = {
  /** Why nothing was tried, or null. */
  readonly skipped: null | "off" | "closed" | "none" | "foreign" | "stopped" | "busy" | "not_throwaway";
  /** Vouchers made (or found made by a reconcile). */
  readonly booked: number;
  /** PDFs attached. */
  readonly attached: number;
  /** Files made tonight. */
  readonly files: number;
  /** The reason recorded on the connection this run, or null. */
  readonly stopped: BrokenReason | null;
  /** Something was left for a later run for want of time. */
  readonly outOfTime: boolean;
};

const skip = (skipped: NonNullable<FortnoxSendRun["skipped"]>): FortnoxSendRun => ({
  skipped,
  booked: 0,
  attached: 0,
  files: 0,
  stopped: null,
  outOfTime: false,
});

type Connection = {
  readonly id: string;
  readonly status: "ACTIVE" | "BROKEN";
  readonly externalTenantId: string;
  readonly companyOrgNr: string;
  readonly lastNight: string | null;
  /** The attempt that (re)connected it — a run never writes over a reconnect made meanwhile (the code review's low 6). */
  readonly connectAttemptId: string;
  /** When a run last reached Fortnox cleanly — or, never yet, when it was connected. */
  readonly lastReachedAt: Date;
};

const kindOf = (reason: unknown): string | null =>
  reason !== null && typeof reason === "object" && typeof (reason as { kind?: unknown }).kind === "string" ? (reason as { kind: string }).kind : null;

/**
 * A transaction of the nightly send's, its right open — SYSTEM, the GUC, this
 * run's id — for this transaction only (`set_config`'s third argument).
 */
async function sending<T>(tenantId: string, run: string, fn: (tx: TenantDb) => Promise<T>, opts?: { timeoutMs?: number; lockTimeoutMs?: number }): Promise<T> {
  return withTenant(
    tenantId,
    SYSTEM,
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.fortnox_sending', 'on', true), set_config('app.fortnox_run', ${run}, true)`;
      return fn(tx);
    },
    { lockTimeoutMs: 5_000, ...opts },
  );
}

// ── The owners told (slice 114c) ────────────────────────────────────

/** The workspace's ACTIVE owners — who hear that Fortnox stopped, and that it works again (C89 (c)). */
async function ownersOf(tx: TenantDb, tenantId: string): Promise<Map<string, NotificationReason>> {
  const owners = await tx.member.findMany({
    where: { tenantId, status: "ACTIVE", memberRoles: { some: { role: { isSystem: true, templateKey: "owner" } } } },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  return new Map(owners.map((o): [string, NotificationReason] => [o.id, "OWNER"]));
}

/**
 * THE OWNERS TOLD THAT FORTNOX STOPPED (slice 114c; founder decisions C89
 * (c), (e), C90 (a)) — once per breakage, then every Monday while it lasts.
 * Under the sender's own right (the connection's `stop_told_at` is one of its
 * upkeep columns), the connection locked: when it is BROKEN and its owners
 * have not been told since it broke → `integration.fortnox_stopped`; else
 * when this week's Monday reminder is due (`stopReminderDue`, the
 * workspace's zone) → `integration.fortnox_still_stopped`; either way
 * `stop_told_at` moves (the guard stamps its own clock), so a second run the
 * same hour, or a read inbox row, never tells twice. Inbox + email as each
 * owner's level allows (`emit`); IDS ONLY — the connection. Never throws: a
 * failure is logged by its tag and the next run tells instead.
 */
export async function tellOwners(tenantId: string, connectionId: string, run: string, now: Date): Promise<"stopped" | "reminded" | null> {
  try {
    return await sending(tenantId, run, async (tx) => {
      const [c] = await tx.$queryRaw<{ status: string; broken_since: Date | null; first: boolean; told: Date | null }[]>`
        SELECT status::text AS status, broken_since,
               (stop_told_at IS NULL OR stop_told_at < broken_since) AS first,
               stop_told_at AS told
          FROM integration_connection
         WHERE tenant_id = ${tenantId} AND id = ${connectionId}
           FOR UPDATE`;
      if (!c || c.status !== "BROKEN" || c.broken_since === null) return null;
      let told: "stopped" | "reminded";
      let dedupeKey: string;
      if (c.first || c.told === null) {
        told = "stopped";
        dedupeKey = `integration.fortnox_stopped:${connectionId}:${c.broken_since.toISOString()}`;
      } else {
        const due = stopReminderDue(now, (await readPreferences(tx, tenantId)).timezone, c.told);
        if (due === null) return null;
        told = "reminded";
        // Per breakage AND week: a new stop's reminder never folds into an unread one of an earlier stop.
        dedupeKey = `integration.fortnox_still_stopped:${connectionId}:${c.broken_since.toISOString()}:${due.week}`;
      }
      await emit(tx, tenantId, {
        kind: told === "stopped" ? "integration.fortnox_stopped" : "integration.fortnox_still_stopped",
        entity: { type: "IntegrationConnection", id: connectionId },
        receivers: await ownersOf(tx, tenantId),
        dedupeKey,
      });
      await tx.$executeRaw`
        UPDATE integration_connection SET stop_told_at = now()
         WHERE tenant_id = ${tenantId} AND id = ${connectionId}`;
      return told;
    });
  } catch (e) {
    console.error(`fortnox send: tenant ${tenantId}: the owners were not told: ${errorTag(e)}`);
    return null;
  }
}

// ── What is owed ────────────────────────────────────────────────────

type FileMark = { readonly invoiceId: string; readonly fileId: string; readonly connected: boolean };

type Owed = {
  readonly id: string;
  readonly entryId: string;
  readonly exportId: string;
  readonly fileNumber: number;
  readonly series: string;
  readonly state: "QUEUED" | "SENDING" | "BOOKED";
  readonly fortnox: FortnoxVoucherRef | null;
  readonly nextBefore: number | null;
  readonly files: readonly FileMark[];
  /** A SENDING row's age by the database's clock (null outside the line). */
  readonly attemptedAgeMs: number | null;
  readonly bookedAt: Date | null;
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  readonly event: string;
  readonly bookedOn: string;
  readonly voucher: unknown;
  readonly deductedIds: readonly string[];
};

const isFileMark = (v: unknown): v is FileMark => {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.invoiceId === "string" && typeof o.fileId === "string" && typeof o.connected === "boolean";
};

type OwedRow = {
  id: string;
  entry_id: string;
  export_id: string;
  file_number: number;
  series: string;
  state: "QUEUED" | "SENDING" | "BOOKED";
  fortnox_year: number | null;
  fortnox_series: string | null;
  fortnox_number: number | null;
  fortnox_next_before: number | null;
  files: unknown;
  attempted_age_ms: number | null;
  booked_at: Date | null;
  invoice_id: string;
  invoice_number: string | null;
  event: string;
  booked_on: Date;
  voucher: unknown;
  detail: unknown;
};

/**
 * The connection's deliveries: the LINE (QUEUED, SENDING) in its order —
 * oldest file first, its entries by date then place — or the vouchers whose
 * PDFs are still owed (BOOKED), in the order they were made (uuid v7), a page after the id `after` —
 * read apart, so a page of the second never hides the first. A SENDING row's
 * age is the DATABASE's (it stamped `attempted_at` — the security review's 4).
 */
async function readOwed(
  tenantId: string,
  connectionId: string,
  which: "line" | "pdfs",
  after: string | null = null,
): Promise<Owed[]> {
  const rows = await withTenant(tenantId, SYSTEM, (tx) =>
    which === "line"
      ? tx.$queryRaw<OwedRow[]>`
          SELECT d.id, d.entry_id, d.export_id, f.number AS file_number, f.series, d.state::text AS state,
                 d.fortnox_year, d.fortnox_series, d.fortnox_number, d.fortnox_next_before, d.files,
                 (extract(epoch FROM (now() - d.attempted_at)) * 1000)::float8 AS attempted_age_ms, d.booked_at,
                 x.invoice_id, i.display_number AS invoice_number, x.event::text AS event, x.booked_on, x.voucher, x.detail
            FROM invoice_export_delivery d
            JOIN invoice_export_entry x ON x.tenant_id = d.tenant_id AND x.id = d.entry_id
            JOIN invoice_export f ON f.tenant_id = d.tenant_id AND f.id = d.export_id
            JOIN invoice i ON i.tenant_id = x.tenant_id AND i.id = x.invoice_id
           WHERE d.tenant_id = ${tenantId} AND d.connection_id = ${connectionId}
             AND d.state IN ('QUEUED', 'SENDING')
           ORDER BY f.number, x.booked_on, x.position
           LIMIT ${PAGE}`
      : tx.$queryRaw<OwedRow[]>`
          SELECT d.id, d.entry_id, d.export_id, f.number AS file_number, f.series, d.state::text AS state,
                 d.fortnox_year, d.fortnox_series, d.fortnox_number, d.fortnox_next_before, d.files,
                 NULL::float8 AS attempted_age_ms, d.booked_at,
                 x.invoice_id, i.display_number AS invoice_number, x.event::text AS event, x.booked_on, x.voucher, x.detail
            FROM invoice_export_delivery d
            JOIN invoice_export_entry x ON x.tenant_id = d.tenant_id AND x.id = d.entry_id
            JOIN invoice_export f ON f.tenant_id = d.tenant_id AND f.id = d.export_id
            JOIN invoice i ON i.tenant_id = x.tenant_id AND i.id = x.invoice_id
           WHERE d.tenant_id = ${tenantId} AND d.connection_id = ${connectionId}
             AND d.state = 'BOOKED'
             AND d.id > ${after ?? ""}
           ORDER BY d.id
           LIMIT ${PAGE}`,
  );
  return rows.map((r) => {
    const detail = (r.detail ?? {}) as { deductedIds?: unknown };
    const deducted = Array.isArray(detail.deductedIds) ? detail.deductedIds.filter((x): x is string => typeof x === "string") : [];
    return {
      id: r.id,
      entryId: r.entry_id,
      exportId: r.export_id,
      fileNumber: r.file_number,
      series: r.series,
      state: r.state,
      fortnox:
        r.fortnox_year !== null && r.fortnox_series !== null && r.fortnox_number !== null
          ? { year: r.fortnox_year, series: r.fortnox_series, number: r.fortnox_number }
          : null,
      nextBefore: r.fortnox_next_before,
      files: Array.isArray(r.files) ? r.files.filter(isFileMark) : [],
      attemptedAgeMs: r.attempted_age_ms,
      bookedAt: r.booked_at,
      invoiceId: r.invoice_id,
      invoiceNumber: r.invoice_number ?? "",
      event: r.event,
      bookedOn: isoDay(r.booked_on),
      voucher: r.voucher,
      deductedIds: deducted,
    };
  });
}

// ── A run ───────────────────────────────────────────────────────────

/**
 * One workspace's run (see the header). `deadline` is the job's (epoch ms);
 * `softUntil`, when others wait, the moment after which nothing new is begun.
 * The transport and Fortnox app default to `src/config`'s; the fixture CLI
 * passes the fake's (the e2e harness's own process).
 */
export async function sendToFortnox(
  tenantId: string,
  opts: {
    readonly deadline: number;
    readonly softUntil?: number;
    readonly now?: Date;
    readonly transport?: FortnoxTransport | null;
    readonly appClientId?: string | null;
  },
): Promise<FortnoxSendRun> {
  const transport = opts.transport === undefined ? fortnoxTransport() : opts.transport;
  if (!transport) return skip("off");
  const appClientId = opts.appClientId === undefined ? fortnoxClientId : opts.appClientId;
  const now = opts.now ?? new Date();

  // 1. The workspace.
  const facts = await withTenant(tenantId, SYSTEM, async (tx) => {
    if (!(await moduleOpenUnderSystem(tx, tenantId, "invoicing"))) return "closed" as const;
    const row = await tx.integrationConnection.findFirst({
      where: { tenantId, provider: "FORTNOX", status: { not: "DISCONNECTED" } },
      select: {
        id: true,
        status: true,
        transport: true,
        appClientId: true,
        externalTenantId: true,
        companyOrgNr: true,
        brokenReason: true,
        lastNight: true,
        connectAttemptId: true,
        connectedAt: true,
        lastOkAt: true,
      },
    });
    if (!row || row.status === "DISCONNECTED") return "none" as const;
    if (row.transport !== transport.kind || row.appClientId !== appClientId) return "foreign" as const;
    if (transport.kind === "fake" && !(await isThrowawayWorkspace(tx, tenantId))) return "not_throwaway" as const;
    // A stop only a person's reconnect mends: nothing is tried — but its
    // owners are still reminded every Monday (slice 114c), so it is told below.
    if (row.status === "BROKEN" && TERMINAL_KINDS.has(kindOf(row.brokenReason) ?? "")) return { go: false as const, id: row.id };
    const today = todayIn((await readPreferences(tx, tenantId)).timezone, now);
    const connection: Connection = {
      id: row.id,
      status: row.status,
      externalTenantId: row.externalTenantId,
      companyOrgNr: row.companyOrgNr,
      lastNight: row.lastNight ? isoDay(row.lastNight) : null,
      connectAttemptId: row.connectAttemptId,
      lastReachedAt: row.lastOkAt && row.lastOkAt > row.connectedAt ? row.lastOkAt : row.connectedAt,
    };
    return { go: true as const, connection, today };
  });
  if (typeof facts === "string") return skip(facts);
  if (!facts.go) {
    await tellOwners(tenantId, facts.id, randomUUID(), now);
    return skip("stopped");
  }
  const { connection, today } = facts;

  // 2. The lease. A file being made holds the connection FOR SHARE for its
  // transaction: a claim that waits past its bound is "busy", like one held.
  const run = randomUUID();
  let claimed: { id: string }[];
  try {
    claimed = await sending(
      tenantId,
      run,
      (tx) =>
        tx.$queryRaw<{ id: string }[]>`
          UPDATE integration_connection
             SET send_lease_until = now() + make_interval(mins => ${LEASE_MINUTES}::int), send_run_id = ${run}
           WHERE tenant_id = ${tenantId} AND id = ${connection.id} AND status <> 'DISCONNECTED'
             AND (send_lease_until IS NULL OR send_lease_until < now())
          RETURNING id`,
      // The lock wait ends first (the re-check's N1): a wait reads as busy, never as a lost transaction.
      { lockTimeoutMs: EXPORT_LOCK_WAIT_MS, timeoutMs: 15_000 },
    );
  } catch (e) {
    if (isLockTimeout(e) || isDeadlock(e)) return skip("busy");
    throw e;
  }
  if (claimed.length === 0) return skip("busy");

  const sender = new Sender(tenantId, run, connection, transport, opts.deadline, opts.softUntil ?? opts.deadline, now, today);
  try {
    const done = await sender.go();
    // 6. The owners: a stop this run recorded — or one they have not heard of
    // this week — told now (its own transaction; a failure is the next run's).
    await tellOwners(tenantId, connection.id, run, now);
    return done;
  } finally {
    try {
      await sending(tenantId, run, (tx) =>
        tx.$executeRaw`
          UPDATE integration_connection SET send_lease_until = NULL, send_run_id = NULL
           WHERE tenant_id = ${tenantId} AND id = ${connection.id} AND send_run_id = ${run} AND status <> 'DISCONNECTED'`,
      );
    } catch (e) {
      // It runs out in ten minutes anyway.
      console.error(`fortnox send: tenant ${tenantId}: the lease was not released: ${errorTag(e)}`);
    }
  }
}

/**
 * The night's file refused because the connection is no longer this run's —
 * disconnected, or its lease lost — the export guard's one refusal of that
 * kind, read from the error's meta, never its message. Any OTHER refusal is a
 * disagreement between the plan and the database: a bug to see, never quiet
 * (the re-check's low 1).
 */
function isLostConnection(e: unknown): boolean {
  let meta = "";
  try {
    meta = JSON.stringify((e as { meta?: unknown } | null)?.meta ?? {});
  } catch {
    return false;
  }
  return meta.includes("INVOICE_EXPORT_GUARD: a Fortnox file goes to the workspace");
}

/** The line stops here: with a reason to record, or quietly (unknown stays unknown; a write refused ends the run). */
class LineStop extends Error {
  constructor(readonly reason: BrokenReason | null) {
    super("fortnox: the line stopped");
  }
}

class Sender {
  private token = "";
  private readonly years = new Map<string, FortnoxFinancialYear | null>();
  /** Deliveries whose PDFs this run already tried — never twice in one run. */
  private readonly triedPdfs = new Set<string>();
  private booked = 0;
  private attached = 0;
  private files = 0;
  private outOfTime = false;
  /** The first reason the line stopped this run. */
  private stopped: BrokenReason | null = null;
  /** A booked voucher's PDF overdue this run — reported when nothing else stopped. */
  private pdfOverdue: BrokenReason | null = null;
  /** The token answered and the company is the connected one. */
  private reachable = false;
  /** The line stopped quietly (an unknown answer, Fortnox's rate, a write refused) — the state left as it is. */
  private quiet = false;
  /** How far this run's `now` is from the real one (a test's clock; 0 in a real run). */
  private readonly skewMs: number;

  constructor(
    private readonly tenantId: string,
    private readonly run: string,
    private readonly connection: Connection,
    private readonly transport: FortnoxTransport,
    private readonly deadline: number,
    private readonly softUntil: number,
    private readonly now: Date,
    private readonly today: string,
  ) {
    this.skewMs = now.getTime() - Date.now();
  }

  /** Nothing NEW begun past the soft limit or this close to the deadline. */
  private mayBegin(needMs: number): boolean {
    if (Date.now() >= this.softUntil || this.deadline - Date.now() < needMs) {
      this.outOfTime = true;
      return false;
    }
    return true;
  }

  private stopWith(e: unknown): void {
    if (!(e instanceof LineStop)) throw e;
    if (e.reason) this.stopped ??= e.reason;
    else this.quiet = true;
  }

  async go(): Promise<FortnoxSendRun> {
    // 2. A token, and the company it answers for (§10.4).
    try {
      this.token = await this.transport.tenantToken(this.connection.externalTenantId, this.deadline);
      const company = await this.transport.companyInformation(this.token, this.deadline);
      if (company.databaseNumber !== this.connection.externalTenantId || orgDigitsOf(company.orgNr) !== orgDigitsOf(this.connection.companyOrgNr)) {
        this.stopped = { kind: "COMPANY_CHANGED" };
      } else {
        this.reachable = true;
      }
    } catch (e) {
      const reason = this.reasonOf(e);
      if (reason) this.stopped = reason;
      else this.quiet = true;
    }

    if (this.reachable) {
      try {
        // 3 and 4: the line; then, while the night is open and nothing is owed, a file at a time.
        for (;;) {
          const clear = await this.deliverLine();
          await this.attachOwed();
          if (!clear || this.stopped || this.quiet || this.outOfTime) break;
          if (this.connection.lastNight !== null && this.connection.lastNight >= this.today) break;
          if (!this.mayBegin(FILE_MIN_LEFT_MS)) break;
          const made = await this.nightFile();
          if (made === "busy") {
            this.quiet = true;
            break;
          }
          if (made === "none") {
            await this.closeNight();
            break;
          }
          this.files += 1;
        }
      } catch (e) {
        this.stopWith(e);
      }
    }

    // 5. The connection's state.
    const recorded = await this.settle();
    return { skipped: null, booked: this.booked, attached: this.attached, files: this.files, stopped: recorded, outOfTime: this.outOfTime };
  }

  /** The consent or the licence gone — the two stops only a person mends that a call can show — or null. */
  private accessGone(e: FortnoxError): BrokenReason | null {
    if (e.kind === "auth") return { kind: "CONSENT_GONE" };
    if (e.kind === "licence") return { kind: "NO_LICENCE" };
    return null;
  }

  /**
   * A call's failure as a stop: the consent or licence gone; Fortnox refusing
   * a question (a 4xx — its code and words); an answer Fortleva cannot read
   * (NOT_ANSWERING) — or null, QUIET, for what passes by itself: Fortnox
   * unreachable, or its rate. Never quiet for what repeats every run (the
   * code review's medium).
   */
  private reasonOf(e: unknown): BrokenReason | null {
    if (!isFortnoxError(e)) throw e;
    console.error(`fortnox send: tenant ${this.tenantId}: ${e.logTag}`);
    const gone = this.accessGone(e);
    if (gone) return gone;
    if (e.kind === "refused") return { kind: "REFUSED", code: e.code, message: e.detail === null ? null : e.detail.slice(0, MESSAGE_MAX) };
    if (e.kind === "shape") return { kind: "NOT_ANSWERING" };
    return null;
  }

  /** A Fortnox call whose failure stops the line (see `reasonOf`). */
  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (!isFortnoxError(e)) throw e;
      throw new LineStop(this.reasonOf(e));
    }
  }

  /** Where the line stopped: the reason, with its entry. */
  private at(o: Owed, reason: BrokenReason): BrokenReason {
    return { ...reason, entryId: o.entryId, invoice: o.invoiceNumber, event: o.event, day: o.bookedOn };
  }

  /** THE VOUCHER LINE, strictly in order. True when nothing is left in it. */
  private async deliverLine(): Promise<boolean> {
    for (;;) {
      const line = await readOwed(this.tenantId, this.connection.id, "line");
      if (line.length === 0) return true;
      for (const o of line) {
        let ref: FortnoxVoucherRef | null;
        try {
          ref = await this.book(o);
        } catch (e) {
          if (!(e instanceof LineStop)) throw e;
          // The entry's reason; a refused write (the lease gone) ends the run.
          if (e.reason) this.stopped ??= this.at(o, e.reason);
          else this.quiet = true;
          return false;
        }
        if (ref === null) return false;
        await this.attach({ ...o, state: "BOOKED", fortnox: ref, bookedAt: this.now, nextBefore: null });
      }
      if (line.length < PAGE) return true;
    }
  }

  /**
   * PDFs owed by vouchers booked in earlier runs — after the line, as time
   * allows, a page at a time (oldest booked first), so a hundred that keep
   * failing never hide the rest (the code review's low 3).
   */
  private async attachOwed(): Promise<void> {
    let after: string | null = null;
    for (;;) {
      const owed = await readOwed(this.tenantId, this.connection.id, "pdfs", after);
      for (const o of owed) {
        if (this.triedPdfs.has(o.id)) continue;
        if (!this.mayBegin(PDF_MIN_LEFT_MS)) return;
        await this.attach(o);
      }
      const last = owed.at(-1);
      if (owed.length < PAGE || !last) return;
      after = last.id;
    }
  }

  /** The financial year holding a day, asked once per run. */
  private async yearOn(day: string): Promise<FortnoxFinancialYear | null> {
    if (this.years.has(day)) return this.years.get(day)!;
    const year = await this.call(() => this.transport.financialYearOn(this.token, day, this.deadline));
    this.years.set(day, year);
    return year;
  }

  /**
   * One entry's voucher — reconciled first when its earlier ask is unknown.
   * Its Fortnox voucher, or null when the line stops here (the reason set,
   * or quiet). Throws LineStop for Fortnox's access refused or a write refused.
   */
  private async book(o: Owed): Promise<FortnoxVoucherRef | null> {
    const draft = draftOf(o);
    if (!draft) {
      console.error(`fortnox send: tenant ${this.tenantId}: entry ${o.entryId}'s voucher is out of shape`);
      this.stopped ??= this.at(o, { kind: "REFUSED" });
      return null;
    }
    if (o.state === "SENDING") {
      // Its age on the DATABASE's clock — which stamped it (the security
      // review's 4) — moved by how far this run's `now` is from the real one.
      if (o.attemptedAgeMs === null || o.attemptedAgeMs + this.skewMs < UNSURE_AFTER_MS) {
        // Its answer may still be on its way: a later run.
        this.quiet = true;
        return null;
      }
      // Up to forty questions: begun only with the time a voucher would get (the security review's nit 6).
      if (!this.mayBegin(VOUCHER_MIN_LEFT_MS)) return null;
      const found = await this.reconcile(o);
      if (found === "unsure") return null;
      if (found !== null) return found;
    }
    return this.send(o, draft);
  }

  /**
   * A SENDING entry: the vouchers from its kept number on, matched on its
   * marker. Booked when found; back in the queue when not; "unsure" (quiet)
   * when Fortnox cannot say.
   */
  private async reconcile(o: Owed): Promise<FortnoxVoucherRef | null | "unsure"> {
    const year = await this.yearOn(o.bookedOn);
    const series = year ? await this.call(() => this.transport.voucherSeries(this.token, o.series, year.id, this.deadline)) : null;
    if (year && series && o.nextBefore !== null) {
      if (series.nextNumber === null) {
        // Fortnox no longer says where its series stands: a stop to see, every run.
        this.stopped ??= this.at(o, { kind: "NOT_ANSWERING" });
        return "unsure";
      }
      const end = Math.min(series.nextNumber, o.nextBefore + RECONCILE_SCAN);
      for (let n = o.nextBefore; n < end; n++) {
        const number = n;
        const v = await this.call(() => this.transport.voucherByNumber(this.token, o.series, number, year.id, this.deadline));
        if (v && isOurVoucher(v.comments, o.entryId)) {
          const ref = { year: year.id, series: o.series, number };
          await this.writeBooked(o, ref);
          return ref;
        }
      }
    }
    // Not there (no year, no series, not in the range): never made — asked again.
    await this.writeDelivery(o, "requeue");
    return null;
  }

  /** Ask Fortnox for the voucher, intent first. */
  private async send(o: Owed, draft: FortnoxVoucherDraft): Promise<FortnoxVoucherRef | null> {
    if (!this.mayBegin(VOUCHER_MIN_LEFT_MS)) return null;
    const year = await this.yearOn(o.bookedOn);
    if (year === null) {
      this.stopped ??= this.at(o, { kind: "NO_FINANCIAL_YEAR" });
      return null;
    }
    const series = await this.call(() => this.transport.voucherSeries(this.token, o.series, year.id, this.deadline));
    if (series === null || !series.manual) {
      this.stopped ??= this.at(o, { kind: "SERIES", code: series === null ? "missing" : "notManual" });
      return null;
    }
    if (series.nextNumber === null) {
      // Without it a lost answer could never be looked for: never asked (and a stop to see).
      this.stopped ??= this.at(o, { kind: "NOT_ANSWERING" });
      return null;
    }
    // The two questions above took time: the voucher's call keeps its whole timeout (the code review's low 2).
    if (!this.mayBegin(VOUCHER_MIN_LEFT_MS)) return null;

    // Intent first: SENDING, with where a reconcile would look — committed.
    await this.writeDelivery(o, "sending", series.nextNumber);
    let ref: FortnoxVoucherRef;
    try {
      ref = await this.transport.createVoucher(this.token, year.id, draft, this.deadline);
    } catch (e) {
      if (!isFortnoxError(e)) throw e;
      console.error(`fortnox send: tenant ${this.tenantId}: entry ${o.entryId}: ${e.logTag}`);
      if (e.kind === "unknown" || e.kind === "shape") {
        // It may exist: it stays SENDING, reconciled by number on a later run.
        this.quiet = true;
        return null;
      }
      // Refused for certain — nothing was made: back in the queue.
      await this.writeDelivery(o, "requeue");
      if (e.kind === "rate") {
        this.quiet = true;
        return null;
      }
      if (e.kind === "auth") throw new LineStop({ kind: "CONSENT_GONE" });
      if (e.kind === "licence") throw new LineStop({ kind: "NO_LICENCE" });
      this.stopped ??= this.at(o, await this.diagnose(draft, year.id, e));
      return null;
    }
    await this.writeBooked(o, ref);
    return ref;
  }

  /** Why Fortnox refused a voucher, as far as we can tell: an account missing or inactive — else Fortnox's own words. */
  private async diagnose(draft: FortnoxVoucherDraft, yearId: number, e: FortnoxError): Promise<BrokenReason> {
    try {
      for (const account of [...new Set(draft.rows.map((r) => r.account))]) {
        if (this.deadline - Date.now() < PDF_MIN_LEFT_MS) break;
        const a = await this.transport.account(this.token, account, yearId, this.deadline);
        if (a === null || !a.active) return { kind: "ACCOUNT", account, code: a === null ? "missing" : "inactive" };
      }
    } catch {
      // Fortnox's own words, below.
    }
    return { kind: "REFUSED", code: e.code, message: e.detail === null ? null : e.detail.slice(0, MESSAGE_MAX) };
  }

  // ── The delivery's writes (each its own transaction; a refusal ends the run) ──

  /** QUEUED → SENDING (with the series' next number), or SENDING → QUEUED. */
  private async writeDelivery(o: Owed, step: "sending" | "requeue", nextBefore?: number): Promise<void> {
    try {
      await sending(this.tenantId, this.run, (tx) =>
        tx.invoiceExportDelivery.update({
          where: { id: o.id },
          data: step === "sending" ? { state: "SENDING", fortnoxNextBefore: nextBefore! } : { state: "QUEUED", fortnoxNextBefore: null },
          select: { id: true },
        }),
      );
    } catch (e) {
      this.refusedWrite(e);
    }
  }

  /** SENDING → BOOKED with Fortnox's voucher. Refused (the lease gone): it stays SENDING — reconciled later. */
  private async writeBooked(o: Owed, ref: FortnoxVoucherRef): Promise<void> {
    try {
      await sending(this.tenantId, this.run, (tx) =>
        tx.invoiceExportDelivery.update({
          where: { id: o.id },
          data: { state: "BOOKED", fortnoxYear: ref.year, fortnoxSeries: ref.series, fortnoxNumber: ref.number, fortnoxNextBefore: null },
          select: { id: true },
        }),
      );
    } catch (e) {
      this.refusedWrite(e);
    }
    this.booked += 1;
  }

  /** A write the database refused — the lease gone, the connection disconnected: the run stops, quietly. */
  private refusedWrite(e: unknown): never {
    console.error(`fortnox send: tenant ${this.tenantId}: a write was refused, the run stops: ${errorTag(e)}`);
    throw new LineStop(null);
  }

  // ── Its PDFs ──

  /**
   * Attach the PDFs a BOOKED voucher owes — its own document's and, for a
   * payment, each credit note it deducted — and mark it DONE when all are.
   * Never stops the voucher line; a PDF still not attached a day after the
   * voucher is reported (PDF_MISSING) when nothing else stopped. Throws
   * LineStop for the consent or licence gone, or a write refused.
   */
  private async attach(o: Owed): Promise<void> {
    if (!o.fortnox) return;
    this.triedPdfs.add(o.id);
    const ref = o.fortnox;
    const owed = [o.invoiceId, ...o.deductedIds.filter((id) => id !== o.invoiceId)];
    if (owed.length > FILES_MAX) {
      // More than the database keeps (the pre-apply review's low): reported a
      // day on — attached by hand (slice 114c) — never a write it refuses.
      this.overdue(o);
      return;
    }
    let files = [...o.files];
    for (const invoiceId of owed) {
      if (files.some((f) => f.invoiceId === invoiceId && f.connected)) continue;
      if (!this.mayBegin(PDF_MIN_LEFT_MS)) return;
      try {
        let mark = files.find((f) => f.invoiceId === invoiceId) ?? null;
        if (mark !== null) {
          // Uploaded before; its connection's answer was lost, or never asked.
          const fileId = mark.fileId;
          const at = await this.transport.fileConnection(this.token, fileId, this.deadline);
          if (at !== null && at.series === ref.series && at.number === ref.number) {
            files = files.map((f) => (f.fileId === fileId ? { ...f, connected: true } : f));
            await this.writeFiles(o, files);
            continue;
          }
          if (at !== null) {
            // Connected to another voucher — never by us: a fresh copy for ours.
            files = files.filter((f) => f.fileId !== fileId);
            mark = null;
          }
        }
        if (mark === null) {
          const pdf = await this.pdfOf(invoiceId);
          if (pdf === null) {
            this.overdue(o);
            return;
          }
          const fileId = await this.transport.uploadToInbox(this.token, pdf.bytes, pdf.name, this.deadline);
          mark = { invoiceId, fileId, connected: false };
          files = [...files, mark];
          // Kept before it is connected: a lost answer below is checked, not uploaded twice.
          await this.writeFiles(o, files);
        }
        const fileId = mark.fileId;
        await this.transport.connectFile(this.token, ref.year, fileId, ref.series, ref.number, this.deadline);
        files = files.map((f) => (f.fileId === fileId ? { ...f, connected: true } : f));
        await this.writeFiles(o, files);
        this.attached += 1;
      } catch (e) {
        if (e instanceof LineStop) throw e;
        if (!isFortnoxError(e)) throw e;
        console.error(`fortnox send: tenant ${this.tenantId}: entry ${o.entryId}'s PDF: ${e.logTag}`);
        // The consent or licence gone stops everything; any other failure is
        // this PDF's — tried again next run, reported once a day old.
        const gone = this.accessGone(e);
        if (gone) throw new LineStop(gone);
        this.overdue(o);
        return;
      }
    }
    if (owed.every((id) => files.some((f) => f.invoiceId === id && f.connected))) await this.writeDone(o, files);
  }

  /** A PDF not attached this run: reported once its voucher is a day old. */
  private overdue(o: Owed): void {
    const since = o.bookedAt ?? this.now;
    if (this.now.getTime() - since.getTime() >= PDF_GRACE_MS) this.pdfOverdue ??= this.at(o, { kind: "PDF_MISSING" });
  }

  /** An invoice's archived PDF, exactly as archived — or null when it is not made yet or cannot be read. */
  private async pdfOf(invoiceId: string): Promise<{ readonly bytes: Uint8Array; readonly name: string } | null> {
    const row = await withTenant(this.tenantId, SYSTEM, (tx) =>
      tx.invoice.findFirst({ where: { id: invoiceId }, select: { pdfFile: { select: { id: true, r2Key: true, sha256: true, originalFilename: true } } } }),
    );
    const f = row?.pdfFile;
    if (!f) return null;
    let bytes: Uint8Array | null;
    try {
      bytes = await getStorage().getObject(f.r2Key);
    } catch (e) {
      console.error(`fortnox send: tenant ${this.tenantId}: invoice ${invoiceId}'s PDF could not be read: ${errorTag(e)}`);
      return null;
    }
    if (!bytes || bytes.byteLength === 0 || bytes.byteLength > PDF_MAX_BYTES) return null;
    if (createHash("sha256").update(bytes).digest("hex") !== f.sha256) {
      console.error(`fortnox send: tenant ${this.tenantId}: invoice ${invoiceId}'s stored PDF does not match its record (file ${f.id})`);
      return null;
    }
    const base = (f.originalFilename ?? invoiceId).replace(/[^\p{L}\p{N} ._()-]/gu, "_").slice(0, 120);
    return { bytes, name: base.toLowerCase().endsWith(".pdf") ? base : `${base}.pdf` };
  }

  private async writeFiles(o: Owed, files: readonly FileMark[]): Promise<void> {
    try {
      await sending(this.tenantId, this.run, (tx) =>
        tx.invoiceExportDelivery.update({ where: { id: o.id }, data: { files: files.map((f) => ({ ...f })) }, select: { id: true } }),
      );
    } catch (e) {
      this.refusedWrite(e);
    }
  }

  /** BOOKED → DONE — and, when it was its file's last voucher owed, `invoice_export.sent` (once: under the lease). */
  private async writeDone(o: Owed, files: readonly FileMark[]): Promise<void> {
    try {
      await sending(this.tenantId, this.run, async (tx) => {
        await tx.invoiceExportDelivery.update({ where: { id: o.id }, data: { state: "DONE", files: files.map((f) => ({ ...f })) }, select: { id: true } });
        const [s] = await tx.$queryRaw<{ left: number; vouchers: number; by_hand: number; series: string | null; from_n: number | null; to_n: number | null }[]>`
          SELECT count(*) FILTER (WHERE d.state NOT IN ('DONE', 'BY_HAND'))::int AS left,
                 count(*)::int AS vouchers, count(*) FILTER (WHERE d.state = 'BY_HAND')::int AS by_hand,
                 min(d.fortnox_series) AS series, min(d.fortnox_number) AS from_n, max(d.fortnox_number) AS to_n
            FROM invoice_export_delivery d
           WHERE d.tenant_id = ${this.tenantId} AND d.export_id = ${o.exportId}`;
        if (!s || s.left > 0) return;
        await record(tx, {
          action: "invoice_export.sent",
          targetType: "InvoiceExport",
          targetId: o.exportId,
          metadata: { number: o.fileNumber, vouchers: s.vouchers, byHand: s.by_hand, fortnoxSeries: s.series, fortnoxFrom: s.from_n, fortnoxTo: s.to_n },
        });
      });
    } catch (e) {
      this.refusedWrite(e);
    }
  }

  // ── The night ──

  /** The next file of the connected company's entries, made as SYSTEM — or none, or the lock held too long. */
  private async nightFile(): Promise<"made" | "none" | "busy"> {
    const org = orgDigitsOf(this.connection.companyOrgNr);
    // The connection's CHECK holds NNNNNN-NNNN: ten digits always.
    if (org === null) throw new Error("fortnox send: a connection without its org. number");
    try {
      const made = await sending(this.tenantId, this.run, (tx) => makeFortnoxFile(tx, this.tenantId, { id: this.connection.id, org }, this.now), {
        lockTimeoutMs: EXPORT_LOCK_WAIT_MS,
        timeoutMs: EXPORT_TX_TIMEOUT_MS,
      });
      return made === null ? "none" : "made";
    } catch (e) {
      if (isLockTimeout(e) || isDeadlock(e) || (e instanceof DomainError && e.code === "INVOICE_EXPORT_BUSY")) return "busy";
      // The database refused the night's file because a disconnect or a lost
      // lease committed meanwhile: this run is over, quietly (the code review's low 1).
      if (isLostConnection(e)) this.refusedWrite(e);
      throw e;
    }
  }

  /** Nothing of the company's is new: tonight is over (`last_night`). */
  private async closeNight(): Promise<void> {
    try {
      await sending(this.tenantId, this.run, (tx) =>
        tx.$executeRaw`
          UPDATE integration_connection SET last_night = ${this.today}::date
           WHERE tenant_id = ${this.tenantId} AND id = ${this.connection.id} AND status <> 'DISCONNECTED'`,
      );
    } catch (e) {
      this.refusedWrite(e);
    }
  }

  // ── The connection's state ──

  /** Whether a booked voucher's PDF has been owed longer than its grace — no restore then. */
  private async pdfsOverdue(): Promise<boolean> {
    const [row] = await withTenant(this.tenantId, SYSTEM, (tx) =>
      tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM invoice_export_delivery d
         WHERE d.tenant_id = ${this.tenantId} AND d.connection_id = ${this.connection.id} AND d.state = 'BOOKED'
           AND d.booked_at < ${new Date(this.now.getTime() - PDF_GRACE_MS)}`,
    );
    return (row?.n ?? 0) > 0;
  }

  private async nothingOwed(): Promise<boolean> {
    const [row] = await withTenant(this.tenantId, SYSTEM, (tx) =>
      tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM invoice_export_delivery d
         WHERE d.tenant_id = ${this.tenantId} AND d.connection_id = ${this.connection.id} AND d.state IN ('QUEUED', 'SENDING')`,
    );
    return (row?.n ?? 0) === 0;
  }

  /**
   * A stop's reason onto the connection (BROKEN — audited on the ACTIVE →
   * BROKEN step only; a later reason while still BROKEN replaces the one
   * shown), or — when it was BROKEN, nothing stopped, the run was not quiet,
   * no PDF is overdue and the line moved or nothing is owed — back to ACTIVE
   * (`integration.restored`, R7). A QUIET run leaves the state as it is —
   * unless no run has reached Fortnox for a day: NOT_ANSWERING (the code
   * review's medium, the security review's 1). Every run that got anywhere
   * notes it (`last_ok_at`). Never over a person's reconnect made meanwhile
   * (the code review's low 6). The reason recorded, or null.
   */
  private async settle(): Promise<BrokenReason | null> {
    let reason = this.stopped ?? this.pdfOverdue;
    const progressed = this.booked > 0 || this.attached > 0;
    if (reason === null && (this.quiet || !this.reachable) && !progressed) {
      // Already stopped: its own reason stands — one unreachable run never
      // relabels it (the re-check's low 2: a stopped run writes no `last_ok_at`).
      if (this.connection.status === "BROKEN") return null;
      if (this.now.getTime() - this.connection.lastReachedAt.getTime() < QUIET_GRACE_MS) return null;
      reason = { kind: "NOT_ANSWERING" };
    }
    const restore =
      reason === null &&
      !this.quiet &&
      this.reachable &&
      this.connection.status === "BROKEN" &&
      (this.booked > 0 || (await this.nothingOwed())) &&
      !(await this.pdfsOverdue());
    let recorded: BrokenReason | null = null;
    try {
      await sending(this.tenantId, this.run, async (tx) => {
        const [was] = await tx.$queryRaw<{ status: string; broken_reason: unknown; connect_attempt_id: string; broken_since: Date | null; told: boolean }[]>`
          SELECT status::text AS status, broken_reason, connect_attempt_id, broken_since,
                 (stop_told_at IS NOT NULL AND stop_told_at >= broken_since) AS told
            FROM integration_connection
           WHERE tenant_id = ${this.tenantId} AND id = ${this.connection.id}
             FOR UPDATE`;
        if (!was || was.status === "DISCONNECTED") return;
        // Reconnected by a person while this run went: theirs stands.
        if (was.connect_attempt_id !== this.connection.connectAttemptId) return;
        // A stop only a person mends is held whole (its guard refuses to touch it).
        if (was.status === "BROKEN" && TERMINAL_KINDS.has(kindOf(was.broken_reason) ?? "")) return;
        if (reason !== null) {
          const json = JSON.stringify(storedReason(reason));
          // The statement's clock, read AFTER the lock above — never earlier
          // than a telling another run committed meanwhile, which `stop_told_at
          // < broken_since` must see as a new breakage (slice 114c's pre-apply
          // review, low 2; `now()` is this transaction's start, before the wait).
          await tx.$executeRaw`
            UPDATE integration_connection
               SET status = 'BROKEN'::integration_status, broken_since = coalesce(broken_since, statement_timestamp()), broken_reason = ${json}::jsonb
             WHERE tenant_id = ${this.tenantId} AND id = ${this.connection.id}`;
          if (was.status === "ACTIVE") {
            await record(tx, {
              action: "integration.broken",
              targetType: "IntegrationConnection",
              targetId: this.connection.id,
              // The kind and Fortnox's code — never its words (they may name a client).
              metadata: { provider: "FORTNOX", kind: reason.kind, code: reason.code ?? null, entryId: reason.entryId ?? null },
            });
          }
          recorded = reason;
          return;
        }
        if (restore && was.status === "BROKEN") {
          await tx.$executeRaw`
            UPDATE integration_connection
               SET status = 'ACTIVE'::integration_status, broken_since = NULL, broken_reason = NULL, last_ok_at = now()
             WHERE tenant_id = ${this.tenantId} AND id = ${this.connection.id}`;
          await record(tx, {
            action: "integration.restored",
            targetType: "IntegrationConnection",
            targetId: this.connection.id,
            metadata: { provider: "FORTNOX", was: kindOf(was.broken_reason) },
          });
          // The owners who were told it stopped hear that it works again — a
          // note in the inbox, no email (C90 (b)); one per breakage.
          if (was.told && was.broken_since !== null) {
            await emit(tx, this.tenantId, {
              kind: "integration.fortnox_restored",
              entity: { type: "IntegrationConnection", id: this.connection.id },
              receivers: await ownersOf(tx, this.tenantId),
              dedupeKey: `integration.fortnox_restored:${this.connection.id}:${was.broken_since.toISOString()}`,
            });
          }
          return;
        }
        await tx.$executeRaw`
          UPDATE integration_connection SET last_ok_at = now()
           WHERE tenant_id = ${this.tenantId} AND id = ${this.connection.id}`;
      });
    } catch (e) {
      console.error(`fortnox send: tenant ${this.tenantId}: the connection's state was not written: ${errorTag(e)}`);
    }
    // What the connection now says — only a reason actually written (the re-check's nit).
    return recorded;
  }
}

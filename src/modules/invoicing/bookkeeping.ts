import { createHash } from "node:crypto";

import { record } from "@/audit/record";
import { resolveScope } from "@/authz/authorize";
import { deny } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { hasAccess, requireAccess } from "@/entitlements/resolver";
import { todayIn } from "@/lib/due-date";
import { fail, isDeadlock, isLockTimeout } from "@/lib/domain-error";
import { addDays } from "@/lib/week";
import { xlsxWorkbook } from "@/lib/xlsx";
import { readPreferences } from "@/preferences/service";

import {
  BOOKKEEPING_FIELDS,
  BOOKKEEPING_PREF_KEY,
  bookkeepingFrom,
  bookkeepingToStore,
  methodOf,
  normalizeBookkeepingValue,
  yearStartOf,
  type BookkeepingField,
  type BookkeepingMethod,
  type BookkeepingSettings,
} from "./bookkeeping-accounts";
import type { InvoicingCtx } from "./drafts";
import { LIST_EVENTS, listColumns, listRow, type ListAmounts, type ListedEntry, type ListEvent, type ListRemark, type ListWords } from "./invoice-list";
import { formatFixed, readFixed, type Minor } from "./money";
import { isoDay } from "./print";
import { selectForFile } from "./bookkeeping-select";
import { dueYearEnd, paymentUndoDay, periodEndOf, reversalUndoDay, yearEndCorrections, type YearEndState } from "./bookkeeping-year-end";
import { sieFile, type SieVoucher } from "./sie";
import { isVatProfile, type VatProfile } from "./vat";
import {
  bookedAmounts,
  issueVoucher,
  lessCredits,
  paymentVoucher,
  reversalOf,
  yearEndVoucher,
  type BookableInvoice,
  type BookedAmounts,
} from "./vouchers";

/**
 * THE BOOKKEEPING FILE (Phase 4 slice 111; founder decision C82; the design
 * and its reviews: docs/research/2026-10-10-slice-111-fortnox-file-design.md,
 * §10 overriding the body). A member who may (`invoice:export`, with
 * `invoice:view` and a TENANT-WIDE client scope — a file is every client's
 * invoices) makes a FILE of what is new since the last one, and downloads it
 * — an SIE 4I import for Fortnox (`sie.ts`) and a list (`invoice-list.ts`) —
 * as often as they like; both are regenerated from what the file froze.
 *
 * WHAT IS NEW depends on the workspace's METHOD (`bookkeeping-accounts.ts`):
 *
 *  - INVOICE (fakturametoden): each invoice and credit note issued and not yet
 *    in a file, booked on its issue date (`ISSUE`).
 *  - CASH (kontantmetoden, C82 (e)): each invoice marked paid with no payment
 *    booked (`PAYMENT`, on `paid_on`, less the credit notes it deducts); each
 *    booked payment whose invoice is no longer paid on that day
 *    (`PAYMENT_UNDONE`, on the file's day, its voucher negated — FIRST, so a
 *    re-mark on another day books after it); and each credit note, listed
 *    (`CREDIT_NOTED`, no voucher; it waits for its invoice's pending payment
 *    events, so its remark reads the record as this file leaves it).
 *
 * THE CASH METHOD'S YEAR END (slice 111b; C83; `bookkeeping-year-end.ts`):
 * once the financial year has ended and nothing dated in it waits, the
 * person books it (`bookYearEnd`) — a YEAR-END FILE holding a `YEAR_END` for
 * each invoice unpaid on its last day E. Later regular files then hold each
 * one's reversal on E + 1 (`YEAR_END_REVERSED`) and, for a payment on or
 * before E marked since, its withdrawal on E (`YEAR_END_UNDONE`, before the
 * payment) and its reversal's on E + 1 (`YEAR_END_REVERSAL_UNDONE`).
 *
 * ONE FILE = ONE FINANCIAL YEAR AND ONE SELLER (the design review's M1, L1):
 * the year and the seller of the earliest FILEABLE event (one whose
 * dependencies are filed or in this file — the re-check's 1: a payment
 * waiting on its own reversal never decides the year), then everything
 * fileable of that year and seller, then what that unblocks; at most
 * `EXPORT_MAX` events. The rest wait for the next file.
 *
 * A PAYMENT DEDUCTS a credit note of its invoice dated on or before the day
 * the money arrived that EXISTED WHEN THE PAYMENT WAS MARKED (issued before
 * the newest `invoice.paid` audit row for the invoice, written in the mark's
 * own transaction) — the re-check's 2 (c): the credit the client could have
 * paid net of. What it deducted is frozen in its `detail`.
 *
 * Locks: the workspace's one export lock first (`invoice_export_lock`), then
 * the invoices whose payment state the file reads, `FOR SHARE` in id order —
 * a Mark as paid/unpaid waits for the file or has committed before it — and
 * every fact is read AGAIN under those locks (the re-check's 7). The
 * database has the last word (`invoice_export_guard`,
 * `invoice_export_entry_guard`); its refusals stay unmapped — a disagreement
 * is a bug to see, never a "try again" (the re-check's 5).
 */

export const EXPORT_MAX = 1000;
/** Entries per INSERT statement. */
const ENTRY_BATCH = 250;
const chunks = <T>(xs: readonly T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(xs.length / size) }, (_, i) => xs.slice(i * size, (i + 1) * size));
export const EXPORT_LOCK_WAIT_MS = 5_000;
export const EXPORT_TX_TIMEOUT_MS = 30_000;
/** Files on one page of the list (the review's L10). */
export const EXPORT_FILES_PAGE = 50;

const memberPrincipal = (ctx: InvoicingCtx) => ({ type: "member", id: ctx.actor.memberId }) as const;

/** The gates every verb takes, in order: see invoices, export them, and every client. */
async function openBookkeeping(tx: TenantDb, ctx: InvoicingCtx): Promise<void> {
  await requireAccess(tx, ctx.tenantId, ctx.actor, "invoice:view");
  await requireAccess(tx, ctx.tenantId, ctx.actor, "invoice:export");
  // A file is every client's invoices: a member scoped to some clients would
  // either see the others' or leave them behind in "new". The app's rule —
  // the database holds the code (AUTHZ §3.2).
  if (!(await resolveScope(tx, ctx.actor)).all) deny("FORBIDDEN");
}

/** The method of the workspace's files, or null before the first (every file has the first's — the guard). */
async function filesMethod(tx: TenantDb): Promise<BookkeepingMethod | null> {
  const first = await tx.invoiceExport.findFirst({ orderBy: { number: "asc" }, select: { method: true } });
  return first?.method ?? null;
}

/** The workspace's settings, read inside a transaction (no gate). */
export async function readBookkeepingSettings(tx: TenantDb, tenantId: string): Promise<BookkeepingSettings> {
  const row = await tx.tenantPreference.findFirst({ where: { tenantId, key: BOOKKEEPING_PREF_KEY }, select: { value: true } });
  return bookkeepingFrom(row?.value ?? null);
}

// ── The documents ───────────────────────────────────────────────────

/** An issued invoice or credit note as a file reads it — frozen facts only. */
type Doc = BookableInvoice & {
  readonly id: string;
  readonly status: string;
  readonly dueDate: string;
  readonly issuedAt: Date | null;
  readonly paidOn: string | null;
  readonly creditsInvoiceId: string | null;
  readonly creditsNumber: string | null;
  readonly clientOrgNr: string | null;
  readonly clientVatNumber: string | null;
  readonly clientCountry: string | null;
  readonly seller: { readonly legalName: string; readonly orgNr: string | null };
};

const text = (o: unknown, key: string): string | null => {
  if (o === null || typeof o !== "object") return null;
  const v = (o as Record<string, unknown>)[key];
  return typeof v === "string" && v.trim() !== "" ? v : null;
};

const sellerKey = (d: Doc): string => `${d.seller.legalName}|${d.seller.orgNr ?? ""}`;

/** The documents by id — one narrow read and one grouped read of their lines, in sequence. */
async function loadDocs(tx: TenantDb, ids: readonly string[]): Promise<Map<string, Doc>> {
  const out = new Map<string, Doc>();
  if (ids.length === 0) return out;
  const rows = await tx.invoice.findMany({
    where: { id: { in: [...ids] }, status: { not: "DRAFT" } },
    select: {
      id: true,
      kind: true,
      status: true,
      displayNumber: true,
      issueDate: true,
      dueDate: true,
      issuedAt: true,
      paidOn: true,
      currency: true,
      vatProfile: true,
      creditsInvoiceId: true,
      creditsDisplayNumber: true,
      bookRateToSek: true,
      fxRateToSek: true,
      sellerSnapshot: true,
      buyerSnapshot: true,
    },
  });
  const nets = await tx.invoiceLine.groupBy({
    by: ["invoiceId", "vatRatePct"],
    where: { invoiceId: { in: rows.map((r) => r.id) } },
    _sum: { amountExVat: true },
  });
  const groupsOf = new Map<string, { rate: bigint; net: Minor }[]>();
  for (const n of nets) {
    const list = groupsOf.get(n.invoiceId) ?? [];
    list.push({ rate: readFixed(n.vatRatePct, 2), net: n._sum.amountExVat === null ? 0n : readFixed(n._sum.amountExVat, 2) });
    groupsOf.set(n.invoiceId, list);
  }
  for (const r of rows) {
    if (r.displayNumber === null || r.issueDate === null || r.dueDate === null || !isVatProfile(r.vatProfile)) {
      throw new Error("bookkeeping: an issued invoice without its number, dates or VAT treatment");
    }
    const legalName = text(r.sellerSnapshot, "legalName");
    if (legalName === null) throw new Error("bookkeeping: an issued invoice without its seller");
    out.set(r.id, {
      id: r.id,
      kind: r.kind,
      status: r.status,
      displayNumber: r.displayNumber,
      issueDate: isoDay(r.issueDate),
      dueDate: isoDay(r.dueDate),
      issuedAt: r.issuedAt,
      paidOn: r.paidOn ? isoDay(r.paidOn) : null,
      clientName: text(r.buyerSnapshot, "name") ?? "",
      clientOrgNr: text(r.buyerSnapshot, "orgNr"),
      clientVatNumber: text(r.buyerSnapshot, "vatNumber"),
      clientCountry: text(r.buyerSnapshot, "countryCode")?.trim().toUpperCase() ?? null,
      currency: r.currency,
      vatProfile: r.vatProfile as VatProfile,
      groups: groupsOf.get(r.id) ?? [],
      bookRate: r.bookRateToSek === null ? null : readFixed(r.bookRateToSek, 6),
      vatRate: r.fxRateToSek === null ? null : readFixed(r.fxRateToSek, 6),
      creditsInvoiceId: r.creditsInvoiceId,
      creditsNumber: r.creditsDisplayNumber,
      seller: { legalName, orgNr: text(r.sellerSnapshot, "orgNr") },
    });
  }
  return out;
}

// ── A voucher and an entry's facts, as JSON ─────────────────────────

type VoucherJson = { readonly text: string; readonly rows: readonly { readonly account: string; readonly amount: string }[] };

const voucherToJson = (v: SieVoucher): VoucherJson => ({
  text: v.text,
  rows: v.rows.map((r) => ({ account: r.account, amount: formatFixed(r.amount, 2) })),
});

function voucherFromJson(raw: unknown, date: string): SieVoucher | null {
  if (raw === null || typeof raw !== "object") return null;
  const v = raw as { text?: unknown; rows?: unknown };
  if (typeof v.text !== "string" || !Array.isArray(v.rows)) throw new Error("bookkeeping: a stored voucher out of shape");
  return {
    date,
    text: v.text,
    rows: v.rows.map((r: { account?: unknown; amount?: unknown }) => {
      if (typeof r.account !== "string" || typeof r.amount !== "string") throw new Error("bookkeeping: a stored voucher row out of shape");
      return { account: r.account, amount: readFixed(r.amount, 2) };
    }),
  };
}

/** What an entry froze for its list row (and, for a payment, what it deducted). */
type EntryDetail = {
  readonly amounts: ListAmounts;
  readonly relates: readonly string[];
  readonly remark: ListRemark | null;
  /** A payment: the credit notes it deducted, by id. */
  readonly deductedIds?: readonly string[];
};

const amountsOf = (a: BookedAmounts, sign: bigint): ListAmounts => ({
  net: formatFixed(sign * a.net, 2),
  vat: formatFixed(sign * a.vat, 2),
  total: formatFixed(sign * (a.net + a.vat), 2),
  netSek: formatFixed(sign * a.netSek, 2),
  vatSek: formatFixed(sign * a.vatSek, 2),
  totalSek: formatFixed(sign * (a.netSek + a.vatSek), 2),
});

const negateAmounts = (a: ListAmounts): ListAmounts => {
  const neg = (v: string) => formatFixed(-readFixed(v, 2), 2);
  return { net: neg(a.net), vat: neg(a.vat), total: neg(a.total), netSek: neg(a.netSek), vatSek: neg(a.vatSek), totalSek: neg(a.totalSek) };
};

function detailFromJson(raw: unknown): EntryDetail {
  const d = (raw ?? {}) as Partial<EntryDetail>;
  if (!d.amounts) throw new Error("bookkeeping: a stored entry without its amounts");
  return { amounts: d.amounts, relates: d.relates ?? [], remark: d.remark ?? null, ...(d.deductedIds ? { deductedIds: d.deductedIds } : {}) };
}

// ── The cash method's payment state ─────────────────────────────────

/** One invoice's payment as booked so far, and as it stands. */
type PayState = {
  readonly invoiceId: string;
  readonly paidOn: string | null;
  /** PAYMENTs less PAYMENT_UNDONEs booked: 0 or 1. */
  readonly booked: number;
  /** The newest booked PAYMENT (undone or not). */
  readonly last: { readonly bookedOn: string; readonly voucher: unknown; readonly detail: unknown; readonly file: number } | null;
};

/**
 * Payment states: every invoice that needs a payment event (`candidates`),
 * and/or the invoices named (`ids`). ONE statement.
 */
async function payStates(tx: TenantDb, tenantId: string, opts: { readonly candidates: boolean; readonly ids: readonly string[] }): Promise<Map<string, PayState>> {
  const rows = await tx.$queryRaw<
    { id: string; paid_on: Date | null; booked: number; last_on: Date | null; last_voucher: unknown; last_detail: unknown; last_file: number | null }[]
  >`
    WITH booked AS (
      SELECT x.invoice_id,
             count(*) FILTER (WHERE x.event = 'PAYMENT') - count(*) FILTER (WHERE x.event = 'PAYMENT_UNDONE') AS n
        FROM invoice_export_entry x
       WHERE x.tenant_id = ${tenantId} AND x.event IN ('PAYMENT', 'PAYMENT_UNDONE')
       GROUP BY x.invoice_id
    ), last_paid AS (
      SELECT DISTINCT ON (x.invoice_id) x.invoice_id, x.booked_on, x.voucher, x.detail, f.number
        FROM invoice_export_entry x
        JOIN invoice_export f ON f.tenant_id = x.tenant_id AND f.id = x.export_id
       WHERE x.tenant_id = ${tenantId} AND x.event = 'PAYMENT'
       ORDER BY x.invoice_id, f.number DESC, x.position DESC
    )
    SELECT i.id, i.paid_on, coalesce(b.n, 0)::int AS booked,
           l.booked_on AS last_on, l.voucher AS last_voucher, l.detail AS last_detail, l.number AS last_file
      FROM invoice i
      LEFT JOIN booked b ON b.invoice_id = i.id
      LEFT JOIN last_paid l ON l.invoice_id = i.id
     WHERE i.tenant_id = ${tenantId} AND i.kind = 'INVOICE' AND i.status <> 'DRAFT'
       AND (   i.id = ANY(${[...opts.ids]}::text[])
            OR (${opts.candidates}::boolean
                AND (   (i.paid_on IS NOT NULL AND coalesce(b.n, 0) = 0)
                     OR (coalesce(b.n, 0) = 1 AND l.booked_on IS DISTINCT FROM i.paid_on))))
     ORDER BY i.id`;
  return new Map(
    rows.map((r) => [
      r.id,
      {
        invoiceId: r.id,
        paidOn: r.paid_on ? isoDay(r.paid_on) : null,
        booked: r.booked,
        last: r.last_on && r.last_file !== null ? { bookedOn: isoDay(r.last_on), voucher: r.last_voucher, detail: r.last_detail, file: r.last_file } : null,
      },
    ]),
  );
}

const needsUndo = (s: PayState): boolean => s.booked === 1 && s.last !== null && s.last.bookedOn !== s.paidOn;
const needsPay = (s: PayState): boolean => s.paidOn !== null && (s.booked === 0 || needsUndo(s));

// ── The cash method's year ends (slice 111b) ────────────────────────

/** One invoice's booked year end E as the files record it — and what it froze. */
type FiledYearEnd = YearEndState & {
  readonly invoiceId: string;
  readonly voucher: unknown;
  readonly detail: unknown;
  /** The year-end file's number. */
  readonly file: number;
  /** Its reversal, once filed. */
  readonly reversal: { readonly voucher: unknown; readonly file: number } | null;
};

const yearEndKey = (invoiceId: string, yearEnd: string) => `${invoiceId}:${yearEnd}`;

/**
 * Every booked year end that may still need a reversal or a withdrawal
 * (`yearEndCorrections` decides; this read leaves out only the two settled
 * shapes — withdrawn with no reversal left standing, and reversed while it
 * stands and its invoice was not paid by E, neither by its mark nor in the
 * books). ONE statement.
 */
async function yearEndStates(tx: TenantDb, tenantId: string): Promise<Map<string, FiledYearEnd>> {
  const rows = await tx.$queryRaw<
    {
      invoice_id: string;
      year_end: Date;
      voucher: unknown;
      detail: unknown;
      file: number;
      paid_on: Date | null;
      paid_in_books: boolean;
      withdrawn: boolean;
      rev_voucher: unknown;
      rev_file: number | null;
      reversal_withdrawn: boolean;
    }[]
  >`
    SELECT s.*
      FROM (
        SELECT ye.invoice_id, ye.year_end, ye.voucher, ye.detail, yf.number AS file, i.paid_on,
               invoice_export_paid_in_books(ye.tenant_id, ye.invoice_id, ye.year_end) AS paid_in_books,
               EXISTS (SELECT 1 FROM invoice_export_entry u
                        WHERE u.tenant_id = ye.tenant_id AND u.invoice_id = ye.invoice_id
                          AND u.event = 'YEAR_END_UNDONE' AND u.year_end = ye.year_end) AS withdrawn,
               rv.voucher AS rev_voucher, rf.number AS rev_file,
               EXISTS (SELECT 1 FROM invoice_export_entry w
                        WHERE w.tenant_id = ye.tenant_id AND w.invoice_id = ye.invoice_id
                          AND w.event = 'YEAR_END_REVERSAL_UNDONE' AND w.year_end = ye.year_end) AS reversal_withdrawn
          FROM invoice_export_entry ye
          JOIN invoice_export yf ON yf.tenant_id = ye.tenant_id AND yf.id = ye.export_id
          JOIN invoice i ON i.tenant_id = ye.tenant_id AND i.id = ye.invoice_id
          LEFT JOIN invoice_export_entry rv
            ON rv.tenant_id = ye.tenant_id AND rv.invoice_id = ye.invoice_id
           AND rv.event = 'YEAR_END_REVERSED' AND rv.year_end = ye.year_end
          LEFT JOIN invoice_export rf ON rf.tenant_id = rv.tenant_id AND rf.id = rv.export_id
         WHERE ye.tenant_id = ${tenantId} AND ye.event = 'YEAR_END'
      ) s
     WHERE NOT (s.withdrawn AND (s.rev_file IS NULL OR s.reversal_withdrawn))
       AND NOT (NOT s.withdrawn AND s.rev_file IS NOT NULL AND (s.paid_on IS NULL OR s.paid_on > s.year_end) AND NOT s.paid_in_books)
     ORDER BY s.invoice_id, s.year_end`;
  return new Map(
    rows.map((r) => {
      const yearEnd = isoDay(r.year_end);
      return [
        yearEndKey(r.invoice_id, yearEnd),
        {
          invoiceId: r.invoice_id,
          yearEnd,
          withdrawn: r.withdrawn,
          reversed: r.rev_file !== null,
          reversalWithdrawn: r.reversal_withdrawn,
          paidOn: r.paid_on ? isoDay(r.paid_on) : null,
          paidInBooks: r.paid_in_books,
          voucher: r.voucher,
          detail: r.detail,
          file: r.file,
          reversal: r.rev_file !== null ? { voucher: r.rev_voucher, file: r.rev_file } : null,
        },
      ];
    }),
  );
}

// ── The plan ────────────────────────────────────────────────────────

/** One event this file could book. */
type Candidate = {
  readonly key: string;
  readonly event: ListEvent;
  /** The document the row is about: the invoice (ISSUE, payments) or the credit note (ISSUE, CREDIT_NOTED). */
  readonly doc: Doc;
  readonly bookedOn: string;
  /** Events that must be filed first — in this file or before. */
  readonly dependsOn: readonly string[];
  /** An event filed only TOGETHER with this one, when they share a group (`selectForFile`'s units; slice 111b). */
  readonly companion?: string;
  /** A year-end event's E (slice 111b). */
  readonly yearEnd?: string;
};

type Plan = {
  readonly method: BookkeepingMethod;
  readonly candidates: readonly Candidate[];
  readonly docs: ReadonlyMap<string, Doc>;
  readonly states: ReadonlyMap<string, PayState>;
  /** Booked year ends a candidate reverses or withdraws, by `yearEndKey`. */
  readonly yearEnds: ReadonlyMap<string, FiledYearEnd>;
  /** A paid invoice → when its payment was marked (the newest `invoice.paid` audit row). */
  readonly markedAt: ReadonlyMap<string, Date>;
  /** A credit note of a paid invoice → when it was issued (its `invoice.issued` audit row). */
  readonly creditIssuedAt: ReadonlyMap<string, Date>;
  /** The invoices whose payment state the plan read — locked `FOR SHARE` by a maker. */
  readonly stateIds: readonly string[];
  /** Every year end booked, oldest first — a file never straddles one (the review's L2). */
  readonly bookedYearEnds: readonly string[];
};

/** Every year end the workspace has booked, oldest first. */
async function bookedYearEndsOf(tx: TenantDb): Promise<string[]> {
  const rows = await tx.invoiceExport.findMany({ where: { yearEnd: { not: null } }, orderBy: { yearEnd: "asc" }, select: { yearEnd: true } });
  return rows.map((r) => isoDay(r.yearEnd!));
}

/**
 * A candidate's GROUP — what one file may hold: one bookkeeping year and one
 * seller. The year is named by its last day (`periodEndOf`): the booked year
 * ends on or before the newest, the setting's financial year after it — so a
 * financial year changed after a year end was booked never puts both sides of
 * it in one file (slice 111b; its review's L2 and re-check's R6).
 */
const groupOf =
  (yearStart: number, bookedYearEnds: readonly string[]) =>
  (c: Candidate): string =>
    `${periodEndOf(c.bookedOn, yearStart, bookedYearEnds)}|${sellerKey(c.doc)}`;

const keyOf = (event: ListEvent, invoiceId: string, yearEnd?: string) => (yearEnd ? `${event}:${invoiceId}:${yearEnd}` : `${event}:${invoiceId}`);

async function plan(tx: TenantDb, tenantId: string, method: BookkeepingMethod, today: string, yearStart: number): Promise<Plan> {
  if (method === "INVOICE") {
    const ids = await tx.invoice.findMany({
      where: { status: { not: "DRAFT" }, exportEntries: { none: { event: "ISSUE" } } },
      select: { id: true },
    });
    const docs = await loadDocs(
      tx,
      ids.map((r) => r.id),
    );
    const candidates = [...docs.values()].map((doc) => ({ key: keyOf("ISSUE", doc.id), event: "ISSUE" as const, doc, bookedOn: doc.issueDate, dependsOn: [] }));
    return {
      method,
      candidates,
      docs,
      states: new Map(),
      yearEnds: new Map(),
      markedAt: new Map(),
      creditIssuedAt: new Map(),
      stateIds: [],
      bookedYearEnds: [],
    };
  }

  // THE CASH METHOD. The invoices with a payment event to book…
  const due = await payStates(tx, tenantId, { candidates: true, ids: [] });
  // …the credit notes not yet listed…
  const noted = await tx.invoice.findMany({
    where: { kind: "CREDIT_NOTE", status: { not: "DRAFT" }, exportEntries: { none: { event: "CREDIT_NOTED" } } },
    select: { id: true, creditsInvoiceId: true },
  });
  // …and the payment state of their invoices too (a remark reads it).
  const originals = [...new Set(noted.map((n) => n.creditsInvoiceId).filter((id): id is string => id !== null && !due.has(id)))];
  const more = originals.length > 0 ? await payStates(tx, tenantId, { candidates: false, ids: originals }) : new Map<string, PayState>();
  const states = new Map([...due, ...more]);
  // …and the booked year ends still to reverse or withdraw (slice 111b).
  const yearEnds = await yearEndStates(tx, tenantId);
  const yearEndIds = [...new Set([...yearEnds.values()].map((y) => y.invoiceId))];

  const paying = [...due.values()].filter(needsPay).map((s) => s.invoiceId);
  // Every issued credit note of an invoice being paid (what a payment may deduct).
  const creditsOfPaying =
    paying.length === 0
      ? []
      : await tx.invoice.findMany({
          where: { kind: "CREDIT_NOTE", status: { not: "DRAFT" }, creditsInvoiceId: { in: paying } },
          select: { id: true },
        });
  const docs = await loadDocs(tx, [
    ...new Set([...states.keys(), ...noted.map((n) => n.id), ...creditsOfPaying.map((c) => c.id), ...originals, ...yearEndIds]),
  ]);
  // When each payment was MARKED and each of its credit notes ISSUED — the
  // two AUDIT rows, never `issued_at`: `issueInvoice` takes its `now` before
  // its transaction waits for the original's lock, so a credit that waited
  // behind a mark could carry an earlier `issued_at` than the mark it came
  // after (the code review's 2). Both rows are written while holding the
  // ORIGINAL's row lock (`markInvoicePaid` locks it; a credit note's issue
  // locks its original first), so their times order the two acts as they
  // happened. A member's rows only (the security review's nit 5).
  const creditIds = creditsOfPaying.map((c) => c.id);
  const marks =
    paying.length === 0
      ? []
      : await tx.$queryRaw<{ target_id: string; at: Date }[]>`
          SELECT a.target_id, max(a.created_at) AS at
            FROM audit_event a
           WHERE a.tenant_id = ${tenantId} AND a.action = 'invoice.paid' AND a.actor_type = 'MEMBER'
             AND a.target_id = ANY(${paying}::text[])
           GROUP BY a.target_id`;
  const issues =
    creditIds.length === 0
      ? []
      : await tx.$queryRaw<{ target_id: string; at: Date }[]>`
          SELECT a.target_id, min(a.created_at) AS at
            FROM audit_event a
           WHERE a.tenant_id = ${tenantId} AND a.action = 'invoice.issued' AND a.actor_type = 'MEMBER'
             AND a.target_id = ANY(${creditIds}::text[])
           GROUP BY a.target_id`;
  const markedAt = new Map(marks.map((m) => [m.target_id, m.at]));
  const creditIssuedAt = new Map(issues.map((m) => [m.target_id, m.at]));

  const candidates: Candidate[] = [];
  const bookedYearEnds = await bookedYearEndsOf(tx);
  // The payment each invoice will book in this plan, if any (its day).
  const payingOn = new Map<string, string>();
  for (const s of due.values()) if (needsPay(s)) payingOn.set(s.invoiceId, s.paidOn!);
  // Slice 111b: each booked year end's reversal or withdrawals. The
  // withdrawal of the year end the guard makes a payment wait for — the
  // invoice's year end at the workspace's EARLIEST booked year end on or
  // after the payment day — is that payment's COMPANION: filed with it,
  // never alone (the design review's M1; its re-check's R2 — the guard's own
  // test). Any later withdrawal of the invoice waits for the payment and is
  // due by what the books then hold. A reversal's withdrawal waits for its
  // year end's.
  const withdrawalOf = new Map<string, string>(); // invoice → the companion withdrawal's key
  for (const y of yearEnds.values()) {
    const doc = docs.get(y.invoiceId);
    if (!doc) continue;
    const paidOn = payingOn.get(doc.id);
    const guarding = paidOn === undefined ? undefined : bookedYearEnds.find((e) => e >= paidOn);
    let undone: string | null = null;
    for (const event of yearEndCorrections(y)) {
      const key = keyOf(event, doc.id, y.yearEnd);
      let dependsOn: string[] = [];
      let companion: string | undefined;
      if (event === "YEAR_END_UNDONE") {
        undone = key;
        if (paidOn !== undefined && y.yearEnd === guarding) {
          withdrawalOf.set(doc.id, key);
          companion = keyOf("PAYMENT", doc.id);
        } else if (paidOn !== undefined && paidOn <= y.yearEnd) dependsOn = [keyOf("PAYMENT", doc.id)];
      } else if (event === "YEAR_END_REVERSAL_UNDONE" && undone !== null) dependsOn = [undone];
      candidates.push({
        key,
        event,
        doc,
        bookedOn:
          event === "YEAR_END_UNDONE"
            ? y.yearEnd
            : event === "YEAR_END_REVERSED"
              ? addDays(y.yearEnd, 1)
              : reversalUndoDay(y.yearEnd, today, yearStart, bookedYearEnds),
        dependsOn,
        ...(companion ? { companion } : {}),
        yearEnd: y.yearEnd,
      });
    }
  }
  const pendingOf = new Map<string, string[]>();
  for (const s of due.values()) {
    const doc = docs.get(s.invoiceId);
    if (!doc) continue;
    const keys: string[] = [];
    const paymentKey = keyOf("PAYMENT", doc.id);
    if (needsUndo(s)) {
      const k = keyOf("PAYMENT_UNDONE", doc.id);
      // Dated in the ended year that holds both days, or the file's day (the
      // design review's M3); a companion of the re-mark, so a correction is
      // never filed half (`selectForFile` joins them only within one group).
      const bookedOn = paymentUndoDay({ bookedOn: s.last!.bookedOn, paidOn: s.paidOn, today, yearStart, bookedYearEnds });
      candidates.push({ key: k, event: "PAYMENT_UNDONE", doc, bookedOn, dependsOn: [], ...(needsPay(s) ? { companion: paymentKey } : {}) });
      keys.push(k);
    }
    if (needsPay(s)) {
      const withdrawal = withdrawalOf.get(doc.id);
      candidates.push({ key: paymentKey, event: "PAYMENT", doc, bookedOn: s.paidOn!, dependsOn: [...keys, ...(withdrawal ? [withdrawal] : [])] });
      keys.push(paymentKey);
    }
    pendingOf.set(doc.id, keys);
  }
  for (const n of noted) {
    const doc = docs.get(n.id);
    if (!doc) continue;
    candidates.push({
      key: keyOf("CREDIT_NOTED", doc.id),
      event: "CREDIT_NOTED",
      doc,
      bookedOn: doc.issueDate,
      // Its invoice's pending payment events first, so its remark reads the
      // record as it will stand.
      dependsOn: n.creditsInvoiceId ? (pendingOf.get(n.creditsInvoiceId) ?? []) : [],
    });
  }
  // An event waiting on something that is no candidate could never be filed
  // — a bug to see, never a silent stall (the design review's L3).
  const keys = new Set(candidates.map((c) => c.key));
  for (const c of candidates) {
    if (c.dependsOn.some((k) => !keys.has(k)) || (c.companion !== undefined && !keys.has(c.companion))) {
      throw new Error(`bookkeeping: ${c.key} waits on an event that is not planned`);
    }
  }
  return {
    method,
    candidates,
    docs,
    states,
    yearEnds,
    markedAt,
    creditIssuedAt,
    stateIds: [...new Set([...states.keys(), ...yearEndIds])].sort(),
    bookedYearEnds,
  };
}

const EVENT_ORDER: Readonly<Record<ListEvent, number>> = {
  PAYMENT_UNDONE: 0,
  YEAR_END_UNDONE: 0,
  ISSUE: 1,
  PAYMENT: 1,
  YEAR_END: 1,
  YEAR_END_REVERSED: 1,
  YEAR_END_REVERSAL_UNDONE: 1,
  CREDIT_NOTED: 2,
};

/** The events a file inserts FIRST, in a statement of their own: what a payment's guard counts. */
const FIRST_EVENTS: ReadonlySet<ListEvent> = new Set(["PAYMENT_UNDONE", "YEAR_END_UNDONE"]);

const countByEvent = (picked: readonly Candidate[]): Record<ListEvent, number> => {
  const out = Object.fromEntries(LIST_EVENTS.map((e) => [e, 0])) as Record<ListEvent, number>;
  for (const c of picked) out[c.event] += 1;
  return out;
};

const byDate = (a: Candidate, b: Candidate): number =>
  a.bookedOn.localeCompare(b.bookedOn) ||
  Number(a.doc.displayNumber) - Number(b.doc.displayNumber) ||
  EVENT_ORDER[a.event] - EVENT_ORDER[b.event] ||
  a.key.localeCompare(b.key);

// ── Turning a picked event into what is stored ──────────────────────

type Built = { readonly c: Candidate; readonly voucher: SieVoucher | null; readonly detail: EntryDetail };

/** The credit notes of an invoice a payment deducts (see the header). */
function deductedBy(p: Plan, invoice: Doc, paidOn: string): Doc[] {
  const marked = p.markedAt.get(invoice.id) ?? null;
  return [...p.docs.values()]
    .filter((d) => d.kind === "CREDIT_NOTE" && d.creditsInvoiceId === invoice.id)
    .filter((d) => {
      if (d.issueDate > paidOn) return false;
      if (marked === null) return true;
      const issued = p.creditIssuedAt.get(d.id) ?? null;
      return issued !== null && issued < marked;
    })
    .sort((a, b) => Number(a.displayNumber) - Number(b.displayNumber));
}

function build(p: Plan, picked: readonly Candidate[], s: BookkeepingSettings, fileNumber: number): Built[] {
  const out: Built[] = [];
  // The payment each invoice has booked once this file is in (a credit note's remark reads it).
  const bookedAfter = new Map<string, { bookedOn: string; file: number; deductedIds: readonly string[] } | null>();
  for (const st of p.states.values()) {
    const last = st.last && st.booked === 1 ? detailFromJson(st.last.detail) : null;
    bookedAfter.set(st.invoiceId, st.last && last ? { bookedOn: st.last.bookedOn, file: st.last.file, deductedIds: last.deductedIds ?? [] } : null);
  }
  for (const c of picked) {
    const doc = c.doc;
    if (c.event === "ISSUE") {
      const credit = doc.kind === "CREDIT_NOTE";
      const voucher = issueVoucher(doc, s);
      out.push({
        c,
        voucher,
        detail: {
          amounts: amountsOf(bookedAmounts(doc), credit ? -1n : 1n),
          relates: credit && doc.creditsNumber ? [doc.creditsNumber] : [],
          remark: voucher === null ? { kind: "nothing" } : null,
        },
      });
    } else if (c.event === "PAYMENT_UNDONE") {
      const st = p.states.get(doc.id);
      if (!st?.last) throw new Error("bookkeeping: a reversal without the payment it reverses");
      const was = voucherFromJson(st.last.voucher, st.last.bookedOn);
      const wasDetail = detailFromJson(st.last.detail);
      out.push({
        c,
        voucher: was === null ? null : reversalOf(was, c.bookedOn, "PAYMENT_UNDONE", doc.displayNumber, doc.clientName),
        detail: {
          amounts: negateAmounts(wasDetail.amounts),
          relates: [],
          remark: { kind: "reverses", day: st.last.bookedOn, file: st.last.file },
        },
      });
      bookedAfter.set(doc.id, null);
    } else if (c.event === "PAYMENT") {
      const credits = deductedBy(p, doc, c.bookedOn);
      const amounts = lessCredits(bookedAmounts(doc), credits.map(bookedAmounts));
      const voucher = paymentVoucher(doc, amounts, c.bookedOn, s);
      const deductedIds = credits.map((d) => d.id);
      out.push({
        c,
        voucher,
        detail: {
          amounts: amountsOf(amounts, 1n),
          relates: credits.map((d) => d.displayNumber),
          remark: voucher === null ? { kind: "nothing" } : null,
          deductedIds,
        },
      });
      bookedAfter.set(doc.id, { bookedOn: c.bookedOn, file: fileNumber, deductedIds });
    } else if (c.event === "YEAR_END_REVERSED" || c.event === "YEAR_END_UNDONE" || c.event === "YEAR_END_REVERSAL_UNDONE") {
      // Slice 111b — a booked year end's negations, each its source's exact
      // negative: the year end itself (reversed on E + 1, or withdrawn on E),
      // or its reversal (withdrawn on E + 1).
      const y = c.yearEnd ? p.yearEnds.get(yearEndKey(doc.id, c.yearEnd)) : undefined;
      if (!y) throw new Error("bookkeeping: a year-end event without the year end it negates");
      const ofReversal = c.event === "YEAR_END_REVERSAL_UNDONE";
      if (ofReversal && !y.reversal) throw new Error("bookkeeping: a reversal's withdrawal without the reversal");
      const source = ofReversal ? voucherFromJson(y.reversal!.voucher, addDays(y.yearEnd, 1)) : voucherFromJson(y.voucher, y.yearEnd);
      if (source === null) throw new Error("bookkeeping: a year end without its voucher");
      const yearEndAmounts = detailFromJson(y.detail).amounts;
      out.push({
        c,
        voucher: reversalOf(source, c.bookedOn, c.event, doc.displayNumber, doc.clientName),
        detail: {
          // Signed as booked: the year end's own figures negated — and, for
          // the reversal's withdrawal, negated twice.
          amounts: ofReversal ? yearEndAmounts : negateAmounts(yearEndAmounts),
          relates: [],
          remark:
            c.event === "YEAR_END_REVERSED"
              ? { kind: "reversesYearEnd", day: y.yearEnd, file: y.file }
              : c.event === "YEAR_END_UNDONE"
                ? y.paidOn !== null && y.paidOn <= y.yearEnd
                  ? { kind: "paidByYearEnd", day: y.paidOn, file: y.file }
                  : // Due by the books alone — a payment by then stands in an earlier file.
                    { kind: "paidInBooks", day: y.yearEnd, file: y.file }
                : { kind: "undoesReversal", day: addDays(y.yearEnd, 1), file: y.reversal!.file },
        },
      });
    } else if (c.event === "YEAR_END") {
      throw new Error("bookkeeping: a year end is booked only by bookYearEnd");
    } else {
      // CREDIT_NOTED — listed, never booked; its remark from the record as it stands now.
      const original = doc.creditsInvoiceId ? p.docs.get(doc.creditsInvoiceId) : undefined;
      const paid = doc.creditsInvoiceId ? (bookedAfter.get(doc.creditsInvoiceId) ?? null) : null;
      const remark: ListRemark =
        paid !== null
          ? paid.deductedIds.includes(doc.id)
            ? { kind: "deducted", day: paid.bookedOn, file: paid.file }
            : { kind: "afterPayment", day: paid.bookedOn, file: paid.file }
          : original?.status === "CREDITED"
            ? { kind: "creditedUnpaid" }
            : { kind: "unpaid" };
      out.push({
        c,
        voucher: null,
        detail: { amounts: amountsOf(bookedAmounts(doc), -1n), relates: doc.creditsNumber ? [doc.creditsNumber] : [], remark },
      });
    }
  }
  return out;
}

// ── The year end (slice 111b; C83) ──────────────────────────────────

/** One invoice a year end books: the invoice less its credit notes dated by then. */
type YearEndItem = { readonly doc: Doc; readonly amounts: BookedAmounts; readonly voucher: SieVoucher; readonly credits: readonly Doc[] };

/** A seller's organisation number, digits only — what makes it one company's books. */
const orgDigits = (orgNr: string | null): string | null => {
  const digits = orgNr?.replace(/\D/g, "") ?? "";
  return digits === "" ? null : digits;
};

type PlannedYearEnd = {
  readonly items: YearEndItem[];
  /** Every invoice read — what a maker locks. */
  readonly ids: string[];
  /** Unpaid invoices of another organisation number, left out (the design review's H1). */
  readonly leftOut: { readonly orgNr: string; readonly count: number }[];
};

/**
 * The invoices unpaid on E (the design's §2): issued by then, not marked paid
 * by then, and NO PAYMENT STANDING IN THE BOOKS at E — a payment booked by E
 * and reversed only after it still holds the sale in that year, so it is not
 * booked again (`invoice_export_paid_in_books`, the guard's own test). Each
 * less its credit notes dated by then; one with nothing left IN ITS OWN
 * CURRENCY is not in it (the review's L6 — two partial credits can leave a
 * kronor remainder). Only the YEAR'S company's (the review's H1, the
 * re-check's R8): the organisation number of the newest invoice issued on or
 * before E — the rest left out and named, never refused. By number.
 */
async function planYearEnd(tx: TenantDb, tenantId: string, yearEnd: string, settings: BookkeepingSettings): Promise<PlannedYearEnd> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT i.id
      FROM invoice i
     WHERE i.tenant_id = ${tenantId} AND i.kind = 'INVOICE' AND i.status <> 'DRAFT'
       AND i.issue_date <= ${yearEnd}::date
       AND (i.paid_on IS NULL OR i.paid_on > ${yearEnd}::date)
       AND NOT invoice_export_paid_in_books(i.tenant_id, i.id, ${yearEnd}::date)
     ORDER BY i.id`;
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return { items: [], ids, leftOut: [] };
  const credits = await tx.invoice.findMany({
    where: { kind: "CREDIT_NOTE", status: { not: "DRAFT" }, creditsInvoiceId: { in: ids }, issueDate: { lte: new Date(`${yearEnd}T00:00:00Z`) } },
    select: { id: true },
  });
  const docs = await loadDocs(tx, [...ids, ...credits.map((c) => c.id)]);
  const creditsOf = new Map<string, Doc[]>();
  for (const d of docs.values()) {
    if (d.kind !== "CREDIT_NOTE" || d.creditsInvoiceId === null) continue;
    creditsOf.set(d.creditsInvoiceId, [...(creditsOf.get(d.creditsInvoiceId) ?? []), d]);
  }
  // The company whose year this is: the seller of the newest invoice issued
  // on or before E (the re-check's R8 — not the company card now: a sole
  // trader turned company in January, or a typo fixed after E, would leave
  // the whole year out).
  const [newest] = await tx.$queryRaw<{ org_nr: string | null }[]>`
    SELECT i.seller_snapshot ->> 'orgNr' AS org_nr
      FROM invoice i
     WHERE i.tenant_id = ${tenantId} AND i.status <> 'DRAFT' AND i.issue_date <= ${yearEnd}::date
     ORDER BY i.issue_date DESC, i.issued_at DESC NULLS LAST, i.id DESC
     LIMIT 1`;
  const current = orgDigits(newest?.org_nr ?? null);

  const items: YearEndItem[] = [];
  // By the number's digits (one company however it was typed), shown as first spelled.
  const leftOut = new Map<string, { orgNr: string; count: number }>();
  for (const id of ids) {
    const doc = docs.get(id);
    if (!doc) continue;
    const its = (creditsOf.get(id) ?? []).sort((a, b) => Number(a.displayNumber) - Number(b.displayNumber));
    const amounts = lessCredits(bookedAmounts(doc), its.map(bookedAmounts));
    if (amounts.net === 0n && amounts.vat === 0n) continue;
    const voucher = yearEndVoucher(doc, amounts, yearEnd, settings);
    if (voucher === null) continue;
    const seller = orgDigits(doc.seller.orgNr);
    if (current !== null && seller !== current) {
      const key = seller ?? "";
      const was = leftOut.get(key);
      leftOut.set(key, { orgNr: was?.orgNr ?? doc.seller.orgNr ?? "—", count: (was?.count ?? 0) + 1 });
      continue;
    }
    items.push({ doc, amounts, voucher, credits: its });
  }
  items.sort((a, b) => Number(a.doc.displayNumber) - Number(b.doc.displayNumber));
  return { items, ids, leftOut: [...leftOut.values()].sort((a, b) => a.orgNr.localeCompare(b.orgNr)) };
}

/** The year end due (`dueYearEnd`) and the newest one booked — ONE statement for both facts. */
async function yearEndDueFor(
  tx: TenantDb,
  tenantId: string,
  method: BookkeepingMethod | null,
  yearStart: number,
  today: string,
): Promise<{ readonly due: string | null; readonly lastYearEnd: string | null }> {
  const [row] = await tx.$queryRaw<{ last_ye: Date | null; first_issue: Date | null }[]>`
    SELECT (SELECT max(e.year_end) FROM invoice_export e WHERE e.tenant_id = ${tenantId}) AS last_ye,
           (SELECT min(i.issue_date) FROM invoice i
             WHERE i.tenant_id = ${tenantId} AND i.kind = 'INVOICE' AND i.status <> 'DRAFT') AS first_issue`;
  const lastYearEnd = row?.last_ye ? isoDay(row.last_ye) : null;
  const firstIssue = row?.first_issue ? isoDay(row.first_issue) : null;
  return { due: dueYearEnd({ method, yearStart, today, lastYearEnd, firstIssue }), lastYearEnd };
}

/**
 * An event the year end E waits for: dated on or before E and still to be
 * filed — except a credit note's listing, which books nothing (the year end
 * deducts credit notes by their date anyway; the design review's L3).
 */
const holdsYearEnd = (c: Candidate, yearEnd: string): boolean => c.bookedOn <= yearEnd && c.event !== "CREDIT_NOTED";

const sumSek = (items: readonly YearEndItem[]): bigint => items.reduce((s, it) => s + it.amounts.netSek + it.amounts.vatSek, 0n);

export type YearEndBooked = { readonly id: string; readonly number: number; readonly yearEnd: string; readonly count: number };

/**
 * `invoice:export` (+ `invoice:view`, every client) — BOOK THE YEAR END
 * (C83 (a)): the year-end file of the year end that is due, holding a
 * `YEAR_END` for each of the current company's invoices unpaid on its last
 * day. The press carries what the person was shown — the day, how many, the
 * total in kronor: another day (booked meanwhile, or not ended) is
 * INVOICE_YEAR_END_NOT_DUE, another set INVOICE_YEAR_END_CHANGED ("look
 * again"; the design review's L4). INVOICE_YEAR_END_WAITING while an event
 * dated in that year waits for a file (the design's §3.2: the year end reads
 * complete books). A year with nothing unpaid still gets its (empty) file —
 * the record that it was looked at, and what makes the next year due.
 *
 * Locks: the export lock first (every maker's and the settings save's
 * order), then the invoices the year end reads `FOR SHARE` in id order, read
 * again under them — and only THEN the §3.2 check (L4): a Mark as paid then
 * waits for the year end, and a payment on or before E it marks becomes a
 * late correction (C83 (b)).
 */
export async function bookYearEnd(
  ctx: InvoicingCtx,
  input: { readonly yearEnd: unknown; readonly count: unknown; readonly totalSek: unknown },
  opts: { readonly now?: Date } = {},
): Promise<YearEndBooked> {
  const seen = typeof input.yearEnd === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.yearEnd) ? input.yearEnd : fail("INVALID_INPUT", "yearEnd");
  const seenCount = typeof input.count === "number" && Number.isInteger(input.count) && input.count >= 0 ? input.count : fail("INVALID_INPUT", "count");
  const seenTotal = typeof input.totalSek === "string" && /^-?\d{1,15}\.\d{2}$/.test(input.totalSek) ? input.totalSek : fail("INVALID_INPUT", "totalSek");
  const now = opts.now ?? new Date();
  try {
    return await withTenant(
      ctx.tenantId,
      memberPrincipal(ctx),
      async (tx) => {
        await openBookkeeping(tx, ctx);
        await tx.$executeRaw`SELECT invoice_export_lock(${ctx.tenantId})`;
        const settings = await readBookkeepingSettings(tx, ctx.tenantId);
        const method = (await filesMethod(tx)) ?? methodOf(settings);
        if (method === null) return fail("INVOICE_EXPORT_NO_METHOD");
        const today = todayIn((await readPreferences(tx, ctx.tenantId)).timezone, now);
        const yearStart = yearStartOf(settings);
        const { due } = await yearEndDueFor(tx, ctx.tenantId, method, yearStart, today);
        if (due === null || due !== seen) return fail("INVOICE_YEAR_END_NOT_DUE");

        // Read, lock, read again — until nothing new to lock.
        let ye = await planYearEnd(tx, ctx.tenantId, due, settings);
        const locked = new Set<string>();
        for (let round = 0; ; round++) {
          const toLock = ye.ids.filter((id) => !locked.has(id));
          if (toLock.length === 0) break;
          if (round === 3) return fail("INVOICE_EXPORT_BUSY");
          await tx.$queryRaw`SELECT id FROM invoice WHERE tenant_id = ${ctx.tenantId} AND id = ANY(${toLock}::text[]) ORDER BY id FOR SHARE`;
          for (const id of toLock) locked.add(id);
          ye = await planYearEnd(tx, ctx.tenantId, due, settings);
        }
        const p = await plan(tx, ctx.tenantId, method, today, yearStart);
        if (p.candidates.some((c) => holdsYearEnd(c, due))) return fail("INVOICE_YEAR_END_WAITING");
        const totalSek = formatFixed(sumSek(ye.items), 2);
        if (ye.items.length !== seenCount || totalSek !== seenTotal) return fail("INVOICE_YEAR_END_CHANGED");

        const made = await tx.invoiceExport.create({
          data: {
            tenantId: ctx.tenantId,
            number: 0, // the guard numbers it
            method,
            series: settings.series,
            madeOn: new Date(`${today}T00:00:00Z`),
            yearEnd: new Date(`${due}T00:00:00Z`),
            createdByMemberId: ctx.actor.memberId,
          },
          select: { id: true, number: true },
        });
        const rows = ye.items.map((it, i) => ({
          tenantId: ctx.tenantId,
          exportId: made.id,
          invoiceId: it.doc.id,
          position: i + 1,
          event: "YEAR_END" as const,
          bookedOn: new Date(`${due}T00:00:00Z`),
          yearEnd: new Date(`${due}T00:00:00Z`),
          voucher: voucherToJson(it.voucher),
          detail: { amounts: amountsOf(it.amounts, 1n), relates: it.credits.map((d) => d.displayNumber), remark: null } satisfies EntryDetail,
        }));
        for (const batch of chunks(rows, ENTRY_BATCH)) await tx.invoiceExportEntry.createMany({ data: batch });
        await record(tx, {
          action: "invoice_export.year_end_booked",
          targetType: "InvoiceExport",
          targetId: made.id,
          metadata: { number: made.number, yearEnd: due, invoices: rows.length, totalSek, leftOut: ye.leftOut.reduce((s, l) => s + l.count, 0) },
        });
        return { id: made.id, number: made.number, yearEnd: due, count: rows.length };
      },
      { lockTimeoutMs: EXPORT_LOCK_WAIT_MS, timeoutMs: EXPORT_TX_TIMEOUT_MS },
    );
  } catch (e) {
    if (isLockTimeout(e) || isDeadlock(e)) return fail("INVOICE_EXPORT_BUSY");
    throw e;
  }
}

/**
 * The newest year end booked, or null (slice 111b; its design review's L9):
 * Mark as paid says so when the payment's day falls on or before it. Any
 * member who sees invoices — the day is no secret, and the dialog is theirs.
 */
export async function readNewestYearEnd(ctx: InvoicingCtx): Promise<string | null> {
  return withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    if (!(await hasAccess(tx, ctx.tenantId, ctx.actor, "invoice:view"))) return null;
    const row = await tx.invoiceExport.findFirst({ where: { yearEnd: { not: null } }, orderBy: { yearEnd: "desc" }, select: { yearEnd: true } });
    return row?.yearEnd ? isoDay(row.yearEnd) : null;
  });
}

/**
 * The year end due, for `/invoices`' reminder (C83 (a)) — null for anyone
 * the Bookkeeping page would not open for, under the invoice method, or when
 * none is due. Asked again here, quietly: the caller only showed the link.
 */
export async function readYearEndReminder(ctx: InvoicingCtx, opts: { readonly now?: Date } = {}): Promise<string | null> {
  return withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    if (!(await hasAccess(tx, ctx.tenantId, ctx.actor, "invoice:view"))) return null;
    if (!(await hasAccess(tx, ctx.tenantId, ctx.actor, "invoice:export"))) return null;
    if (!(await resolveScope(tx, ctx.actor)).all) return null;
    const settings = await readBookkeepingSettings(tx, ctx.tenantId);
    const method = (await filesMethod(tx)) ?? methodOf(settings);
    if (method !== "CASH") return null;
    const today = todayIn((await readPreferences(tx, ctx.tenantId)).timezone, opts.now ?? new Date());
    return (await yearEndDueFor(tx, ctx.tenantId, method, yearStartOf(settings), today)).due;
  });
}

// ── The page ────────────────────────────────────────────────────────

export type BookkeepingFile = {
  readonly id: string;
  readonly number: number;
  readonly method: BookkeepingMethod;
  readonly madeOn: string;
  readonly madeBy: string | null;
  /** Events booked (a voucher) and listed only. */
  readonly vouchers: number;
  readonly listed: number;
  /** The earliest and latest day it books, `YYYY-MM-DD`. */
  readonly first: string | null;
  readonly last: string | null;
  /** A year-end file: the year's last day it books (slice 111b). */
  readonly yearEnd: string | null;
};

/** At most this many of a year end's invoices are listed on the page. */
export const YEAR_END_PREVIEW = 50;

export type BookkeepingPage = {
  readonly method: BookkeepingMethod | null;
  readonly yearStart: number;
  readonly series: string;
  /** What the next file would hold — null until a method is chosen. */
  readonly next: {
    readonly count: number;
    readonly byEvent: Readonly<Record<ListEvent, number>>;
    readonly first: string | null;
    readonly last: string | null;
    /** New events that wait for a later file (another financial year, another seller, the cap). */
    readonly waiting: number;
    /** The newest booked year end when this file books on or before it — a correction into a closed year (C83 (b)). */
    readonly intoBookedYear: string | null;
  } | null;
  /** The year end that is due (CASH only; C83 (a)), or null. */
  readonly yearEnd: {
    /** The year's last day, `YYYY-MM-DD`. */
    readonly date: string;
    /** Events dated on or before it still waiting for a file — the year end waits for them. */
    readonly waiting: number;
    /** Unpaid invoices of ANOTHER organisation number — not in this year end (the design review's H1). */
    readonly leftOut: readonly { readonly orgNr: string; readonly count: number }[];
    /** The invoices unpaid then, as booking it now would book them. */
    readonly count: number;
    readonly totalSek: string;
    readonly rows: readonly { readonly number: string; readonly client: string; readonly issueDate: string; readonly totalSek: string }[];
  } | null;
  readonly files: readonly BookkeepingFile[];
  /** The number to pass as `before` for the next (older) page, or null. */
  readonly olderBefore: number | null;
  readonly canEditSettings: boolean;
};

/** `invoice:export` (+ `invoice:view`, every client) — the Bookkeeping page. */
export async function readBookkeeping(ctx: InvoicingCtx, opts: { readonly before?: number; readonly now?: Date } = {}): Promise<BookkeepingPage> {
  return withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    await openBookkeeping(tx, ctx);
    const settings = await readBookkeepingSettings(tx, ctx.tenantId);
    const method = (await filesMethod(tx)) ?? methodOf(settings);
    let next: BookkeepingPage["next"] = null;
    let yearEnd: BookkeepingPage["yearEnd"] = null;
    if (method !== null) {
      const today = todayIn((await readPreferences(tx, ctx.tenantId)).timezone, opts.now ?? new Date());
      const yearStart = yearStartOf(settings);
      const p = await plan(tx, ctx.tenantId, method, today, yearStart);
      const sorted = [...p.candidates].sort(byDate);
      const picked = selectForFile(sorted, groupOf(yearStart, p.bookedYearEnds), EXPORT_MAX);
      const days = picked.map((c) => c.bookedOn).sort();
      const { due, lastYearEnd } = await yearEndDueFor(tx, ctx.tenantId, method, yearStart, today);
      next = {
        count: picked.length,
        byEvent: countByEvent(picked),
        first: days[0] ?? null,
        last: days.at(-1) ?? null,
        waiting: p.candidates.length - picked.length,
        // A credit note's listing books nothing — it never reopens a year (the re-check's NIT).
        intoBookedYear: lastYearEnd !== null && picked.some((c) => c.bookedOn <= lastYearEnd && c.event !== "CREDIT_NOTED") ? lastYearEnd : null,
      };
      if (due !== null) {
        const ye = await planYearEnd(tx, ctx.tenantId, due, settings);
        yearEnd = {
          date: due,
          waiting: p.candidates.filter((c) => holdsYearEnd(c, due)).length,
          leftOut: ye.leftOut,
          count: ye.items.length,
          totalSek: formatFixed(sumSek(ye.items), 2),
          rows: ye.items.slice(0, YEAR_END_PREVIEW).map((it) => ({
            number: it.doc.displayNumber,
            client: it.doc.clientName,
            issueDate: it.doc.issueDate,
            totalSek: formatFixed(it.amounts.netSek + it.amounts.vatSek, 2),
          })),
        };
      }
    }
    const files = await tx.invoiceExport.findMany({
      where: opts.before ? { number: { lt: opts.before } } : {},
      orderBy: { number: "desc" },
      take: EXPORT_FILES_PAGE + 1,
      select: { id: true, number: true, method: true, madeOn: true, yearEnd: true, createdByMemberId: true },
    });
    const more = files.length > EXPORT_FILES_PAGE;
    files.splice(EXPORT_FILES_PAGE);
    const stats =
      files.length === 0
        ? []
        : await tx.$queryRaw<{ export_id: string; vouchers: number; listed: number; first: Date | null; last: Date | null }[]>`
            SELECT x.export_id,
                   count(*) FILTER (WHERE x.voucher IS NOT NULL)::int AS vouchers,
                   count(*) FILTER (WHERE x.voucher IS NULL)::int AS listed,
                   min(x.booked_on) AS first, max(x.booked_on) AS last
              FROM invoice_export_entry x
             WHERE x.tenant_id = ${ctx.tenantId} AND x.export_id = ANY(${files.map((f) => f.id)}::text[])
             GROUP BY x.export_id`;
    const statOf = new Map(stats.map((s) => [s.export_id, s]));
    const makers = await tx.member.findMany({
      where: { id: { in: [...new Set(files.map((f) => f.createdByMemberId))] } },
      select: { id: true, user: { select: { name: true } } },
    });
    const nameOf = new Map(makers.map((m) => [m.id, m.user.name]));
    const canEditSettings = await hasAccess(tx, ctx.tenantId, ctx.actor, "settings:edit");
    return {
      method,
      yearStart: yearStartOf(settings),
      series: settings.series,
      next,
      yearEnd,
      files: files.map((f) => {
        const st = statOf.get(f.id);
        return {
          id: f.id,
          number: f.number,
          method: f.method,
          madeOn: isoDay(f.madeOn),
          madeBy: nameOf.get(f.createdByMemberId) ?? null,
          vouchers: st?.vouchers ?? 0,
          listed: st?.listed ?? 0,
          first: st?.first ? isoDay(st.first) : null,
          last: st?.last ? isoDay(st.last) : null,
          yearEnd: f.yearEnd ? isoDay(f.yearEnd) : null,
        };
      }),
      olderBefore: more ? (files.at(-1)?.number ?? null) : null,
      canEditSettings,
    };
  });
}

// ── Making a file ───────────────────────────────────────────────────

export type MadeFile = { readonly id: string; readonly number: number; readonly count: number; readonly waiting: number };

/**
 * `invoice:export` — make the next file of what is new (see the header).
 * INVOICE_EXPORT_NO_METHOD before a method is chosen; INVOICE_EXPORT_EMPTY
 * when nothing is new; INVOICE_EXPORT_BUSY on a lock held past the bound.
 */
export async function createExport(
  ctx: InvoicingCtx,
  opts: { readonly now?: Date; readonly max?: number } = {},
): Promise<MadeFile> {
  const now = opts.now ?? new Date();
  const max = opts.max ?? EXPORT_MAX;
  try {
    return await withTenant(
      ctx.tenantId,
      memberPrincipal(ctx),
      async (tx) => {
        await openBookkeeping(tx, ctx);
        await tx.$executeRaw`SELECT invoice_export_lock(${ctx.tenantId})`;
        const settings = await readBookkeepingSettings(tx, ctx.tenantId);
        // Read under the lock: the files' method once there is one (the guard
        // holds every file to the first's), the setting's only before.
        const method = (await filesMethod(tx)) ?? methodOf(settings);
        if (method === null) return fail("INVOICE_EXPORT_NO_METHOD");
        const today = todayIn((await readPreferences(tx, ctx.tenantId)).timezone, now);
        const yearStart = yearStartOf(settings);

        // Read, lock what a mark could move, read AGAIN under the locks (the
        // re-check's 7) — until the second read names nothing new to lock.
        let p = await plan(tx, ctx.tenantId, method, today, yearStart);
        const locked = new Set<string>();
        for (let round = 0; ; round++) {
          const toLock = p.stateIds.filter((id) => !locked.has(id));
          if (toLock.length === 0) break;
          if (round === 3) return fail("INVOICE_EXPORT_BUSY");
          await tx.$queryRaw`SELECT id FROM invoice WHERE tenant_id = ${ctx.tenantId} AND id = ANY(${toLock}::text[]) ORDER BY id FOR SHARE`;
          for (const id of toLock) locked.add(id);
          p = await plan(tx, ctx.tenantId, method, today, yearStart);
        }

        const sorted = [...p.candidates].sort(byDate);
        const picked = selectForFile(sorted, groupOf(yearStart, p.bookedYearEnds), max);
        if (picked.length === 0) return fail("INVOICE_EXPORT_EMPTY");

        const made = await tx.invoiceExport.create({
          data: {
            tenantId: ctx.tenantId,
            number: 0, // the guard numbers it
            method,
            series: settings.series,
            madeOn: new Date(`${today}T00:00:00Z`),
            createdByMemberId: ctx.actor.memberId,
          },
          select: { id: true, number: true },
        });
        const built = build(p, picked, settings, made.number);
        const rows = built.map((b, i) => ({
          tenantId: ctx.tenantId,
          exportId: made.id,
          invoiceId: b.c.doc.id,
          position: i + 1,
          event: b.c.event,
          bookedOn: new Date(`${b.c.bookedOn}T00:00:00Z`),
          ...(b.c.yearEnd ? { yearEnd: new Date(`${b.c.yearEnd}T00:00:00Z`) } : {}),
          ...(b.voucher ? { voucher: voucherToJson(b.voucher) } : {}),
          detail: b.detail,
        }));
        // A few statements, not one per entry (the code review's 4: a thousand
        // round trips outlast the transaction over a slow link): the
        // REVERSALS and WITHDRAWALS first — a re-marked payment's guard counts
        // its reversal, a payment by a booked year end's guard looks for that
        // year end's withdrawal, and a reversal's withdrawal for the year
        // end's (slice 111b) — then the rest. Within a statement each row's
        // guard sees the rows before it, and nothing else in a file depends on
        // another entry.
        const first = rows.filter((r) => FIRST_EVENTS.has(r.event));
        const rest = rows.filter((r) => !FIRST_EVENTS.has(r.event));
        for (const batch of [first, ...chunks(rest, ENTRY_BATCH)]) {
          if (batch.length > 0) await tx.invoiceExportEntry.createMany({ data: batch });
        }
        const byEvent = countByEvent(picked);
        const days = picked.map((c) => c.bookedOn).sort();
        await record(tx, {
          action: "invoice_export.created",
          targetType: "InvoiceExport",
          targetId: made.id,
          metadata: { number: made.number, method, ...byEvent, first: days[0]!, last: days.at(-1)!, waiting: p.candidates.length - picked.length },
        });
        return { id: made.id, number: made.number, count: picked.length, waiting: p.candidates.length - picked.length };
      },
      { lockTimeoutMs: EXPORT_LOCK_WAIT_MS, timeoutMs: EXPORT_TX_TIMEOUT_MS },
    );
  } catch (e) {
    if (isLockTimeout(e) || isDeadlock(e)) return fail("INVOICE_EXPORT_BUSY");
    throw e;
  }
}

// ── Downloading a file ──────────────────────────────────────────────

export type ExportFormat = "sie" | "xlsx";

export type ExportedFile = { readonly bytes: Uint8Array; readonly fileName: string; readonly number: number };

/**
 * `invoice:export` — a file's bytes, regenerated from what it froze: the SIE
 * import (its vouchers by day, then place) or the list (every entry). The
 * company the SIE names is the files' invoices' frozen seller. Audited with
 * the bytes' SHA-256 — what exactly was handed over (the review's nit).
 */
export async function exportFile(
  ctx: InvoicingCtx,
  exportId: string,
  format: ExportFormat,
  words: ListWords & { readonly sheet: string },
): Promise<ExportedFile> {
  return withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    await openBookkeeping(tx, ctx);
    const file = await tx.invoiceExport.findFirst({
      where: { id: exportId },
      select: { id: true, number: true, series: true, madeOn: true },
    });
    if (!file) return deny("NOT_FOUND");
    const entries = await tx.invoiceExportEntry.findMany({
      where: { exportId },
      orderBy: { position: "asc" },
      select: { invoiceId: true, position: true, event: true, bookedOn: true, voucher: true, detail: true },
    });
    const docs = await loadDocs(tx, [...new Set(entries.map((e) => e.invoiceId))]);
    let bytes: Uint8Array;
    let fileName: string;
    if (format === "sie") {
      const first = entries.length > 0 ? docs.get(entries[0]!.invoiceId) : undefined;
      const vouchers = entries
        .map((e) => ({ e, v: voucherFromJson(e.voucher, isoDay(e.bookedOn)) }))
        .filter((x): x is { e: (typeof entries)[number]; v: SieVoucher } => x.v !== null)
        .sort((a, b) => a.v.date.localeCompare(b.v.date) || a.e.position - b.e.position)
        .map((x) => x.v);
      bytes = sieFile({
        company: first ? first.seller : { legalName: "-", orgNr: null },
        madeOn: isoDay(file.madeOn),
        series: file.series,
        vouchers,
      });
      fileName = `fortleva-fakt-${file.number}.si`;
    } else {
      const rows = entries.map((e) => {
        const doc = docs.get(e.invoiceId);
        if (!doc) throw new Error("bookkeeping: an entry's invoice is gone");
        const d = detailFromJson(e.detail);
        const listed: ListedEntry = {
          event: e.event,
          bookedOn: isoDay(e.bookedOn),
          kind: doc.kind,
          displayNumber: doc.displayNumber,
          relates: d.relates,
          issueDate: doc.issueDate,
          dueDate: doc.dueDate,
          clientName: doc.clientName,
          clientOrgNr: doc.clientOrgNr,
          clientVatNumber: doc.clientVatNumber,
          clientCountry: doc.clientCountry,
          vatProfile: doc.vatProfile,
          currency: doc.currency,
          bookRate: doc.bookRate === null ? null : formatFixed(doc.bookRate, 6),
          amounts: d.amounts,
          remark: d.remark,
        };
        return listRow(listed, words);
      });
      bytes = xlsxWorkbook({ sheet: words.sheet, columns: listColumns(words), rows });
      fileName = `fortleva-fakturor-${file.number}.xlsx`;
    }
    await record(tx, {
      action: "invoice_export.downloaded",
      targetType: "InvoiceExport",
      targetId: file.id,
      metadata: { number: file.number, format, sha256: createHash("sha256").update(bytes).digest("hex") },
    });
    return { bytes, fileName, number: file.number };
  });
}

// ── The settings ────────────────────────────────────────────────────

export type BookkeepingSettingsPage = {
  readonly values: BookkeepingSettings;
  readonly canEdit: boolean;
  /** A file exists: the method is fixed (C82 (e); the guard holds it too). */
  readonly methodFixed: boolean;
};

/** `settings:view` with the invoicing module open — Settings → Invoicing's Bookkeeping card. */
export async function readBookkeepingSettingsPage(ctx: InvoicingCtx): Promise<BookkeepingSettingsPage> {
  return withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "settings:view");
    await requireAccess(tx, ctx.tenantId, ctx.actor, "invoice:view");
    const values = await readBookkeepingSettings(tx, ctx.tenantId);
    const canEdit = await hasAccess(tx, ctx.tenantId, ctx.actor, "settings:edit");
    const methodFixed = (await tx.invoiceExport.count({ where: {} })) > 0;
    return { values, canEdit, methodFixed };
  });
}

/**
 * `settings:edit` (+ `invoice:view`) — the Bookkeeping card's save: every
 * posted field normalised (one refusal refuses the save), the method refused
 * a change once a file exists, the tenant row locked first so two saves of
 * different fields never lose one (the review's L3). Returns the fields that
 * changed.
 */
export async function updateBookkeepingSettings(
  ctx: InvoicingCtx,
  patch: Partial<Record<BookkeepingField, unknown>>,
): Promise<BookkeepingField[]> {
  const next: Partial<Record<BookkeepingField, string | null>> = {};
  for (const field of BOOKKEEPING_FIELDS) if (field in patch) next[field] = normalizeBookkeepingValue(field, patch[field]);
  return withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "settings:edit");
    await requireAccess(tx, ctx.tenantId, ctx.actor, "invoice:view");
    // The export lock FIRST — the makers' order — so a method change and a
    // file being made never interleave (both reviews' race: a change read "no
    // file yet" while the first was being made, and the workspace's files and
    // its setting disagreed for good). Then the tenant row, so two saves of
    // different fields never lose one (the review's L3).
    await tx.$executeRaw`SELECT invoice_export_lock(${ctx.tenantId})`;
    await tx.$queryRaw`SELECT id FROM tenant WHERE id = ${ctx.tenantId} FOR NO KEY UPDATE`;
    const before = await readBookkeepingSettings(tx, ctx.tenantId);
    const after: Record<BookkeepingField, string> = { ...before };
    for (const field of BOOKKEEPING_FIELDS) {
      if (!(field in next)) continue;
      // Blank is "the default" — except the method, which has none to go back to.
      const v = next[field] ?? null;
      if (field === "method" && v === null) continue;
      after[field] = v ?? bookkeepingFrom(null)[field];
    }
    const changed = BOOKKEEPING_FIELDS.filter((f) => after[f] !== before[f]);
    if (changed.length === 0) return [];
    if (changed.includes("method")) {
      // A one-way choice the database fixes with the first file: decided by a
      // member who may make files (the security review's nit 4), and once a
      // file exists, only ever back to the files' method.
      await requireAccess(tx, ctx.tenantId, ctx.actor, "invoice:export");
      const fixed = await filesMethod(tx);
      if (fixed !== null && after.method !== fixed) return fail("INVOICE_EXPORT_METHOD_FIXED");
    } else if (changed.includes("yearStart")) {
      // Slice 111b (its design review's L2): the financial year decides what
      // a file holds and when a year end falls — decided, like the method, by
      // a member who may make files.
      await requireAccess(tx, ctx.tenantId, ctx.actor, "invoice:export");
    }
    const value = bookkeepingToStore(after);
    await tx.tenantPreference.upsert({
      where: { tenantId_key: { tenantId: ctx.tenantId, key: BOOKKEEPING_PREF_KEY } },
      create: { tenantId: ctx.tenantId, key: BOOKKEEPING_PREF_KEY, value, updatedByMemberId: ctx.actor.memberId },
      update: { value, updatedByMemberId: ctx.actor.memberId },
      select: { id: true },
    });
    await record(tx, {
      action: "invoice_settings.bookkeeping_changed",
      targetType: "TenantPreference",
      targetId: BOOKKEEPING_PREF_KEY,
      metadata: { changes: Object.fromEntries(changed.map((f) => [f, { from: before[f], to: after[f] }])) },
    });
    return changed;
  });
}

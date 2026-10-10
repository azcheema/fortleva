import { createHash } from "node:crypto";

import { record } from "@/audit/record";
import { resolveScope } from "@/authz/authorize";
import { deny } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { hasAccess, requireAccess } from "@/entitlements/resolver";
import { todayIn } from "@/lib/due-date";
import { fail, isDeadlock, isLockTimeout } from "@/lib/domain-error";
import { xlsxWorkbook } from "@/lib/xlsx";
import { readPreferences } from "@/preferences/service";

import {
  BOOKKEEPING_FIELDS,
  BOOKKEEPING_PREF_KEY,
  bookkeepingFrom,
  bookkeepingToStore,
  financialYearOf,
  methodOf,
  normalizeBookkeepingValue,
  yearStartOf,
  type BookkeepingField,
  type BookkeepingMethod,
  type BookkeepingSettings,
} from "./bookkeeping-accounts";
import type { InvoicingCtx } from "./drafts";
import { listColumns, listRow, type ListAmounts, type ListedEntry, type ListEvent, type ListRemark, type ListWords } from "./invoice-list";
import { formatFixed, readFixed, type Minor } from "./money";
import { isoDay } from "./print";
import { selectForFile } from "./bookkeeping-select";
import { sieFile, type SieVoucher } from "./sie";
import { isVatProfile, type VatProfile } from "./vat";
import { bookedAmounts, issueVoucher, lessCredits, paymentVoucher, reversalOf, type BookableInvoice, type BookedAmounts } from "./vouchers";

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
};

type Plan = {
  readonly method: BookkeepingMethod;
  readonly candidates: readonly Candidate[];
  readonly docs: ReadonlyMap<string, Doc>;
  readonly states: ReadonlyMap<string, PayState>;
  /** A paid invoice → when its payment was marked (the newest `invoice.paid` audit row). */
  readonly markedAt: ReadonlyMap<string, Date>;
  /** A credit note of a paid invoice → when it was issued (its `invoice.issued` audit row). */
  readonly creditIssuedAt: ReadonlyMap<string, Date>;
  /** The invoices whose payment state the plan read — locked `FOR SHARE` by a maker. */
  readonly stateIds: readonly string[];
};

const keyOf = (event: ListEvent, invoiceId: string) => `${event}:${invoiceId}`;

async function plan(tx: TenantDb, tenantId: string, method: BookkeepingMethod, today: string): Promise<Plan> {
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
    return { method, candidates, docs, states: new Map(), markedAt: new Map(), creditIssuedAt: new Map(), stateIds: [] };
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
    ...new Set([...states.keys(), ...noted.map((n) => n.id), ...creditsOfPaying.map((c) => c.id), ...originals]),
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
  const pendingOf = new Map<string, string[]>();
  for (const s of due.values()) {
    const doc = docs.get(s.invoiceId);
    if (!doc) continue;
    const keys: string[] = [];
    if (needsUndo(s)) {
      const k = keyOf("PAYMENT_UNDONE", doc.id);
      candidates.push({ key: k, event: "PAYMENT_UNDONE", doc, bookedOn: today, dependsOn: [] });
      keys.push(k);
    }
    if (needsPay(s)) {
      const k = keyOf("PAYMENT", doc.id);
      candidates.push({ key: k, event: "PAYMENT", doc, bookedOn: s.paidOn!, dependsOn: [...keys] });
      keys.push(k);
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
  return { method, candidates, docs, states, markedAt, creditIssuedAt, stateIds: [...new Set([...states.keys()])].sort() };
}

const EVENT_ORDER: Readonly<Record<ListEvent, number>> = { PAYMENT_UNDONE: 0, ISSUE: 1, PAYMENT: 1, CREDIT_NOTED: 2 };

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
        voucher: was === null ? null : reversalOf(was, c.bookedOn, doc.displayNumber, doc.clientName),
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
};

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
    if (method !== null) {
      const today = todayIn((await readPreferences(tx, ctx.tenantId)).timezone, opts.now ?? new Date());
      const p = await plan(tx, ctx.tenantId, method, today);
      const sorted = [...p.candidates].sort(byDate);
      const yearStart = yearStartOf(settings);
      const picked = selectForFile(sorted, (c) => `${financialYearOf(c.bookedOn, yearStart)}|${sellerKey(c.doc)}`, EXPORT_MAX);
      const byEvent: Record<ListEvent, number> = { ISSUE: 0, PAYMENT: 0, PAYMENT_UNDONE: 0, CREDIT_NOTED: 0 };
      for (const c of picked) byEvent[c.event] += 1;
      const days = picked.map((c) => c.bookedOn).sort();
      next = { count: picked.length, byEvent, first: days[0] ?? null, last: days.at(-1) ?? null, waiting: p.candidates.length - picked.length };
    }
    const files = await tx.invoiceExport.findMany({
      where: opts.before ? { number: { lt: opts.before } } : {},
      orderBy: { number: "desc" },
      take: EXPORT_FILES_PAGE + 1,
      select: { id: true, number: true, method: true, madeOn: true, createdByMemberId: true },
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

        // Read, lock what a mark could move, read AGAIN under the locks (the
        // re-check's 7) — until the second read names nothing new to lock.
        let p = await plan(tx, ctx.tenantId, method, today);
        const locked = new Set<string>();
        for (let round = 0; ; round++) {
          const toLock = p.stateIds.filter((id) => !locked.has(id));
          if (toLock.length === 0) break;
          if (round === 3) return fail("INVOICE_EXPORT_BUSY");
          await tx.$queryRaw`SELECT id FROM invoice WHERE tenant_id = ${ctx.tenantId} AND id = ANY(${toLock}::text[]) ORDER BY id FOR SHARE`;
          for (const id of toLock) locked.add(id);
          p = await plan(tx, ctx.tenantId, method, today);
        }

        const sorted = [...p.candidates].sort(byDate);
        const yearStart = yearStartOf(settings);
        const picked = selectForFile(sorted, (c) => `${financialYearOf(c.bookedOn, yearStart)}|${sellerKey(c.doc)}`, max);
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
          ...(b.voucher ? { voucher: voucherToJson(b.voucher) } : {}),
          detail: b.detail,
        }));
        // A few statements, not one per entry (the code review's 4: a thousand
        // round trips outlast the transaction over a slow link): the
        // REVERSALS first — a re-marked payment's guard counts its reversal —
        // then the rest. Within a statement each row's guard sees the rows
        // before it, and nothing else in a file depends on another entry.
        const undone = rows.filter((r) => r.event === "PAYMENT_UNDONE");
        const rest = rows.filter((r) => r.event !== "PAYMENT_UNDONE");
        for (const batch of [undone, ...chunks(rest, ENTRY_BATCH)]) {
          if (batch.length > 0) await tx.invoiceExportEntry.createMany({ data: batch });
        }
        const byEvent: Record<ListEvent, number> = { ISSUE: 0, PAYMENT: 0, PAYMENT_UNDONE: 0, CREDIT_NOTED: 0 };
        for (const c of picked) byEvent[c.event] += 1;
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

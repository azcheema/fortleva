import { salesAccountFor, vatAccountFor, type BookkeepingSettings } from "./bookkeeping-accounts";
import { vatInSek } from "./fx";
import { divRoundHalfAway, vatOn, type Minor } from "./money";
import { sieText, type SieRow, type SieVoucher } from "./sie";
import type { VatProfile } from "./vat";

/**
 * WHAT THE BOOKKEEPING FILE BOOKS (Phase 4 slice 111; founder decision C82).
 *
 * THE INVOICE METHOD — each invoice and credit note ON ITS ISSUE DATE:
 *
 *   receivables (1510)      debit   what the client owes, in kronor
 *   sales (3001…/3308/3305) credit  each VAT rate's net, by treatment and rate
 *   output VAT (2611…)      credit  each rate's VAT
 *
 * THE CASH METHOD (C82 (e)) — each PAYMENT on the day it arrived, the same
 * voucher with the BANK (1930) debited, for the invoice LESS every credit note
 * of it issued on or before that day (document by document, each with its own
 * VAT and kronor); a payment undone is its booked voucher negated.
 *
 * A credit note's voucher (invoice method) is its invoice's with every sign
 * reversed. In kronor:
 *
 *  - a SEK invoice books its own amounts;
 *  - another currency books each rate's NET at the invoice's BOOKING rate —
 *    the ECB's on the invoice date (C82 (d)), or its VAT's rate when it
 *    carries Swedish VAT (C82 (f)); a credit note carries its original's —
 *    and each rate's VAT as the invoice STATES it in kronor (its VAT × the
 *    VAT rate, `vatInSek` — the figure printed and reported);
 *  - the debit is the sum of the credits, so every voucher balances by
 *    construction.
 *
 * Rows to the same account are merged; rows of 0,00 are left out; a voucher
 * of nothing is `null` (an invoice of 0,00 — the event is still recorded and
 * listed). A voucher's text is at most 50 characters as CP437 spells it —
 * Fortnox refuses longer (the design review's H1) — with no double quote in it.
 */

export type BookableInvoice = {
  readonly kind: "INVOICE" | "CREDIT_NOTE";
  readonly displayNumber: string;
  /** `YYYY-MM-DD`. */
  readonly issueDate: string;
  /** The buyer as the invoice names them (its frozen snapshot). */
  readonly clientName: string;
  readonly currency: string;
  readonly vatProfile: VatProfile;
  /** Each VAT rate's net (hundredths of a percent; öre/cents), from the frozen lines. */
  readonly groups: readonly { readonly rate: bigint; readonly net: Minor }[];
  /** SEK per unit in millionths — the booking rate (C82 (d), (f)); null on SEK. */
  readonly bookRate: bigint | null;
  /** SEK per unit in millionths — the VAT's rate (C78 (a)); null without VAT in another currency. */
  readonly vatRate: bigint | null;
};

export type BookedGroup = {
  readonly rate: bigint;
  readonly net: Minor;
  readonly vat: Minor;
  readonly netSek: Minor;
  readonly vatSek: Minor;
};

/** Amounts per rate and in total, in the invoice's currency and in kronor. */
export type BookedAmounts = {
  readonly groups: readonly BookedGroup[];
  readonly net: Minor;
  readonly vat: Minor;
  readonly netSek: Minor;
  readonly vatSek: Minor;
};

const total = (groups: readonly BookedGroup[]): BookedAmounts => ({
  groups,
  net: groups.reduce((s, g) => s + g.net, 0n),
  vat: groups.reduce((s, g) => s + g.vat, 0n),
  netSek: groups.reduce((s, g) => s + g.netSek, 0n),
  vatSek: groups.reduce((s, g) => s + g.vatSek, 0n),
});

const byRateDesc = (a: { rate: bigint }, b: { rate: bigint }) => (a.rate === b.rate ? 0 : a.rate > b.rate ? -1 : 1);

/** One document's amounts — POSITIVE for both kinds (a voucher signs them). Throws — a bug — without the rates it needs. */
export function bookedAmounts(inv: BookableInvoice): BookedAmounts {
  const sek = inv.currency === "SEK";
  if (!sek && inv.bookRate === null) throw new Error("vouchers: an invoice in another currency without its booking rate");
  const groups = [...inv.groups].sort(byRateDesc).map((g) => {
    const vat = vatOn(g.net, g.rate);
    // The VAT's own rate — or, on an invoice whose VAT rows sum to nothing
    // (no VAT in kronor was stated, so none was fetched), its booking rate
    // (the re-check's NIT 9: C82 (f) books VAT and net at one rate anyway).
    const vatSek = sek || vat === 0n ? vat : vatInSek(vat, inv.vatRate ?? inv.bookRate!);
    const netSek = sek ? g.net : divRoundHalfAway(g.net * inv.bookRate!, 1_000_000n);
    return { rate: g.rate, net: g.net, vat, netSek, vatSek };
  });
  return total(groups);
}

/** An invoice less its credit notes, rate by rate, each document's own figures (the cash method's payment). */
export function lessCredits(invoice: BookedAmounts, credits: readonly BookedAmounts[]): BookedAmounts {
  const map = new Map<bigint, { net: Minor; vat: Minor; netSek: Minor; vatSek: Minor }>();
  for (const g of invoice.groups) map.set(g.rate, { net: g.net, vat: g.vat, netSek: g.netSek, vatSek: g.vatSek });
  for (const c of credits) {
    for (const g of c.groups) {
      const left = map.get(g.rate) ?? { net: 0n, vat: 0n, netSek: 0n, vatSek: 0n };
      map.set(g.rate, { net: left.net - g.net, vat: left.vat - g.vat, netSek: left.netSek - g.netSek, vatSek: left.vatSek - g.vatSek });
    }
  }
  return total([...map.entries()].map(([rate, a]) => ({ rate, ...a })).sort(byRateDesc));
}

export const VOUCHER_TEXT_MAX = 50;

/**
 * A voucher's text: `<what> <number> <client>`, Swedish always (the books),
 * spelled as CP437 carries it, double quotes as `'`, at most 50 characters —
 * the client's name is what gets cut.
 */
export function voucherText(what: string, displayNumber: string, clientName: string): string {
  const head = sieText(`${what} ${displayNumber}`);
  const name = sieText(clientName).replace(/"/g, "'");
  const room = VOUCHER_TEXT_MAX - Array.from(head).length - 1;
  if (room <= 0) return Array.from(head).slice(0, VOUCHER_TEXT_MAX).join("");
  const cut = Array.from(name).slice(0, room).join("").trimEnd();
  return cut === "" ? head : `${head} ${cut}`;
}

/** Rows for a debit account against an amount's sales and VAT; sign −1 reverses every row. */
function rowsFor(debit: string, amounts: BookedAmounts, profile: VatProfile, s: BookkeepingSettings, sign: bigint): SieRow[] {
  // Insertion order is the row order: the debit, sales (highest rate first), VAT.
  const byAccount = new Map<string, Minor>();
  const add = (account: string, amount: Minor) => byAccount.set(account, (byAccount.get(account) ?? 0n) + amount);
  add(debit, sign * (amounts.netSek + amounts.vatSek));
  for (const g of amounts.groups) add(salesAccountFor(s, profile, g.rate), -sign * g.netSek);
  for (const g of amounts.groups) {
    const account = vatAccountFor(s, g.rate);
    if (account !== null) add(account, -sign * g.vatSek);
    else if (g.vatSek !== 0n) throw new Error("vouchers: VAT at a rate of 0");
  }
  return [...byAccount.entries()].filter(([, amount]) => amount !== 0n).map(([account, amount]) => ({ account, amount }));
}

const voucherOf = (date: string, text: string, rows: SieRow[]): SieVoucher | null => (rows.length === 0 ? null : { date, text, rows });

/** THE INVOICE METHOD: an invoice or credit note on its issue date, to receivables. */
export function issueVoucher(inv: BookableInvoice, s: BookkeepingSettings): SieVoucher | null {
  const credit = inv.kind === "CREDIT_NOTE";
  const rows = rowsFor(s.receivables, bookedAmounts(inv), inv.vatProfile, s, credit ? -1n : 1n);
  return voucherOf(inv.issueDate, voucherText(credit ? "Kreditfaktura" : "Faktura", inv.displayNumber, inv.clientName), rows);
}

/** THE CASH METHOD: a payment of an invoice (less the credit notes before it) on the day it arrived, to the bank. */
export function paymentVoucher(
  inv: BookableInvoice,
  amounts: BookedAmounts,
  paidOn: string,
  s: BookkeepingSettings,
): SieVoucher | null {
  if (inv.kind !== "INVOICE") throw new Error("vouchers: only an invoice is paid");
  const rows = rowsFor(s.bank, amounts, inv.vatProfile, s, 1n);
  return voucherOf(paidOn, voucherText("Inbetalning faktura", inv.displayNumber, inv.clientName), rows);
}

/** A booked voucher reversed on another day — every row negated (a payment marked as unpaid after its file). */
export function reversalOf(booked: SieVoucher, on: string, displayNumber: string, clientName: string): SieVoucher {
  return {
    date: on,
    text: voucherText("Återförd inbetalning", displayNumber, clientName),
    rows: booked.rows.map((r) => ({ account: r.account, amount: -r.amount })),
  };
}

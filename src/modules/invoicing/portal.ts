import { AuthzError, deny } from "@/authz/errors";
import { localDateString } from "@/lib/duration";
import { authorizePortal, withPortalRead, type PortalPrincipal } from "@/portal";

import { readFixed } from "./money";

/**
 * THE INVOICING MODULE'S PORTAL PROJECTION — a client's invoices and credit
 * notes, as the client reads them (Phase 4 slice 109; founder decision C79
 * (b)). Reads only, under the contact principal, allow-listed; both tripwire
 * tiers scan this file (`src/authz/portal-projections.test.ts`).
 *
 * WHICH: every invoice and credit note of the contact's own client that has
 * been ISSUED and SENT — emailed, or marked as sent (C79 (b)) — EACH ON ITS
 * OWN SEND (a credit note appears once it is sent, like an invoice). Shown
 * even when its project's portal is switched off: the client already has it.
 * `invoice`'s `portal_gate` holds exactly that (client, not a draft, sent),
 * and `portal_invoice_primary` holds it to a MAIN contact (AUTHZ §8: no
 * money for a client's collaborators) — the projection restates the terms
 * and asks `portal.invoice.view`, PRIMARY ONLY, as well.
 *
 * WHAT A CLIENT IS TOLD: the number, the kind, the dates, the currency, the
 * amount AS PRINTED (a credit note's with its minus sign — C77 (a)), where it
 * stands (to pay, overdue, paid, credited), what a credit note credits by
 * number, and — on one invoice — its credit notes and what is left to pay.
 * NEVER: the agency's note on a payment, who issued or sent it, the project
 * (a project whose portal is off must not be named — the design review's
 * nit), the lines (class A: the PDF is the client's copy). The bank details,
 * the Pay now link and the PDF come from the brokers (`portal-writes.ts`).
 *
 * "Overdue" is today in the zone the page passes (the portal's own — a
 * contact has none, and the workspace's preference is not theirs to read).
 */

export type PortalInvoiceState = "TO_PAY" | "OVERDUE" | "PAID" | "CREDITED" | "CREDIT_NOTE";

export type PortalInvoice = {
  readonly id: string;
  readonly kind: "INVOICE" | "CREDIT_NOTE";
  readonly displayNumber: string;
  /** `YYYY-MM-DD`. */
  readonly issueDate: string;
  /** An invoice's; null on a credit note (it asks no one to pay). */
  readonly dueDate: string | null;
  readonly currency: string;
  /** Hundredths, AS PRINTED: a credit note's is negative. */
  readonly amount: bigint;
  readonly state: PortalInvoiceState;
  /** A credit note: the invoice it credits, by number (and its id when the client has it). */
  readonly credits: { readonly displayNumber: string; readonly id: string | null } | null;
};

export type PortalInvoiceDetail = PortalInvoice & {
  /** An invoice: its credit notes the client has (sent ones), newest first. */
  readonly creditNotes: readonly PortalInvoice[];
  /** An invoice with credit notes the client has, still to pay: what is left, VAT included. */
  readonly leftToPay: bigint | null;
};

/** The most one read returns; one past it says there were more. */
export const PORTAL_INVOICE_LIMIT = 200;

const day = (d: Date): string => d.toISOString().slice(0, 10);


type Row = {
  id: string;
  kind: "INVOICE" | "CREDIT_NOTE";
  status: string;
  displayNumber: string | null;
  issueDate: Date | null;
  dueDate: Date | null;
  currency: string;
  total: { toFixed(dp: number): string } | null;
  creditsInvoiceId: string | null;
  creditsDisplayNumber: string | null;
};

function shape(row: Row, today: string, visible: ReadonlySet<string>): PortalInvoice | null {
  // An issued row always has these (the guard and its CHECKs); one without is not shown.
  if (row.displayNumber === null || row.issueDate === null || row.total === null) return null;
  const credit = row.kind === "CREDIT_NOTE";
  const total = readFixed(row.total, 2);
  const dueDate = credit || row.dueDate === null ? null : day(row.dueDate);
  const state: PortalInvoiceState = credit
    ? "CREDIT_NOTE"
    : row.status === "PAID"
      ? "PAID"
      : row.status === "CREDITED"
        ? "CREDITED"
        : dueDate !== null && dueDate < today
          ? "OVERDUE"
          : "TO_PAY";
  return {
    id: row.id,
    kind: row.kind,
    displayNumber: row.displayNumber,
    issueDate: day(row.issueDate),
    dueDate,
    currency: row.currency,
    // The one sign rule (`print.ts`'s `signed`, C77 (a)): a credit note prints negative.
    amount: credit ? -total : total,
    state,
    credits:
      credit && row.creditsDisplayNumber !== null
        ? { displayNumber: row.creditsDisplayNumber, id: row.creditsInvoiceId !== null && visible.has(row.creditsInvoiceId) ? row.creditsInvoiceId : null }
        : null,
  };
}

/** The contact's own client's sent invoices and credit notes, newest first. */
export async function listPortalInvoices(
  principal: PortalPrincipal,
  clock: { readonly timeZone: string; readonly now?: Date },
): Promise<{ readonly invoices: readonly PortalInvoice[]; readonly truncated: boolean }> {
  return withPortalRead(principal, async (tx) => {
    await authorizePortal(tx, principal, "portal.invoice.view", { kind: "client", clientId: principal.clientId });
    const rows = await tx.invoice.findMany({
      where: { tenantId: principal.tenantId, clientId: principal.clientId, status: { not: "DRAFT" }, sentAt: { not: null } },
      orderBy: [{ issueDate: "desc" }, { number: "desc" }, { id: "desc" }],
      take: PORTAL_INVOICE_LIMIT + 1,
      select: {
        id: true,
        kind: true,
        status: true,
        displayNumber: true,
        issueDate: true,
        dueDate: true,
        currency: true,
        total: true,
        creditsInvoiceId: true,
        creditsDisplayNumber: true,
      },
    });
    const truncated = rows.length > PORTAL_INVOICE_LIMIT;
    rows.splice(PORTAL_INVOICE_LIMIT);
    const today = localDateString(clock.now ?? new Date(), clock.timeZone);
    const visible = new Set(rows.map((r) => r.id));
    return { invoices: rows.flatMap((r) => shape(r, today, visible) ?? []), truncated };
  });
}

/** Whether the contact has any invoice to see — the portal's nav entry (as Logins). */
export async function portalInvoicesShown(principal: PortalPrincipal): Promise<boolean> {
  return withPortalRead(principal, async (tx) => {
    try {
      await authorizePortal(tx, principal, "portal.invoice.view");
    } catch (e) {
      if (e instanceof AuthzError) return false;
      throw e;
    }
    const count = await tx.invoice.count({
      where: { tenantId: principal.tenantId, clientId: principal.clientId, status: { not: "DRAFT" }, sentAt: { not: null } },
    });
    return count > 0;
  });
}

/** One sent invoice or credit note — and, an invoice, the credit notes the client has. */
export async function readPortalInvoice(
  principal: PortalPrincipal,
  invoiceId: string,
  clock: { readonly timeZone: string; readonly now?: Date },
): Promise<PortalInvoiceDetail> {
  return withPortalRead(principal, async (tx) => {
    await authorizePortal(tx, principal, "portal.invoice.view", { kind: "invoice", invoiceId });
    const gate = { tenantId: principal.tenantId, clientId: principal.clientId, status: { not: "DRAFT" as const }, sentAt: { not: null } };
    const row = await tx.invoice.findFirst({ where: { id: invoiceId, ...gate }, select: {
        id: true,
        kind: true,
        status: true,
        displayNumber: true,
        issueDate: true,
        dueDate: true,
        currency: true,
        total: true,
        creditsInvoiceId: true,
        creditsDisplayNumber: true,
      } });
    const today = localDateString(clock.now ?? new Date(), clock.timeZone);
    const original =
      row?.kind === "CREDIT_NOTE" && row.creditsInvoiceId
        ? await tx.invoice.findFirst({ where: { id: row.creditsInvoiceId, ...gate }, select: { id: true } })
        : null;
    const shaped = row ? shape(row, today, new Set(original ? [original.id] : [])) : null;
    // Gone between the proof and this read (or malformed): the plane's one answer.
    if (!row || !shaped) return deny("NOT_FOUND", "invoice");
    if (row.kind !== "INVOICE") return { ...shaped, creditNotes: [], leftToPay: null };
    const notes = await tx.invoice.findMany({
      where: { kind: "CREDIT_NOTE", creditsInvoiceId: row.id, ...gate },
      orderBy: [{ issueDate: "desc" }, { number: "desc" }, { id: "desc" }],
      take: 50,
      select: {
        id: true,
        kind: true,
        status: true,
        displayNumber: true,
        issueDate: true,
        dueDate: true,
        currency: true,
        total: true,
        creditsInvoiceId: true,
        creditsDisplayNumber: true,
      },
    });
    const visible = new Set([row.id]);
    const creditNotes = notes.flatMap((n) => shape(n, today, visible) ?? []);
    // What is left, from the credit notes' own TOTALS (the design review's L4 —
    // the lines are class A and read as nothing here), only while it is to pay.
    const open = shaped.state === "TO_PAY" || shaped.state === "OVERDUE";
    const leftToPay = open && creditNotes.length > 0 ? creditNotes.reduce((left, n) => left + n.amount, shaped.amount) : null;
    return { ...shaped, creditNotes, leftToPay };
  });
}

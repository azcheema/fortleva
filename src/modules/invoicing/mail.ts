import { createTranslator } from "next-intl";

import en from "@/messages/en.json";
import sv from "@/messages/sv.json";

import { printAmount, signed, type InvoiceLocale, type InvoicePrint, type PaymentPrint } from "./print";

/**
 * THE EMAIL AN INVOICE IS SENT WITH (Phase 4 slice 109; founder decision C79
 * (a), (c), (e)) — pure: the frozen record in, a subject and a plain-text body
 * out, in the INVOICE'S language (the client's — C76 (e)), never the sender's.
 *
 * WHAT IT SAYS. Who sends it (the seller's legal name as the invoice prints it
 * — never the workspace's display name), the number, that the PDF is attached;
 * an invoice's amount to pay and due date, its Pay now link when it has one,
 * and — always (C79 (c)) — the bank details with the invoice number as the
 * reference, as the PDF prints them; a credit note's amount with its minus
 * sign (C77 (a), `signed`), what it credits and why. Then the client portal's
 * address, for those who have an account there, and — when the workspace has a
 * reply address — that a reply reaches it.
 *
 * WHAT IT NEVER SAYS: anything the PDF does not. It is a covering letter for
 * the archived document, and both are read by the client's accounts people.
 */

const MESSAGES = { en, sv } as const;

const translatorFor = (locale: InvoiceLocale) => createTranslator({ locale, messages: MESSAGES[locale], namespace: "invoiceMail" });
const pdfTranslatorFor = (locale: InvoiceLocale) => createTranslator({ locale, messages: MESSAGES[locale], namespace: "invoicePdf" });

/**
 * What an INVOICE is now, at the send (the design review's M1): a Send again
 * of one that was paid, credited or partly credited must not ask for its
 * printed total, nor offer a fixed-amount link for it.
 */
export type InvoiceMailState =
  | { readonly kind: "open" }
  /** Some of it credited: what is left, VAT included, from the credit notes' totals. */
  | { readonly kind: "partly"; readonly left: bigint }
  | { readonly kind: "paid" }
  | { readonly kind: "credited" };

export type InvoiceMailOptions = {
  /** The Pay now link — an invoice's; shown only while the state is "open". */
  readonly payLink: string | null;
  /** An invoice's state now; a credit note's is ignored. */
  readonly state: InvoiceMailState;
  /** The invoice's own page in the client's portal — null while the portal (or invoicing in it) is closed. */
  readonly portalUrl: string | null;
  /** A reply reaches the workspace (it has a reply address). */
  readonly replyable: boolean;
};

const paymentLines = (payment: PaymentPrint, locale: InvoiceLocale): string[] => {
  const p = pdfTranslatorFor(locale);
  const lines: string[] = [];
  if (payment.bankgiro) lines.push(`${p("bankgiro")}: ${payment.bankgiro}`);
  if (payment.plusgiro) lines.push(`${p("plusgiro")}: ${payment.plusgiro}`);
  if (payment.iban) lines.push(`${p("iban")}: ${payment.iban}`);
  if (payment.bic) lines.push(`${p("bic")}: ${payment.bic}`);
  return lines;
};

export function renderInvoiceMail(print: InvoicePrint, opts: InvoiceMailOptions): { subject: string; text: string } {
  const t = translatorFor(print.locale);
  const p = pdfTranslatorFor(print.locale);
  const credit = print.kind === "CREDIT_NOTE";
  // A header line: no line break may ride in (the design review's nit).
  const seller = print.seller.legalName.replace(/[\r\n]+/g, " ").trim();
  const amount = `${printAmount(signed(print.totals.total, print.kind), print.locale)} ${print.currency}`;
  const subject = t("subject", { kind: p(`kind.${print.kind}`), number: print.displayNumber, seller });

  const blocks: string[][] = [];
  blocks.push([credit ? t("introCredit", { seller, number: print.displayNumber }) : t("intro", { seller, number: print.displayNumber })]);
  if (credit && print.credits) {
    blocks.push([
      t("credits", { number: print.credits.displayNumber, date: print.credits.issueDate }),
      t("creditAmount", { amount }),
      ...(print.creditReason ? [t("reason", { reason: print.creditReason })] : []),
    ]);
  } else if (opts.state.kind === "paid") {
    blocks.push([t("paid", { amount })]);
  } else if (opts.state.kind === "credited") {
    blocks.push([t("credited")]);
  } else {
    // Open, or partly credited: what is left to pay — and a fixed-amount link
    // only while nothing has been taken off the printed total.
    const open = opts.state.kind === "open";
    const due = open ? amount : `${printAmount(opts.state.left, print.locale)} ${print.currency}`;
    blocks.push([open ? t("amount", { amount: due }) : t("leftToPay", { amount: due, total: amount }), t("dueDate", { date: print.dueDate })]);
    const payLink = open ? opts.payLink : null;
    if (payLink) blocks.push([t("payOnline"), payLink]);
    const bank = paymentLines(print.payment, print.locale);
    if (bank.length > 0) {
      blocks.push([payLink ? t("orBank") : t("bank"), ...bank, p("paymentReference", { number: print.displayNumber })]);
    }
  }
  if (opts.portalUrl) blocks.push([t("portal"), opts.portalUrl]);
  if (opts.replyable) blocks.push([t("reply")]);
  return { subject, text: blocks.map((b) => b.join("\n")).join("\n\n") };
}

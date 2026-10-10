import { describe, expect, it } from "vitest";

import { renderInvoiceMail } from "./mail";
import { invoiceTotals } from "./money";
import { printAmount, type InvoicePrint } from "./print";

/**
 * THE EMAIL AN INVOICE IS SENT WITH (Phase 4 slice 109; C79 (a), (c)): its
 * words in the invoice's language, the amounts as the PDF prints them, a
 * credit note's with its minus sign, the bank details always, the pay link
 * when there is one — and nothing the PDF does not say.
 */

const lines = [
  {
    id: "00000000-0000-7000-8000-000000000001",
    position: 1,
    description: "Design work",
    quantity: 10_000n,
    unit: "h",
    unitPrice: 100_000n,
    vatRate: 2_500n,
    amount: 1_000_000n,
  },
];

function invoice(overrides: Partial<InvoicePrint> = {}): InvoicePrint {
  return {
    kind: "INVOICE",
    credits: null,
    creditReason: null,
    locale: "sv",
    displayNumber: "10001",
    issueDate: "2026-10-09",
    dueDate: "2026-11-08",
    paymentTermsDays: 30,
    periodStart: null,
    periodEnd: null,
    buyerReference: "PO-77",
    ourReference: "Ada Lovelace",
    note: "An internal-looking note that the PDF prints",
    vatProfile: "SE_DOMESTIC",
    currency: "SEK",
    lines,
    totals: invoiceTotals(lines.map((l) => ({ amount: l.amount, rate: l.vatRate }))),
    sekVat: null,
    seller: {
      legalName: "Naxdor Test AB",
      orgNr: "556677-8899",
      vatNumber: "SE556677889901",
      seat: "Stockholm",
      fSkattApproved: true,
      addressLine1: "Storgatan 1",
      addressLine2: null,
      postalCode: "111 22",
      city: "Stockholm",
      countryCode: "SE",
      footerNote: null,
    },
    buyer: {
      name: "Kund AB",
      orgNr: null,
      vatNumber: null,
      addressLine1: "Gatan 2",
      addressLine2: null,
      postalCode: "222 33",
      city: "Malmö",
      countryCode: "SE",
    },
    payment: { bankgiro: "123-4567", plusgiro: null, iban: "SE45 5000 0000 0583 9825 7466", bic: "ESSESESS" },
    hoursPage: null,
    ...overrides,
  };
}

const opts = { payLink: null, state: { kind: "open" } as const, portalUrl: "https://os.example.test/portal", replyable: false };

describe("renderInvoiceMail — an invoice", () => {
  it("in Swedish: who sends it, the amount to pay and due date, the bank details with the reference, the portal", () => {
    const mail = renderInvoiceMail(invoice(), opts);
    expect(mail.subject).toBe("Faktura 10001 från Naxdor Test AB");
    expect(mail.text).toContain("Här kommer faktura 10001 från Naxdor Test AB.");
    // 10 000,00 + 25 % VAT, in the PDF's own formatting.
    expect(mail.text).toContain(`Att betala: ${printAmount(1_250_000n, "sv")} SEK`);
    expect(mail.text).toContain("Förfallodatum: 2026-11-08");
    expect(mail.text).toContain("Betalningsuppgifter:\nBankgiro: 123-4567\nIBAN: SE45 5000 0000 0583 9825 7466\nBIC: ESSESESS");
    expect(mail.text).toContain("Ange fakturanummer 10001 vid betalning.");
    expect(mail.text).toContain("https://os.example.test/portal");
    expect(mail.text).not.toContain("Betala online");
    expect(mail.text).not.toContain("Svara på det här mejlet");
  });

  it("in English, with the pay link first and the bank details as the other way", () => {
    const mail = renderInvoiceMail(invoice({ locale: "en" }), { ...opts, payLink: "https://buy.stripe.com/abc", replyable: true });
    expect(mail.subject).toBe("Invoice 10001 from Naxdor Test AB");
    expect(mail.text).toContain("Total to pay: 12,500.00 SEK");
    expect(mail.text).toContain("Pay online:\nhttps://buy.stripe.com/abc");
    expect(mail.text).toContain("Or pay to:\nBankgiro: 123-4567");
    expect(mail.text.indexOf("Pay online")).toBeLessThan(mail.text.indexOf("Or pay to"));
    expect(mail.text).toContain("Questions? Reply to this email.");
  });

  it("says nothing of the portal while the client's portal is closed", () => {
    const mail = renderInvoiceMail(invoice(), { ...opts, portalUrl: null });
    expect(mail.text).not.toContain("kundportalen");
  });

  it("names the seller as the invoice prints it, and nothing the PDF does not say", () => {
    const mail = renderInvoiceMail(invoice(), opts);
    // Not the note, not the references, not a line: the PDF carries those.
    expect(mail.text).not.toContain("Design work");
    expect(mail.text).not.toContain("Ada Lovelace");
  });

  it("puts no line break into the subject, whatever the seller's name holds", () => {
    const print = invoice();
    const mail = renderInvoiceMail({ ...print, seller: { ...print.seller, legalName: "Naxdor\r\nBcc: x@y.example AB" } }, opts);
    expect(mail.subject).not.toMatch(/[\r\n]/);
  });
});

describe("renderInvoiceMail — sent again, once it is no longer simply open (the design review's M1)", () => {
  const link = "https://buy.stripe.com/abc";

  it("partly credited: what is left to pay, the bank details — and no fixed-amount link", () => {
    const mail = renderInvoiceMail(invoice({ locale: "en" }), { ...opts, payLink: link, state: { kind: "partly", left: 1_000_000n } });
    expect(mail.text).toContain(`Left to pay: ${printAmount(1_000_000n, "en")} SEK (of ${printAmount(1_250_000n, "en")} SEK, after credit notes)`);
    expect(mail.text).not.toContain("Total to pay");
    expect(mail.text).not.toContain(link);
    expect(mail.text).toContain("Payment details:\nBankgiro: 123-4567");
  });

  it("paid: a copy, nothing to pay — no amount due, no link, no bank details", () => {
    const mail = renderInvoiceMail(invoice(), { ...opts, payLink: link, state: { kind: "paid" } });
    expect(mail.text).toContain("Fakturan");
    expect(mail.text).toContain("är betald");
    expect(mail.text).not.toContain("Att betala");
    expect(mail.text).not.toContain(link);
    expect(mail.text).not.toContain("Bankgiro");
  });

  it("credited in full: a copy, nothing to pay", () => {
    const mail = renderInvoiceMail(invoice({ locale: "en" }), { ...opts, payLink: link, state: { kind: "credited" } });
    expect(mail.text).toContain("credited in full");
    expect(mail.text).not.toContain("Total to pay");
    expect(mail.text).not.toContain(link);
    expect(mail.text).not.toContain("Bankgiro");
  });
});

describe("renderInvoiceMail — a credit note", () => {
  const credit = invoice({
    kind: "CREDIT_NOTE",
    displayNumber: "10002",
    credits: { displayNumber: "10001", issueDate: "2026-10-01" },
    creditReason: "Wrong hourly rate",
    paymentTermsDays: 0,
    payment: { bankgiro: null, plusgiro: null, iban: null, bic: null },
  });

  it("says what it credits, why, and its amount with a minus sign — and asks no one to pay", () => {
    const mail = renderInvoiceMail(credit, { ...opts, payLink: "https://buy.stripe.com/never" });
    expect(mail.subject).toBe("Kreditfaktura 10002 från Naxdor Test AB");
    expect(mail.text).toContain("Här kommer kreditfaktura 10002 från Naxdor Test AB.");
    expect(mail.text).toContain("Den krediterar faktura 10001 daterad 2026-10-01.");
    expect(mail.text).toContain(`Belopp: ${printAmount(-1_250_000n, "sv")} SEK`);
    expect(mail.text).toContain("Orsak: Wrong hourly rate");
    expect(mail.text).not.toContain("Att betala");
    expect(mail.text).not.toContain("Förfallodatum");
    // A credit note never carries a pay link, whatever is passed.
    expect(mail.text).not.toContain("buy.stripe.com");
  });

  it("in English", () => {
    const mail = renderInvoiceMail({ ...credit, locale: "en" }, opts);
    expect(mail.subject).toBe("Credit note 10002 from Naxdor Test AB");
    expect(mail.text).toContain("It credits invoice 10001 dated 2026-10-01.");
    expect(mail.text).toContain(`Amount: ${printAmount(-1_250_000n, "en")} SEK`);
  });
});

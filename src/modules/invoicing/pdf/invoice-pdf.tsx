// OUT OF THE REACT COMPILER: these components are rendered by react-pdf's own
// reconciler, on the React that `@react-pdf/renderer` (a server-external
// package) loads — not on the bundle's. A compiled component's memo cache
// would ask the bundle's React for a dispatcher it never set.
"use no memo";

import path from "node:path";

import { Document, Font, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import { createTranslator } from "next-intl";

import en from "@/messages/en.json";
import sv from "@/messages/sv.json";

import {
  printAddress,
  printAmount,
  printFxRate,
  printQuantity,
  printRate,
  signed,
  type InvoiceLocale,
  type InvoicePrint,
} from "../print";

/**
 * THE INVOICE'S PDF (Phase 4 slice 108; ARC-24's renderer, `@react-pdf/renderer`
 * — no browser, rendered in our own server function). A pure drawing of an
 * `InvoicePrint`: every value comes from the frozen record, every label from
 * `invoicePdf.*` in the INVOICE's language.
 *
 * What a Swedish invoice must carry (mervärdesskattelagen 2023:200 17 kap.
 * 24 §; aktiebolagslagen 28 kap. 5 §) and where it is: the date and the
 * number (the head); the seller's VAT number, name and address and org. number
 * (the head and the foot), the registered office of an aktiebolag (the foot);
 * the buyer's name and address, and VAT number where there is one (the
 * reverse charge needs it — the issue refuses without); what was sold and how
 * much (the lines); the date of supply — the work period, when the draft named
 * one; the taxable amount per rate, the unit prices, the rate and the VAT per
 * rate (the totals); on another currency carrying Swedish VAT, that VAT in SEK
 * and the rate used; the reverse-charge wording "Omvänd betalningsskyldighet" /
 * "Reverse charge", or the outside-the-scope note. Plus the commercial rest —
 * due date, terms, references, where to pay and with which reference — and
 * "Godkänd för F-skatt" when the company is.
 *
 * A CREDIT NOTE (slice 108b; C77) is the same drawing with what differs: its
 * title ("Kreditfaktura"), the invoice it credits by number and date (ML's
 * unambiguous reference) and why (C77 (b)); every quantity and amount with a
 * minus sign (C77 (a) — `signed`; unit prices and rates as stored, so each
 * line still multiplies out); no due date, terms, payment block or the
 * workspace's invoice note (it asks no one to pay, and the note may say how).
 *
 * FONTS: Inter 4.1 static Regular and SemiBold (SIL OFL 1.1, `./fonts/OFL-Inter.txt`),
 * committed in `./fonts/` from the release's `extras/ttf/`
 * (https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip; sha256
 * 40d692fc… and 78a843fa…). Not the standard Helvetica:
 * its WinAnsi encoding has no Polish, Czech or Hungarian letters, so a client
 * named "Łódź Sp. z o.o." would print wrong. Read from disk, so
 * `next.config.ts` traces the folder into the invoice routes.
 */

const FONT_DIR = path.join(process.cwd(), "src", "modules", "invoicing", "pdf", "fonts");
let fontsRegistered = false;

function registerFonts(): void {
  if (fontsRegistered) return;
  Font.register({
    family: "Inter",
    fonts: [
      { src: path.join(FONT_DIR, "Inter-Regular.ttf"), fontWeight: 400 },
      { src: path.join(FONT_DIR, "Inter-SemiBold.ttf"), fontWeight: 600 },
    ],
  });
  // Never hyphenate: an org. number, an IBAN or a company name split with a
  // hyphen would print a different value.
  Font.registerHyphenationCallback((word) => [word]);
  fontsRegistered = true;
}

/** A printed page has no theme: these are the PDF's own inks, not the app's tokens. */
const INK = { text: "#1a1a1a", muted: "#5f5f5f", rule: "#d4d4d4", band: "#f4f4f4" } as const;

const s = StyleSheet.create({
  page: { fontFamily: "Inter", fontSize: 9, color: INK.text, paddingTop: 40, paddingBottom: 90, paddingHorizontal: 44, lineHeight: 1.35 },
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24 },
  // A line height of its own on every size above the page's: an inherited
  // one is the page's in points, and a 15-point line on a 12-point pitch
  // runs into the line below it.
  seller: { fontSize: 15, lineHeight: 1.25, fontWeight: 600, maxWidth: 280, marginBottom: 2 },
  kind: { fontSize: 18, lineHeight: 1.2, fontWeight: 600, textAlign: "right" },
  kindNumber: { fontSize: 11, lineHeight: 1.3, textAlign: "right", color: INK.muted, marginTop: 2 },
  parties: { flexDirection: "row", justifyContent: "space-between", marginBottom: 20 },
  buyer: { width: 250 },
  label: { fontSize: 7.5, color: INK.muted, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 3 },
  strong: { fontWeight: 600 },
  meta: { width: 220 },
  metaRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 2 },
  metaLabel: { color: INK.muted, marginRight: 8 },
  caption: { fontSize: 7.5, color: INK.muted, marginBottom: 4 },
  tableHead: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: INK.rule, paddingBottom: 4, marginBottom: 2 },
  row: { flexDirection: "row", paddingVertical: 4, borderBottomWidth: 0.5, borderBottomColor: INK.rule },
  th: { fontSize: 7.5, color: INK.muted, textTransform: "uppercase", letterSpacing: 0.4 },
  cDesc: { flexGrow: 1, flexShrink: 1, flexBasis: 0, paddingRight: 8 },
  cQty: { width: 48, textAlign: "right" },
  cUnit: { width: 38, paddingLeft: 6 },
  cPrice: { width: 72, textAlign: "right" },
  cVat: { width: 38, textAlign: "right" },
  cAmount: { width: 80, textAlign: "right" },
  totals: { alignSelf: "flex-end", width: 250, marginTop: 10 },
  totalRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 2 },
  grand: { flexDirection: "row", justifyContent: "space-between", borderTopWidth: 1, borderTopColor: INK.text, marginTop: 4, paddingTop: 4, fontSize: 11, lineHeight: 1.3, fontWeight: 600 },
  box: { marginTop: 14, padding: 8, backgroundColor: INK.band },
  section: { marginTop: 14 },
  payment: { marginTop: 14, width: 280 },
  foot: { position: "absolute", bottom: 28, left: 44, right: 44, borderTopWidth: 0.5, borderTopColor: INK.rule, paddingTop: 6, fontSize: 7.5, lineHeight: 1.4, color: INK.muted },
});

const MESSAGES = { en, sv } as const;

function translatorFor(locale: InvoiceLocale) {
  return createTranslator({ locale, messages: MESSAGES[locale], namespace: "invoicePdf" });
}

function MetaRow({ label, value }: { readonly label: string; readonly value: string | null }) {
  if (!value) return null;
  return (
    <View style={s.metaRow}>
      <Text style={s.metaLabel}>{label}</Text>
      <Text>{value}</Text>
    </View>
  );
}

function TotalRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <View style={s.totalRow}>
      <Text style={{ color: INK.muted }}>{label}</Text>
      <Text>{value}</Text>
    </View>
  );
}

/** The document, for `renderInvoicePdf` and the unit test. */
export function InvoicePdf({ invoice }: { readonly invoice: InvoicePrint }) {
  const t = translatorFor(invoice.locale);
  const loc = invoice.locale;
  const credit = invoice.kind === "CREDIT_NOTE";
  // Every amount and quantity through the one sign rule (`print.ts`).
  const money = (minor: bigint) => printAmount(signed(minor, invoice.kind), loc);
  const kind = t(`kind.${invoice.kind}`);
  const seller = invoice.seller;
  const buyer = invoice.buyer;
  const domestic = invoice.vatProfile === "SE_DOMESTIC";
  const buyerLines = printAddress(buyer, loc, seller.countryCode);
  const sellerLines = printAddress(seller, loc, buyer.countryCode);
  const pay = invoice.payment;
  const footParts = [
    seller.legalName,
    t("orgNr", { value: seller.orgNr }),
    t("vatNumber", { value: seller.vatNumber }),
    seller.seat ? t("seat", { seat: seller.seat }) : null,
    seller.fSkattApproved ? t("fSkatt") : null,
  ].filter((p): p is string => Boolean(p));

  return (
    <Document
      title={t("documentTitle", { kind, number: invoice.displayNumber })}
      author={seller.legalName}
      language={loc === "sv" ? "sv-SE" : "en-GB"}
    >
      <Page size="A4" style={s.page}>
        <View style={s.head}>
          <View>
            <Text style={s.seller}>{seller.legalName}</Text>
            {sellerLines.map((line, i) => (
              <Text key={i} style={{ color: INK.muted }}>
                {line}
              </Text>
            ))}
          </View>
          <View>
            <Text style={s.kind}>{kind}</Text>
            <Text style={s.kindNumber}>{invoice.displayNumber}</Text>
          </View>
        </View>

        <View style={s.parties}>
          <View style={s.buyer}>
            <Text style={s.label}>{t("billedTo")}</Text>
            <Text style={s.strong}>{buyer.name}</Text>
            {buyerLines.map((line, i) => (
              <Text key={i}>{line}</Text>
            ))}
            {buyer.orgNr ? <Text>{t("orgNr", { value: buyer.orgNr })}</Text> : null}
            {buyer.vatNumber ? <Text>{t("vatNumber", { value: buyer.vatNumber })}</Text> : null}
          </View>
          <View style={s.meta}>
            <MetaRow label={credit ? t("credit.number") : t("number")} value={invoice.displayNumber} />
            <MetaRow label={credit ? t("credit.issueDate") : t("issueDate")} value={invoice.issueDate} />
            {credit ? null : <MetaRow label={t("dueDate")} value={invoice.dueDate} />}
            {credit ? null : (
              <MetaRow
                label={t("terms")}
                value={invoice.paymentTermsDays === 0 ? t("termsNow") : t("termsDays", { days: invoice.paymentTermsDays })}
              />
            )}
            <MetaRow label={t("ourReference")} value={invoice.ourReference} />
            <MetaRow label={t("yourReference")} value={invoice.buyerReference} />
            <MetaRow
              label={t("period")}
              value={
                invoice.periodStart && invoice.periodEnd
                  ? t("periodRange", { start: invoice.periodStart, end: invoice.periodEnd })
                  : invoice.periodStart
                    ? t("periodFrom", { start: invoice.periodStart })
                    : invoice.periodEnd
                      ? t("periodUntil", { end: invoice.periodEnd })
                      : null
              }
            />
          </View>
        </View>

        {invoice.credits ? (
          <View style={[s.box, { marginTop: 0, marginBottom: 14 }]} wrap={false}>
            <Text style={s.strong}>
              {t("credit.credits", { number: invoice.credits.displayNumber, date: invoice.credits.issueDate })}
            </Text>
            {invoice.creditReason ? <Text>{t("credit.reason", { reason: invoice.creditReason })}</Text> : null}
          </View>
        ) : null}

        <Text style={s.caption}>{t("amountsIn", { currency: invoice.currency })}</Text>
        <View style={s.tableHead}>
          <Text style={[s.th, s.cDesc]}>{t("lines.description")}</Text>
          <Text style={[s.th, s.cQty]}>{t("lines.quantity")}</Text>
          <Text style={[s.th, s.cUnit]}>{t("lines.unit")}</Text>
          <Text style={[s.th, s.cPrice]}>{t("lines.unitPrice")}</Text>
          {domestic ? <Text style={[s.th, s.cVat]}>{t("lines.vat")}</Text> : null}
          <Text style={[s.th, s.cAmount]}>{t("lines.amount")}</Text>
        </View>
        {invoice.lines.map((line) => (
          <View key={line.id} style={s.row} wrap={false}>
            <Text style={s.cDesc}>{line.description}</Text>
            <Text style={s.cQty}>{printQuantity(signed(line.quantity, invoice.kind), loc)}</Text>
            <Text style={s.cUnit}>{line.unit ?? ""}</Text>
            <Text style={s.cPrice}>{printAmount(line.unitPrice, loc)}</Text>
            {domestic ? <Text style={s.cVat}>{t("vatRate", { rate: printRate(line.vatRate, loc) })}</Text> : null}
            <Text style={s.cAmount}>{money(line.amount)}</Text>
          </View>
        ))}

        <View style={s.totals} wrap={false}>
          <TotalRow label={t("subtotal")} value={money(invoice.totals.subtotal)} />
          {domestic ? (
            invoice.totals.groups.map((g) => (
              <TotalRow
                key={String(g.rate)}
                label={t("vatAt", { rate: printRate(g.rate, loc), base: money(g.net) })}
                value={money(g.vat)}
              />
            ))
          ) : (
            <TotalRow label={t("noVat")} value={money(0n)} />
          )}
          <View style={s.grand}>
            <Text>{t("total")}</Text>
            <Text>{`${money(invoice.totals.total)} ${invoice.currency}`}</Text>
          </View>
        </View>

        {invoice.sekVat ? (
          <View style={[s.totals, { marginTop: 12 }]} wrap={false}>
            <Text style={s.label}>{t("sekTitle")}</Text>
            {invoice.sekVat.groups.map((g) => (
              <TotalRow key={String(g.rate)} label={t("sekAt", { rate: printRate(g.rate, loc) })} value={`${money(g.vatSek)} SEK`} />
            ))}
            {invoice.sekVat.groups.length > 1 ? (
              <TotalRow label={t("sekTotal")} value={`${money(invoice.sekVat.totalSek)} SEK`} />
            ) : null}
            <Text style={s.caption}>
              {t("sekRate", { currency: invoice.currency, rate: printFxRate(invoice.sekVat.micros, loc), date: invoice.sekVat.date })}
            </Text>
          </View>
        ) : null}

        {invoice.vatProfile === "EU_REVERSE_CHARGE" ? (
          <View style={s.box} wrap={false}>
            <Text style={s.strong}>{t("reverseCharge")}</Text>
            <Text>{t("reverseChargeBody")}</Text>
          </View>
        ) : invoice.vatProfile === "OUTSIDE_SCOPE" ? (
          <View style={s.box} wrap={false}>
            <Text style={s.strong}>{t("outsideScope")}</Text>
            <Text>{t("outsideScopeBody")}</Text>
          </View>
        ) : null}

        {invoice.note ? (
          <View style={s.section} wrap={false}>
            <Text>{invoice.note}</Text>
          </View>
        ) : null}

        {credit ? null : (
          <View style={s.payment} wrap={false}>
            <Text style={s.label}>{t("paymentTitle")}</Text>
            <MetaRow label={t("bankgiro")} value={pay.bankgiro} />
            <MetaRow label={t("plusgiro")} value={pay.plusgiro} />
            <MetaRow label={t("iban")} value={pay.iban} />
            <MetaRow label={t("bic")} value={pay.bic} />
            <MetaRow label={t("dueDate")} value={invoice.dueDate} />
            <Text style={{ marginTop: 4 }}>{t("paymentReference", { number: invoice.displayNumber })}</Text>
          </View>
        )}

        {/* The workspace's note in the FLOW, after the payment block — not in
            the fixed footer, whose height the page reserves (the code review's
            low: a 500-character note there overprinted the content above). */}
        {seller.footerNote && !credit ? (
          <View style={s.section} wrap={false}>
            <Text style={{ color: INK.muted }}>{seller.footerNote}</Text>
          </View>
        ) : null}

        {/* ONE line on every page: who issued it — legal name, org. and VAT
            numbers, registered office, F-tax. The address is the head's, on
            the first page (the fix-pass re-check's low: with it, the longest
            allowed details wrapped past the room the page keeps). At the
            longest (a 200-character name, a 100-character office) this wraps
            to three lines: 28 + 6 + 3 × 10.5 = 65.5pt, inside the 90pt
            `paddingBottom`. */}
        <View style={s.foot} fixed>
          <Text>{footParts.join(" · ")}</Text>
        </View>
      </Page>
    </Document>
  );
}

/** The PDF's bytes. */
export async function renderInvoicePdf(invoice: InvoicePrint): Promise<Uint8Array> {
  registerFonts();
  const buffer = await renderToBuffer(<InvoicePdf invoice={invoice} />);
  return new Uint8Array(buffer);
}

/** The file name a download is offered under — in the invoice's language, "kreditfaktura-…" for a credit note. */
export function invoicePdfFileName(invoice: Pick<InvoicePrint, "locale" | "displayNumber" | "kind">): string {
  const t = translatorFor(invoice.locale);
  return invoice.kind === "CREDIT_NOTE" ? t("credit.fileName", { number: invoice.displayNumber }) : t("fileName", { number: invoice.displayNumber });
}

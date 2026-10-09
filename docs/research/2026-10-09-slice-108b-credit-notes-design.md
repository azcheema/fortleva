> **DRAFT, 2026-10-09 — NOT YET DESIGN-REVIEWED.** Written at the end of the slice-108 session, after the founder answered C77; the founder chose to build slice 108b in a FRESH session. The next session: read it, put it to a fresh-agent design review (its §5 holds the open questions), then build. The decisions it cites (C76, C77) are settled; everything else here is a proposal.

# Slice 108b — CREDIT NOTES (Phase 4 step 2, its second half; founder decisions C76 (c), (f) and C77)

Decided (docs/OPEN_QUESTIONS.md C76, C77 — settled, do not re-litigate):
- A credit note takes the NEXT number of the workspace's ONE series (C76 (c)).
- It may credit the WHOLE invoice or PART of it; the invoice reads Credited only once credit notes cover all of it (C76 (f)).
- Its amounts PRINT with a minus sign ("Att betala: −1 250,00") (C77 (a)); storage is the build's choice.
- It must say WHY — a short reason, printed and kept (C77 (b)).
- Crediting offers "Credit and make a corrected copy": the whole invoice credited and a new draft opened with the same lines (C77 (c)).
- Crediting takes `invoice:credit` AND `invoice:issue` (both CA — owners and admins); a credit note is written as a DRAFT and issued like an invoice (slice 107's notes).

Read first: slice 108's migration `prisma/migrations/20261009200000_invoice_issuing/migration.sql` (`invoice_guard` as it stands), `src/modules/invoicing/{drafts,issue,issue-check,issued,pdf-store,print}.ts`, `pdf/invoice-pdf.tsx`.

## 1. Storage: POSITIVE amounts, the kind says "credit"

A credit note's lines, quantities and totals are stored POSITIVE (EN 16931 / Peppol credit note, type 381 — the v2 Peppol adapter maps 1:1); `kind = CREDIT_NOTE` and `credits_invoice_id` say it is a credit. Every existing rule holds — the CHECK `invoice_line_quantity_positive` (quantity > 0) and `invoice_guard`'s totals = lines and total ≥ 0. The PRINT (PDF and page) negates the amounts (C77 (a)); the Fortnox file (step 5) negates on export. One sign rule in one place: `print.ts`.

## 2. Migration `20261010090000_credit_notes` (DDL only)

- `invoice.credit_reason text` — CHECK 1..500 chars, non-blank when set; NULL on an INVOICE; may be NULL on a credit-note DRAFT; NOT NULL on an issued credit note (CHECK).
- `invoice_guard` replaced (CREATE OR REPLACE), everything 108 holds kept. Changes:
  - **INSERT** of a `CREDIT_NOTE` draft: a member as themselves holding `invoice:credit` (and `invoice:issue`, so a credit draft is only ever made by someone who could finish it); `credits_invoice_id` names an ISSUED-or-later **INVOICE** (never a credit note, never a draft, never CREDITED) — the composite FK already binds the same tenant AND client; its `vat_profile`, `currency` and `locale` equal the original's.
  - **Draft edit** of a credit note: as a draft (a member), plus `vat_profile`, `currency`, `locale` stay the original's (so the issue cannot be steered onto other rates or another currency); the reason editable.
  - **Leaving DRAFT** for a credit note — what differs from an invoice:
    1. `invoice:credit` AND `invoice:issue`.
    2. The ORIGINAL locked `FOR UPDATE` (lock order when ISSUING a credit note: the credit note — locked by `lockDraft` — then the original, then the series; `createCreditDraft` / `creditInFull` take the original first, harmlessly — their credit note is a new row, not yet anyone else's to lock) and re-checked: still an issued INVOICE, not CREDITED.
    3. **Per VAT rate, never more than is left:** for each rate on the credit note, its net + the nets at that rate of the original's already-ISSUED credit notes ≤ the original's net at that rate (a rate the original does not have is refused). Totals follow from nets (VAT per rate on each document) — the öre a partial credit's rounding can add is bounded by the per-rate NET rule, which is exact.
    4. The snapshots COPIED from the original (`seller_snapshot`, `payment_snapshot`, `buyer_snapshot`) — the credit note corrects THAT document, so it names the parties as it did, whatever the tenant or client is called now; no live completeness checks (the original passed them).
    5. `credit_reason` NOT NULL.
    6. VAT in SEK: the ORIGINAL's `fx_rate_to_sek` and `fx_rate_date` (the VAT being reversed was stated at that rate) — required equal when the trio is set; `vat_total_sek` recomputed as for an invoice. No fetch.
    7. `payment_terms_days = 0` → `due_date = issue_date` (a credit note asks no one to pay).
    8. The number: the same series, the same last step.
  - **Issued INVOICE → CREDITED:** only when, for EVERY rate of the original, the issued credit notes' nets equal its net (fully covered). Moving there stays a member holding `invoice:credit` (108's rule). PARTLY credited is NOT a status: the original stays ISSUED/SENT/PAID and the page derives "partly credited" from its credit notes.
  - A credit note itself never moves to SENT/PAID/CREDITED in this slice (109 decides whether a credit note is "sent").

## 3. App

- `src/modules/invoicing/credit.ts`:
  - `createCreditDraft(ctx, invoiceId, { reason })` — `invoice:view` + `invoice:credit` + `invoice:issue`, DIRECT scope; the original locked; a new CREDIT_NOTE draft copying the original's client, project, currency, VAT treatment, locale, references, period, and EVERY original line in full — per-line remainders are not tracked; the member lowers or removes lines, and the issue's per-rate rule refuses over-crediting (a draft opened after an earlier partial credit says how much is left per rate). `payment_terms_days = 0`. Audit `invoice.created` {kind: CREDIT_NOTE, creditsInvoiceId}.
  - `creditInFull(ctx, invoiceId, { reason, correctedCopy })` — one transaction: a credit draft with every line, issued at once (the same `issueInvoice` path), the original → CREDITED when that covers it; if `correctedCopy`, a new INVOICE draft with the original's details and lines (not its number, dates or snapshots — it reads live again as every draft does). Returns the credit note's number and, with the copy, the new draft's id. Refused when the original already has an issued credit note (then "whole" is not whole — the member makes a part credit for what is left).
  - Every draft verb on a credit-note draft additionally needs `invoice:credit`; the VAT treatment and currency controls are hidden (fixed to the original's); the reason is a draft field.
  - Issuing a credit-note draft: `issueInvoice` gains the credit-note branch (reason required, the original's rate, no fetch, the per-rate check first in the app as a blocker "overCredit"/"noReason"), then the original → CREDITED in the SAME transaction when covered (audit `invoice.credited` on the original).
  - The fingerprint (slice 108) covers the reason too.
- `print.ts` / `invoice-pdf.tsx`: CREDIT_NOTE → title "Kreditfaktura"/"Credit note", every AMOUNT negated (line amounts, subtotal, VAT per rate, total, SEK VAT; quantities and unit prices as stored), a line "Krediterar faktura 10001 av 2026-10-09" / "Credits invoice 10001 of 2026-10-09" (ML's unambiguous reference to the original), the reason, NO payment block, no due date.
- Pages: the issued invoice shows its credit notes (number, date, amount, link) and "Partly credited" / "Credited", and **Credit…** (when the member may and something is left): a dialog — reason (required), "The whole invoice" / "Part of it", and with "whole" a checked "Make a corrected copy as a new draft"; confirm → whole: issued now (toast with the number), to the corrected draft when copied; part: to the new credit-note draft. A credit-note page shows "Credits invoice 10001" (link) and its reason. The list shows credit notes with their kind and negative totals.

## 4. Tests
- dbtests: create (who, scope, only from an issued invoice, never from a credit note/draft/credited); the per-rate cap (two partial credits; a third over the rest refused; a rate the original lacks refused; concurrent credit issues on one invoice → one refused, never over-credited); the snapshots copied from the original (a renamed client does not reach the credit note); the original's rate reused; CREDITED only when fully covered (DB refuses an early move); credit in full + corrected copy (one transaction; the copy is a plain draft); the reason required (app + guard); numbers from the same series; the fingerprint covers the reason.
- unit: print negation and the reference line; the PDF renders a credit note in both languages.
- e2e: credit in full with a corrected copy from an issued invoice (the harness has no storage — the PDF path as 108's spec).

## 5. Questions for the design review
1. Copying the ORIGINAL's snapshots (not the live rows) into the credit note — right for Swedish law (ML 17 kap. — a credit note "ändringsfaktura" must reference the original unambiguously; does it need the parties' CURRENT details)?
2. The per-rate NET cap as the over-credit rule, and "fully credited" as per-rate nets equal — sound under rounding and concurrency (lock order credit note → original → series)?
3. Reusing the original's exchange rate for the SEK VAT on a credit note — correct?
4. Positive storage + negated print — any trap for the SEK VAT, the export, slice 109's portal view or the Fortnox file?
5. `creditInFull` issuing inside the action that creates the draft (one transaction) — the fingerprint is not needed there (the issuer sees the frozen original); any hole?

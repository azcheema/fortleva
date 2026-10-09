# Slice 109 — SENDING, THE CLIENT'S PORTAL VIEW, PAY NOW (Phase 4 step 3; founder decision C79)

*Design written 2026-10-09 by the building session, before any code; reviewed by a fresh agent before the migration is written (§9 records the review and what was done). C79's six answers are in `docs/OPEN_QUESTIONS.md`; this document is how they are built.*

## 0. What C79 decided, and the readings this design takes

| C79 | Decision | Reading taken here |
|---|---|---|
| (a) | Emailed with the PDF ATTACHED; ARC-09 relaxed for invoices only; **Mark as sent** for another way | The send is **synchronous** from the member's click (not the outbox) — see §3.1. The body names the number, the amount, the due date, the bank details (C79 (c) "always shown"), the pay link when there is one, and the portal. Credit notes are sent the same way. |
| (b) | In the portal once SENT, with its credit notes, state, PDF; main contacts only; even with the project's portal off | The gate is a fact column, **`sent_at IS NOT NULL`**, on EACH document — an invoice and a credit note each appear once THEY are sent (a credit note is sent like an invoice; its page offers **Send…** at once). Status is not the gate: an invoice marked paid before it was ever sent stays out of the portal until it is. |
| (c) | Pay now = a link PER INVOICE, on the draft, seen by the issuer, fixed at issue; bank details always shown | `invoice.pay_link_url`, a draft field of an INVOICE (never a credit note), in the issue fingerprint, frozen by the issued-row diff like every other column; the issue dialog prints it in full. |
| (d) | Marked paid by hand: the day + a note; no part payments | `paid_on` (date) + `payment_note`; status → PAID. **Not asked, proposed:** **Mark as unpaid** (an audited reversal back to SENT or ISSUED) — a mis-click with no way back is worse than a reversal the audit log shows. See §8 Q1. |
| (e) | To the billing email, changeable at send, + up to two more; Send again likewise | The dialog's first address is the client card's billing email (typed when there is none); two more optional; each address gets its own copy (the mailer's one-`to` contract and its per-address suppression). |
| (f) | Stripe and PayPal only; anything else refused; not on the PDF | An exact-host allowlist in `src/config` (`payLinkUrl`, the push fence's shape) AND a CHECK in the database; https, no credentials, no port, no fragment. Hosts: `buy.stripe.com`, `checkout.stripe.com`, `invoice.stripe.com`, `www.paypal.com`, `paypal.com`, `paypal.me`, `www.paypal.me`. The PDF is unchanged (template version stays 2). |

## 1. Data — migration `20261010120000_invoice_sending`

### 1.1 `invoice` gains five columns

- `pay_link_url TEXT` — CHECK: NULL, or ≤ 500 chars matching `^https://(buy\.stripe\.com|checkout\.stripe\.com|invoice\.stripe\.com|www\.paypal\.com|paypal\.com|paypal\.me|www\.paypal\.me)(/[^[:space:][:cntrl:]\\]*)?$` (the host followed by `/` or the end — `https://buy.stripe.com@evil.example/` and `https://buy.stripe.com.evil.example/` fail); and `kind = 'INVOICE' OR pay_link_url IS NULL`.
- `sent_at TIMESTAMPTZ` — the FIRST time it was sent (emailed or marked). CHECK: `sent_at IS NULL OR status <> 'DRAFT'`; `status <> 'SENT' OR sent_at IS NOT NULL`.
- `paid_on DATE`, `payment_note TEXT` — CHECK: `status <> 'PAID' OR paid_on IS NOT NULL`; `paid_on IS NULL OR status IN ('PAID', 'CREDITED')` (PAID → CREDITED keeps it: a refund's history); `payment_note IS NULL OR (paid_on IS NOT NULL AND char_length BETWEEN 1 AND 500 AND non-blank)`; `kind = 'INVOICE' OR paid_on IS NULL`.

The dev database is checked READ-ONLY before applying: no row is SENT or PAID today (no code could move one), so the CHECKs hold on existing rows.

### 1.2 `invoice_delivery` (new, class A)

One row per send: `id`, `tenant_id`, `client_id`, `invoice_id` (composite FK `(tenant_id, client_id, invoice_id) → invoice(tenant_id, client_id, id)` ON DELETE CASCADE — only platform maintenance ever deletes an issued invoice), `method` (`EMAIL` | `MARKED`, CHECK), `recipients TEXT[]` (EMAIL: 1–3 distinct lowercased addresses each ≤ 254 and containing `@`; MARKED: empty), `sent_by_member_id` (attribution, no FK), `created_at`.
Guard `invoice_delivery_guard` (BEFORE INSERT/UPDATE): INSERT only by a member as themselves (`sent_by_member_id = app.principal_id`) holding `invoice:send`, of an issued invoice (status ≠ DRAFT) of the same client, `created_at` now ± 5 min; UPDATE never. Grants: SELECT, INSERT (no UPDATE/DELETE). `tenant_isolation` + `portal_deny`. Never contact-readable: the recipients are the agency's record.

### 1.3 `invoice_guard`, replaced — what changes (everything 108b holds is held)

- `mutable` widens to `{status, updated_at, pdf_file_id, sent_at, paid_on, payment_note}`.
- **`sent_at`**: set once, NULL → a value, by a member as themselves holding `invoice:send`, the value now ± 5 min, **and only with a delivery row for this invoice by this member written IN THIS TRANSACTION** (`xmin = pg_current_xact_id()::xid` — probed true on PG 18.6 for slice 98); never changed or cleared after.
- **Status moves** (the forward-only table, amended):
  - ISSUED → SENT: needs `sent_at` (the CHECK) — an INVOICE **or a credit note** (108b's "a credit note's status does not move" becomes "a credit note moves only ISSUED → SENT"). Code `invoice:send`.
  - ISSUED|SENT → PAID: an INVOICE, `paid_on` set in the same statement, `paid_on` ≤ today (UTC) + 1 and ≥ `issue_date` − 366 days; code `invoice:record_payment`.
  - **PAID → SENT (when `sent_at`) or ISSUED (when not), clearing `paid_on` and `payment_note`** — the reversal (§8 Q1); code `invoice:record_payment`.
  - → CREDITED unchanged (108b).
  - `paid_on`/`payment_note` change only with a move to or from PAID (no silent rewrite of a recorded payment).
- A contact still writes nothing (the guard's first line; the census's named policies below say it twice).

### 1.4 `invoice` becomes CLASS B (client-scoped, status-structural)

- Drop `portal_deny`; add `portal_gate` (RESTRICTIVE FOR ALL): a contact principal sees a row iff `client_id = app.client_id AND status <> 'DRAFT' AND sent_at IS NOT NULL` (WITH CHECK identical).
- Add `portal_no_insert` / `portal_no_update` / `portal_no_delete` (RESTRICTIVE, named — the census migration's shape) so no contact writes the table.
- Add `portal_invoice_primary` (RESTRICTIVE FOR SELECT): a contact principal reads invoices only while their own `contact.portal_profile = 'CONTACT_PRIMARY'` (the `portal_vault_switch` belt — AUTHZ §8's "no money" for collaborators held by the database).
- `model-registry.ts`: `invoice` moves from A to `B_clientScoped`; `PORTAL_GATE_VARIANTS.invoice = { clientColumn: "client_id", term: "status" }`.
- **`invoice_line` STAYS CLASS A** (a deliberate narrowing of 107's note): the client's copy of the lines is the PDF; the portal shows the invoice's totals and dates, never line rows. Fewer surfaces on the plane where a leak is the worst bug.
- Columns a contact principal could read but the projection never selects: `seller_snapshot`, `payment_snapshot` (ciphertext — undecryptable there anyway), `buyer_snapshot`, `our_reference`, `created_by_member_id`, `issued_by_member_id`, `payment_note` (the agency's own reconciliation note — **internal**), `note`/`buyer_reference` (printed on the PDF; not needed on the page). A dbtest plants a sentinel in `payment_note` and proves no portal read returns it.

## 2. App — the member side

- **`src/config`: `payLinkUrl(raw): URL | null`** — the push fence's checks with the exact host list (no suffix matching), ≤ 500.
- **Drafts** (`drafts.ts`): `payLinkUrl` joins `DraftDetailsPatch` (INVOICE drafts only; a credit note's refuses it); `""` clears; stored as the parsed URL's `href`. The **issue fingerprint** (`readIssueFingerprint`) adds it. `createDraft`'s corrected copy (108b) does NOT copy it (its amount changes; a Stripe link is for one amount).
- **Issue dialog**: when set, "Pay now link: <full URL>" (C79 (c): seen by whoever issues).
- **`src/modules/invoicing/send.ts`**:
  - `sendInvoice(ctx, id, { to })`: parse 1–3 addresses (lowercase, distinct, `z.email()`, ≤ 254). Tx 1 (member): `invoice:view` + `invoice:send`, DIRECT client scope, issued (any issued status), the frozen record read strictly, the reply address. If no PDF yet: `ensureInvoicePdf` (refuses `INVOICE_PDF_UNAVAILABLE` → "Its PDF can't be made right now"). The PDF's bytes from storage, their sha-256 checked against the file row (we send what we archived). The mail rendered in the INVOICE'S language (`mail.ts`, pure). Each address sent in turn (`send()`; `"suppressed"` and a refusal are per-address outcomes). None sent → a typed refusal naming why, nothing recorded. Some sent → Tx 2 (member): `invoice:send` again, the invoice locked `FOR UPDATE`, the delivery row (the addresses that went), `sent_at` if NULL, ISSUED → SENT, `invoice.sent` audited `{deliveryId, method: "email", sent: n, notSent: m}` — the addresses are in the delivery row, never in the audit metadata. A Tx 2 failure after mail went is an error to the member (they may send again; a duplicate mail is the honest failure mode — documented, not hidden).
  - `markInvoiceSent(ctx, id)`: `invoice:send`, scope, lock, refuses once `sent_at` is set (`INVOICE_ALREADY_SENT`), delivery row MARKED, `sent_at`, ISSUED → SENT, `invoice.sent {method: "marked"}`.
  - `markInvoicePaid(ctx, id, { paidOn, note })`: `invoice:view` + `invoice:record_payment`, scope, lock; an INVOICE at ISSUED|SENT (`INVOICE_NOT_PAYABLE` otherwise); `invoice.paid {paidOn, noted: boolean}` (the note itself stays out of the audit metadata).
  - `markInvoiceUnpaid(ctx, id)`: `invoice:record_payment`; PAID → SENT|ISSUED; `invoice.payment_undone` (new catalogue action).
- **`src/modules/invoicing/mail.ts`** (pure): subject `Faktura 10001 från Naxdor AB` / `Invoice 10001 from Naxdor AB` / `Kreditfaktura …` / `Credit note …`; body: the amount to pay and due date (an invoice), or what it credits and the amount with its minus sign (a credit note — `signed`); the pay link; the bank details with the invoice number as the reference; "the invoice is attached as a PDF"; the portal's address for main contacts. The seller's name is the frozen `seller_snapshot.legalName`, never `tenant.name`. From stays the deployment's `mailFrom` (a per-workspace sender name is Phase 7's custom domains — owed, not built); Reply-To the workspace's reply address (C68 — the mail carries no live link or code, so it may have one).
- **The mailer** (`src/mailer`): `MailMessage.attachments?: readonly { filename; contentType; content: Uint8Array }[]`; SES maps them to `Content.Simple.Attachments` (`ContentDisposition: ATTACHMENT`, `BASE64`); the dev transport records each attachment's name, type, size and sha-256 — NEVER its bytes — in `.dev-outbox`. ARC-09 and the mailer's header amended: attachments for an issued invoice or credit note only (`send()` refuses any other attachment? — no: the one caller is `send.ts`; a unit tripwire pins that `attachments` is set nowhere else, like `pushEndpointUrl`'s single callers).
- **The issued invoice's page**: header **Send…** (dialog: the billing email filled in, a note when that address is blocked, two optional more, the subject it will carry; Send) — **Send again…** once sent; **Mark as paid…** (date, default today in the workspace zone; note); a "…" menu with **Mark as sent** (until sent) and **Mark as unpaid** (PAID). A **Sending** card lists the deliveries (when, emailed to whom / marked as sent, by whom). The dates card adds "Paid on" + the note. A credit note's page has Send…/Mark as sent, never the payment verbs.
- **The list**: status as today, plus a derived **Overdue** badge (ISSUED|SENT, an INVOICE, due before today in the workspace zone).

## 3. App — the client side

### 3.1 Why sending is synchronous, not the outbox

The outbox is ARC-21's fan-out queue: at-least-once, async, re-rendered at send, retried with backoff, no attachments, its rows in the tenant export. An invoice send is a human act with a human waiting: the member must know at once which addresses took it ("Sent to accounts@…; anna@… is blocked"), and "sent" must not appear on the invoice (or open the portal) for a mail that died on the eighth retry. The password reset and the share code already send straight from a request. Cost: a transport outage refuses the send (the member retries), and a commit failure after delivery means a possible duplicate on retry.

### 3.2 The portal

- **`src/modules/invoicing/portal.ts`** (projection, contact principal, `portal.invoice.view`): `listPortalInvoices` (newest first; number, kind, issue/due date, currency, the amount as printed — `signed` —, the state: Paid / Credited / Overdue / To pay, what a credit note credits by number; ≤ 200), `readPortalInvoice` (one, + its credit notes the client can see + "left to pay" when partly credited by visible ones + the pay link while it is payable and `portal.invoice.pay` holds), `portalInvoicesShown` (count > 0 — the nav entry, as Logins).
- **`src/modules/invoicing/portal-writes.ts`** (brokered, `src/portal/brokered-writes.test.ts`'s pins): `resolvePortalInvoicePdf` — `authorizePortal(…, "portal.invoice.view", { kind: "invoice", invoiceId })` under the contact, then a SYSTEM read restating the gate (client, not DRAFT, `sent_at`, the PDF recorded), `invoice.pdf_downloaded` audited `brokeredForContactId` BEFORE the presign, a 60 s attachment-only link; the documents' download budget (`assertDownloadBudget`'s count, shared). `readPortalInvoicePayment` — a BROKERED READ (on `BROKERED_READS`): the bank details decrypted from the payment snapshot for the detail page, after the same proof.
- **`PortalScopeRef` kind `invoice`** — a probe under the contact (`portal_gate` + `portal_invoice_primary` decide it).
- **Pages**: `/portal/invoices` and `/portal/invoices/[id]`; nav entry **Invoices** when `portalInvoicesShown`. **No View-as route** (as Logins): View-as is open to members who hold no `invoice:view`, so it must not become a way to read invoices; the frame's entry is still drawn under View-as (byte identity), its page not.
- **Pay now**: an external link (`target=_blank`, `rel="noopener noreferrer"`), shown only while the invoice is payable (an INVOICE, ISSUED/SENT, not covered by credit notes) — the portal says "Opens <host>" under it.

## 4. Permission, audit, catalogue

- No new permission code: `invoice:send`, `invoice:record_payment` leave `enforcement.test.ts`'s declared-ahead list (`invoicing` row empties). `portal.invoice.view` / `.pay` exist (AUTHZ §8 rows marked built).
- Audit: `invoice.sent`, `invoice.paid` exist; NEW `invoice.payment_undone`, `invoice.pdf_downloaded`.

## 5. Tests

- **dbtest `send.dbtest.ts`**: the guard — `sent_at` once, only with a same-transaction delivery by the same member, the code; a delivery only by a member holding `invoice:send`, of an issued invoice, never updated; PAID with `paid_on` bounds, unpaid reversal, CHECKs, credit notes ISSUED → SENT only; the pay link CHECK (good hosts, `@`, suffix and port tricks refused, a credit note refused) and the fingerprint moving on it; `sendInvoice` end to end with a temp `LocalDiskTransport` (`setStorage`) and a capturing mail transport (`setTransport`): the attachment's bytes equal the archived file, per-address outcomes (a suppressed address), nothing recorded when nothing went; scope + permission refusals on every verb.
- **dbtest `portal.dbtest.ts` (invoicing)**: a main contact sees exactly the sent, non-draft invoices and credit notes of their own client; never an unsent one, a draft, another client's; a collaborator sees none (the DB, not only the app); the `payment_note` sentinel never comes back; the PDF broker refuses an unsent id; the brokered payment read.
- **census / posture**: `isolation.dbtest.ts` (invoice in B with the status variant; `invoice_delivery` in A) and `census.dbtest.ts` (no contact writes on `invoice`) pass by construction — they are the proof the reclass is right.
- **unit**: `payLinkUrl`; `mail.ts` both kinds × both languages; the SES attachment mapping; the dev transport never writes bytes; `attachments` set only by `send.ts`.
- **e2e `invoice-send.spec.ts`**: a draft's pay link (a bad host refused, a Stripe one kept) → issue (the dialog shows it) → Send… (the harness has NO file storage: the send refuses with the PDF sentence — gated on `R2_BUCKET` as `attachments.spec.ts` is; with R2 it sends and the dev outbox shows the attachment's name) → Mark as sent → as Astrid (a main contact) the portal's Invoices nav and the invoice, To pay, Pay now → Mark as paid → Paid in the portal → Mark as unpaid.

## 6. Docs

DATA_MODEL §6.7 as-built; AUTHZ §8 (portal.invoice.* built); TENANCY (invoice class B, status gate; invoice_delivery A); SECURITY (the pay link as a payment-redirect vector and its fence; the attachment; the outbound list unchanged); ARCHITECTURE ARC-09 (amended); PLAN §0; UI.md if a new pattern appears.

## 7. Out of scope (owed or later)

Payment reminders (none automatic; a "Send reminder" later); per-workspace sender name (Phase 7); hours onto invoices (step 4); the Fortnox file (step 5) — which must read `paid_on`; a webhook marking payments (v1.5); streamed export of PDFs (108's owed item).

## 8. Questions for the design review

1. **Mark as unpaid**: a reversal the founder did not ask about. Keep it (audited), or leave paid one-way?
2. **Each document's own `sent_at` as the portal gate** — is "with its credit notes" (C79 (b)) better served by also showing an unsent credit note of a sent invoice? (That needs a join in the policy on the same table — the recursion trap — or a trigger-maintained copy.)
3. **Synchronous send** (§3.1) — any failure mode that argues for the outbox?
4. **`invoice_line` stays class A** — any portal need this blocks?
5. The pay-link host list — anything missing that Stripe or PayPal actually issue for a per-invoice link?

## 9. The design review's findings and what was done (2026-10-09)

One fresh agent, read-only. One high (a founder question), two mediums, seven lows, nits. Every one taken; nothing dispositioned away. **The design above is amended by this section where they differ.**

- **H1 — a Pay now link bypasses the bank details' protection** (an exact-host fence stops lookalikes, not someone else's Stripe or PayPal account; a manager sets it, an admin issues with no second factor). **Asked → C79 (g):** issuing an invoice WITH a pay link takes the issuer's authenticator code typed in the issue dialog (`requireRecentMfa(actor, INVOICE_DETAILS_STEP_UP_MINUTES)` under the draft's lock, the service deciding from the LOCKED row whether a link is there — the fingerprint already refuses a link added after the page loaded), and every active owner is mailed (`invoice.pay_link_issued`, outbox, in the issue's transaction, a link to the invoice — never the URL; no Reply-To, a security notice). `invoice.draft_edited` names the link (`payLink: href | null`) when it changes and `invoice.issued` carries it. SECURITY.md says plainly what the fence does and does not stop.
- **M1 — a fixed-amount link stays live on an invoice that no longer owes that amount.** Pay now (portal and mail) only while the invoice is an INVOICE at ISSUED/SENT **and no issued credit note of it exists in any send state** — decided as SYSTEM in the portal's payment broker (`readPortalInvoicePayment`), which sees every credit note, and in the sender. The mail of a Send again says what the invoice is now: paid (a copy, nothing to pay), credited in full (a copy), partly credited (what is left — from the credit notes' TOTALS, `signed` — and no link), open (as before). A credit note whose invoice was sent and which itself was not shows the member "Not sent to the client yet".
- **M2 — issuing could set `sent_at`.** The leaving-DRAFT branch refuses `sent_at`, `paid_on`, `payment_note` (both kinds). And a CHECK `status <> 'ISSUED' OR sent_at IS NULL` beside `status <> 'SENT' OR sent_at IS NOT NULL`: for an unpaid invoice ISSUED ⇔ unsent, so the reversal's target is a CHECK, not guard logic.
- **L1** — §1.1's "no row is SENT or PAID" is false (`drafts.dbtest.ts` moves one to PAID with no `paid_on`): the read-only pre-check counts ALL tenants' SENT/PAID rows (a stale fixture tenant would fail `ADD CONSTRAINT`), and `drafts.dbtest.ts` / `credit.dbtest.ts:393` are updated to the new rules.
- **L2** — `sendInvoice`'s second transaction re-asserts `invoice:view`, `invoice:send` AND the client scope, runs under `retryOnContention`; a THROWN transport error on one address is caught and counted not sent (never discarding another address's success). `markInvoiceUnpaid` takes view + record_payment + scope.
- **L3** — the guard's code for a status move is keyed on (OLD, NEW): ISSUED→SENT `invoice:send`; →PAID and PAID→SENT|ISSUED `invoice:record_payment`; →CREDITED `invoice:credit`. Both reversal targets tested with a role holding only `record_payment`.
- **L4** — "left to pay" from credit notes' own totals with `signed`, never `readCreditedNets` (lines are class A: under the contact they read as nothing credited).
- **L5** — `portal-projections.test.ts` gains `paymentNote` and `issuedByMemberId`; the payment broker's `paymentSnapshot` read is the documented exception; `portal_invoice_primary` pinned BY NAME in `isolation.dbtest.ts`.
- **L6 — a budget on invoice email**: per member 30 addresses an hour and per workspace 300 a day; and a second email of the SAME invoice within 60 seconds is refused (a double click). *(As built after the security review — §11: counted from committed RESERVATIONS under a per-workspace advisory lock, the double click keyed on the address list, a send that reached nobody voiding its reservation. The first cut counted `invoice_delivery`, written only after the mail, and had no lock.)*
- **L7 / Q5** — `checkout.stripe.com` DROPPED (a Checkout Session dies within 24 hours; a link fixed at issue would be dead). `buy.stripe.com`, `invoice.stripe.com` (expires after its due date — acceptable), `www.paypal.com`, `paypal.com`, `paypal.me`, `www.paypal.me`. Fragments ARE allowed (PayPal's invoice links carry the id after `#`; §0 (f) was wrong).
- **Nits taken:** `portal_gate`'s WITH CHECK denies contacts outright (the `credential_item` / `project_update` precedent); `invoice.payment_undone` carries the undone `paidOn` and whether there was a note; Mark as sent confirms "its main contacts will see it in the portal", and the portal handles an invoice with no PDF yet; the download budget counts `invoice.pdf_downloaded` with `file.downloaded` under the same lock; the dbtests' prefix in `DBTEST_PREFIXES`; the database's path regex is printable ASCII without backslash; the portal shows NO project on an invoice (a project whose portal is off must not be named); `readCreditNotes` shows Sent; the subject's seller name has CR/LF stripped. (The HTML-escape nit is moot: the mail is plain text.)
- **§8 answers adopted:** keep Mark as unpaid (asked → C79 (h)); keep each document's own `sent_at` as the gate; keep the synchronous send (hardened, L2/L6); keep `invoice_line` class A (registry comment and DATA_MODEL corrected).

## 10. The migration's pre-apply review (2026-10-09)

One fresh agent, read-only, before `20261010120000_invoice_sending` was applied. No SQL error, no bypass of the guard; the 108b guard's body diffed mechanically and found unchanged outside the (109) parts. Taken:

- **Medium — `payment_note` readable at row level by a main contact** once `invoice` is class B (only the projection's select kept it out; a column grant cannot tell member from contact). **Moved to its own class-A table, `invoice_payment_note`** (one per invoice, composite FK, ON DELETE CASCADE): written only IN THE SAME TRANSACTION as the invoice's move to PAID (the invoice row's xmin), by a member holding `invoice:record_payment`; deleted only once the payment is undone (or by its invoice's cascade); never changed. §1.1's `payment_note` column is gone; the `portal-projections` never-list keeps `paymentNote` as a belt.
- **Low — the issue could set the pay link in the same statement**: the leaving-DRAFT branch refuses any change of `pay_link_url`.
- **Low/nit — the header's LOCKS paragraph was wrong**: a delivery or note insert takes FOR KEY SHARE on the invoice through its FK, so the invoice's FOR UPDATE comes first (send.ts does) — reworded, with the no-savepoint condition of the xmin checks.
- **Nit — a two-dimensional `recipients`**: refused (`array_ndims`).
- **The pre-check re-run as an RLS-bypassing role** (`neondb_owner`, `rolbypassrls` true — it sees the one dev tenant's members and projects): zero invoices on dev, so no row can fail the new CHECKs.
- **Delta re-check (the same agent, after the changes above):** all five sound; two more taken — (low) the note guard's xmin proved only that the invoice row was WRITTEN in the transaction (a no-op UPDATE of an old paid invoice would do), so the move to PAID now also sets a transaction-local marker (`app.invoice_paid_now`) the note's guard requires — a belt against an app bug, not raw SQL; (nit) the invoice's guard itself deletes the note when a payment is undone, so no path leaves one for the next payment to inherit.
- **Existing tests the new rules change** (updated in this slice): `drafts.dbtest.ts` (an admin's PAID needs `paid_on`; PAID → SENT is now a reversal), `credit.dbtest.ts` (a credit note's ISSUED → SENT is now allowed — with a send), and both files' TOKENS gain the new CHECK names.

## 11. The code and security reviews (2026-10-09)

Two fresh agents in parallel, read-only. **No high in either; nothing in the applied migration needs a forward fix.** Every finding taken, none dispositioned away but the two noted:

- **Security, medium — the budget and the double-click guard did not hold under concurrency** (they counted `invoice_delivery`, written only after the mail; no lock). Now a RESERVATION (`invoice.send_attempted`: an address count and a 16-hex digest of the list, never an address) is committed under a per-workspace advisory lock BEFORE any mail; the budget and the guard count committed reservations. A dbtest fires three sends at once: one goes.
- **Code, medium — a send that reached nobody made the next retry say "emailed less than a minute ago".** Such a send VOIDS its reservation (`invoice.send_attempt_voided`); the guard and the budget subtract voids; the guard is per address LIST, so a corrected address goes at once; `INVOICE_JUST_SENT` now says "sent to these addresses".
- **Security, low — mail with no trace when the record failed:** the reservation is that trace.
- **Security, low — a fresh step-up from elsewhere stood in for the issue's code:** `issueInvoice` takes `codeTypedNow`, set by the issue action only after it verified a code typed in that request; without it a linked draft is refused.
- **Security, low — free text on the PDF (note, references, lines) can name another account and skips every pay-link fence** (pre-existing; now emailed): the issue dialog warns when the draft's own text reads like somewhere to pay (`mentionsPaymentDetails` — a URL, an IBAN or Bankgiro shape, the words). A warning, not a refusal: C75 (i) left the per-draft note an ordinary edit, and an agency's lines name websites.
- **Code, lows:** the owners' notice promised "who issued it" — the issued page now shows Issued by; "needs your code" was answered before "it changed" — the fingerprint is compared first; the mail's "left to pay" counted credit notes the client never received — it counts SENT ones (any issued one still withholds the link); Mark as unpaid dropped focus — to Download PDF; the mail's portal line links `/portal/invoices/<id>` and is left out while the portal (or invoicing in it) is closed; the reversal by a role holding only `record_payment` is now tested (the admin's `invoice:send` revoked for the test).
- **Nits taken:** the stored link re-fenced before it is mailed; PayPal narrowed to its pay pages (`/ncp/payment/`, `/invoice/p/`, `/invoice/payerView/`, `/paypalme/` — app-side; the CHECK stays the hosts' belt, no forward migration); the attachments tripwire now walks every mailer caller for the word, shorthand included; `INVOICE_NOT_DELIVERED` and `InvoiceDetail.credited` removed; a mixed failure names both causes; the client mail says "ni" throughout and "pdf"; the setup link's wording reused; the issue dialog keeps a code refused before it was checked and starts each opening empty; a vacuous raw-read assertion made non-empty; TENANCY, DATA_MODEL and §9 L6 corrected.
- **Recorded, not changed:** View-as's nav draws "Invoices" from a count, so a member who may View-as but holds no `invoice:view` learns that a sent invoice exists (the Logins precedent); Pay now disappearing because of an unsent credit note tells the client one exists (M1's deliberate trade).
- **Process:** the tree changed during the code review (the security fixes landed meanwhile) — the reviewer said so and reviewed the earlier snapshot; the gates were re-run on the final tree.
- **Fix-pass re-check (1 agent; no high or medium):** (low) a void matched its reservation by TIME, so a slow failed send's void could cancel a later reservation of the same list — every reservation now carries an `attempt` id and a void names it; the guard and both sums count a reservation unless ITS void exists; (low, test gap) the fingerprint-before-code order was not tested — the test now issues with no code and expects INVOICE_CHANGED; nits taken — the header's step 6, the digest's comment (unsalted: confirms a guessed single address to whoever reads the audit log, who can already read the invoice's record of sends), the unit test's describe moved below the imports.

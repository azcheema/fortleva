# Slice 112 — CONTRACTS: TEMPLATES, WRITING, SENDING, SIGNING IN THE PORTAL (Phase 4 step 6; founder decision C84)

*Design written 2026-10-10 by the building session, before any code; reviewed by a fresh agent before the migration is written (§9 records the review and what was done). C84's seven answers are in `docs/OPEN_QUESTIONS.md`; this document is how they are built.*

## 0. What C84 decided, and the readings this design takes

| C84 | Decision | Reading taken here |
|---|---|---|
| (a) | **Written in Fortleva** from saved templates; Fortleva makes the PDF (AGAINST the recommendation of uploading a PDF) | The body is the editor's ProseMirror document (the shape descriptions and progress updates already use), restricted to what a contract needs (§2.1). The PDF is drawn from the FROZEN body at sending, once, and is the exact bytes both signatures attest to (`document_sha256`). |
| (b) | The sender signs as they send: types their name in the send dialog | A `contract_signature` row of party `TENANT`, SIGNED at the moment of sending, by the sending member as themselves, the name as typed, written in the send's own transaction with the hash of the PDF being sent. |
| (c) | ONE person at the client signs, picked at sending | One `contract_signature` row of party `CLIENT`, PENDING, naming one contact. The schema keeps one row per signer so several signers stay additive; the database holds v1 to exactly one client signer. |
| (d) | Only people already in the portal can be picked | A contact with portal access (an active login, not paused) **and** a MAIN contact (`CONTACT_PRIMARY`): AUTHZ §8 already gives `portal.contract.view` / `.sign` to main contacts only, as it does invoices. The picker lists them and says to invite (or make a main contact) anyone else. |
| (e) | A template has a fixed set of fill-ins, filled when a contract is started; any text editable afterwards | Fill-ins are written in the template as `{{name}}` tokens from a fixed list (§2.2), inserted from a menu. Starting a contract replaces each known token in the text with its value, once; nothing is re-filled later. A token whose value is missing is left in place, highlighted, and sending is refused while any `{{…}}` of the list remains. |
| (f) | A contract signed elsewhere can be put in — its signed PDF with its dates | A contract row of origin `UPLOADED`, made directly SIGNED, its PDF in storage, its signed date, start and end typed. No signature rows (the PDF is the evidence). |
| (g) | Templates kept by owners and admins; managers start and send | A new code, `contract:manage_templates` (owners, admins). `contract:create` / `:edit` / `:send` stay owners, managers, admins (the catalogue as seeded). |

**Read by the design, not asked (to be stated to the founder):**

- **What a signature attests to is the FROZEN TEXT, fingerprinted by the database** — not the PDF's bytes. At sending, the database computes `content_sha256` over the contract's title, language, parties block and body *as Postgres stores them* (`jsonb::text` is canonical — AGENTS.md's "never hash a document that has not been through Postgres") and copies it onto both signature rows; the app never supplies it. The PDF is a rendering of that record, drawn after the commit and printing the fingerprint. Two reasons: the e2e harness has no file storage (invoices issue without their PDF there), so a send that needed its PDF stored first could never be tested end to end; and a record the database holds immutable is a stronger exhibit than a file in a bucket. The client reads the contract in the portal as text rendered from the same frozen body, with the PDF to download beside it.
- **The signed copy** is ONE PDF: the contract as sent plus a signature page (both parties' names, email addresses, the moment each signed, how — "signed in the client portal after signing in" / "signed when sending" — and the fingerprint). It is drawn by the system after the client's signature commits, archived once, and swept by the jobs route if that did not happen. IP address and browser are KEPT in the record for the client's signature (the evidence that makes a simple electronic signature defensible, DATA_MODEL §6.6) but not printed.
- **A sent contract never changes.** Withdraw it (the client sees "Withdrawn"), or **Change it**: withdraws it and opens a copy as version n+1 in one step. A declined or withdrawn contract offers **New version** (a copy, version n+1). A signed contract has no versions; a new agreement is a new contract.
- **The client may decline, with an optional reason;** the agency is told (inbox + mail per the member's preferences) like a signature.
- **The client signs by ticking "I have read and accept this contract" and typing their full name** — the same act as the agency's (b), so both signatures on the page read alike.
- **Contracts are client-level** (no project): one client, any of its projects.
- **The contract's start and end dates are record fields** for Expirations and the lists; the text states the term. The end date of a SIGNED contract appears on Expirations (slice 112c).
- **"In the portal" means a MAIN contact whose portal access is ACTIVE** (signed in at least once, not paused) — an invited person who has not yet accepted cannot be picked, nor a collaborator (AUTHZ §8 keeps contracts, like invoices, to main contacts).

## 1. The build in three slices

| Slice | What | Why it is its own |
|---|---|---|
| **112** | Templates (Settings → Contract templates, owners/admins, fill-in menu); `/contracts` and the draft editor (start from a template or blank, the fill-ins, title, signer, language, dates, body); Preview PDF (drawn on demand, never stored); delete a draft. The migration for all three tables, with the send/sign moves REFUSED by the guards until 112b replaces them. | Nothing leaves the agency: no portal surface, no mail. |
| **112b** | Sending (the sender's signature), withdraw, change it / new version, the PDF as sent and the signed copy (drawn after commit, swept), the portal's Contracts area and page, sign / decline (a census write), the agency told, the mails. | The client-facing half: `/security-review` territory (RLS, portal, census write). |
| **112c** | A contract signed elsewhere (upload its PDF, dates, "show to the client"), Expirations, the client page's Contracts tab. | Small, file-upload shaped. |

Each slice is reviewed (`/code-review`, and `/security-review` for 112 and 112b — both touch migrations/RLS and server actions) by fresh agents before its commit.

## 2. The body and the fill-ins

### 2.1 The contract schema

`contractExtensions()` in `src/lib/rich-text/extensions.ts`: StarterKit with headings 1–3, bold, italic, underline, strike, bullet and numbered lists, blockquote, horizontal rule, hard break, links (`openOnClick: false`, `autolink: false`); **no** code, code block, task list (a checkbox has no meaning in a signed contract). `normalizeContractBody` in `normalize.ts` runs the same pipeline as `normalizeDescription` against that schema, at the description caps (512 KB JSON, 100 000 characters). The database adds a backstop CHECK (`octet_length(body::text) <= 600000`). Templates and contracts use the same schema and the same normaliser.

### 2.2 The fill-ins (C84 (e)) — `src/modules/contracts/fill-ins.ts`, pure

A fixed list; the token is `{{key}}`, inserted from an **Insert fill-in** menu in the template editor (typing one by hand works too):

| Key | Value at start | Missing when |
|---|---|---|
| `client_name` | Client name | never |
| `client_org_nr` | Client org number | not on the client card |
| `client_address` | Client address on one line (line 1, line 2, postal code + city, country name in the contract's language when not SE) | no address line 1 |
| `signer_name` | The signer picked in the start dialog | no signer picked |
| `agency_name` | The workspace's legal name (Settings → Invoicing → Company), else the workspace name | never |
| `agency_org_nr` | The workspace's org number | not set |
| `agency_address` | The workspace's address, one line | not set |
| `today` | Today's date in the workspace's time zone, written in the contract's language ("10 October 2026" / "10 oktober 2026") | never |

`fillIn(doc, values)` walks every text node and replaces each token whose value is known, keeping the node's marks; tokens are matched only WITHIN one text node (a token split by formatting is not a token — the menu inserts it unformatted). A token whose value is missing stays. `remainingFillIns(doc)` lists the known keys still present; an unknown `{{…}}` is ordinary text. Filling runs ONCE, when the contract is started; nothing re-fills later (C84 (e): "any of the text can then be edited"). The draft editor shows the remaining ones ("Still to fill in: client org number") and 112b's send refuses while any remains (`CONTRACT_FILL_INS_LEFT`).

## 3. Data — migration `20261011120000_contracts` (DDL only; slice 112)

Three new tables, four new enums. Registered in `MODEL_CLASSES` and `RLS_CLASSES` (`contract_template` class A; `contract`, `contract_signature` class B), grants to `app_runtime`, `ENABLE` + `FORCE ROW LEVEL SECURITY`, `tenant_isolation`.

### 3.1 `contract_template` — CLASS A (`portal_deny`)

`id`, `tenant_id`, `name` (1–120, non-blank, unique per tenant case-insensitively), `body jsonb NOT NULL`, `created_by_member_id`, `updated_by_member_id`, `created_at`, `updated_at`. Guard `contract_template_guard` (BEFORE INSERT/UPDATE/DELETE): a contact writes nothing; every write by a member as themselves (`*_by_member_id = app.principal_id`) holding `contract:manage_templates` (`invoice_member_holds` — a generic permission join, reused as is). Delete allowed (a contract copies the body; `contract.template_id` is attribution only, no FK).

### 3.2 `contract` — CLASS B, status-structural portal gate

Columns: `id`, `tenant_id`, `client_id` (composite FK → `client(tenant_id, id)`), `title` (1–200 non-blank), `origin` (`ContractOrigin`: `WRITTEN` | `UPLOADED`), `status` (`ContractStatus`: `DRAFT` | `SENT` | `SIGNED` | `DECLINED` | `WITHDRAWN`), `version int ≥ 1`, `supersedes_id` (composite FK `(tenant_id, client_id, supersedes_id)` → `contract`; unique — one successor per contract), `template_id` (attribution, no FK), `body jsonb` (WRITTEN: NOT NULL; UPLOADED: NULL — CHECK), `language` (`sv` | `en`; default the client's `invoice_locale`, else the workspace's), `signer_contact_id` (composite FK `(tenant_id, client_id, signer_contact_id)` → `contact`; NULL allowed in a draft), `starts_on date`, `ends_on date` (CHECK `ends_on >= starts_on` when both), `parties jsonb` (the snapshot written at sending — NULL in a draft; CHECK), `content_sha256 char(64)` (written BY THE GUARD at sending; NULL in a draft), `sent_at`, `sent_by_member_id`, `signed_on date`, `withdrawn_at`, `withdrawn_by_member_id`, `pdf_file_id` (WRITTEN: the PDF as sent), `signed_pdf_file_id` (WRITTEN: the signed copy; UPLOADED: the uploaded file), `shown_to_client boolean NOT NULL DEFAULT false` (UPLOADED only — 112c), `created_by_member_id`, `created_at`, `updated_at`. Status/column CHECKs: DRAFT ⇔ `sent_at IS NULL` for WRITTEN; SENT/SIGNED/DECLINED/WITHDRAWN (WRITTEN) need `sent_at`, `content_sha256`, `parties`, `signer_contact_id`; SIGNED needs `signed_on`; WITHDRAWN needs `withdrawn_at`; UPLOADED is only ever SIGNED (112c).

A contact being deleted while named as a DRAFT's signer: the FK is RESTRICT; `deleteContact` clears `signer_contact_id` on the client's drafts first, in its own transaction (a sent contract's signer is a contact who has written in the portal's sense — the delete is refused as it already is for them).

Guard `contract_guard` (BEFORE INSERT/UPDATE/DELETE), slice 112's version:

- A contact writes nothing directly (the census reaches `contract` only through §3.4's definer function).
- INSERT: a member as themselves holding `contract:create`, a WRITTEN DRAFT, `created_at` now ± 5 min, version 1 with no `supersedes_id` (112b widens: version n+1 superseding a DECLINED/WITHDRAWN contract of the same client).
- UPDATE of a DRAFT: holding `contract:edit`; only `title`, `body`, `language`, `signer_contact_id`, `starts_on`, `ends_on`, `updated_at` change. Every other column is immutable in every state.
- Any status move: **refused in slice 112** (`CONTRACT_GUARD: not yet`) — 112b replaces the function.
- DELETE: a DRAFT only, holding `contract:delete`.

The signer (when set) must be a contact of the same client (the FK) — whether they are a main contact in the portal is checked at SENDING (112b), in the guard, because portal access can change while a contract is a draft.

Portal policies (written now, so the table is born class B, though no contact reads anything until 112b ships a surface): `portal_gate` (RESTRICTIVE, contacts only) — `client_id = app.client_id AND ((origin = 'WRITTEN' AND sent_at IS NOT NULL) OR (origin = 'UPLOADED' AND shown_to_client))`; `portal_contract_primary` (RESTRICTIVE SELECT) — the contact is a MAIN contact (`portal_invoice_primary`'s shape); `portal_no_insert` / `portal_no_update` / `portal_no_delete`. Registered as a status-structural variant in `PORTAL_GATE_VARIANTS` (`invoice`'s precedent).

### 3.3 `contract_signature` — CLASS B

`id`, `tenant_id`, `client_id`, `contract_id` (composite FK `(tenant_id, client_id, contract_id)` → `contract` ON DELETE CASCADE — only a draft is deletable, and a draft has no signatures), `party` (`SignatureParty`: `TENANT` | `CLIENT`; unique `(contract_id, party)` — v1's one signer per side), `signer_member_id` / `signer_contact_id` (exactly the one for the party — CHECK), `signer_name`, `signer_email` (copied from the member / contact at sending), `status` (`SignatureStatus`: `PENDING` | `SIGNED` | `DECLINED`), `typed_name` (SIGNED: 1–200 non-blank), `decided_at`, `decline_reason` (≤ 1000, DECLINED only), `ip`, `user_agent` (CLIENT party only — CHECK: NULL on TENANT rows; a member's sign-in is audited elsewhere and a client must never be able to read a member's address), `content_sha256` (copied BY THE TRIGGER from the contract), `created_at`.

Slice 112: the guard refuses every INSERT/UPDATE/DELETE (`CONTRACT_SIGNATURE_GUARD: not yet`); 112b replaces it. Portal policies: `portal_gate` (RESTRICTIVE) — client match and the contract visible to the contact (an `EXISTS` on `contract` under the contact's own RLS); `portal_signature_primary` (main contact); `portal_no_insert` / `portal_no_update` / `portal_no_delete` (112b's census policy replaces the UPDATE deny).

### 3.4 Slice 112b's database moves (designed now, written in 112b's migration)

- **Send** (one transaction, the contract locked FOR UPDATE first): UPDATE `contract` DRAFT → SENT with `sent_by_member_id = who`, `sent_at` now, `parties` (the app's snapshot; the guard checks it is an object with `agency` and `client` keys), by a holder of `contract:send`; the guard checks no fill-in token remains (`body::text ~ '\{\{(client_name|…)\}\}'`), the signer is the client's contact with `portal_status = 'ACTIVE'` and `portal_profile = 'CONTACT_PRIMARY'`, and WRITES `content_sha256 := encode(sha256(convert_to(title || E'\n' || language || E'\n' || parties::text || E'\n' || body::text, 'UTF8')), 'hex')`. Then INSERT the two signature rows (TENANT: SIGNED, `signer_member_id = who`, `typed_name`, `decided_at` now; CLIENT: PENDING, `signer_contact_id = contract.signer_contact_id`); their guard copies `content_sha256`, `signer_name` / `signer_email` from the contract / member / contact rows (never the app's values) and requires the contract SENT in THIS transaction (`xmin = pg_current_xact_id()::xid`). A DEFERRABLE INITIALLY DEFERRED constraint trigger on `contract` checks at commit that a WRITTEN contract that is not a DRAFT has exactly one TENANT SIGNED row and one CLIENT row.
- **Sign / decline — a CENSUS WRITE** under the contact's own principal (`withCensusWrite`): UPDATE their own PENDING CLIENT row to SIGNED (`typed_name`, `decided_at` now ± 5 min, `ip`, `user_agent`) or DECLINED (`decline_reason`). Named census policy `portal_signature_decide`: `USING (signer_contact_id = app.principal_id AND status = 'PENDING')`, `WITH CHECK (signer_contact_id = app.principal_id AND status IN ('SIGNED','DECLINED'))`; the column trigger refuses every other column. An AFTER UPDATE trigger `contract_signature_decided` (SECURITY DEFINER, owned by the migration role) then moves the contract: `UPDATE contract SET status = 'SIGNED', signed_on = <the tenant's local date> … WHERE … AND status = 'SENT'` (or DECLINED), RAISING `CONTRACT_NOT_OPEN` when no row moved — so a withdrawal that commits first makes the signature fail, not land on a withdrawn contract. `contract_guard` admits SENT → SIGNED / DECLINED only from that function (a `set_config('app.contract_decided', …, true)` inside it, checked with `current_user`). Lock order: signature row, then contract — the withdraw path locks only the contract and never the signature, so no cycle.
- **Withdraw**: SENT → WITHDRAWN by `contract:send`; the pending CLIENT row stays PENDING (the trigger can no longer move a non-SENT contract, so the signature fails).
- **The two PDFs**: `pdf_file_id` / `signed_pdf_file_id` set once, NULL → a value, by a member or the system (the PDF writers), a `CONTRACT_PDF` `file_object`.

## 4. App — slice 112

- `src/modules/contracts/` (new module, `index.ts` barrel): `templates.ts` (list — `contract:create` or `contract:manage_templates`; create / update / delete — `contract:manage_templates`; audit `contract_template.created|updated|deleted`), `drafts.ts` (list, read, `startContract` — `contract:create`, client in DIRECT scope, the template's body filled in; `updateContractDraft` — `contract:edit`; `deleteContractDraft` — `contract:delete`; audit `contract.created`, `contract.draft_edited`, `contract.draft_deleted`), `fill-ins.ts` (pure), `signers.ts` (the client's main contacts in the portal — the picker's list), `pdf/contract-pdf.tsx` (react-pdf: the body walker mirroring `render.tsx`, the parties block, the page footer "title · version · page n of m"; 112b adds the signature page), `preview.ts` (draws a draft's PDF on demand for `contract:view` — never stored, marked "Draft — not sent" on every page).
- The fonts: the invoice's Inter files (`src/modules/invoicing/pdf/fonts`) read from that one directory; `next.config.ts` traces them for `/contracts/**` too.
- Routes: `/contracts` (list: client, title, status, version, updated; filter by client and status; **New contract**), `/contracts/[id]` (the draft editor: title, signer picker, language, dates, the body editor, the "Still to fill in" strip, Preview PDF, Delete), `/contracts/[id]/preview` (a route handler streaming the preview PDF), `/settings/contracts` (templates: list, new, edit — name + body editor with Insert fill-in, delete). Nav: **Contracts** (`contract:view`), **Settings → Contract templates** (`contract:manage_templates`).
- Mutations follow the house rule: `requireAccess` → `assertInScope` → mutate → `audit.record` in one transaction; actions derive tenant/member from `requireTenantContext()`; typed `ActionResult` + toast; i18n en + sv.

## 5. Permissions, audit, catalogue

- New code `contract:manage_templates` ("Create and change contract templates"), module `contracts`, owners and admins (CA). Catalogue 115 → 116, `TEMPLATE_VERSION` 15 → 16 — **the seed is owed** (the founder runs `prisma/seed.ts` at release; until then the code is unheld and Settings → Contract templates shows nothing).
- New audit actions (TENANT): `contract_template.created`, `contract_template.updated`, `contract_template.deleted`, `contract.created`, `contract.draft_edited`, `contract.draft_deleted`; 112b: `contract.withdrawn`, `contract.pdf_generated`, `contract.pdf_downloaded` (+ the existing `contract.sent|signed|declined`); 112c: `contract.uploaded`. Metadata: ids, versions, the template id — never the text.

## 6. What reaches the client

Slice 112: **nothing.** The tables are born class B with their gates, but no portal code reads them and no capability surface exists until 112b.

## 7. Tests — slice 112

- Unit: `fill-ins.test.ts` (each key, marks kept, split tokens, missing values left, unknown tokens ignored, `remainingFillIns`); `normalize` for the contract schema (task lists and code refused); the PDF walker renders every node (a smoke render to bytes); the catalogue tests (116, TV16, CA).
- dbtest `contracts.dbtest.ts` (own prefix `dbt-contracts-`, registered in `DBTEST_PREFIXES`): the template guard (holder only, as themselves, contact refused); the contract guard (insert as a draft, edit by `contract:edit` holders only, frozen columns, a status move refused, delete a draft only; a signer of another client refused by the FK); a contact reads nothing of a draft; tenant isolation for all three tables (the isolation suite picks them up from the registry).
- e2e `contracts.spec.ts`: an owner makes a template with two fill-ins, a manager starts a contract from it, sees the filled text and the "Still to fill in" strip, edits and saves, previews the PDF (a 200 with `%PDF`), deletes a draft. Visual stops: `/contracts`, the draft editor, `/settings/contracts` (3 stops / 12 shots).

## 8. Docs

DATA_MODEL §6.6 as-built note (the shape here supersedes the Contract / ContractSignature sketch: statuses, client-level, the content fingerprint); AUTHZ §3 (the new code); PLAN §0 and Phase 4's Contract line; this document's §9.

## 9. Questions for the design review

1. Is fingerprinting the frozen record (in the database, at send) rather than the PDF's bytes sound as the thing a simple electronic signature attests to? Anything that could make the stored `body::text` differ between the hash and a later read (jsonb's canonical form across Postgres versions)?
2. The SECURITY DEFINER trigger as the only door from a contact's signature to the contract's status — is the `set_config` + `current_user` recognition sound, and does the lock order (signature row, then contract; withdraw: contract only) hold against send / withdraw / sign races?
3. The deferred constraint trigger (both signature rows at commit) — any problem with Prisma interactive transactions or with the house's existing triggers?
4. Should the signer be checked as a main contact in the portal only at sending (as designed), or also at signing (a contact demoted to collaborator after sending — `portal_signature_primary` already denies them the row; is that enough)?
5. Fill-ins matched within one text node only — acceptable, or must a token split across marks be found?
6. Once sent, every column of a `contract` row is readable to a main contact by RLS — `created_by_member_id`, `sent_by_member_id`, `template_id` included. Projections withhold them; is a column the client can read by RLS a leak here (they are member ids, not names)?

## 10. Revised after the design review (2026-10-10) — OVERRIDES the body where they differ

A fresh read-only agent reviewed this document against the code (16 items: 7 medium, 8 low, nits). It found **no path by which a client reads a draft**. Every item is taken; the dispositions:

**Slice 112 (this migration):**

1. *(M — no maintenance path.)* All guards admit DELETE under `app.contract_maintenance = 'on'` on `app_platform` (the `invoice_maintenance` shape); `removeTenant` (`e2e/fixtures/seed-cli.ts`) and the dbtest fixture's teardown delete contracts, then templates, under it.
2. *(M — `deleteContact`.)* **`contract.signer_contact_id` has NO foreign key.** It is a draft's choice, not attribution of anything a contact wrote: the guard checks, on INSERT and on any change of it, that it names a contact of the SAME client; a deleted contact leaves a draft naming nobody — the editor shows "no signer", and 112b's send re-checks that the contact exists, is ACTIVE and a main contact. No guard exception for a contact's deletion is needed. 112b's `contract_signature.signer_contact_id` is "attribution, no FK" and `deleteContact` gains its count then (`attribution-columns.test.ts` forces it).
5. *(M — posture.)* `contract`'s gate gains `status <> 'DRAFT'` (the posture test's `term: "status"`, and a belt beside `sent_at`); `contract` is declared in `PORTAL_GATE_VARIANTS` as `{ clientColumn: "client_id", term: "status" }`; `portal_contract_primary` is pinned by name in `CLASS_B_REQUIRED_EXTRA`.
12. *(L — a draft carries none of the later columns.)* CHECK: a WRITTEN DRAFT has `num_nonnulls(parties, content_sha256, sent_at, sent_by_member_id, signed_on, withdrawn_at, withdrawn_by_member_id, pdf_file_id, signed_pdf_file_id) = 0` and `shown_to_client = false`; `@@unique([tenantId, pdfFileId])`, `@@unique([tenantId, signedPdfFileId])`.
13. *(L — keys.)* `contract` gets `@@unique([tenantId, clientId, id])` (the target for `supersedes_id` and 112b's signature FK). No contact key is needed (item 2).
14. *(L — split tokens.)* `remainingFillIns` ALSO scans each textblock's joined text, so a token split by formatting is reported as still to fill in (it is never filled — the person retypes it); saving a template warns of a split token (`splitFillIns`). `signer_name` is filled once: the editor warns when the chosen signer's name does not appear in the body (a pure check on the text, no column). 112b pins the database's key list against `FILL_IN_KEYS`.
15. *(L — scope.)* **`contract_signature` moves to slice 112b**, which writes it with its census policy, its definer trigger and its tests; slice 112 creates `contract_template` and `contract` only. `contract`'s positive portal read is not testable in 112 (nothing is sent) — the dbtest proves a contact reads no DRAFT; 112b proves the rest.
16. *(Nits taken in 112.)* The two models in `EXPORT_MODELS`; `contracts.dbtest.ts` proves cross-tenant isolation by behaviour; every draft update `select`s; the editor round-trips its JSON before the action; `contract:delete` is owners and managers (the e2e deletes as a manager).

**Slice 112b (designed here, built there):**

3. *(M — parties.)* The GUARD builds `parties` at sending from `tenant`, `client` (and the agency's details as Settings → Invoicing holds them); whatever the app sent is overwritten (the invoice snapshot precedent). The signer's and sender's names and emails are copied from `contact` and `"user"` (not `member`).
4. *(M — bound to what the sender saw.)* The send dialog carries the draft's `updated_at` as read; the send's WHERE refuses a draft changed since (`CONTRACT_CHANGED`) — the issue fingerprint's precedent.
6. *(M — census shape.)* `contract_signature`'s `portal_gate` WITH CHECK keeps the USING terms (not the invoice's "contacts never"); the column list is `portal_contact_columns_only('decided_at','decline_reason','ip','status','typed_name','user_agent')`, entered in `census.dbtest.ts`'s CENSUS and TENANCY §7.2; the policy is WITH CHECK only with "PENDING before" in a transition trigger (the sign-off shape); the census WITH CHECK also requires the contact to be ACTIVE and CONTACT_PRIMARY (Q4: checked at signing too).
7. *(M — the definer.)* The guard recognises the definer by `pg_get_userbyid(proowner)` of `contract_signature_decided`, never a literal role name; the definer pins `search_path`, fires `WHEN (OLD.status = 'PENDING' AND NEW.party = 'CLIENT')`, takes `tenant_id`/`client_id` from NEW, resets its marker; `signed_on` is the date in the tenant's `ui.timezone` preference, validated against the allowlist with the default as fallback; `census.dbtest.ts` pins the set of `prosecdef` functions that write for a contact. Lock order confirmed sound (signature → contract; withdraw/change: contract only).
8. *(L — deferred trigger.)* `AFTER UPDATE OF status … WHEN (OLD.status = 'DRAFT')`, so it runs as the sending member; the COMMIT-time error is mapped (`guarded`) and tested.
9. *(L — xmin.)* An `app.contract_sent_now = <id>` marker set by the guard on DRAFT → SENT, checked by the signature insert guard; the two rows inserted in sequence.
10. *(L — the fingerprint.)* Q1 answered sound. The hash input is `jsonb_build_object('id', id, 'version', version, 'client_id', client_id, 'title', title, 'language', language, 'starts_on', starts_on, 'ends_on', ends_on, 'signer_contact_id', signer_contact_id, 'parties', parties, 'body', body)::text` — no ambiguous concatenation; a known-answer vector pinned in a dbtest. §0 (a)'s "exact bytes … `document_sha256`" is superseded: the column is `content_sha256`; `file_object.sha256` stays the archived PDFs' own hash.
11. *(L — evidence readable by colleagues.)* The client signer's `ip` and `user_agent` go on a CLASS-A row (`contract_signature_evidence`), moved there by the definer — a projection's select is not a database rule (slice 109's payment-note precedent).
16. *(Nits for 112b.)* Fonts traced for `/portal/**`; `level SignatureLevel` on the signature row (SES only, for BankID later); probe downloads in-page in e2e; AGENTS' `/api/jobs/run` paragraph lists the PDF sweep.


## 11. The migration's pre-apply review, and the code and security reviews (2026-10-10)

**Pre-apply review of `20261011120000_contracts`** (a fresh read-only agent): safe to apply, no high or medium. All five lows/nits taken BEFORE applying: the body CHECKs raised to 1 MiB (`jsonb::text` adds ~14% over the normaliser's compact 512 KB; the two CHECKs also mapped to `CONTRACT_TOO_LARGE`); the name CHECK renamed `contract_template_name_shape` (it was a prefix of the unique index `contract_template_name_key`, which the error mapper matches by substring); names and titles stored trimmed (`= btrim(…)`); an UPLOADED contract requires its file (`signed_pdf_file_id`); the domain-error comment and DATA_MODEL corrected (a template's body is nullable). Applied to dev by `prisma migrate deploy`.

**Code review** (fresh agent, read-only) — 3 high, 1 medium, 3 low, 2 nits; **security review** (fresh agent, read-only) — no way for a contact to read or write a draft or a template, no cross-tenant path, no authorization or scope bypass; 1 medium (the same bug as the code review's first), 1 low, 3 nits. Dispositions:

1. *(H, both reviews — an empty body refused.)* `normalizeContractBody(null)` went to `PMNode.fromJSON`, which throws on a falsy input → INVALID_INPUT: a blank template, a template renamed while blank, and a cleared draft could not be saved. **Fixed**: null/undefined is an empty body; unit-tested.
2. *(H — a dbtest assertion that would fail.)* The edit test sent `language: "en"` to an Acme draft that already starts in English. **Fixed**: it sends "sv".
3. *(H — an e2e strict-mode violation.)* `getByLabel("Client")` also matched "Who signs for the client". **Fixed**: `{ exact: true }`.
4. *(M — typing lost during a save.)* Both editors were keyed on `updated_at`, so the revalidated page remounted them and dropped what was typed meanwhile. **Fixed**: no key; the saved baseline moves locally; the body's dirty mark is a version counter, cleared only when no edit followed the snapshot sent; Save is guarded on the action (`saving`), not on a transition (AGENTS.md).
5. *(L–M — a list item taller than a page cut off in the PDF.)* **Fixed**: list items wrap (no `wrap={false}`).
6. *(L — a stale signer list.)* **Fixed**: an answer for an earlier client pick is dropped.
7. *(L — a deleted signer could not be cleared.)* **Fixed**: the form's baseline is the stored id, so the draft is dirty from the start and Save clears it.
8. *(L, security — `updated_at` not held by the database; two clocks in one save.)* **Fixed in the app now**: a save is ONE raw statement with `updated_at = clock_timestamp()`. **Owed in 112b**, whose send binds to it (§10 item 4): `contract_guard` sets `updated_at` itself on every UPDATE and pins it on INSERT, and drops it from `editable` — the guard is replaced in 112b's migration anyway.
9. *(N, security — `lockDraft` locked before the scope check.)* **Fixed**: scope on an unlocked read, then the lock.
10. *(N — an ordered list's `type` ignored in the PDF.)* **Fixed**: `listMarker` prints 1 / a / A / i / I as the editor shows them; unit-tested.
11. *(N — Swedish.)* "Understruken" (the adjective pattern), "Undertecknare hos kunden" for the signer label; two unused keys removed. **"Kontrakt" KEPT** for contracts: "Avtal" is already the Swedish label for agreements (`Service`, D4) across the app, and two different things both called "Avtal" in one product would confuse; the founder is told.
12. *(N, security — a name containing a token text stays "to fill in"; N — a docstring.)* Accepted (a client named `{{agency_name}}` is not a real case; the send refuses visibly, never silently) / fixed.

**Gates** (the implementing session, after the fixes): `pnpm typecheck` exit 0; `pnpm exec eslint src e2e --max-warnings 0` exit 0; `pnpm test` 2718 passed / 1 skipped with TWO TIMEOUTS — `src/db/client-graph.test.ts` and `src/ratelimit/local.test.ts` — which fail IDENTICALLY on clean `main` with the diff stashed (2696 passed, the same two), so the machine's load, not this slice; both pass alone. `contracts.dbtest.ts` and `contracts.spec.ts` cannot run on dev until `prisma/seed.ts` writes TV16 (every `setupTenant` refuses a short catalogue) — CI, which seeds an empty database, is their first run.

**The narrow re-check of the fixes** (a fresh read-only agent, 2026-10-11): the fixes hold, traced through the pg adapter's parameter handling and the guard's `editable` list. One low — after a successful Create the template editor cleared its "saving" guard while still navigating, so a second click could post a duplicate (refused as a taken name, for a template that was in fact made) — **fixed** (the editor stays saving once it is leaving); one nit — the `router.refresh()` after an action that revalidates its page — **removed**. Re-gated: typecheck 0, lint 0, the touched unit files 339/339.

**CI run 38090784940 (the commit `fa6f541`): test:db 1693/1694 — one assertion of `contracts.dbtest.ts` read a CHECK's refusal (`contract_language`) as `CONTRACT_SIGNER_INVALID`.** The database was right; the TEST's matcher was not: outside production Prisma prefixes an error's MESSAGE with a code frame of the calling source file's lines, and the three lines above that call held the previous assertion's expected literal `"CONTRACT_SIGNER_INVALID"`, which the loose first-token-anywhere match found first (found by a fresh read-only agent, from `@prisma/client` 7.9.1's runtime). Fixed: the helper classifies on Prisma's `meta` (the driver's own error) only — a CHECK by "violates check constraint", a guard by its RAISE token — and prints the whole text on a failed CHECK assertion. Other dbtests share the loose matcher; it bites only when an expected token sits within three lines above a call, so they are left as they are and the trap is recorded.

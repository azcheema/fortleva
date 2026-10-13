# Slices 114 + 114b — THE DIRECT FORTNOX CONNECTION (Phase 4 step 8; founder decision C89)

*Draft 2026-10-12, before the design review.*

## 0. What was decided, and what the research established

**C89 (all four WITH the recommendation):**
- **(a)** Fortnox's Developer Agreement (2021-06-10) §5.2 forbids using the API "for products or services that are competing with Fortnox current or future products"; §5.7: a use outside those limits waits for Fortnox's **written consent**. The founder asks Fortnox in writing; the build goes ahead against a **FAKE Fortnox**; **nothing is sent to a real Fortnox company until Fortnox replies OK.** (Verified in the PDF itself, 2026-10-12.)
- **(b)** The connection sends **the same entries the bookkeeping file holds**, straight into Fortnox's books, **each with its invoice's PDF attached**. Nothing else in Fortnox changes; paid is still marked by hand.
- **(c)** **Every night, by itself.** A mistake is corrected by a reversing entry, as the file does today. If the connection breaks, **the owners are told.**
- **(d)** **Owners only, with their authenticator code typed in the form, every owner emailed** — connect and disconnect.
- *Stated when asking:* a Fortnox **service account** (not a person's login); every workspace may use it, the integration **unlisted** until C5; **the file stays** for a workspace without a connection, and **once connected new entries go to Fortnox only — never both**; Naxdor's Fortnox needs the integration add-on (189 kr/month unless its plan includes it).

**Research (two passes, 2026-10-12; Fortnox's own pages and the OpenAPI document embedded at `apps.fortnox.se/apidocs`):**
- **Registration:** a Swedish company; a Fortnox customer gets the developer portal free; an app gets a Client-Id/Secret; an integration left **hidden** is usable by customers who know its Client-Id ("preferable for private integrations"); publishing is a review, optional. Up to 30 sandbox test companies.
- **Customer licences:** the integration add-on (`2001103 "Api-licens saknas"` / `error_missing_license` without it), plus Bokföring for the `bookkeeping` scope.
- **Service account:** authorize `https://apps.fortnox.se/oauth-v1/auth?…&account_type=service` (enabled for the app in the portal; **only the customer's system administrators** may consent; ONE per client-id and customer). Then **`grant_type=client_credentials`** at `https://apps.fortnox.se/oauth-v1/token` with Basic auth and a **`TenantId`** header (the company's `DatabaseNumber` from `GET /3/companyinformation`, or the token's `tenantId` claim): a 1-hour access token, **no refresh token**, the consent "valid indefinitely until [the customer] actively choose[s] to revoke it". **So Fortleva keeps NO per-workspace secret** — only the TenantId, which is useless without the app's own secret AND the customer's consent. PKCE optional (S256 only) unless the app turns "PKCE required" on. The code exchange returns access + refresh tokens (refresh 45 days, rotating) — we use the access token once and **keep neither**.
- **Integrator-side revoke of a service consent: UNCONFIRMED** (only `POST /oauth-v1/revoke` of a refresh token is documented). A customer removes the integration in Fortnox ("Manage integrations"); "Consent created" / "Consent revoked" **webhooks** exist (payload/signing UNCONFIRMED) — not relied on.
- **Scopes needed:** `bookkeeping` (vouchers, financial years, voucher series, accounts), `companyinformation`, `inbox` + `connectfile` (attach a file to a voucher), `settings` (the locked period). Every scope is read+write; adding one later needs a new consent.
- **Rate limit:** 25 requests per 5 s per client-id and tenant (429 beyond).
- **Vouchers:** `POST /3/vouchers?financialyear={Id}` `{"Voucher":{Description ≤200, Comments ≤1000, TransactionDate, VoucherSeries, VoucherRows:[{Account, Debit, Credit, TransactionInformation ≤100}]}}` → `VoucherNumber`, `Year`. **No update, no delete** via the API (in the app only the newest of a series while its period is open). The series must be **manual** (`2001940`). **No idempotency key, and no server-side search on text**; `GET /3/vouchers/sublist/{series}?financialyear&fromdate&todate` lists `Comments`, `Description`, `VoucherNumber`, `TransactionDate` — so a retry can list one day of one series and match our marker in `Comments` client-side.
- **Attaching:** `POST /3/inbox?path=inbox_v` (multipart `file`; PDF/TIF/JPG) → `File.Id`; then `POST /3/voucherfileconnections?financialyear={Id}` `{"VoucherFileConnection":{FileId, VoucherSeries, VoucherNumber (string)}}`. One uploaded file per connection (GET/DELETE keyed by FileId alone — one file, one voucher; inferred).
- **Pre-checks:** `GET /3/financialyears?date=` (empty list → no year; each year carries `AccountingMethod` **`ACCRUAL` | `CASH`**); `GET /3/voucherseries/{code}?financialyear=` (`Manual`); `GET /3/accounts/{n}?financialyear=` (`Active`); `GET /3/settings/lockedperiod` (`EndDate`).
- **Company information:** `CompanyName`, `OrganizationNumber`, `DatabaseNumber`.

## 1. Two slices

- **114 — THE CONNECTION.** Settings → Invoicing gains a **Fortnox** card: connect (owner + code → Fortnox's consent screen → back), the company it is connected to, a **check** of what Fortnox still needs (financial year, series, accounts, method), disconnect (owner + code). Every owner mailed at each. **Nothing is sent.** The Fortnox client (live + fake), the configuration, the connection record, the new permission code.
- **114b — THE NIGHTLY SEND.** The jobs route makes, once a workspace-night, the next file **as SYSTEM** for a connected workspace and delivers its entries in order — each a voucher, its PDF attached — recording Fortnox's numbers; a failure stops the line and tells the owners once; the Bookkeeping page shows what went where. The year end (a person's act) is delivered the same way.

Each slice is its own commit, with its own code + security review; ONE design review now covers both (the 113/113b precedent).

## 2. Configuration — `src/config` (slice 114)

- `FORTNOX_CLIENT_ID`, `FORTNOX_CLIENT_SECRET` — the integration's (the founder registers it; RUNBOOK gets the steps). The secret never printed, never logged, never sent to the browser.
- **`FORTNOX_TRANSPORT`: `off` | `fake` | `live`.** **Default `off` in production, `fake` everywhere else.** **`fake` is REFUSED in production** (a fake would "deliver" into nothing and mark entries sent — the worst failure this slice could have). `live` requires both keys (config refuses to start otherwise). **This is how C89 (a) is enforced:** production is `off` until the founder sets `live` after Fortnox's written OK; a developer may point `live` at a Fortnox **sandbox** test company deliberately. `off` → the card says "Not available yet" and the job does nothing.
- The redirect URI: `${appOrigin}/settings/invoicing/fortnox/callback` (the single app host — decision 8; registered in the Fortnox portal). Built in `src/config`, no hostname elsewhere.
- Fortnox's hosts (`apps.fortnox.se`, `api.fortnox.se`) are constants in `src/config` (no hostname outside it).

## 3. The Fortnox client — `src/integrations/fortnox/` (slice 114; used by 114b)

- **`client.ts`** — one typed function per call: `exchangeCode`, `tenantToken` (client credentials, cached in-process for 55 min per TenantId), `companyInformation`, `financialYearOn(date)`, `voucherSeries(code, yearId)`, `account(n, yearId)`, `lockedPeriod()`, `createVoucher`, `vouchersOnDay(series, yearId, day)`, `uploadToInbox(bytes, name)`, `connectFile(fileId, series, number, yearId)`, `fileConnection(fileId)`.
  - `fetch` with `AbortSignal.timeout(15_000)`, `redirect: "error"`, `cache: "no-store"`; the response body read with a size cap (1 MB); JSON parsed defensively (each field checked).
  - **Errors classified** (`FortnoxError` with a `kind`): `auth` (401, `invalid_client`, a token refused for the TenantId — the consent is gone), `licence` (`2001103`, `2001101`), `refused` (a 4xx with Fortnox's `ErrorInformation {code, message}` — kept: the code, and the message cut to 200 characters for the owners to read), `rate` (429), `unknown` (5xx, timeout, network — **for a POST the outcome is UNKNOWN**).
  - **A per-TenantId limiter** in-process: at most 20 requests per 5 s (headroom under 25); on 429 the run for that workspace ends (the next run continues).
  - Logs: the call's name, status and Fortnox's error code — never a token, never a body.
- **`fake.ts`** — the in-process FAKE Fortnox (the `fake` transport): companies keyed by TenantId, financial years, series, accounts, vouchers numbered per series and year, an inbox and file connections; and test hooks (`refuseNext(code, message)`, `timeoutAfterCreate()`, `revokeConsent()`), exported for dbtests only. The e2e server uses the same fake; its consent screen is our own route (§4.3) — **only when the transport is `fake`, never in production** (the config refuses `fake` there).

## 4. The connection (slice 114)

### 4.1 Permission

**New code `invoice:connect_bookkeeping`** (module invoicing) — "Connect the workspace to its bookkeeping program (Fortnox), and disconnect it" — **seeded C (owners) only, ✦**. Catalogue 116 → 117; **TV17 seed owed** (dev already owes TV16). Every verb also asks `invoice:view` and the member's code **typed in the form**, verified by the action seconds before (`verifyStepUpWithHeaders`), then `requireRecentMfa(…, 1)` — the bank details' window (`INVOICE_DETAILS_STEP_UP_MINUTES`).

### 4.2 Data — migration `20261019090000_fortnox_connection` (DDL only)

**`integration_connection`** (new, CLASS A — the DATA_MODEL §6.13 placeholder, made real for one provider; no credentials column — a service account needs none):
`id uuid(7)`, `tenant_id`, `provider` (enum `IntegrationProvider`: `FORTNOX`), `status` (enum: `ACTIVE`, `BROKEN`, `DISCONNECTED`), `external_tenant_id TEXT` (Fortnox's DatabaseNumber, digits), `company_name TEXT`, `company_org_nr TEXT`, `connected_by_member_id`, `connected_at`, `disconnected_by_member_id NULL`, `disconnected_at NULL`, `broken_since NULL`, `broken_reason JSONB NULL` (`{kind, code?, message?, entryId?, day?}`), `last_ok_at NULL`, `last_night TEXT NULL` (114b: the workspace day of the last nightly file, `YYYY-MM-DD`), `created_at`.
- UNIQUE `(tenant_id, provider) WHERE status <> 'DISCONNECTED'` — one live connection per workspace.
- **UNIQUE `(provider, external_tenant_id) WHERE status <> 'DISCONNECTED'`** — one Fortleva workspace per Fortnox company (Fortnox allows ONE service consent per app and customer: two workspaces on one consent would share its revocation, and a second connection is far more likely a mistake than a need). A collision says only "this Fortnox company is already connected to another Fortleva workspace" — **a cross-tenant fact, see §9 Q1.**
- CHECKs: status ↔ the disconnected pair (both set iff DISCONNECTED); `broken_since` set iff BROKEN; `external_tenant_id ~ '^[0-9]{1,20}$'`; name ≤ 200, org nr ≤ 20.

**`integration_connect_attempt`** (new, CLASS A) — one row per press of Connect:
`id`, `tenant_id`, `member_id`, `state_hash TEXT UNIQUE` (SHA-256 of the 256-bit `state`), `pkce_verifier TEXT NULL` (cleared on use), `created_at`, `expires_at` (+10 min), `used_at NULL`, `outcome TEXT NULL` (`CONNECTED` or a refusal's code).

**Guards** (each `BEFORE INSERT OR UPDATE OR DELETE`; every GUC read `coalesce(…, '') = 'on'` — memory `plpgsql-null-guc-trap`):
- `integration_connection_guard`:
  - INSERT: a member, as themselves, holding `invoice:connect_bookkeeping` (`invoice_member_holds`), status ACTIVE, connected now (±5 min), and **an attempt of theirs used in THIS transaction** (`xmin = pg_current_xact_id()`, outcome `CONNECTED`).
  - UPDATE by a member: only ACTIVE/BROKEN → DISCONNECTED, by a holder of the code, `disconnected_by` = them, now; nothing else changes.
  - UPDATE by SYSTEM behind `app.integration_upkeep` (set only by the 114b sender — a census test): only `status` ACTIVE ↔ BROKEN, `broken_since`, `broken_reason`, `last_ok_at`, `last_night`; never a DISCONNECTED row; never the identity columns.
  - DELETE: maintenance only (`app.invoice_maintenance` as `app_platform`).
- `integration_connect_attempt_guard`: INSERT by a member as themselves holding the code, expiring in exactly 10 minutes; UPDATE only `used_at` (once, before `expires_at`, by the same member), `pkce_verifier` → NULL, `outcome` (once); DELETE maintenance only.

Grants `SELECT, INSERT, UPDATE` on both to `app_runtime`; RLS `tenant_isolation` + `portal_deny`; both in `MODEL_CLASSES` + `RLS_CLASSES` (A); the export's manifest (the connection is the tenant's data; the attempt's verifier is NULL once used, and an unused one is ten minutes old at most — the export may leave the column out).

### 4.3 Connecting — the flow

1. **The card** (Settings → Invoicing, below Bookkeeping; `settings:view` + `invoice:view`, the invoicing module open): not connected → what the connection does in two sentences, what Fortnox needs (the integration add-on, a system administrator to approve, a voucher series of its own marked manual — the setting's, default `F` — and the financial year), and **"N entries not yet in any file will go in the first night (dated A–B). If they are already in your books, make a file of them first."** (`readBookkeeping`'s `next`, see §9 Q2). A **Connect to Fortnox…** button for holders of the code.
2. **The dialog** asks the code. The action verifies it, then `beginFortnoxConnect(ctx)`: the gates (§4.1); the workspace's **organisation number must be filled in** on the company card (else `FORTNOX_NO_ORG_NR`, linking the card); a fresh `state` (32 random bytes, base64url) and PKCE verifier; the attempt row; audit `integration.connect_started` `{provider}`; returns the consent URL. The client navigates to it (`window.location.assign`).
3. **Fortnox's consent screen** (a system administrator signs in and approves the scopes; `account_type=service`). Fake transport: our route `/settings/invoicing/fortnox/fake-consent` redirects straight back with a code bound to a fake company whose org. number is the workspace's (and a hook for a mismatching one).
4. **The callback** `GET /settings/invoicing/fortnox/callback?code&state` (or `?error&state`), a route under `(tenant)/(authed)` (`requireTenantContext` — the member's session; a top-level redirect carries the `SameSite=Lax` session cookie):
   - Find the attempt by `sha256(state)` **in this tenant, of this member, unused, unexpired**; else redirect with `?fortnox=EXPIRED`. Mark it used (its own short transaction, committed first — single use even if what follows fails).
   - `error` from Fortnox → `?fortnox=DENIED` / `?fortnox=NO_LICENCE` (`error_missing_license`) — never Fortnox's text in a URL.
   - Exchange the code (with the verifier) → an access token; **the refresh token is dropped unread** (never stored, never logged; not revoked — revoking it might end the service consent, UNCONFIRMED).
   - `GET /3/companyinformation` → name, org. number, DatabaseNumber. **The org. number's digits must equal the workspace's company card's** (else `?fortnox=ORG_MISMATCH`, the page naming both companies — the main protection against "connect the wrong company", with the state binding against a forged callback).
   - **Prove the service consent:** a client-credentials token for that TenantId (else `?fortnox=NOT_SERVICE` — consented as a user, not a service account).
   - One member transaction: the export lock (`invoice_export_lock` — every maker's order, so a file being made and a connection appearing never interleave), the gates again (`invoice:connect_bookkeeping`, `invoice:view` — not the code: it was typed at step 2, ≤10 min before, and the attempt carries it), a BROKEN connection of the workspace → DISCONNECTED (reconnecting replaces it), the new ACTIVE row, the attempt's `outcome = CONNECTED`, audit **`integration.connected`** `{provider, companyName, orgNr, externalTenantId}`, every active owner mailed (`INTEGRATION_CONNECTED_MAIL` — a link to the card, never the details, `noticeToOwners`' rule).
   - Then **the check** (§4.4) runs once and its result is shown on the card the redirect lands on.
5. **Disconnect…** (holders of the code; the code typed): the export lock, the row → DISCONNECTED, audit **`integration.disconnected`** `{provider, companyName}`, owners mailed. The card then says: to remove Fortleva from Fortnox entirely, a system administrator removes it under *Manage integrations* in Fortnox (integrator-side revoke UNCONFIRMED). 114b: what was made for Fortnox and not yet sent stays listed, downloadable (§5.6).

### 4.4 The check — "Is Fortnox ready?"

Read-only GETs with a client-credentials token, run after connecting and by **Check again** (the card's viewers who hold `invoice:export` or the code; at most once a minute per workspace — an in-process limit, the route's precedent): the token (consent alive), the financial year of today (exists; its `AccountingMethod` matches the workspace's method — `CASH` ↔ cash method, `ACCRUAL` ↔ invoice method; a mismatch is a warning, the person's books), the series (exists, **manual**), each of the ten accounts (exists, active), the locked period (shown: "Fortnox is locked up to 30 Sep" — entries dated before it would be refused). A checklist; nothing written (no audit — a read; §9 Q5).

## 5. The nightly send (slice 114b)

### 5.1 Data — migration `20261020090000_fortnox_send` (guards replaced: pre-apply review)

- **`invoice_export`**: `+ destination` enum `InvoiceExportDestination` (`DOWNLOAD` default, `FORTNOX`); `+ connection_id NULL` (FK `(tenant_id, connection_id)` → `integration_connection`); **`created_by_member_id` becomes NULLABLE**; CHECKs `(destination = 'FORTNOX') = (connection_id IS NOT NULL)` and `created_by_member_id IS NOT NULL OR (destination = 'FORTNOX' AND year_end IS NULL)`.
- **`invoice_export_guard` replaced word for word, plus:**
  - a **SYSTEM branch**: `app.principal = 'system'` AND `coalesce(current_setting('app.fortnox_sending', true), '') = 'on'` AND `created_by_member_id IS NULL` AND destination `FORTNOX` AND `year_end IS NULL` AND the connection (this tenant's) **ACTIVE**, read `FOR SHARE` after the export lock;
  - **the destination rule for everyone** (after the lock): a live (ACTIVE or BROKEN) connection exists ⇔ the file is `FORTNOX` to THAT connection — **"never both", held by the database**: no download file while connected, no Fortnox file without one. (A BROKEN connection still takes a member's year end: it is delivered when Fortnox answers again.)
- **`invoice_export_entry_guard` replaced word for word, plus** the principal check widened to the system branch above (the GUC, and the file made in this transaction with `created_by_member_id IS NULL`); every event rule unchanged.
- **`invoice_export_delivery`** (new, CLASS A) — one row per entry WITH a voucher in a `FORTNOX` file (a credit note's listing books nothing and needs none):
  `entry_id` PK (FK `(tenant_id, entry_id)` → `invoice_export_entry`), `tenant_id`, `export_id`, `connection_id`, `state` (`PENDING`, `BOOKED`, `DONE`, `BY_HAND`), `fortnox_year INT NULL` (the financial year's Id), `fortnox_series TEXT NULL`, `fortnox_number INT NULL`, `files JSONB NOT NULL DEFAULT '[]'` (`[{invoiceId, fileId, connected: bool}]`), `attempted_at`, `booked_at NULL`, `done_at NULL`, `handled_by_member_id NULL`, `created_at`.
  - CHECKs: the Fortnox triple set iff state ∈ {BOOKED, DONE}; `handled_by_member_id` set iff BY_HAND.
  - UNIQUE `(tenant_id, connection_id, fortnox_year, fortnox_series, fortnox_number)` — one Fortnox voucher is one entry.
  - **`invoice_export_delivery_guard`**: INSERT by SYSTEM behind `app.fortnox_sending`, state PENDING, its entry's file `FORTNOX` to this connection; UPDATE forward only — PENDING → BOOKED (the triple set once) → DONE (every file connected), or PENDING/BOOKED → BY_HAND by a **member holding `invoice:export`** as themselves (§5.5); the Fortnox triple never changes once set; DELETE maintenance only.

### 5.2 The night — `src/jobs/fortnox-send.ts` → `src/modules/invoicing/fortnox-send.ts`

Discovery (`withPlatform`, read-only, ids only): SENDING tenants with an ACTIVE or BROKEN Fortnox connection. Per workspace, under its OWN system principal, in a random order, within **a minute a run** across workspaces (113's budget), each workspace's failure its own (logged by name and code only):

1. **The transport is not `off`**, the invoicing module open, the connection ACTIVE or BROKEN.
2. **A token** (client credentials). Refused (`auth`/`licence`) → BROKEN with that reason (§5.4); stop.
3. **Deliver what is owed**, oldest file first, entries in the SIE file's order (by date, then position) — **strictly in order: the first that cannot go stops the line** (a reversal must never reach Fortnox before what it reverses, and the accountant should see one problem, not a scatter).
4. **Only when nothing is owed and the workspace's day has moved on since `last_night`** (the first run after midnight in the workspace's zone — the night; §9 Q3): make the next file **as SYSTEM** (`createExport`'s body, with `destination FORTNOX`, `created_by NULL`, under `app.fortnox_sending`), set `last_night`, then deliver it (step 3).
5. A workspace whose connection was BROKEN and now delivered or checked cleanly → ACTIVE (`last_ok_at`), audited `integration.restored` (SYSTEM).

The file's making is `createExport`'s plan/lock/select/build, factored so both a member's press and the night use ONE body (the principal and the destination the only differences). `EXPORT_MAX` (1 000) holds; a backlog takes several files, each delivered before the next is made — so the FIRST night after connecting may take several hours of runs for a large backlog (§9 Q2).

### 5.3 Delivering one entry

1. **Its PDFs**: the entry's document's archived PDF (`invoice.pdf_file_id`) and, for a PAYMENT, each credit note it deducted (`detail.deductedIds`). One not archived yet → stop (the PDF backstop runs earlier in the same route; next run). Read from storage as the download does.
2. **Its financial year**: `financialYearOn(booked_on)` (cached per run). None → stop, reason `NO_FINANCIAL_YEAR {day}`.
3. **Intent first:** INSERT the delivery row PENDING (`attempted_at` now) and **commit** — so a crash between Fortnox's answer and our record leaves a PENDING row, never silence.
4. **`createVoucher`** — `VoucherSeries` = the file's series; `TransactionDate` = `booked_on`; `Description` = the voucher's text (≤50 already, C82's H1); **`Comments` = `Fortleva <entry id>`** (the marker); rows: `Account`, and the signed amount as `Debit` (positive) or `Credit` (negative), to the öre (decimal strings → numbers with two decimals; every voucher balances by construction — the entry guard's `invoice_export_voucher_ok`).
   - **Answered** → UPDATE BOOKED with Fortnox's year, series and number.
   - **Refused** → the row stays PENDING… *no*: a refusal is CERTAIN (nothing created) — the PENDING row is kept as the record of the attempt and the line stops with that reason (§5.4); the next attempt re-uses it.
   - **Unknown** (timeout, 5xx, network) → stop; the row stays PENDING.
5. **A PENDING row at the start of a run** (a crash, an unknown answer, a refusal) → **reconcile before re-sending**: `vouchersOnDay(series, year, booked_on)` and look for `Comments` = our marker (each candidate fetched when the list lacks Comments). Found → BOOKED with its number (never a second voucher). Not found → send (step 4). The list failing → stop (unknown stays unknown).
6. **Attach**: for each PDF not yet connected — `uploadToInbox` (a lost upload only leaves an orphan in Fortnox's inbox: harmless; re-uploaded), record the FileId, `connectFile`; an unknown answer → `fileConnection(fileId)` before trying again. All connected → DONE.
7. When a file's every delivery is DONE or BY_HAND (and its listing-only entries need none): audit **`invoice_export.sent`** `{number, vouchers, fortnoxSeries, fortnoxFrom, fortnoxTo, byHand}` as SYSTEM.

Each step's DB write is its own short system transaction (with `app.fortnox_sending` set by the module alone — `fortnox-census.test.ts`, the renewals' precedent); **no HTTP call inside a transaction**.

### 5.4 When it breaks — the owners are told

A stop's reason goes on the connection: `BROKEN`, `broken_since` (first time only), `broken_reason {kind, code, message (≤200), entryId, day}` — audited `integration.broken` (SYSTEM) **only on the ACTIVE → BROKEN step**, and the owners told ONCE per breakage: an inbox notice **`integration.fortnox_stopped`** (owners, coalesced by connection + `broken_since`) and an email to each active owner (operational, their email level respected — not a security notice; §9 Q4). It names the reason in plain words ("Fortnox has no financial year for 15 Jan 2027 — add it in Fortnox"; "the account 3001 is not active in Fortnox"; "Fortnox is locked up to 30 Sep — entries dated before it are refused"; "Fortnox no longer accepts Fortleva — a system administrator must connect it again"; "Fortnox said: <its message>") and that **nothing is lost: Fortleva tries again every hour**. A later reason while still BROKEN updates the card, not the inbox.

Kinds: `CONSENT_GONE`, `NO_LICENCE`, `NO_FINANCIAL_YEAR`, `SERIES` (missing / not manual), `ACCOUNT` (missing / inactive), `PERIOD_LOCKED`, `PDF_MISSING` (only after 24 h — before that it is the backstop's ordinary lag, not a break), `REFUSED` (anything else, with Fortnox's code and message).

### 5.5 "Booked by hand in Fortnox"

A stuck entry the accountant has dealt with in Fortnox (booked by hand, or decided not to) is marked **Booked by hand** on the Bookkeeping page by a holder of `invoice:export` (with `invoice:view` and the tenant-wide scope — the page's own gates): the delivery row → BY_HAND, audited **`invoice_export.entry_booked_by_hand`** `{number, entryId, event, invoice}`; the line moves on at the next run. Asked first (danger tone: Fortleva will never send it).

### 5.6 The Bookkeeping page

- **Connected:** "Make file" gives way to **"Sent to Fortnox every night — N entries wait for tonight"** (the plan's count); the connection's state (OK, or the reason, with Check again).
- **The files list:** a Fortnox file says **"Sent to Fortnox — F 12–19"** (series and numbers), **"Sending — 3 of 8"**, or **"Stopped at <invoice> <event>: <reason>"** with Booked by hand. Its **list (.xlsx) stays downloadable**; its **SIE does not** (importing it would book twice) — **except its UNSENT entries once the connection is gone** (disconnected with entries owed: "Download the 4 entries not sent", an SIE of just those, and Booked by hand for each).
- The year end (`bookYearEnd`) while connected makes a FORTNOX file (a member's; the guard's destination rule), delivered at the next run.

## 6. Audit catalogue

`integration.connect_started`, `integration.connected`, `integration.disconnected` (members); `integration.broken`, `integration.restored` (SYSTEM); `invoice_export.sent` (SYSTEM); `invoice_export.entry_booked_by_hand` (member). `invoice_export.created` gains `destination` in its metadata and may be SYSTEM. Notification kind `integration.fortnox_stopped` (owners; inbox + mail; reason `OWNER_NOTICE`?—reuse the owners' reason if one exists). Mail kinds `INTEGRATION_CONNECTED_MAIL`, `INTEGRATION_DISCONNECTED_MAIL` (security notices, `noticeToOwners`), `FORTNOX_STOPPED_MAIL`.

## 7. Security notes (for the review)

- **No per-workspace secret is stored.** The app's client secret is the only credential, in the environment. A leaked database gives TenantIds, useless without the secret and a customer's consent to THIS app.
- **The connect is the dangerous moment** (the connection decides where every client's invoices go): owners only (✦ code, seeded C), the code typed in the form within a minute, every owner mailed; the callback bound to a single-use, ten-minute, hashed state of THIS member in THIS workspace with PKCE; **the Fortnox company's org. number must match the workspace's**; a service consent proven.
- **What leaves Fortleva:** vouchers (accounts, amounts in kronor, a ≤50-character text naming the client and the invoice number) and the invoices' PDFs (the client's name, address, lines) — to the tenant's own Fortnox, on the tenant's instruction, under the tenant's own agreement with Fortnox (SECURITY.md's integrations row, §465: Fortleva is the tenant's *försystem*; Fortnox is the tenant's processor, not ours). The Developer Agreement §12.3 wants a data processing agreement between the integrator and the customer — **the Phase 7 ToS/DPA must name the Fortnox transfer** (a note for Phase 7, nothing to build).
- **SSRF:** only Fortnox's two fixed hosts; `redirect: "error"`.
- **Fortnox's error text** is shown to owners (React-escaped, ≤200 characters) and stored on the connection; logs carry only Fortnox's numeric code.
- **The GUCs** `app.fortnox_sending` and `app.integration_upkeep` are set by `fortnox-send.ts` alone (a census unit test greps the tree).
- **The callback is a GET with an effect** — unavoidable for OAuth; the state is the CSRF defence, single-use, and the effect is idempotent on refresh (a used state redirects EXPIRED).

## 8. Tests

- **Unit:** the voucher's Fortnox shape (signs → Debit/Credit, öre exact, the marker), error classification (each documented code), the limiter, state/PKCE (S256 of the verifier), the config's transport rule (`fake` refused in production; `live` without keys refused; default `off` in production), the census of the two GUCs, the reconcile matcher.
- **dbtest** `fortnox.dbtest.ts` (prefix `fnx-`, registered in `DBTEST_PREFIXES`): the connection guard (member connect only with an attempt used in-tx; disconnect; system upkeep only behind the GUC and only its columns; DELETE refused); the attempt guard; the two cross-row uniques; **the export guard's system branch** (refused without the GUC, without an ACTIVE connection, with a member id, with a year end) and **the destination rule** (no DOWNLOAD while connected, no FORTNOX without); the entry guard's system branch; the delivery guard (forward only, the triple set once, BY_HAND by an export holder only); **a full night against the fake** — the file made as SYSTEM, every voucher sent in order with its PDF, the numbers recorded, `invoice_export.sent`; **an unknown answer reconciled** (the fake creates then times out: one voucher in Fortnox, BOOKED with its number, never two); a refusal stops the line, BROKEN once, one notice, later runs silent, restored when it goes; a missing financial year; Booked by hand; disconnect with entries owed.
- **e2e** `fortnox.spec.ts`: Settings → Invoicing → Connect (code typed) → the fake consent → back, the card names the company and the check; Disconnect (code); the Bookkeeping page connected; `seed-cli`'s `run-fortnox-night` for the e2e tenant only → "Sent to Fortnox — F 1–n".

## 9. Questions for the review

- **Q1 — the cross-tenant unique on the Fortnox company.** It tells an owner of workspace X that the Fortnox company they administer is connected elsewhere. Keep (one consent per app and customer makes two workspaces fight over one revocation), or drop and let two workspaces share a company?
- **Q2 — the first night's backlog.** Everything not yet in any file goes on the first night. The card says how many and from when, and the escape is to make a file of them first. Enough, or does connecting need a "start from" date? (A "start from" date would leave entries in NO file and none in Fortnox — the gap the one-file rule exists to prevent.)
- **Q3 — "the night".** The first run after the workspace's midnight makes the file; delivery of anything owed happens every run. Events dated today are taken too (a payment marked at 00:30). Fine, or should the night take only events dated before today — which the cash method's reversals (dated the file's day) make awkward?
- **Q4 — the stopped notice.** Owners only (C89 (c)) — should the holders of `invoice:export` (who see the page) be told too? Email at their level, or always, like a security notice?
- **Q5 — the check is unaudited.** It writes nothing in Fortleva and reads the tenant's own Fortnox. Agreed?
- **Q6 — a voucher's PDFs.** The entry's document, plus a payment's deducted credit notes. Year-end vouchers and reversals get their invoice's PDF too. Right?
- **Q7 — strictly in order.** One stuck entry holds everything after it until a person acts or Fortnox is fixed. Right for books — or should unrelated invoices pass it?
- **Q8 — the guards replaced word for word** (two big plpgsql functions). Alternatives: a new BEFORE trigger that runs first and handles the system principal, leaving the old guards untouched — but they refuse `who <> 'member'` outright, so they must change. Any cheaper safe shape?

## 10. The design review (2026-10-12/13) — §10 OVERRIDES THE BODY

Two fresh read-only reviewers: **correctness** (R — 3 HIGH, 7 MEDIUM, 6 LOW, NITs) and **security** (S — 1 HIGH, 4 MEDIUM, 5 LOW, 5 NIT). Every claim that rests on code was checked (`invoice_export_lock` refuses every principal but a member — `20261010230000`:200; the newest entry guard is `20261011090200`'s; `isProduction` is `NODE_ENV` alone and the e2e server is a production build — config:126, playwright.config). **Every finding is TAKEN unless it says otherwise.** One product question came out of it, asked and answered: **C89 (e)** — a stopped connection is told ONCE, then REMINDED EVERY MONDAY while still stopped.

### 10.1 One sender at a time, and what "unknown" means (R1, S4, R11 — HIGH)

- **A LEASE per connection:** `integration_connection.send_lease_until`, `send_run_id` (uuid). A run claims it by a conditional UPDATE (`… WHERE send_lease_until IS NULL OR send_lease_until < now() RETURNING`; advisory locks do not survive a pooler's transaction mode), 10 minutes, released at the run's end. **Every delivery write** (→ SENDING, → BOOKED, → DONE, SENDING → QUEUED) requires `app.fortnox_run` = the connection's `send_run_id` with the lease live and the connection not DISCONNECTED — read `FOR SHARE` in the delivery guard. **Booked by hand is refused while a lease is live** (`FORTNOX_BUSY`: "Fortleva is sending to Fortnox right now — try again in a minute"). **Disconnect is NOT refused** (S5: it is the kill switch): it commits, the run's next write is refused, the run stops (§10.4).
- **A SENDING row is reconciled only when its `attempted_at` is over 2 minutes old** (longer than any round trip — a voucher Fortnox makes after our 15-second abort lands within it); a younger one stops the line until the next run.
- **Reconcile by number, not by day (R11):** before `createVoucher`, the series' `NextVoucherNumber` is read and stored on the SENDING row (`fortnox_next_before`). Reconciling fetches each voucher from that number up to the series' current next − 1 (`GET /3/vouchers/{series}/{n}?financialyear=` — `Comments` is on each) and matches `Fortleva <entry id>`. Bounded by what was made since; no pagination question (S4's).
- **Lifecycle (R5, R6):** delivery rows are made **QUEUED with the file, in its transaction, by its maker** (the night or a member's year end) — one per entry with a voucher; "owed" is a query. `QUEUED → SENDING → BOOKED → DONE`; `SENDING → QUEUED` (refused for certain, or reconciled and not found — `attempted_at` bumped by the next SENDING); `QUEUED → BY_HAND` and `BOOKED → BY_HAND` (a member holding `invoice:export`: **"it is in Fortnox's books"** — R13 — for a BOOKED one, "its PDFs are attached by hand"); `QUEUED → DOWNLOADED` (§10.2). CHECKs: the Fortnox triple NULL in QUEUED/SENDING/DOWNLOADED, set in BOOKED/DONE, either in BY_HAND (kept once set, never changed); BOOKED → BOOKED only to record FileIds. **Strict order applies to the VOUCHER (Q7):** the line moves on once an entry is BOOKED; its attachments are retried every run on their own, and a BOOKED entry still missing a PDF after 24 h is reported (`PDF_MISSING`).
- **`invoice_export.sent`** is written in the transaction that moves a file's last owed row (under the lease — exactly once, R14).

### 10.2 Reconnecting, disconnecting, and what is owed (R2 — HIGH; S3, S5)

- **Reconnecting to the SAME Fortnox company (same DatabaseNumber) REACTIVATES the same row** (a member's BROKEN → ACTIVE through a fresh attempt: owner + code + consent + the org check), so its owed files go on. **A DIFFERENT company needs Disconnect first.** Audited `integration.reconnected`.
- **CONSENT_GONE, NO_LICENCE and COMPANY_CHANGED are TERMINAL (S3):** the night never tries such a row again — a consent given through ANOTHER workspace would otherwise revive it and push its backlog into a company that removed it on purpose. Only a member's reconnect brings it back. Other kinds (no financial year, an account, the series, a lock, a refusal, a PDF) are retried every run.
- **After a Disconnect**, owed entries are listed on the Bookkeeping page: **QUEUED ones** download as an SIE of just those, which marks them **DOWNLOADED** in the same transaction (audited `invoice_export.unsent_downloaded`), or are marked Booked by hand; **a SENDING one (outcome unknown) is never in that download** — it says "may already be in Fortnox: look in series F from number N for 'Fortleva <ref>' in the comment", and the person marks it **Booked by hand** (it is there) or **Not in Fortnox** (back to QUEUED → downloadable). DOWNLOAD files made before connecting are never sent — the card says so (R16).
- Not taken: keying the voucher unique on the DatabaseNumber (R2's last line) — the row is REUSED for the same company, so `connection_id` already is the company.

### 10.3 Each company's sales only into its own books (R3 — HIGH)

- **The destination is per SELLER, held by the entry guard:** an entry whose document's seller org. number (the digits of `seller_snapshot->>'orgNr'`, normalised as below) equals the live connection's `company_org_nr` goes **only** into a FORTNOX file to that connection; **any other seller's** entries **only** into a DOWNLOAD file. "Never both" holds per seller. The file-level destination rule of §5.1 is REPLACED by this (a DOWNLOAD file while connected is allowed — it holds another seller's group; a file is one group, one seller).
- The night plans **only the connected seller's** candidates; while connected, **Make file** offers only the others' and shows only when there are any ("12 entries of an earlier company, org. no. …, cannot go to this Fortnox — make a file of them"). Dependencies never cross sellers (a credit note, a payment and a year end are their invoice's seller's). The year end's file takes its year's company's destination (`planYearEnd`'s company).
- The card warns when the company card's org. number differs from the connected Fortnox company's (new invoices would then not go).
- **Org. numbers compared normalised (S6):** both sides through `normalizeOrgNr` (12-digit and `16`/`19`/`20`-prefixed forms); a refusal, an empty or missing value on either side is a MISMATCH — never two empties equal.

### 10.4 The secret, the transports, and a hijacked connect (S1 — HIGH; S2, S5, R9)

- **The app's client secret is a root credential for EVERY connected company** (any consenting TenantId — small integers — plus the secret is a token). §7 is rewritten so: the secret, not the database, is the crown jewel. **TWO Fortnox registrations**: a **TEST** app (consents only from Fortnox sandbox test companies; its secret may live on a developer's machine) and a **PRODUCTION** app whose secret exists **only in production's environment** — never in `.env.local`, never in Vercel Preview, never in GitHub Actions (a future sandbox smoke masks `base64(id:secret)` and every TenantId with `::add-mask::`). RUNBOOK gets the registration, the rotation steps (whether service consents survive a secret rotation — to be tried on the sandbox first) and "PKCE required" turned on (S10). SECURITY.md amended: the integrations rows (348, 367, 465) and T8 — no tokens stored; the secret treated like the root keyring (§6.1).
- **`FORTNOX_TRANSPORT` defaults to `off` EVERYWHERE** (S2, R9); **`fake` is set explicitly** by the harnesses (`playwright.config.ts`, `vitest.db.config.ts`) and **refused on a production build off loopback** (the push and FX rule — the e2e server is a production build on loopback). **`live` requires both keys.** Not taken: S2's two-condition "production only" rule for `live` — it would forbid trying the TEST app against a sandbox from a developer's machine; the two registrations and the tagging below hold the same line.
- **Every connection row is TAGGED** with the transport and the client id that made it (`transport`, `client_id`); a sender **skips every row not its own** — a dev process (test app) never sends for a production row in a database branch, and a fake row is never sent live.
- **The fake** is FILE-BACKED (`.dev-fortnox/`, the dev transports' precedent — the e2e server and `seed-cli` are two processes), keyed by TenantIds in a reserved range (≥ 9 000 000 000) and refusing any other. **The harness has no file storage** (contracts.spec.ts:190), so the e2e can show a voucher BOOKED and its PDF owed — the dbtest covers attachments with a temporary local-disk storage (`setStorage`).
- **The first file waits for the next night (S5):** connecting sets `last_night` to the connect day, so the owners' mail has hours before anything leaves.
- **Every night re-reads `companyinformation`** (one GET, with the client-credentials token): DatabaseNumber and org. number must match the row; drift → BROKEN `COMPANY_CHANGED` (terminal).

### 10.5 The night (R8, R10, R7)

- **The night OPENS** at the first run after the workspace's midnight (`last_night < today`) and **stays open** while files are made back to back — each delivered before the next is made — and **CLOSES** (`last_night = today`) at the first run whose plan picks nothing. Events marked after it closes wait for the next night; a backlog of thousands goes on through the day's runs (R8).
- **Budget (R10):** 45 s a run across workspaces; the deadline checked **before every HTTP call**, its timeout `min(15 s, remaining − 5 s)`, **no `createVoucher` begun with under 20 s left**; while others wait, no workspace takes more than a third of it (S13). About a voucher a second at best: the card says a large backlog takes hours.
- **Restored (R7)** only by a voucher created, or by a run with nothing owed whose token works; **Check again never writes** (Q5).

### 10.6 The rest

- **The lock (R4):** `invoice_export_lock` re-created to admit `app.principal = 'system'` (exactly — `platform_admin` also carries an empty id) with `coalesce(current_setting('app.fortnox_sending', true), '') = 'on'`. The entry guard re-created from **`20261011090200`'s** body. **ONE GUC** (`app.fortnox_sending`) for files, deliveries and the connection's upkeep (R17), set by `fortnox-send.ts` alone (census). **A unit test diffs each re-created function against its previous migration and allows only the marked hunks (Q8).**
- **Connect (R15, S7, S9, S10, S11, S12):** impersonation refused first at begin, callback, disconnect and Booked by hand (the `enterVault` precedent, `door.ts`); `requireAccess` on all four gates in the callback; the attempt found and spent by ONE `UPDATE … WHERE state_hash = $1 AND member_id = $me AND used_at IS NULL AND expires_at > now() RETURNING`; its `outcome` set BEFORE the connection's insert; the connection carries a UNIQUE `connect_attempt_id` (the guard: the same member's, spent in this transaction — `xmin`, outcome CONNECTED); refused connects audited **`integration.connect_refused {provider, reason}`**; the redirect is `?attempt=<id>` and the card renders the outcome from the viewer's OWN attempt row (`outcome`, and for a mismatch the Fortnox company's name and org. number stored on it — never in a URL); the token's `tenantId` claim checked against `DatabaseNumber`, and `companyinformation` read again with the CLIENT-CREDENTIALS token (binding the service token to the same company); the unused refresh token dropped (revoked only if the sandbox shows the consent survives). PKCE verifier kept as a column, cleared on use, **left out of the export** (R15's HMAC not taken: no new key). **No org. number in any audit row** (seller.ts's rule — a sole trader's is a personnummer): `integration.connected {provider, externalTenantId}`.
- **Scopes (R12):** `bookkeeping companyinformation inbox connectfile` — `settings` dropped; a locked period read from the refusal.
- **Reach of the broken reason (S8):** the Settings card shows the state and the kind in plain words only; the entry, the invoice and Fortnox's message only on the Bookkeeping page (tenant-wide scope); every mail generic with a link (ARC-09). **C89 (e):** the stopped notice once (inbox + email at the owner's level), then a reminder every Monday while still stopped (a dedupe key per ISO week).
- **Q1 kept** (both reviews): the message names no workspace and says the other workspace's owner must disconnect; a platform RUNBOOK line for a stale row blocking a company's rightful workspace.
- **Rate limits (S13):** Connect and Check again behind the Upstash limiter (the portal's).
- **Hygiene (S14, S15, R16, R17):** every path and query value built with `URLSearchParams`/`encodeURIComponent`; values from Fortnox (FileId, the year's Id) format-checked before reuse; `FortnoxError` never carries the URL, headers or body; the delivery row's `export_id`/`connection_id` checked against the entry's file; the card counts `count + waiting` across every group; maker names read for non-null ids only; `exportFile` refuses a FORTNOX file's SIE on the SERVER (except §10.2's unsent download); AGENTS.md's jobs-route paragraph gains "SENDS VOUCHERS TO FORTNOX"; the migration spells out grants, RLS, the registry and the export manifest; notification reason `OWNER` reused.
- **S6 (stated, not built):** the org. match guards against mistakes, not against a phished Fortnox administrator of another company — inherent to a shared OAuth app; the platform-wide kill switch is `FORTNOX_TRANSPORT=off`.

### 10.7 What slice 114 builds (the connection), as amended

Config (§10.4), the client and the file-backed fake (§3, §10.4), `invoice:connect_bookkeeping` (C ✦; catalogue 117, TV17), migration **`20261019090000_fortnox_connection`** — `integration_connection` (with the tags, the lease columns, `last_night`, `connect_attempt_id`) and `integration_connect_attempt` (with `seen_company_name`, `seen_org_nr`) and their guards — the card (connect, the outcome, the check, disconnect), the callback, the owners' mails, audit, RUNBOOK + SECURITY + DATA_MODEL + AUTHZ. **114b** builds everything that sends (§5 as amended by §10.1–§10.3, §10.5, §10.6).

## 11. Slice 114's own reviews (2026-10-13) — what was found, and what was done

Three fresh read-only reviewers over the uncommitted slice, in parallel: the migration's **pre-apply** review (P), **code** (C), **security** (S′). Gates before them: typecheck 0, ESLint 0, `pnpm test` 172 files / 2 797 passed / 1 skipped, `pnpm build` 0. **No HIGH in the code or the security; the one HIGH (C1 = P1) was a dbtest assertion.** Every finding TAKEN unless it says otherwise.

- **C1 / P1 (HIGH, a test):** the dbtest expected the guard on a runtime DELETE — the runtime role has NO DELETE grant, so the database refuses before any trigger (42501). The test now reads "permission denied", and the guard's own DELETE branch is driven through the platform role without the maintenance GUC (both tables).
- **C2 / S′1:** a failure AFTER the attempt was spent left it with no outcome and no audit row, and an expired or replayed callback said nothing. Now everything after the spend runs in one `try`: any error at all records the outcome (FAILED, or **BUSY** for the lock — a new outcome) and `integration.connect_refused`, and the callback is never a throw once spent; a callback that finds no attempt redirects with the fixed flag `?fortnox=expired` (no data — S9 untouched), whose note says to press Connect again. The dbtest replays a REAL spent state.
- **C3:** connect's and disconnect's export-lock waits were unbounded — now the bookkeeping makers' bounds (`EXPORT_LOCK_WAIT_MS`, `EXPORT_TX_TIMEOUT_MS`); a lock timeout or deadlock is BUSY (connect) or `INVOICE_EXPORT_BUSY` (disconnect); the lock is taken AFTER the gates.
- **C4 / S′2:** the service-consent proof could come from the 55-minute token cache — `tenantToken(…, { fresh: true })` always asks Fortnox (the connect's proof, the check's first call) and refreshes the cache; the check's failure REPLACES its "reachable" line.
- **C5:** two connects at once — the second found the first's ACTIVE row and said "another company". Now **ALREADY** (a new outcome) when it is the same company; the dbtest drives it.
- **C6:** the "Connected" note outlived a disconnect (`?attempt=` stayed) — Disconnect replaces the URL; a connected outcome and the auto-check show only while a connection exists.
- **C7:** a refused code exchange (our credentials, an expired code, a PKCE mismatch) read as "the administrator said no" — DENIED is now the consent screen's own `error` only; the exchange's refusals are FAILED, logged by tag.
- **C8:** `pendingForFiles` ran on every Settings render even with the transport off — only when a Fortnox exists; and with the transport off the card still SHOWS an earlier connection with Disconnect (it needs no Fortnox — also S′10a).
- **C9:** Connect spent a code attempt before plain refusals — `fortnoxConnectBlocker` (no write, no code, the ✦ window aside) runs first in the action, and the card offers "fill in the org. number" instead of Connect when the company card has none.
- **C10 (nits):** the pending count counts only what books (not credit notes' listings); focus returns to the button that opened the form; the check's missing-year date formatted; a second press on Check ignored by a ref; the limiter's subjects — a company's token and API calls share ONE subject (its TenantId), a one-off token is keyed by its SHA-256 (also S′8); the fake claims a code by an atomic rename. *Not taken:* "the limiter's read-modify-write races" — it is synchronous between awaits, so it cannot interleave in one process.
- **S′3:** S3 held in the DATABASE too — the SYSTEM branch refuses BROKEN → ACTIVE for CONSENT_GONE, NO_LICENCE, COMPANY_CHANGED; and **`fortnox-census.test.ts`** pins that nothing outside the tests sets `app.fortnox_sending` until 114b names its sender.
- **S′4 / S′5:** connect, disconnect and the check take a TENANT-WIDE client scope (the bookkeeping file's rule), the card's `canConnect` / `canCheck` with them — which also puts Fortnox's own words in the check behind that scope.
- **S′6:** the fake-consent route requires a signed-in member; the fake prunes code files over ten minutes old.
- **S′7:** `seen_org_nr` (another company's — maybe a sole trader's personnummer) left out of the tenant export.
- **S′9:** SECURITY §3.6 records the GET callback as the one exception to "state-changing operations as POST only".
- **S′10b (for 114b):** with `fake` on the SHARED dev database a member could connect a real workspace to its fake company, and the nightly send would then "send" its entries into `.dev-fortnox/` — **114b sends under the fake transport only for test-prefixed workspaces**.
- **P2:** the `broken_reason` CHECK passed on NULL when `kind` was missing — `coalesce(jsonb_typeof(…), '') = 'string'`; the dbtest drives it.
- **P3:** `seen_company_name` and `seen_org_nr` both or neither. **P4:** the header's "spent in this transaction" corrected (the OUTCOME is written in it). **P5:** `connected_at` stamped by the database on INSERT too. **P6:** the column is `app_client_id` (`appClientId`) — `client_id` is a tenant's Client everywhere else. **P7:** a connect that committed and then lost its answer no longer 500s: the refusal's own failure is swallowed (the outcome stands as written).
- New outcomes in the CHECK: `ALREADY`, `BUSY`.

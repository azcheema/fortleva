# PLAN.md — Fortleva Phased Build Plan

> **This file is the ongoing source of truth for build progress (§12).** Mark progress here — check items off, update the Status column, and append dated notes to the log at the bottom. Do not fork planning into other tools.
>
> Status legend: `[ ]` not started · `[~]` in progress · `[x]` done. Last updated: 2026-08-03 (Phase 0).
>
> Companion docs: `ARCHITECTURE.md` (stack decisions, ARC-xx), `TENANCY.md` (isolation), `AUTHZ.md` (permissions), `DATA_MODEL.md` (schema), `SECURITY.md` (threat model, GDPR), `CONTINUITY_BOX.md` (§8 design), `OPEN_QUESTIONS.md` (founder decisions).

---

## 1. Ordering: the brief's sequence holds (§11)

The brief asked directly: *should productization come earlier?* **No. The research found no reason to move it, and several to keep it at Phase 7.**

1. **Solo capacity is the binding constraint.** One full-time founder cannot run onboarding, support, billing operations, and dunning for strangers while the core domain (clients, projects, invoices, portal) is still being built. Productizing early converts build time into support time at the worst possible moment.
2. **Tenant zero is the validation loop.** Running Naxdor on Phases 1–6 finds the design errors (§1) before any paying tenant sees them. Selling at Phase 3 means selling a portal with no contracts, no invoices, and no issues — an empty product in exactly the market where [Assembly](https://assembly.com/pricing), SuiteDash, and Hubflo are feature-complete (§10.8).
3. **The classic retrofit risk is already defused.** The reason teams regret late productization is retrofitting entitlements into scattered plan checks (§4). This plan lands the entitlement *shape* — the versioned `entitlements` JSON on `Tenant`, the four-gate resolver, `TenantPreference`, `FeatureFlag` — in **Phase 1**, with every module gated from the day it ships. Phase 7 then wires Stripe to a resolver that already exists; it is plumbing, not surgery.
4. **No revenue pressure.** Running cost pre-productization is under ~$50/mo (Vercel Pro + Neon + R2 + Upstash free tier — see `ARCHITECTURE.md` §6). There is nothing to monetize early to cover.

The honest counterargument — earlier external validation of willingness-to-pay — loses at this scale: the competitive research already validates the category (a dozen funded competitors), and the differentiators (EU residency, continuity box) are validated by their *absence* everywhere else, not by an early checkout page.

**Pushback — launch sequencing (§12).** The brief puts the continuity box (the strongest differentiator, §8) *after* productization. I keep that order — the box's trigger model consumes billing state (lapsed-subscription dead-man signals) and the platform console (veto disputes), both Phase 7 artifacts — but the consequence is that at the moment self-signup opens, the flagship feature does not exist yet. Recommendation: treat Phase 7's self-signup as a **soft launch** (waitlist / hand-onboarded tenants), and time the public marketing launch after Phase 8, so "the agency platform with a continuity box" is true on day one of saying it. Phases 7 and 8 should be planned back-to-back.

**Note on Phase 6.** After the settled scope deltas (decision #7: reports v1 = uploaded PDFs as client-visible `Document`s + CrUX charts; GSC/GA4 sync → v2), Phase 6 is the smallest phase (~1–2 weeks). It keeps its number so all eight docs agree, but it can ship inside the Phase 5 release window if convenient — it is still independently shippable on its own.

---

## 2. Working rules — every phase

**"Independently shippable" means:** at the end of the phase, the system is deployed, Naxdor (tenant zero) uses the new capability on real work, nothing half-built is reachable in the UI, and the phase's non-negotiable tests run green in CI. A phase that cannot be left alone for three months afterward is not done.

**Standing definition of done, every phase (§12):**

- [ ] CI green, including the cross-tenant isolation suite (runs on every PR from Phase 1 forever — `TENANCY.md` §11) and the phase's deny-matrix additions.
- [ ] The four non-negotiable test families exist for everything the phase touched: **tenant isolation, client-level scoping, file visibility, privilege escalation** (§12).
- [ ] Every new privileged operation is in the `AuditEvent` static catalog with write-time visibility (`SECURITY.md` §7).
- [ ] Every new module sits behind its entitlement gate + `TenantPreference` toggle (§4), even while entitlements default to unlimited.
- [ ] All new strings in Swedish and English via i18n; no hardcoded copy; no assumption of exactly two languages (§12).
- [ ] From Phase 2 on: new entities added to the per-tenant export manifest (see Phase 2 — the export path is a continuity commitment, §8).
- [ ] Nothing Naxdor-specific in schema or UI — if only Naxdor needs it, it is a `TenantPreference` (§12).
- [ ] Small, reviewable commits (§12).

**Parallel external tracks** (start early; they have lead time, not effort):

| Track | Start | Needed by |
|---|---|---|
| Swedish lawyer engagement (question list in `CONTINUITY_BOX.md`; ToS/DPA review) | during Phase 6–7 | Phase 7 ToS, Phase 8 box |
| Trademark clearance for "Fortleva" (classes 9 + 42; TMview/EUIPO/PRV/USPTO) | any time in Phases 1–6 — manual check, blocks only the purchase | before the Phase 7 domain buy |
| Product domain purchase — product apex **+ platform-ops apex** (ARC-11) | **Phase 7** — no longer blocks Phase 1 (decision 9; `OPEN_QUESTIONS.md` B1) | Phase 7, leading the cutover by weeks (DNS + warm-up) |
| ~~ESP selection~~ (settled: **Amazon SES `eu-central-1`**, decision 10) → **DNS on `mailer.naxdor.com` + AWS production-access request** | **now — still blocks Phase 1's invite flow**, but it is *shorter* than previously recorded: DNS/DKIM verification is minutes, AWS commits to an initial response within 24h (approval is not guaranteed — plan 1 business day, tolerate 4), and **sender warm-up is effectively zero** for transactional mail on shared IPs at this volume | Phase 1 week 1 — the invite flow can be coded against the sandbox throughout |
| Idura (BankID) contract | only when a tenant asks | v2 |
| Google OAuth / service-account sync decision | only if v2 sync confirmed | v2 |

---

## 3. Phase overview and status

| # | Phase | Shippable = | Est. (solo, full-time) | Status |
|---|---|---|---|---|
| 0 | Research & specification | 8 docs in `/docs`, founder review | done | `[~]` docs written, review pending |
| 1 | Foundation | Naxdor team runs identity, roles, files, audit on it | 6–8 wk | `[ ]` |
| 2 | Core domain | Naxdor runs clients & projects day-to-day on it | 4–5 wk | `[ ]` |
| 3 | Client portal | First real Naxdor client uses the portal | 4–5 wk | `[ ]` |
| 4 | Money | Naxdor issues compliant invoices & contracts through it | 6–8 wk | `[ ]` |
| 5 | Collaboration | Clients report issues in-product, not by email | 3–4 wk | `[ ]` |
| 6 | Reports | Clients see report documents + CrUX charts | 1–2 wk | `[ ]` |
| 7 | Productization | A stranger signs up, pays, runs their agency | 6–8 wk | `[ ]` |
| 8 | Continuity box | Boxes sealable/openable; platform continuity promises live | 6–8 wk + legal latency | `[ ]` |

Total: roughly **9–11 months** solo full-time, including slack. Phase 1 is the one that must never be compressed — tenancy, permissions, and audit are foundations, not features, and are never retrofitted (§11).

---

## Phase 0 — Research & specification (current)

Scope: this document set. Exit criteria: founder reviews the 8 docs and resolves the **blocks-Phase-1** group in `OPEN_QUESTIONS.md` — **all resolved as of 2026-08-08**:

- ~~**B1** product name + domain purchases~~ — **no longer a Phase 1 gate.** Name decided 2026-08-05 (**Fortleva**; trademark check still outstanding); domain purchases demoted to Phase 7 by decision 9, since v1 runs on `os.naxdor.com` / `ops.naxdor.com`;
- ~~**B2** Neon project created in Frankfurt `aws-eu-central-1`~~ — **done 2026-08-08**: project `fortleva`, region confirmed from the dashboard, PG18; Free plan for now, upgrade to Launch before tenant-zero data lands;
- ~~**B3** template-drift policy~~ — **decided 2026-08-08: Option B, tracked-diff-additive** (template lineage + override tracking + `TENANT_REVOKE` tombstones in the first roles migration);
- ~~**B4** ESP choice~~ — **decided 2026-08-08** (decision 10): **Amazon SES `eu-central-1`**. No longer a gate; what remains is *execution* — create the identity for `mailer.naxdor.com`, publish its DKIM/MAIL FROM/DMARC records, then file AWS production access. Verified 2026-08-08: the DNS is **not** a precondition of filing, only a best practice that speeds approval, and warm-up is a non-event at this volume;
- **B5** pricing currency (flagged one-way door; decide by Phase 7 design start, does not gate Phase 1 code);
- ~~**B6** default role-seeding matrix sign-off~~ — **accepted as specced 2026-08-08**; the seed migration and deny-matrix suite build from `AUTHZ.md` §3.2 as written.

**Phase 0 exit: complete 2026-08-08.** Every blocks-Phase-1 item is resolved; Phase 1 build started the same day.

Downgrade semantics for portal Contacts is **not** a Phase-0 gate — it is C1, decided at Phase 7. No application code was written (§0).

- [x] Research sweep (12 areas, sourced)
- [x] Docs drafted
- [ ] Founder review + Phase-1 blockers resolved

---

## Phase 1 — Foundation (v1)

**Goal:** the multi-tenant, permissioned, audited shell everything else assumes. Naxdor as tenant zero (fresh start, no migration).

**Scope:**

- [ ] **Infrastructure day-1 irreversibles:** Neon project in Frankfurt `aws-eu-central-1` ([region is immutable](https://neon.com/docs/introduction/regions); London is UK, not EU); **both** R2 buckets created with `jurisdiction=eu` ([immutable at creation](https://developers.cloudflare.com/r2/reference/data-location/)) — the general document bucket **and** the dedicated continuity bucket with its 90-day bucket lock and no-delete runtime credential (ARC-06, `CONTINUITY_BOX.md` §2.6); **two CNAMEs under `naxdor.com` — `os` (tenant + portal) and `ops` (platform console) — pointed at Vercel, plus a dedicated sending subdomain for SPF/DKIM/DMARC** (ARC-11 / decision 9; **no domain purchase in Phase 1**, no zone delegation, Naxdor DNS and mail untouched; file delivery rides the `<account>.eu.r2.cloudflarestorage.com` endpoint and a branded files apex is v2); Vercel Pro, functions pinned EU.

  Note the asymmetry: unlike Neon's region and R2's bucket jurisdiction, the hostnames are **the one day-1 choice here that is *not* irreversible** — that is the whole point of decision 9, and it holds only while INV-D1/INV-D2 (ARC-11) hold. Build the config module and the CI cookie assertion in the same week as the CNAMEs, not later.
- [ ] **Identity via Better Auth** (self-hosted, pinned ≥ 1.6.11, only needed plugins — `SECURITY.md` §3): `User` (member identity), email+password, **MFA** (TOTP + backup codes; mandatory for platform and owner-equivalent roles §9), member invitation flow, admin plugin for the platform plane. Better Auth owns identity/sessions/invitations **only**; all authorization lives in our own schema (ARC-04/05).
- [ ] **Tenancy plumbing** (`TENANCY.md`): `Tenant`, `Member`; `withTenant(tenantId, principal, fn)` unit-of-work with transaction-local `set_config`; thin `$extends` belt; RLS with `FORCE ROW LEVEL SECURITY`, InitPlan-wrapped fail-closed policies; composite-FK discipline; `cell`/`databaseUrl` column on `Tenant` (physical-isolation seam, execution v2).
- [ ] **Restricted DB roles:** SQL-created runtime role without BYPASSRLS (Neon console roles bypass RLS silently), separate owner/migrate credentials, `REVOKE UPDATE, DELETE` on `AuditEvent` + guard trigger.
- [ ] **Tenant-scoped roles & permissions** (`AUTHZ.md`): `Role`, `Permission`, `RolePermission`, `MemberRole`; immutable **`resource:verb`** permission codes (colon — `AUTHZ.md` §3.1 is the normative source; audit actions stay `entity.verb` and portal capabilities stay `portal.area.verb`, three deliberately distinct namespaces); system role templates (templateKeys `owner` / `manager` / `admin` / `employee`, the owner template displayed as "CEO", + the portal Contact profiles) with clone-and-customize and the template-lineage/override columns from the first migration (B3); transactional escalation guards (grant-subset, last-owner, no-self-escalation); the single `authorize()` / `authorizedResourceIds()` seam with **deny-default resource scoping** semantics (decision #5 — zero assignments ⇒ see nothing; `client:view_all` seeded on CEO/Manager/Admin templates only). The `MemberClient` / `MemberProject` assignment tables are designed here but land physically in Phase 2 with their parent entities.
- [ ] **CI isolation suite** (`TENANCY.md` §11): adversarial cross-tenant reads/writes enumerated from the Prisma DMMF, unset-GUC ⇒ zero rows, run on ephemeral Neon branches on every PR.
- [ ] **AuditEvent + static event catalog:** `audit.record()` inside the same transaction as each mutation; write-time visibility (TENANT | PLATFORM); `impersonatorId` field and impersonation start/stop events (machinery now, console UI in Phase 7); retention job via Vercel cron.
- [ ] **File storage:** `FileObject` + `FileVersion` (app-level versioning — R2 has no object versioning, and version rows are needed anyway; §10.6); presigned PUT with signed Content-Length + HEAD verification; per-tenant quota metering in Postgres; **`visibility` flag (`internal` default | `client_visible`) enforced at the data layer** (§5); downloads served off-origin from the R2 endpoint (`<account>.eu.r2.cloudflarestorage.com` — a separate apex by construction, no purchase) with `Content-Disposition: attachment`; extension/MIME allowlist (v1 anti-abuse; attachmentAV = v2); multipart-abort lifecycle rule + reconciliation job.
- [ ] **Entitlement shape now, Stripe later (§4):** versioned `entitlements` JSON on `Tenant` (modules + limits: maxClients, maxMembers, maxStorageBytes), `TenantPreference`, `FeatureFlag`, and the four-gate resolver in evaluation order (flag kill-switch → entitlement → tenant preference → permission), all server-side, each gate one function call. Defaults: everything on, unlimited, until Phase 7.
- [ ] **Encryption service seam** (`SECURITY.md` §6): own ~80-line AES-256-GCM service, `v1.<keyId>.<iv>.<ct>.<tag>` format, env-var key + offline copy, seam for per-tenant DEK/KMS later. Applied from day 1 to TOTP secrets/backup codes; ready for integration credentials (Phase 4).
- [ ] **Three planes as route groups** (§2, ARC-12): platform / tenant / portal with separate middleware and session claims; portal group is a locked shell until Phase 3. Single app host (decision #8, hosted per decision #9): tenant resolved through one seam (hostname→tenantId lookup stubbed), no tenant slugs in absolute URLs, **one config module owning `APP_URL` + cookie attributes + mail sender (INV-D2) — the host is never hardcoded**, so the Phase 7 move off `naxdor.com` is a config edit plus DNS.
- [ ] **Amazon SES `eu-central-1` — start in week 1** (decision 10, ARC-09). Sending domain **`mailer.naxdor.com`**, custom MAIL FROM **`bounce.mailer.naxdor.com`**. Order: pre-flight `aws sesv2 get-account --region eu-central-1` plus `list-email-identities` (catches a pre-existing identity or an already-pending review that would 409 the request) → publish `_dmarc.mailer` → create the identity → publish the three Easy DKIM CNAMEs (tokens only exist *after* creation; use the returned `SigningHostedZone`, never a hardcoded suffix, and no leading underscore on the token) → publish the MAIL FROM `MX 10 feedback-smtp.eu-central-1.amazonses.com` + `TXT v=spf1 include:amazonses.com ~all` on `bounce.mailer`, then enable custom MAIL FROM → IAM principal scoped by `ses:FromAddress` → config set + SNS + webhook + DLQ → mailbox-simulator tests → file production access. **`send.naxdor.com` is off-limits** — it carries a live SES `eu-west-1` MAIL FROM (ARC-09); audit and decommission it as a *separate* change with its own rollback. **Nothing on the `naxdor.com` apex may be touched** — not SPF, not MX, not `default._domainkey`, not `_dmarc`.
- [ ] **Bounce/complaint webhook — EU-pinned, verified, dead-lettered.** The SNS payload carries recipient email addresses (personal data), so the route inherits ARC-01's `fra1` pin and that pin must be *asserted*, not assumed — Vercel Functions default to `iad1` (Washington DC), which would process recipient addresses in the US and contradict `SECURITY.md` §9.3. Also: confirm Vercel Deployment Protection does not cover the path (SNS posts the subscription confirmation unauthenticated and a 401 presents as a subscription that never confirms); SNS posts `Content-Type: text/plain`, so read the raw body; branch `bounceSubType` — `OnAccountSuppressionList`/`OnTenantSuppressionList` mean "already known bad", do **not** count toward the bounce rate, and must not trigger reputation escalation. Account-level suppression *management* APIs are disabled in the sandbox, so the GDPR erasure path (`DeleteSuppressedDestination`) is a **post-approval** task.
- [ ] **Decide the reply path for `mailer.naxdor.com` before the first invite ships.** Nothing in the record set can *receive* mail, and the A-wildcard means a reply to `noreply@mailer.naxdor.com` reaches a Vercel edge with no SMTP listener and fails at connect. For an invite-driven product that is a product defect, not a mail detail. Cheapest fix: a `Reply-To` on a monitored SiteGround mailbox — changes no DNS, touches no apex record. (An MX on `mailer.` is also permitted; AWS's "MAIL FROM must not receive mail" restriction binds `bounce.mailer`, not `mailer`.)
- [ ] i18n scaffold (sv + en); **transactional email adapter** — one `send(message)` interface over Amazon SES so the vendor stays swappable in a day (ARC-09); **do not name the module `ses`** — bare "SES" means Simple Electronic Signature in this codebase (`SignatureLevel.SES`, Phase 4), so name it `mail` / `mailer`; baseline auth rate limiting (Upstash Redis EU).
- [ ] **Naxdor seeded as tenant zero**; founder = platform admin with MFA.
- [ ] *Platform-continuity cheap win #1:* founder credentials into Bitwarden Emergency Access; self-hosting runbook skeleton in the repo (kept current every phase, formalized in Phase 8).

**Shippable =** Naxdor staff log in with MFA, manage members and roles, upload files with visibility flags, and every privileged operation lands in an append-only audit log — with CI proving a second seeded tenant can see none of it.

**Non-negotiable tests before ship (§12):** cross-tenant isolation suite (all models); privilege-escalation deny-matrix (grant-subset, last-owner removal, self-escalation); file-visibility default-internal enforcement at data layer; RLS fail-closed (unset GUC ⇒ zero rows); runtime role verified `rolbypassrls = false`; audit append-only (UPDATE/DELETE rejected); invite-only paths (no public member signup); **no session cookie carries a `Domain` attribute and every one is `__Host-`-prefixed (INV-D1) — asserted in CI, because while the app is under `naxdor.com` a stray `Domain=` leaks sessions to every sibling Naxdor property.**

**Effort:** 6–8 weeks. Highest overrun risk of any phase; do not trim the test suite to make a date.

---

## Phase 2 — Core domain (v1)

**Goal:** Naxdor's real client and project records live here, not in spreadsheets.

**Scope:**

- [ ] `Client` — company details, org.nr / VAT ID, billing address, assigned members; **internal private notes** (visibility `internal`, never in any portal-reachable query path) (§6).
- [ ] `Contact` — person records at a client (name, email, role). Records only; portal identity arrives in Phase 3 (decision #6 keeps the identity stacks separate).
- [ ] `MemberClient`, `MemberProject` assignment tables wired into the Phase-1 `authorize()` seam; deny-default live (decision #5).
- [ ] `Project` — type, scope, status, start/launch dates, environments, repo link, hosting details; `ProjectVersion` (current version, release notes) + `Milestone`; the **timeline / stage view** — milestones + version list, deliberately not a Gantt (§6, decision #7). This is the portal's centerpiece next phase; design it well now.
- [ ] `Service` — what the client buys (one-off / retainer / hosting / SEO / maintenance; recurring vs one-time; renewal dates as data). Renewal *automation* is Phase 4; the entity lands here because Phase 3's portal reads it.
- [ ] `Document` — general storage layer over `FileObject`/`FileVersion`: attach to `Client`/`Project`, folders or tags, version history, visibility flag surfaced in UI (default `internal`, §5).
- [ ] *Platform-continuity cheap win #2:* **per-tenant export v0** — manually triggered export of all tenant entities (JSONL + files + schema-versioned manifest). Standing rule from here: every later phase extends the manifest as part of its definition of done.

**Shippable =** Naxdor runs day-to-day client/project work in the product: every active client, project, version, and document is in, and an employee assigned to two clients provably cannot see the third.

**Non-negotiable tests before ship:** client↔client scoping (deny-default: zero assignments ⇒ zero rows; `client:view_all` only via template roles); internal notes/documents absent from every client-visible query path (tested at the data layer via the RESTRICTIVE portal policy, before any portal UI exists — `TENANCY.md` §7); isolation suite extended to all new models; export round-trip (export → validate manifest completeness).

**Effort:** 4–5 weeks.

---

## Phase 3 — Client portal (v1)

**Goal:** the read-mostly surface contacts actually use (§2, §6).

**Scope:**

- [ ] **Separate Contact identity stack** (decision #6 — final): distinct account table, session namespace, cookie name, and audience from the member stack, even for identical emails; portal route group goes live; middleware rejects portal sessions on tenant/platform routes by audience alone.
- [ ] **Invite flow:** invite-only forever, no contact self-signup (§3); invites issued by staff holding `client:manage_contacts`, audited; acceptance sets up portal credentials (**contact MFA is v2** — `DATA_MODEL.md` P5, `SECURITY.md` §3.5; no `ContactTwoFactor` model exists in v1).
- [ ] **Read surfaces:** projects + timeline (versions, milestones, release notes), `Document`s/files (client-visible only, short-lived signed URLs authorization-checked at issue time §9), `Service`s, own company record. Hardcoded portal capability set — contacts never enter the role/permission machinery (`AUTHZ.md` §8).
- [ ] **Version sign-off, v1-lite** (decision #7): a Contact approves/acknowledges a `ProjectVersion` from the timeline; recorded with identity + timestamp, audited, displayed. (Full deliverable-approval workflows: v2.)
- [ ] **Portal rate limiting** (§9): per-principal and per-email limits on login, invite acceptance, and downloads (Upstash Redis EU + `@upstash/ratelimit`), Vercel WAF free rules as outer shield.
- [ ] Portal file downloads audited (`AuditEvent`), per catalog.

**Shippable =** a real Naxdor client contact logs in, sees exactly their own projects/timeline/files/services, signs off a version — and nothing else, provably.

**Non-negotiable tests before ship:** portal deny-matrix — cross-client read attempts, cross-tenant read attempts, `internal` file/document/note access, tenant-route access with a portal session (audience rejection), self-signup attempts; sign-off recorded exactly once per version per contact; rate-limit behavior under brute force.

**Effort:** 4–5 weeks.

---

## Phase 4 — Money (v1)

**Goal:** contracts and legally compliant invoices; the phase where correctness is regulated, not chosen.

**Scope:**

- [ ] **`Contract` + `ContractSignature`** (§6, §10.3): versioned, status lifecycle (draft/sent/signed/expired), effective/expiry dates. Two v1 signing paths (research: SES is legally sufficient for Swedish B2B service contracts — formfrihet + [eIDAS Art. 25](https://www.docusign.com/products/electronic-signature/legality/sweden)):
  - upload externally signed PDF (wet ink or the tenant's own tool);
  - **native SES click-to-accept:** authenticated portal Contact reviews and accepts → sealed PDF with audit trail (portal identity, timestamp, IP, SHA-256) stored immutably in R2 EU. Works for US clients under ESIGN/UETA. **BankID = v2** (pooled [Idura](https://idura.eu/pricing/signatures) broker, entitlement-gated).
- [ ] **`InvoiceSeries` / `Invoice` / `InvoiceLine`** (§6, §10.2): per-tenant, per-fiscal-year **gap-free series** — numbers allocated atomically at issuance, drafts unnumbered, issued invoices immutable, corrections via credit notes, never deletes ([Skatteverket's unbroken-series expectation](https://www.faronline.se/dokument/skatteverket/stallningstaganden2/2023/skvst20230626c/)). Content per [ML 2023:200 17 kap. 24 §](https://www.skatteverket.se/foretag/moms/saljavarorochtjanster/momslagensregleromfakturering.4.58d555751259e4d66168000403.html) incl. VAT amount **in SEK on foreign-currency invoices**; tenant invoice settings for orgnr/säte (ABL 28 kap. 5 §) and "Godkänd för F-skatt" — settings, not schema hardcoding.
- [ ] **Three hard-coded VAT profiles** (decision #3): SE domestic (25/12/6) · EU B2B reverse charge (VIES validation with stored timestamp/consultation number, "Omvänd betalningsskyldighet", box-39 metadata, periodisk-sammanställning support data) · non-EU outside scope (box-40 metadata). Modeled on EN 16931 / Peppol BIS 3 semantics so Peppol is a v2 adapter, never Svefaktura (withdrawn — see skip list). Multi-currency; PDF + CSV export from day one.
- [ ] **Pay-now button (v1, competitor delta):** `Invoice.paymentLinkUrl` — a **tenant-provided payment link** (their own Stripe Checkout/payment link, Swish, or bank link) rendered as the pay-now button on the invoice and in the portal, plus manual paid-status marking and reconciliation notes (`externalPaymentRef`). Optional per `TenantPreference`. The platform never touches the money flow — **no Stripe Connect** (skip list). *This is deliberately the no-credentials version:* v1 stores a URL, not a key, so Phase 4 needs no tenant-credential store.
- [ ] *v1.5 (not this phase):* the tenant's **own Stripe restricted key** via `IntegrationConnection(STRIPE_TENANT)` (encrypted with the Phase-1 service), giving per-invoice Checkout Sessions and automatic paid-status reconciliation — `DATA_MODEL.md` §11. Build when a tenant asks for automatic reconciliation; the `paymentLinkUrl` path stays as the permanent fallback.
- [ ] **`Service` renewals:** renewal-date reminders, renewal → draft invoice linkage.
- [ ] **BFL carve-out (§9):** issued invoices are the tenant's räkenskapsinformation — [7-year retention](https://www.bfn.se/fragor-och-svar/arkivering/) that outlives the subscription; GDPR deletion flows exempt them; archive export at offboarding is a contractual promise (lands in the Phase 7 ToS).

- [ ] **Seller-side scope, stated in the product:** v1 supports **Swedish-established issuing tenants only** (`DATA_MODEL.md` §6.7). Selling *to* US/non-EU clients is fully covered by the OUTSIDE_SCOPE profile; a **US-established issuing entity, and US sales tax, are out of scope for v1** — a tenant operating from both jurisdictions (Naxdor included) issues through its Swedish entity. Extension path (tenant-level tax-regime enum + per-regime issuer profile) is named, not built.

**Shippable =** Naxdor issues its real invoices and contracts through the product: a Swedish invoice, a reverse-charge EU invoice, and a US invoice all render compliant PDFs; a client signs a contract in the portal; an invoice gets paid via its pay-now link.

**Non-negotiable tests before ship:** gap-free numbering under concurrent issuance (parallel allocation race — exactly one sequence, no gaps, no duplicates); issued-invoice immutability; credit-note flow; VAT fixtures for all three profiles incl. SEK-VAT-on-EUR/USD-invoice; contract seal hash verification; portal visibility of invoices/contracts scoped per client (CONTACT_PRIMARY profile only).

**Effort:** 6–8 weeks.

---

## Phase 5 — Collaboration (v1)

**Goal:** issues framed as the client **request queue** (decision #7 — this framing subsumes forms/intake for v1; the productized-service lane validates it).

**Scope:**

- [ ] `Issue` — type (bug / idea / requirement), priority, status, attachments (`FileObject`), reporter (Contact or Member), link to the `ProjectVersion` that fixes it (§6). Lightweight tracker, not Jira.
- [ ] `IssueComment` — threaded comments; per-comment visibility (`internal` triage notes vs client-visible replies), same data-layer enforcement as §5.
- [ ] Staff triage views (queue per client/project, status transitions, assignment).
- [ ] **Notifications:** in-app + email on issue created/commented/status-changed and sign-off requests; minimal per-recipient preferences; digest option. (Messaging-as-threaded-comments beyond issues: v2.)

**Shippable =** Naxdor's clients report bugs/ideas/requirements in the portal instead of email; staff triage and close them against releases; everyone gets notified.

**Non-negotiable tests before ship:** internal comments never reach any portal query path; cross-client issue isolation; notification fan-out respects visibility (a client-visible status change never emails another client's contacts); rate limiting on portal issue creation (abuse surface, §9).

**Effort:** 3–4 weeks.

---

## Phase 6 — Reports (v1, deliberately thin)

**Goal:** performance reporting without the OAuth swamp (decision #7).

**Scope:**

- [ ] `PerformanceReport` — uploaded report files (PDF/CSV) published as **client-visible `Document`s**, listed on a per-client reports surface (v1 = manual upload, confirmed §10.5).
- [ ] **CrUX + CrUX History charts (v1):** [API-key only, free](https://developer.chrome.com/docs/crux/api), per-project origin/URL Core Web Vitals with a designed empty state (small client sites often have no CrUX data).
- [ ] **GSC/GA4 sync — explicitly v2** (service-account-invite pattern preferred over OAuth; see v2 backlog). Manual upload remains the permanent fallback either way.

**Shippable =** a client opens Reports and sees their monthly report file plus live Core Web Vitals trend charts (or an honest empty state).

**Non-negotiable tests before ship:** report visibility flags (a report is client-visible only when explicitly published); CrUX empty/error states; per-client scoping on the reports surface.

**Effort:** 1–2 weeks. May ship with Phase 5's release (see §1 note).

---

## Phase 7 — Productization (v1)

**Goal:** turn Naxdor's system into a SaaS: plans, self-signup, platform console. Soft launch; public marketing launch after Phase 8 (see §1 pushback).

**Scope:**

- [ ] **Stripe subscriptions** (platform bills tenants — [Checkout + Customer Portal + Stripe Tax](https://stripe.com/en-se/pricing), ARC-07): webhook → **local versioned entitlements** on `Tenant` (idempotent, raw-body signature verification, re-fetch subscription from Stripe rather than trusting event order). Stripe's boolean-only Entitlements API skipped — our limits are numeric ([even Stripe recommends persisting locally](https://docs.stripe.com/billing/entitlements)).
- [ ] **Plans per decision #4:** flat tiers ~$39–49 / $129–149 / $299–399 + extra staff seats; **unlimited free client contacts forever** (one-way door — metering clients later is a repricing you can't survive); custom domain reserved mid-tier (v2 feature, priced now); white-label + continuity box top-tier. Honest flat pricing — no add-on creep. Currency decision executed day 1 (SEK/USD split — [sticky per Stripe customer](https://docs.stripe.com/billing); `OPEN_QUESTIONS.md`).
- [ ] **Tax:** `tax_id_collection` → automatic reverse charge for EU B2B; **we still file periodisk sammanställning** — Stripe calculates, never files; follow-up process for failed VIES validations.
- [ ] **Trials & dunning:** 14 days, no card (`if_required`, `end_behavior=pause`); Smart Retries + dunning emails + in-app payment-failed banner.
- [ ] **Downgrade = read-only grandfathering** ([Trello model](https://community.atlassian.com/forums/Trello-questions/What-happens-to-the-boards-when-you-downgrade-to-free/qaq-p/1987366)): block creation past the new limit, never delete or hide existing data; applies at period end. The entitlement resolver gains an **exemption mechanism** here — required by Phase 8's rule that the continuity box survives billing lapse.
- [ ] **Tenant self-signup + onboarding:** tenant creation wizard, role templates seeded, guided first client/project; reserved-name hygiene at signup.
- [ ] **Platform admin console** (§7): tenant provisioning, plan/entitlement overrides, trials, usage & health (storage, members, activity), suspension/offboarding, full data export, hard deletion with grace period; **impersonation UI** on the Phase-1 machinery — exceptional, reason-logged, time-boxed, visible in the tenant's own audit log (§7), and **read-only with no write-elevation path in v1**: the permission set is intersected with a read-only mask server-side and no write-mode flag is built (`AUTHZ.md` §9, `SECURITY.md` §8). Scoped write elevation — a separate start-time flag, separately reasoned and audited — is **v2**, only if support reality demands it.
- [ ] **Domain cutover off `naxdor.com`** (decision #9, `OPEN_QUESTIONS.md` B1 — **start this first, it is the phase's long pole**): buy the product apex + platform-ops apex, delegate the product zone to Vercel nameservers **while it is empty** (ARC-11), move `os.naxdor.com` → `app.<product>.tld` and `ops.naxdor.com` → `<product-ops>.tld` through the INV-D2 config module, stand up the marketing site on the product apex, re-issue SPF/DKIM/DMARC on the new sending domain and **warm the sender before launch traffic** (calendar time, not effort). Old hosts 301 to new for a grace period; `__Host-` cookies mean every session is invalidated by the move, so schedule it before the first external tenant, not after. INV-D1's prohibition on `Domain=` cookies lifts only once this lands.
- [ ] **Branding basics (v1):** tenant logo, colors, email sender name. Subdomains/custom domains/white-label: v2 (decision #8).
- [ ] **Legal surface:** ToS, privacy policy, DPA + sub-processor list (`SECURITY.md` §9), BFL EU-storage notification note; *platform-continuity cheap win #3:* **ToS wind-down commitment — ≥90 days notice + free export in open formats** (ahead of ~40% of SaaS contracts).

**Shippable =** a stranger signs up, starts a trial, pays, gets exactly their plan's entitlements, and can be supported, suspended, exported, or deleted from the console — while Naxdor continues running as tenant zero on the same rails.

**Non-negotiable tests before ship:** webhook idempotency + signature verification; full subscription lifecycle on Stripe Test Clocks (trial end, renewal, payment failure, cancellation); four-gate evaluation-order tests; downgrade grandfathering (over-limit data readable, creation blocked, nothing deleted); entitlement changes audited; impersonation fully audited with both identities; self-signup cannot create a contact identity (§3).

**Effort:** 6–8 weeks.

---

## Phase 8 — Continuity box (v1, both levels)

**Goal:** the differentiator, built on Phase-1 foundations (encryption seam, audit catalog, R2 EU bucket) and Phase-7 billing state. Full design in `CONTINUITY_BOX.md`.

**Scope — tenant → client box:**

- [ ] `ContinuityBox`: contents assembled and **sealed client-side** in the staff browser (age encryption), single blob to the **dedicated continuity R2 bucket** provisioned in Phase 1 (bucket lock, no-delete runtime credential); DB holds metadata only — a database dump reveals nothing (§8).
- [ ] **Key custody: 2-of-3 Shamir (decision #1 — final):** Share A printed continuity card held by the client (generated client-side, never touches the server); Share B in the platform DB (single share useless alone); Share C trustee. Platform alone can never decrypt; card loss recoverable via B+C. Never email key material.
- [ ] `ContinuityOpenRequest` — **request + veto-window trigger** (Bitwarden emergency-access model): a `CONTACT_PRIMARY` contact requests → all tenant admins notified on every channel with escalation → **veto window (default 21 days, configurable 7–60)** → auto-grant on expiry. Platform-observed dead-man signals (lapsed subscription + no staff logins) **badge/enable the request and may shorten the window — never auto-open.** Cooldown after veto; hostile-veto escalation to platform-mediated human review.
- [ ] **Open-once + download window (decision #2 — final):** atomic SEALED→OPENED transition (conditional update + audit row in one transaction), then a 7-day window ([R2 presign max](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)) with unlimited re-downloads of the same blob, every issuance logged. Friction on request: plain-language warning, confirmation, cooldown (§8 abuse design).
- [ ] **Content-rot defenses:** quarterly reseal ritual with reminders; contact offboarding forces reseal; contents template = **pointers + recovery instructions, not live credentials** (founder's lean, confirmed): registrar/DNS, hosting, repos, third-party services, where real secrets live, architecture notes, successor recommendations.
- [ ] **Billing-lapse exemption:** the box is entitlement-gated for *selling* (top tier, decision #4) but read/open paths survive nonpayment via the Phase-7 exemption mechanism — a continuity feature that seals itself on a missed invoice defeats its purpose. Retention window for lapsed tenants: `OPEN_QUESTIONS.md`.
- [ ] Every box lifecycle event in the audit catalog (seal, reseal, request, veto, open, download, dispute).
- [ ] **Legal package (with lawyer, not advice):** template continuity clause for the agency↔client contract referencing the box; ToS disclaimers (no verification beyond described procedure, no accuracy warranty, not an estate instrument, liability cap, wrongful-release indemnity); lawyer question list headlined by konkursbo enforceability (`CONTINUITY_BOX.md`).

**Scope — platform → tenants (items not already landed earlier):**

- [ ] **Scheduled automated per-tenant exports pushed outside our infrastructure** (tenant-provided bucket or signed delivery; JSONL + files + manifest, optional SQLite bundle) — productizing the Phase-2 manual export.
- [ ] Self-hosting runbook finalized; founder dead-man arrangements formalized (Bitwarden Emergency Access from Phase 1 + named successor).
- [ ] *Already landed earlier, by design:* export path (Phase 2, extended every phase) · founder emergency access + runbook skeleton (Phase 1) · ToS wind-down commitment ≥90 days + free export (Phase 7). Formal SaaS escrow ([Codekeeper ~$2.6k/yr](https://codekeeper.co/pricing/saas-escrow)): **v2**, flagged as a marketing asset ("we escrow ourselves").

**Shippable =** a tenant seals a box for a client; the client holds a printed card; an open request survives the full veto/notify/grant flow; the opened package downloads for 7 days; the platform can prove — cryptographically, not contractually — that it could never read the contents.

**Non-negotiable tests before ship:** open-once atomicity (concurrent open attempts → exactly one OPENED transition); no server-side key material sufficient to decrypt (DB + R2 dump test); veto-window state machine incl. cooldown and dispute path; download-window expiry; forced reseal on contact offboarding; billing-lapse exemption; complete audit trail for every lifecycle event; box events visible to both tenant and platform audiences per catalog.

**Effort:** 6–8 weeks build, plus lawyer latency (started in Phase 6–7 per §2).

---

## v2 backlog (build when the trigger fires — not before)

| Item | Trigger | Notes |
|---|---|---|
| BankID signing via pooled [Idura](https://idura.eu/pricing/signatures) broker (€139/mo incl. 200 signatures, €0.013/tx) | first tenant asks / offers to pay | one platform account, metered per tenant as an entitlement; per-tenant vendor accounts don't scale down |
| [Fortnox](https://www.fortnox.se/developer) invoice push | tenant demand | self-serve dev portal, marketplace review, end-customer integration license ~189 kr/mån; Bokio later (gatekept API) |
| Subdomain-per-tenant, then custom domains | v2 rollout / mid-tier plan sales (decision #8) | Phase-1 seams (hostname→tenantId resolver, centralized cookie config, no slugs in URLs) keep this a config-plus-routing job, not a rewrite |
| GSC/GA4 sync | tenants want automated reports | service-account-invite pattern first (no Google verification, ships in days); OAuth only if needed — start [sensitive-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification) 1–2 months ahead, never run production sync in Testing mode |
| Forms / intake builder | request-queue framing stops covering intake | Phase 5's Issue queue is the v1 answer |
| Proposals / quotes | tenant demand | Services + Contracts cover the v1 job; add quote-accept later |
| Recurring billing (tenant → their clients) | tenant demand | the productized-service lane lives on this; likely the point Stripe Connect gets re-evaluated |
| Messaging as threaded comments beyond issues | tenant demand | never a full chat product |
| attachmentAV virus scanning via R2 events | real portal upload volume | v1 mitigation: allowlist + attachment disposition + separate download host |
| Formal SaaS escrow (Codekeeper) | upmarket tenant asks / marketing decision | "we escrow ourselves" as credibility asset |
| Peppol e-invoicing adapter | Swedish mandate materializes (inquiry reports 2027-11-30; ViDA 2030) | EN 16931 alignment from Phase 4 makes this an adapter |
| Physical tenant isolation (dedicated Neon project) | a tenant demands/pays for it | `cell` seam from Phase 1 makes extraction mechanical |

## Skip list (decided — do not build)

| Item | Reason |
|---|---|
| Time tracking | table stakes only in the freelancer/per-seat-priced lane; integrate later if ever, don't build |
| Scheduling | link Calendly; zero differentiation |
| Email marketing | different product; crowded market |
| Full chat (read receipts, email bridging) | a quarter of work masquerading as a feature; threaded comments suffice |
| Svefaktura | [withdrawn as SFTI recommendation April 2021](https://sfti.se/utbildningarochstod/nyheter/nyhetsarkiv/overgangenfransvefakturatillpeppolbisfakturan.4984.html) — dead format |
| Stripe Connect | platform bills tenants directly; tenants' clients pay tenants' own Stripe — [Connect only enters if tenants charge through us](https://docs.stripe.com/connect/saas) (revisit only with recurring-billing v2) |

---

## Progress log

| Date | Note |
|---|---|
| 2026-08-03 | Phase 0: research sweep + 8 docs drafted; awaiting founder review and Phase-1 blocker decisions (`OPEN_QUESTIONS.md`). |

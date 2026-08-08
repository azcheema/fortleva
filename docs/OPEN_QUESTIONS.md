# OPEN_QUESTIONS.md — Decisions needed from the founder

**Fortleva · Phase 0 · 2026-08-03**

This is the decision ledger required by the brief (§0.8, §10), grouped **Blocks Phase 1** vs **Can wait** per §12's rule: *ask before assuming on anything that blocks Phase 1*. Blockers have no default — building starts after you answer. Can-wait items each carry a decide-by phase and a recommendation; if you say nothing by the decide-by point, the recommendation becomes the default and is recorded here.

The eight decisions already settled in brainstorming are recorded first so the whole decision log lives in one file. **Settled decisions are closed** — nothing below reopens them; the open questions are the parameters those decisions left unbound.

---

## 1. Decided 2026-08-03 (settled — do not reopen)

| # | Decision (one line) | Specced in |
|---|---|---|
| 1 | **Continuity key custody: 2-of-3 Shamir** — client-held printed card + platform DB share (useless alone) + trustee share; platform alone can never decrypt; card loss recoverable via the other two. | `CONTINUITY_BOX.md` (custody), `SECURITY.md` (encryption design), `DATA_MODEL.md` (`ContinuityBox`) |
| 2 | **Exactly-once: open-once + window** — atomic, logged SEALED→OPENED transition, then a 7-day download window with unlimited re-downloads of the same blob, every issuance logged. | `CONTINUITY_BOX.md` (state machine), `DATA_MODEL.md` (`ContinuityBox`, `ContinuityOpenRequest`) |
| 3 | **Invoicing: native invoice ledger, not accounting** — v1 issues compliant invoices (gap-free `InvoiceSeries`, 3 VAT profiles, EN 16931-aligned, PDF/CSV export, pay-now); tenant's accounting tool stays the bookkeeping source of truth; Fortnox push v2. | `DATA_MODEL.md` (`InvoiceSeries`/`Invoice`/`InvoiceLine`), `ARCHITECTURE.md`, `PLAN.md` Phase 4 |
| 4 | **Pricing: parity + differentiate** — flat tiers ~$39–49 / $129–149 / $299–399 + extra seats; **unlimited free client Contacts forever**; custom domain mid-tier; white-label + continuity box top-tier. | `PLAN.md` Phase 7, `AUTHZ.md` (entitlements shape), `ARCHITECTURE.md` (cost model) |
| 5 | **Resource scoping: deny-default + `client:view_all`** — zero assignments ⇒ a Member sees nothing; `client:view_all` seeded on CEO/Manager/Admin templates only; fail-closed. | `AUTHZ.md` (scoping), `DATA_MODEL.md` (`MemberClient`, `MemberProject`) |
| 6 | **Separate identities per principal type** — Member login (`User`) and Contact login are distinct accounts even with the same email: different tables, session namespaces, cookies. | `AUTHZ.md` (principals), `DATA_MODEL.md` (`User` vs `Contact`), `SECURITY.md` (sessions) |
| 7 | **v1 scope deltas accepted** — pay-now button v1 (Phase 4); performance reports v2 (v1 = report PDFs as client-visible `Document`s + CrUX charts); version sign-off v1-lite in the portal timeline (Phase 3); Issues framed as client request queue (subsumes forms/intake). Forms / proposals / recurring billing / messaging → v2; time tracking / scheduling / email marketing → skip. | `PLAN.md` (phase contents and v1/v2/skip table) |
| 8 | **Single app domain for v1** (founder's call, against the subdomain recommendation) with mitigations: one tenant-resolution seam with a hostname→tenantId lookup stubbed in; no tenant slugs in absolute URLs; centralized cookie config; portal and tenant app in separate route groups. Subdomain-per-tenant + custom domains → v2. *(The "buy the product domain now anyway" mitigation is superseded by decision 9.)* | `ARCHITECTURE.md` (routing + seam), `PLAN.md` (v2 items) |
| 9 | **v1 runs on Naxdor subdomains; product domain deferred to Phase 7** (2026-08-05) — `os.naxdor.com` (tenant + portal), `ops.naxdor.com` (platform console), dedicated sending subdomain for SPF/DKIM. Naxdor is the only tenant through Phases 1–6, one CNAME to Vercel needs no zone delegation, and the wildcard-TLS objection binds only on the v2 rollout. Two day-1 invariants: **INV-D1** no cookie ever carries a `Domain` attribute while under `naxdor.com`; **INV-D2** the host is never hardcoded — one config module owns `APP_URL`, cookies and mail sender. **This demotes B1 from a Phase 1 blocker to a Phase 7 decision.** | `ARCHITECTURE.md` ARC-11, `SECURITY.md` §2.2/§3.3/§12, `PLAN.md` (Phase 1, Phase 7), B1 below |
| 10 | **Transactional email: Amazon SES `eu-central-1` (Frankfurt)** (2026-08-08) — resolves B4. Resend **disqualified on verification** (its own docs: region selection governs send-routing only; all account data, metadata, logs and API records are stored in the US regardless); Postmark disqualified (no EU hosting, no plans). Scaleway TEM recorded as runner-up and rejected because its zero-US-sub-processor advantage is **unrealizable while Neon, R2, Stripe and Upstash are all US-parent**. AWS is already the substrate under Neon Frankfurt, so Amazon SES adds no new jurisdiction. **Naming: bare "SES" in these docs means Simple Electronic Signature — always write "Amazon SES" for email.** | `ARCHITECTURE.md` ARC-09, `SECURITY.md` §9.2, `PLAN.md` (Phase 1 week 1), B4 below |

---

## 2. Blocks Phase 1

Per §12, nothing in this section is assumed. **All Phase 1 gates are now closed** — B2 executed, B3 and B6 decided, B4 resolved (all 2026-08-08); B1 was demoted to Phase 7 by decision 9. Entries are kept in this section, under their original IDs, only so the many cross-references to them still resolve. B5 remains the sole open item here, and it gates Phase 7, not Phase 1 code. B5 sits here as a founder-flagged commercial decision that is expensive to reverse — see its decide-by note; it does not gate Phase 1 code.

### B1. Product name (decided) + domain purchases — ⬇ DEMOTED to Phase 7 by decision 9

- **Name — DECIDED 2026-08-05: Fortleva.** Swedish verb, "to continue to exist" — SO notes it is used of institutions and activities rather than of people, which is exactly the product's subject. All docs now use it; the former working title "Agency OS" is retired. Screened clean the same day: `fortleva.com`/`.app`/`.se`/`.dev` all unregistered, npm + GitHub + X + LinkedIn handles free, no commercial use found. Runners-up: Varaktig (no `.se`), Vidare (best meaning, `.com` and `.se` both taken). ⚠️ **Trademark clearance is still outstanding** — classes 9 and 42 on TMview/EUIPO/PRV/USPTO could not be checked programmatically and need a manual pass before money is spent on domains or brand assets. Note the name is easy to misspell as "fortlleva"; register the typo variant if it is cheap.
- **Superseded premise.** This item used to read "buy two apexes before Phase 1 day 1". **Decision 9 (2026-08-05) replaced that:** v1 runs on `os.naxdor.com` (tenant + portal) and `ops.naxdor.com` (platform console), with a dedicated sending subdomain for transactional mail. Nothing is purchased before Phase 1. The paragraph below that declared "**naxdor.com must never be used**" was wrong in its scope — it conflated the *wildcard-TLS* requirement (which does force nameserver delegation, and does still bind on the v2 rollout) with the *single-subdomain* case (one CNAME to Vercel, zone untouched). Kept visible rather than deleted, per §12, so the correction is legible.
- **Question (still open, now for Phase 7).** Which domains do we buy? Needed: (a) the primary product apex (e.g. `fortleva.app`) serving the marketing site plus `app.<product>.tld` for the tenant and portal planes, (b) a **second registered apex for the platform-ops console** (`<product-ops>.tld`) — specced in `ARCHITECTURE.md` ARC-11 and assumed by `AUTHZ.md` §1 and `SECURITY.md` §2.2 — and — recommended — (c) reserving the matching `.com`/`.se` variants.
- **Not on this list:** a file-delivery apex. R2 presigned URLs are served from `<account>.eu.r2.cloudflarestorage.com`, which is already a separate apex requiring no purchase; a *branded* files domain is **v2** (it needs a Worker, since R2 presigned URLs don't work on custom domains) — see C17.
- **Why it still matters.** Deferred is not free. The Phase 7 cutover touches auth cookie scoping, every absolute URL, and transactional email identity — SPF/DKIM/DMARC on a new apex plus sender-reputation warm-up is **calendar time, not effort**, so the domain purchase must lead Phase 7 by weeks, not days. What makes the deferral safe is INV-D2: the host is never hardcoded, so the cutover is a config edit plus DNS. If that invariant rots, this decision turns expensive — it is CI-enforced for exactly that reason.
- **Recommendation.** Clear the trademark check at leisure during Phases 1–6, then buy the product apex + a short ops apex (~$15–25/yr each) **early in Phase 7**; keep all Naxdor DNS untouched throughout. Registering under the founder's existing registrar is fine; delegate the product zone to Vercel nameservers **at purchase time while it is empty** (ARC-11 — delegating a live zone is the painful part), ahead of the v2 subdomain rollout (C6).
- **Decide by.** **Phase 7 design start** (was: Phase 1 day 1). **No default** — I cannot buy domains. Nothing in Phases 1–6 is blocked.

### B2. Neon project creation in Frankfurt — ✅ RESOLVED 2026-08-08

- **Done.** Project `fortleva` created in the founder's account, region confirmed **`aws-eu-central-1` (AWS Europe Central 1, Frankfurt)** from the project dashboard, Postgres 18, default compute 0.25–2 CU. The immutable choice is correct.
- **One deviation, accepted with a deadline.** Created on the **Free plan**, not Launch. Acceptable during active build (the [90-day-inactivity deletion clause](https://neon.com/pricing) cannot bite a project being worked on daily), but **upgrade to Launch before tenant-zero data lands** — a database holding real Naxdor client data does not live on a free tier. Plan is changeable at any time; only the region was a one-way door.
- **Standing rules from `TENANCY.md`, still in force.** No roles are ever created via the Neon console/API/CLI (they join `neon_superuser` and carry BYPASSRLS, silently defeating RLS); `app_runtime`/`app_platform` are created in versioned migration SQL — Phase 1, migration 001, not by hand. Pooled connection string (`-pooler`) → `DATABASE_URL`, direct → `DIRECT_URL`; both stored in Bitwarden, never in the repo.
- ~~**Decide by.** Phase 1 day 1.~~ Done — nothing blocks on Neon.

### B3. Template-drift policy — ✅ RESOLVED 2026-08-08: **Option B, tracked-diff-additive**

Founder accepted the recommendation as specced. The Phase 1 `Role`/`RolePermission` migration therefore carries template lineage + per-permission override tracking from day one, including the `TENANT_REVOKE` tombstone semantics already shaped in `DATA_MODEL.md` (`RolePermissionSource`): additions auto-propagate to clones unless overridden, removals never auto-propagate, every propagation writes an `AuditEvent`. Original decision record kept below.

- **Question.** When a Tenant clones a system role template (CEO/Manager/Admin/Employee) and the Platform later adds a permission to that template — e.g. a new module ships with `report:view` — what happens to existing tenant clones?
  - **Option A — frozen clones:** the clone never changes; tenants (or the Platform, manually) opt in to updates.
  - **Option B — tracked-diff-additive:** each tenant `Role` records its source template + explicit per-permission overrides; **new permissions added to the template auto-propagate to clones unless the tenant has overridden that permission; removals never auto-propagate.** Every propagation writes an `AuditEvent`.
- **Why it matters.** This decides the Phase 1 `Role`/`RolePermission` schema (template linkage + override tracking must exist from the first migration — [retrofitting diff-tracking is painful](https://workos.com/blog/how-to-design-multi-tenant-rbac-saas), and the "global defaults with tenant-level diffs" hybrid is the documented industry pattern). Frozen clones make every future module launch a manual per-tenant role-migration chore for the founder, forever.
- **Recommendation.** **Option B, tracked-diff-additive.** One line: additive propagation is the only direction that can never lock a tenant out (removals are the lockout risk; additions are auditable and reversible per tenant), and it keeps role maintenance O(1) for the Platform as modules ship. `AUTHZ.md` specs both options and this recommendation.
- **Decide by.** Before the Phase 1 roles migration. **No default** (schema-shaping).

### B4. ESP for transactional email — ✅ RESOLVED 2026-08-08 (decision 10): **Amazon SES `eu-central-1`**

- **Question (answered).** Which email service provider sends the product's transactional mail — member invites, Contact portal invites, verification/MFA fallback, notifications, and (later) continuity-box alerts?
- **Why it mattered.** Member invite flows are Phase 1; DNS records (SPF/DKIM/DMARC) go on the v1 sending subdomain under `naxdor.com` (decision 9, *not* the product domain — B1 is now Phase 7) and deliverability warm-up takes weeks. The ESP becomes a **sub-processor** in the GDPR chain (§9; `SECURITY.md` §9.2), and continuity-box notifications are the highest-stakes email this product will ever send. One design rule was fixed regardless of vendor and still is: **key material never transits email** (`CONTINUITY_BOX.md`) — ESP logs are exactly why.
- **Spike run 2026-08-06; decided 2026-08-08.** The Phase 0 sweep had not covered ESPs, so a spike ran against four candidates on EU processing, bounce/complaint webhooks, solo-dev DX, and pricing at hundreds of emails/month.
  - **Resend — disqualified.** Verified against [Resend's own region docs](https://resend.com/docs/dashboard/domains/regions): region selection controls only where mail is *routed and sent from*; "all account data, including email metadata, logs, and API records, is stored in the United States regardless of the sending region you select." EU send-region is also Pro-tier+. This resolved `ARCHITECTURE.md` ARC-09's old "not verified" flag **negative**.
  - **Postmark — disqualified.** No EU hosting and publicly no plans to add it; all data US, SCCs in the DPA.
  - **Scaleway TEM — runner-up, not taken.** French (iliad Group), EU-only with no US sub-processors, free ≤300/day then ~€1/1k, native webhooks. Rejected because the sovereignty upgrade it sells is **unrealizable at v1**: Neon, R2, Stripe and Upstash are all US-parent, so a zero-US-sub-processor chain cannot be honestly claimed whichever ESP sends the mail (`SECURITY.md` §9.3). Take it if a tenant's procurement ever demands that chain end-to-end — the adapter swap is a day.
  - **Amazon SES `eu-central-1` — chosen.** Data at rest in the same region as Neon, and since Neon Frankfurt *is* `aws-eu-central-1`, AWS is already in the chain — this adds no new jurisdiction and yields one clean sentence: everything at rest in Frankfurt. ~$0 at v1 volume. Strongest vendor-longevity story, which is the tiebreak that matters for continuity alerts. Costs accepted: worst DX (React Email still templates fine — the loss is the unified send SDK) and bounce/complaint events via SNS rather than a plain webhook.
- **Two scheduling claims made on 2026-08-06 were refuted on 2026-08-08 and must not be reintroduced.** (a) Production access does **not** require SPF/DKIM/DMARC to be published first — [AWS's own page](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html) calls prior domain verification "a best practice that helps to get your production access request approved faster", and the only required fields are mail type and website URL; sandbox is 200/24h to verified recipients and AWS promises an *initial response* in 24h, not approval. (b) **Warm-up is effectively zero** — it matters for dedicated IPs and bulk volume, and Fortleva is transactional-only on shared IPs at hundreds of mails/month. Together these shorten the Phase 1 critical path that the earlier framing had inflated to "weeks".
- **Live DNS survey, 2026-08-08 — the finding that actually changes the plan.** `send.naxdor.com` is **already in use** by a pre-existing Amazon SES identity pinned to `eu-west-1` (Ireland). v1 therefore sends from **`mailer.naxdor.com`** with MAIL FROM `bounce.mailer.naxdor.com`. Details, apex-safety rules and the IAM/SES-Tenants follow-ups are in `ARCHITECTURE.md` ARC-09; the legacy `eu-west-1` identity needs its own audit-and-decommission change (**new item: C20**).
- **Consequences now landed.** `ARCHITECTURE.md` ARC-09 rewritten; `SECURITY.md` §9.2 sub-processor row replaced with the AWS entity; `PLAN.md` Phase 1 week 1 carries the DNS + production-access task. **Naming hazard recorded:** bare "SES" already means *Simple Electronic Signature* in this doc set (`DATA_MODEL.md` `SignatureLevel.SES`, `AUTHZ.md` `portal.contract.sign`) — the email provider is always written **"Amazon SES"**, and the mail adapter must not be named `ses`.

### B5. Pricing currency: SEK vs USD vs dual *(flagged decide-by — does not gate Phase 1 code)*

- **Question.** In which currency do tenants subscribe — SEK, USD, or dual (SEK for Swedish tenants, USD for the rest)?
- **Why it matters.** [Currency is sticky per Stripe customer](https://docs.stripe.com/currencies): once a Tenant's first subscription exists, that customer is locked to its currency — switching later means a new Stripe customer and a migration. Decision 4's price anchors are USD-denominated; a Swedish AB settling USD eats Stripe's ~2% conversion unless a USD bank account is added ([Stripe pricing, Sweden](https://stripe.com/en-se/pricing)). Nothing in Phases 1–6 touches this — it shapes Phase 7's Price catalog (`currency_options`), Checkout, and the marketing site.
- **Recommendation.** **Dual, via one Stripe Price with `currency_options`**: SEK for Swedish tenants, USD for everyone else. One line: it matches how each buyer thinks about money and avoids repricing either market later; add a USD bank account when US volume justifies it.
- **Decide by.** Before Phase 7 design starts (the phase's first task is the plan/price catalog). Listed among blockers at the founder's request because it is a one-way door commercially — but it can safely wait until Phase 7 as long as it is *decided before the first paying tenant checks out*.

### B6. Default role-seeding matrix sign-off — ✅ RESOLVED 2026-08-08: accepted as specced

Founder reviewed a digest of the §3.2 C/M/A/E matrix (including the two most opinionated defaults, called out explicitly: Managers cannot issue invoices while Admins can, and Employees see only assigned clients per decision 5) and accepted it unchanged. The Phase 1 seed migration and the deny-matrix CI suite build from `AUTHZ.md` §3.2 as written. These are defaults — tenants clone and customize, and B3's additive propagation carries future template changes. Original decision record kept below.

### B6 (original record). Default role-seeding matrix sign-off (`AUTHZ.md` §3.2)

- **Question.** Do you accept the C/M/A/E seeding columns of the 64-code catalog as they stand? They are opinionated in three places worth your eyes: **Employees get no invoice permissions at all** (not even `invoice:view`); **Managers can create and edit draft invoices but cannot `invoice:issue`, `invoice:send`, `invoice:record_payment` or `invoice:credit`** (issuing is legally significant and irreversible, so it sits with CEO + Admin); and **`continuity_box:edit` / `:configure` are CEO-only**, as are `invoice:manage_series`, `billing:manage`, `settings:manage_modules` and `tenant:export`.
- **Why it matters.** `AUTHZ.md` §11 item 2 flags this as needing founder review **before the Phase-1 seed migration**. Permission codes are immutable and the seed rows are what every tenant's system roles are built from; changing the matrix after tenants exist means a per-tenant role migration, not a code edit. It also decides what the deny-matrix CI suite asserts — get it wrong and the tests lock the wrong answer in.
- **Recommendation.** **Accept as specced**, with one deliberate consequence acknowledged: a Manager at a small agency will ask why they cannot send an invoice. The answer is that they can prepare it and a CEO/Admin issues it — which is the right default for a legally irreversible act, and a tenant that disagrees clones the Manager template and grants the codes (that is what clone-and-customize is for). One line: default *tight* on the irreversible verbs, because loosening a template is a click and tightening it after a mistake is a conversation.
- **Decide by.** Before the Phase-1 seed migration (same gate as B3). **No default** — `AUTHZ.md` declares it a Phase-1 blocker.

---

## 3. Can wait

Each item: question · why it matters · recommendation (one-line rationale) · decide-by. Recommendations become defaults if undecided at the decide-by point.

### C1. Downgrade semantics for portal Contacts of over-limit Clients

- **Question.** Tenant downgrades below its `maxClients` entitlement. Tenant-side behavior is settled research-backed policy: [read-only grandfathering, Trello model](https://community.atlassian.com/forums/Trello-questions/What-happens-to-the-boards-when-you-downgrade-to-free/qaq-p/1987366) — block creation past the limit, never delete or hide. Open: what do **portal Contacts of the over-limit Clients** experience?
- **Why it matters.** This is where the tenant's billing state becomes visible to *their* customers — the most brand-sensitive edge in the entitlement system. Hiding a Contact's own project files because their agency downgraded would contradict the product's continuity positioning outright.
- **Recommendation.** Tenant chooses which Clients stay active; excess Clients go read-only **symmetrically**: staff cannot write to them, portal Contacts keep full read + file download but cannot open new Issues (existing threads visible; a neutral "temporarily read-only" note, no mention of the tenant's billing). One line: data is never hidden from the people it belongs to, and staff/portal symmetry avoids issues nobody can triage. v1 scope: enforced when entitlements ship.
- **Decide by.** Phase 7 (entitlement enforcement design).

### C2. Continuity-box retention after tenant churn + who pays storage

- **Question.** A Tenant offboards (cancels, or vanishes — the latter being the box's whole scenario). How long do sealed `ContinuityBox` blobs remain openable, and who pays for the storage?
- **Why it matters.** The entitlement exemption is already decided in principle (the box must survive billing lapse — a box that seals itself on nonpayment defeats its purpose), but the *endpoint* is undefined, and it interacts with GDPR retention (`SECURITY.md`) and the ToS. Tenant churn caused by disappearance is precisely when Clients need the window to notice, request, and clear the veto period.
- **Recommendation.** Retain sealed boxes **12 months after tenant offboarding**, openable under the normal trigger flow; platform absorbs storage — at [R2's $0.015/GB-month](https://developers.cloudflare.com/r2/pricing/) a 1 GB box costs ~$0.18/year, so "who pays" is a non-question at v1 scale. One line: 12 months comfortably covers notice + request + veto for every plausible disappearance timeline, at negligible cost; state the window in the ToS and DPA retention schedule.
- **Decide by.** Phase 8 design (window value); ToS drafting in Phase 7 (the promise).

### C3. Veto-window default + trustee default + hostile-veto arbiter stance

- **Question.** Three parameters the settled trigger model (request → notify → veto window → auto-grant, per [Bitwarden Emergency Access](https://bitwarden.com/help/emergency-access/)) leaves unbound: (a) default veto-window length; (b) is a trustee (Shamir share C holder) mandatory at sealing, and who is the default; (c) what is the Platform's stance when a tenant vetoes in bad faith while actually defunct?
- **Why it matters.** (a) trades false-positive opens (tenant on holiday) against delay in genuine disasters; (b) trades custody resilience against sealing friction that could kill feature adoption; (c) is the one place the Platform cannot stay purely mechanical.
- **Recommendation.** (a) **Default 21 days, configurable 7–60**, auto-shortened to the 7-day floor when platform-observed dead-man signals corroborate (lapsed subscription + 60 days without staff logins). 21 is the reasoned midpoint: long enough to absorb a three-week holiday with 11 escalating notifications inside it, short enough that a genuinely defunct agency does not cost the client a month — and it is now the single value carried identically by `CONTINUITY_BOX.md` §3.2, `DATA_MODEL.md` (`vetoWindowDays @default(21)`) and `PLAN.md` Phase 8. (b) **Trustee optional with a loud warning**; suggested default trustee = a second Contact at the Client; sealing without one requires acknowledging that a lost card then means B+C recovery is impossible — mandatory trustees would strangle adoption of the flagship feature. (c) **Platform as process arbiter, never content adjudicator**: after 2 vetoes on the same box, or any veto while the subscription is lapsed, escalate to a platform-mediated dispute with low-volume human review ([Apple's Legacy Contact manual-review model](https://support.apple.com/guide/security/legacy-contact-security-secebf027fb8/web)); cooldown of 30 days between requests. All three configurable per box within bounds.
- **Decide by.** Phase 8 design; (c) also needs the lawyer's view (C9).

### C4. BankID broker contract (Idura) — trigger condition

- **Question.** When do we sign the pooled platform account at [Idura (ex-Criipto): €139/mo incl. 200 signatures + €0.013/BankID transaction](https://idura.eu/pricing/signatures)? v1 e-sign is the native SES click-to-accept + upload-signed-PDF (settled); BankID is the v1.5 upsell.
- **Why it matters.** €139/mo is the first standing cost that exceeds the entire v1 infrastructure bill; signing early is dead weight, signing late loses a deal. Pricing and the Criipto→Idura rebrand are both churning — figures need re-verification at contract time.
- **Recommendation.** Sign when the **first paying tenant commits to a tier priced to cover it, or two tenants request BankID** — whichever first; sandbox integration (free, no card) can be built one sprint ahead of that. One line: the pooled-account arbitrage only pays once real demand exists; gate as an entitlement, never a role check.
- **Decide by.** Revisit quarterly from Phase 4 (contracts ship). v1.5 scope.

### C5. Fortnox marketplace application timing

- **Question.** When do we register as a [Fortnox developer](https://www.fortnox.se/developer) and start the marketplace review for the v2 invoice-push integration?
- **Why it matters.** Registration needs a Swedish orgnr/BankID (founder action), marketplace review takes calendar time, and the end customer pays Fortnox for integration access (~189 kr/mån on cheap tiers) — a surprise cost to warn tenants about. [Rate limits (25 req/5 s)](https://www.fortnox.se/en/developer/guides-and-good-to-know/rate-limits-for-fortnox-api) are ample at our scale. Bokio gatekeeps public integrations — Fortnox is first, settled by decision 3's v2 note.
- **Recommendation.** Register the (free) developer account when Phase 4 ships — cheap option value, no commitment; file the marketplace application only when the v2 integration is actually being built and ≥1 tenant asks. One line: registration is free optionality, review is not worth starting before there is software to review.
- **Decide by.** Post-Phase 4 review. v2 scope.

### C6. Subdomain-per-tenant rollout trigger

- **Question.** Decision 8 defers wildcard subdomains (`{tenant}.product.app`) to v2 with the seam pre-built. What triggers the rollout?
- **Why it matters.** Rollout requires delegating the product apex to Vercel nameservers (recreating MX/TXT there — coordinate with B4's email DNS), flipping the auth cookie to apex scope, and exercising the hostname→tenantId resolver against real traffic ([wildcards work on all Vercel plans](https://vercel.com/docs/multi-tenant/limits); per-subdomain certs are automatic and $0).
- **Recommendation.** Roll out **as part of Phase 7 productization** — branded portal URLs are part of what self-signup tenants are buying — or earlier if a paying tenant asks; not before, since the single-domain machinery is decision 8's point. One line: tie it to the phase whose sales story needs it.
- **Pushback (recorded, not reopening decision 8).** Research recommended subdomains from day 1; the founder's mitigations make deferral acceptable, but every month on a single domain accretes absolute URLs and email templates that assume it. Treat Phase 7 as a hard deadline, not a soft target — the seam only stays cheap if it is exercised before the codebase is large.
- **Decide by.** Phase 7 planning. v2 scope (may pull into late v1 if a tenant pays).

### C7. Custom-domain premium pricing

- **Question.** Decision 4 places custom domains in the mid-tier. Open: exact packaging — bundled in mid-tier only, or also a standalone add-on for lower tiers, and at what price?
- **Why it matters.** Vercel adds [no per-domain fee](https://vercel.com/docs/platforms/multi-tenant-platforms/configuring-domains); the real costs are the auth token-handoff flow (cookies never cross apexes) and tenant DNS support labor. Comparable: [Clerk charges $10/mo per satellite domain](https://clerk.com/pricing) just for the auth leg. Research prices the feature at $25–50/mo to cover support.
- **Recommendation.** **Bundled in mid-tier per decision 4; no standalone add-on at launch** (add-on creep is the industry's dirty secret — decision 4's "honest flat pricing" cuts against it); build only when the first tenant on mid-tier actually asks. One line: the tier already sells it; a second SKU adds pricing noise before there is demand.
- **Decide by.** Phase 7 pricing sheet. Build is v2.

### C8. SaaS escrow as a marketing asset

- **Question.** Do we buy formal platform-level escrow ([Codekeeper, ~$199/mo billed annually + $249 setup ≈ $2.6k/yr](https://codekeeper.co/pricing)) before scale justifies it, to market "we escrow ourselves"?
- **Why it matters.** Platform-level continuity v1 is settled (scheduled per-tenant exports pushed outside our infra + self-hosting runbook + founder-credential emergency access + ≥90-day wind-down ToS commitment). Escrow is the paid upgrade to that story — and for a product whose flagship feature *is* continuity, the credibility argument runs ahead of the scale argument. Un-verified deposits are largely ritual, though: real verification is where escrow costs explode.
- **Recommendation.** **Defer at launch; revisit at ~$5k MRR or the first tenant who asks for it in procurement** — whichever first — and if bought, market it prominently. One line: $2.6k/yr against a sub-$50/mo infra bill is premature until revenue or a deal demands it; the v1 export machinery is the substance, escrow is the certificate.
- **Decide by.** Quarterly review post-launch (first review at Phase 7 exit). v2 scope.

### C9. Swedish lawyer engagement — scope and timing

- **Question.** When do we engage a Swedish lawyer, and with what scope? The compiled question list lives in **`CONTINUITY_BOX.md` §"Questions for a Swedish lawyer"** — headlined by the #1 question: enforceability of a pre-agreed release trigger against a Swedish konkursbo (ipso facto / återvinning), plus framtidsfullmakt limits for company functions, dödsbo unanimity, and GDPR bases for release and trustee shares.
- **Why it matters.** The brief (§8) is explicit that the legal mechanism is the hard half and demands questions, not amateur legal advice. Three deliverables depend on the engagement: the box's trigger/claimant design (Phase 8), the template continuity clause for tenant↔client contracts, and the ToS/DPA package (Phase 7) whose disclaimers `CONTINUITY_BOX.md` already lists.
- **Recommendation.** **One fixed-fee engagement, scheduled during Phase 7** so ToS/DPA and the box design are reviewed together, and *before any Phase 8 code*: scope = the `CONTINUITY_BOX.md` question list + ToS/DPA/continuity-clause review + C10's notification wording. One line: a single combined engagement is cheaper than two, and Phase 8 must not be built on unreviewed trigger assumptions.
- **Decide by.** Book by Phase 7 start; answers in hand before Phase 8 build.

### C10. Skatteverket EU-storage language (BFL 7 kap. 3a §)

- **Question.** Issued invoices are the tenant's räkenskapsinformation; stored in Neon Frankfurt they are "stored abroad (EU)", which [BFL 7 kap. 3a § permits if Skatteverket is notified of the location](https://www.bfn.se/fragor-och-svar/arkivering/), with immediate electronic access and printability in Sweden. The duty is the **tenant's**, not ours. What is our stance: ToS clause only, in-product notice at invoicing activation, or both — and does tenant zero (Naxdor) file its own notification?
- **Why it matters.** Silence sets Swedish tenants up for a compliance foot-fault we knew about; over-lawyering the onboarding adds friction. Decision 3 already positions the tenant's accounting system as the archival source of truth, which softens — but does not remove — the point.
- **Recommendation.** **Both**: a plain-language in-product notice when a tenant activates Invoicing (with a link to the BFN guidance) + a ToS clause; wording reviewed inside C9's engagement. Naxdor files its own notification when Phase 4 goes live. One line: a one-screen notice at activation is the cheapest possible discharge of a duty we cannot perform for them.
- **Decide by.** Notice + Naxdor filing at Phase 4; ToS text at Phase 7.

### C11. Performance-data ingestion: service-account vs OAuth (v2)

- **Question.** Performance reports are v2 (decision 7; v1 = uploaded report PDFs + CrUX charts, which need [only an API key](https://developer.chrome.com/docs/crux/api)). For v2 sync of Search Console/GA4: service-account-invite pattern or full OAuth?
- **Why it matters.** OAuth on `webmasters.readonly`/`analytics.readonly` means [sensitive-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification) — free but realistically weeks, with Testing-mode refresh tokens dying every 7 days until published, and any future restricted scope triggering CASA ($540–4,500/yr). The service-account pattern (tenant adds our SA email to each property) ships in days with no verification — but [broke platform-wide for two months in 2026](https://discuss.google.dev/t/problem-with-new-service-accounts/362176), so it can never be the only path.
- **Recommendation.** **Service-account invite, with CSV/PDF upload as the permanent fallback**; choose OAuth later only if tenants demonstrably cannot add users to their clients' properties, and start verification 1–2 months before that build. One line: days-not-weeks to ship, no verification treadmill, and the fallback covers the pattern's known outage mode.
- **Decide by.** v2 planning, after Phase 6.

### C12. Virus-scanning trigger condition

- **Question.** v1 ships the cheap mitigations (extension/MIME allowlist, `Content-Disposition: attachment`, separate download host — the XSS surface outranks the malware surface at this scale — plus a `scanStatus` field on `FileObject` so scanning is retrofit-free). When do we wire real scanning ([attachmentAV via R2 event notifications](https://attachmentav.com/blog/antivirus-for-cloudflare-r2/), which drags in Cloudflare Queues on the $5/mo Workers plan)?
- **Why it matters.** Contacts are the least-trusted principals (§9), and Phase 5's Issues attachments are the first surface where they upload files that tenant staff then open. Scanning before any hostile upload path exists is dead cost; after, it is exposure.
- **Recommendation.** **Trigger = Phase 5 Issues attachments opening to any non-Naxdor tenant** (i.e., mandatory before Phase 7 self-signup; optional while tenant zero is the only tenant). One line: scan from the moment strangers can upload to staff, not before.
- **Decide by.** Phase 5 build (flip on by Phase 7 at the latest).

### C13. `maxCustomRoles` cap values per tier, and the step-up MFA action list

- **Question.** Two parameters `AUTHZ.md` §11 (items 3–4) leaves unbound: (a) the per-tier `maxCustomRoles` entitlement limit that keeps role explosion in check; (b) which actions beyond `continuity_box:edit`, `continuity_box:configure` and `tenant:export` require a **step-up** (fresh second factor within 10 minutes, `SECURITY.md` §3.6).
- **Why it matters.** (a) is an entitlement number, so it lands with the Phase-7 plan catalog and is easy to raise, hard to lower. (b) is pure friction-vs-assurance: every added action taxes a real workflow, and the ✦ `requiresMfa` set already forces enrollment for all of them.
- **Recommendation.** (a) **5 / 15 / 30 by tier** — templates carry ~90% of tenants at zero custom roles, so the cap only ever bites on genuine sprawl. (b) **Add exactly two:** `member:manage_roles` and `role:edit` (the escalation surface), leaving billing and settings on enrollment-only. One line: step up where a compromised session could grant itself permanence, not where it could merely spend money that is already audited and reversible.
- **Decide by.** (a) Phase 7 pricing sheet; (b) Phase 1 (it is a constant in the authorization seam, trivially changed later).

### C14. Audit-retention job execution + the Neon/CLOUD-Act DPA wording

- **Question.** Two items `TENANCY.md` §13 routes here: (a) confirm the audit-retention job runs as a **Vercel cron** hitting a `CRON_SECRET`-protected route under a privileged role, since [pg_cron does not fire while Neon compute is scaled to zero](https://neon.com/docs/extensions/pg_cron); (b) settle the DPA/sub-processor language for the Neon jurisdiction nuance — data at rest in Frankfurt, US parent (Databricks), CLOUD Act reachable in principle.
- **Why it matters.** (a) a retention schedule that silently never runs is worse than none: it is a documented promise in the ROPA that the log quietly contradicts. (b) `SECURITY.md` §9.2/§9.3 already states the honest position; what is open is the *contract wording* a tenant's counsel reads.
- **Recommendation.** (a) **Confirmed as specced** — Vercel cron, idempotent and chunked, with an alert when a monthly run does not complete; add a CI/monitoring assertion that the job ran, because the failure mode is silence. (b) Take `SECURITY.md` §9.2's sub-processor row verbatim into the DPA and let C9's lawyer engagement polish it; do not soften "CLOUD Act reachable in principle" — the honest line is also the defensible one, and it is equally true of AWS/GCP/Azure.
- **Decide by.** (a) Phase 1 (job ships there); (b) Phase 7 with the DPA, inside C9's engagement.

### C15. Paid invoice "archive mode" after offboarding

- **Question.** `SECURITY.md` §10 and §13: issued invoices are the tenant's räkenskapsinformation with a 7-year BFL clock that outlives the subscription. At offboarding we hand over the archive export and delete. Do we also offer a **paid read-only archive mode** — the tenant keeps hosted access to their issued invoices after they stop paying for the product?
- **Why it matters.** It is the difference between "here is a zip, good luck for seven years" and a small recurring revenue line that also reduces the risk of a former tenant losing records they are legally required to keep. It also touches the deletion promise: an archive mode is an exception to "deleted day 90".
- **Recommendation.** **Not at launch.** The export (JSONL + PDFs + manifest) plus decision 3's position that the tenant's *accounting system* is the archival source of truth discharges the duty; a paid archive tier is a product with its own support surface. Revisit if a departing tenant asks — the R1 retention rules already make the data survivable. One line: sell the export, not the hostage.
- **Decide by.** Phase 7 ToS drafting (the promise must be stated either way).

### C16. Tenant-enforced MFA preference, and contact MFA

- **Question.** `SECURITY.md` §3.5 leaves two MFA items open: (a) a `TenantPreference` letting a tenant require MFA for **all** its members (today: mandatory only for owner-equivalent/✦-holders, available to everyone else); (b) confirmation that **contact MFA stays v2** (`DATA_MODEL.md` P5 — no `ContactTwoFactor` model in the v1 schema).
- **Why it matters.** (a) is the first thing an enterprise-ish client of a tenant asks for and is cheap once the enrollment-forcing machinery exists. (b) is a stated deviation from brief §9's "MFA available everywhere" and must stay stated in exactly one place rather than drifting between docs.
- **Recommendation.** (a) **v2**, as specced — build it when a tenant asks; the enforcement hook (force enrollment at next login) already exists for ✦ holders, so it is a preference row and a check. (b) **Confirm v2**: the portal is invite-only, rate-limited and read-mostly in v1, and the second Better Auth instance makes `ContactTwoFactor` purely additive — likely landing beside BankID, itself a stronger factor.
- **Decide by.** Phase 7 (a); (b) is already spec'd v2 — say so now if you disagree, because it is cheaper before the portal ships.

### C17. `Contact.email` global uniqueness, and a branded file-delivery apex

- **Question.** Two deliberate v1 narrowings, both cheap to relax later and expensive to reverse if built now: (a) `Contact.email` is **globally unique in v1** (`DATA_MODEL.md` P2) — the same person cannot be a portal contact of two tenants with one address; relax to `(tenantId, email)` when Host-based tenant resolution lands (v2). (b) A **branded file-delivery domain** (`<product-files>.tld`) instead of the R2 endpoint — v2, because R2 presigned URLs do not work on custom domains without a Worker (ARC-06/ARC-11).
- **Why it matters.** (a) is a real, if rare, user-facing limitation at tens of tenants; plus-addressing is the workaround. Relaxing is a constraint drop; the reverse would be a data migration. (b) is cosmetic in v1 and the R2 endpoint is already cookie-free, which is the property that matters.
- **Recommendation.** **Both stay as specced.** (a) Relax with the v2 subdomain rollout (C6), not before. (b) Build the branded files apex only alongside custom domains, if at all. One line: neither buys anything a v1 tenant would notice, and both get cheaper after the subdomain work.
- **Decide by.** (a) with C6 (Phase 7 planning); (b) v2.

### C18. Lower-tier continuity add-on, and Vercel WAF EU usage rates

- **Question.** (a) `CONTINUITY_BOX.md` P4: the box is top-plan-gated per decision 4, which points the flagship feature away from one-person agencies — its most natural beneficiaries. Do we offer a per-client **continuity add-on** on lower tiers (cost-covering, not free)? (b) `ARCHITECTURE.md` §8: confirm current Vercel WAF **EU usage rates** before relying on anything beyond the free custom rules.
- **Why it matters.** (a) every open request and dispute is a human-attention event (escrow incumbents bill ~$199/hr for release processing), which is why gating is partly a support-cost decision — but the story "the agency platform with a continuity box" sells worst to the tier that needs it most. (b) `SECURITY.md` §4 already rejects Vercel's paid rate limiting on semantics (IP/JA4 keys, per-region counters); the only open item is the price of what we *do* use, which is the $0 rules.
- **Recommendation.** (a) **Hold the top-tier gate at launch; revisit after the first ten boxes exist** with real request volume in hand — then price an add-on at roughly one support-hour per client per year rather than opening it free. (b) **No action** — v1 uses only free WAF custom rules; re-check rates if we ever enable paid features. One line: measure the support cost before pricing against it.
- **Decide by.** (a) post-Phase 8 launch review; (b) whenever paid WAF features are first considered.

### C19. US-established tenants and US sales tax (invoicing scope)

- **Question.** `DATA_MODEL.md` §6.7 now states the v1 seller-side scope: **Swedish-established issuing tenants only**. Selling *to* US clients is fully supported (OUTSIDE_SCOPE profile); a US-established *issuing entity*, and any sales-tax/nexus concept, are out of scope. Confirm — including for Naxdor itself, which brief §1 describes as operating in Sweden + US: **which entity issues invoices through the product in v1?**
- **Why it matters.** The whole issuer model is Swedish (one issuer-identity block on `Tenant`, three VAT profiles, the SEK-VAT rule, BFL retention). If Naxdor intends to invoice US clients from a US entity through this product, that is a second tax regime and a Phase-4 scope change, not a settings toggle.
- **Recommendation.** **Swedish entity issues; scope stands.** The extension path is named and non-destructive when it is worth building (a tenant-level tax-regime enum selecting a per-regime issuer profile set — `VatProfile` is already per-invoice and `sellerSnapshot` already freezes issuer identity per invoice). One line: build the second regime for a paying US tenant, not for a hypothetical one.
- **Decide by.** Phase 4 design start (the answer only changes what Phase 4 renders).

### C20. Legacy Amazon SES identity on `send.naxdor.com` (`eu-west-1`)

- **Question.** A live SES custom MAIL FROM for `send.naxdor.com` pinned to **`eu-west-1` (Ireland)** was found during the 2026-08-08 DNS survey — `MX 10 feedback-smtp.eu-west-1.amazonses.com` + `TXT v=spf1 include:amazonses.com ~all`, authoritative on `ns1.vercel-dns.com`. What still sends through it, and when is it decommissioned?
- **Why it matters.** It is unmanaged sending surface on the same registered domain Fortleva now sends from: its reputation is shared with `mailer.naxdor.com` under relaxed DMARC alignment at the organizational-domain level, and nobody is currently watching its bounce or complaint rates. It is *not* a residency violation (Ireland is EU) and it does **not** block Phase 1 — Fortleva sends from a different subdomain by design. It is also financially relevant: SES pricing plans are per account **and** per Region, and whether this identity has metered activity since 2025-06-01 determines whether the account is on legacy à-la-carte (~$0.10/1K) or Essentials ($0.16/1K) — a difference of pennies at v1 volume, so read the console rather than assuming, and never switch to Pro or Enterprise.
- **Recommendation.** **Audit in Phase 1 week 1, decommission later as its own change with its own rollback.** Do not touch those two DNS records while standing Fortleva up — a broken MAIL FROM MX drives the legacy identity `Success → TemporaryFailure → Failed` and misroutes its bounce feedback. Add both records to the Phase 1 DNS regression baseline so an accidental edit is caught by the same pass.
- **Decide by.** Audit in Phase 1 week 1; decommission any time after Fortleva mail is live and stable.

---

## 4. Decide-by schedule (at a glance)

| ID | Decision | Decide by | Default if undecided |
|---|---|---|---|
| B1 | ~~Product name~~ (decided: **Fortleva**, 2026-08-05; trademark check outstanding) + domain purchases | **Phase 7 design start** (demoted from Phase 1 day 1 by decision 9) | None — v1 runs on `os.`/`ops.naxdor.com` |
| B2 | ~~Neon project, Frankfurt, founder's account~~ (done 2026-08-08: `fortleva`, Frankfurt confirmed, PG18; Free plan — upgrade to Launch before tenant-zero data) | ~~Phase 1 day 1~~ — resolved | Settled |
| B3 | ~~Template-drift policy~~ (decided 2026-08-08: **Option B, tracked-diff-additive**) | ~~Phase 1 roles migration~~ — resolved | Settled |
| B4 | ~~ESP for transactional email~~ (decided: **Amazon SES `eu-central-1`**, 2026-08-08, decision 10) | ~~Phase 1 week 1–2~~ — resolved | Settled — DNS + production access are now Phase 1 week 1 *tasks*, not decisions |
| B5 | Pricing currency (SEK/USD/dual) | Phase 7 design start | None — one-way door; rec: dual via `currency_options` |
| B6 | ~~Default role-seeding matrix sign-off~~ (accepted as specced 2026-08-08) | ~~Phase 1 seed migration~~ — resolved | Settled |
| C1 | Over-limit portal semantics | Phase 7 | Symmetric read-only, reads never hidden |
| C2 | Box retention post-churn | Phase 8 (ToS: Phase 7) | 12 months, platform pays |
| C3 | Veto window / trustee / arbiter | Phase 8 (+C9) | **21d default (7–60 configurable, 7 on corroborating signals)**, optional trustee, process-arbiter stance |
| C4 | Idura BankID contract | Quarterly from Phase 4 | Sign at first covering tenant or 2 requests |
| C5 | Fortnox marketplace timing | Post-Phase 4 | Dev account at Phase 4; application with v2 build |
| C6 | Subdomain rollout trigger | Phase 7 planning | Ship with Phase 7 |
| C7 | Custom-domain packaging | Phase 7 pricing sheet | Mid-tier bundled, no add-on |
| C8 | Platform escrow | Quarterly post-launch | Defer; revisit at ~$5k MRR or procurement ask |
| C9 | Lawyer engagement | Book by Phase 7 start | Single fixed-fee engagement, combined scope |
| C10 | BFL EU-storage stance | Phase 4 / Phase 7 | In-product notice + ToS clause; Naxdor files |
| C11 | Perf-data sync path | v2 planning | Service-account invite + upload fallback |
| C12 | Virus-scanning trigger | Phase 5 | On when contact uploads reach non-Naxdor tenants |
| C13 | `maxCustomRoles` caps · step-up MFA action list | Phase 7 · Phase 1 | 5/15/30 by tier; step up `member:manage_roles` + `role:edit` |
| C14 | Audit-retention cron confirmation · Neon CLOUD-Act DPA wording | Phase 1 · Phase 7 (C9) | Vercel cron + run-completion alert; `SECURITY.md` §9.2 wording verbatim |
| C15 | Paid invoice archive mode after offboarding | Phase 7 ToS | Not at launch — export discharges it |
| C16 | Tenant-enforced MFA preference · contact MFA | Phase 7 · now | Both v2 (`DATA_MODEL.md` P5) |
| C17 | `Contact.email` global uniqueness · branded files apex | With C6 · v2 | Both stay as specced; relax with subdomains |
| C18 | Lower-tier continuity add-on · Vercel WAF EU rates | Post-Phase 8 · when paid WAF considered | Hold top-tier gate; no action on WAF (free rules only) |
| C19 | US-established tenants / US sales tax scope | Phase 4 design start | Swedish issuing entity only; extension path named |
| C20 | Legacy Amazon SES identity on `send.naxdor.com` (`eu-west-1`) | Audit Phase 1 week 1; decommission later | Leave its DNS untouched; audit, then retire in its own change |

*End of Phase 0 decision ledger. B1 (Phase 7), B2 (executed), B3 (Option B), B4 (decision 10) and B6 (accepted) are settled — **nothing gates Phase 1; the build clock started 2026-08-08** (`PLAN.md`).*

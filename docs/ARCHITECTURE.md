# ARCHITECTURE.md — Fortleva

**Status:** Phase 0 specification — no application code. Draft for founder review.
**Date:** 2026-08-03
**Companion docs:** `PLAN.md` (phasing), `TENANCY.md` (isolation mechanics), `AUTHZ.md` (permission model), `DATA_MODEL.md` (schema), `SECURITY.md` (threat model, GDPR), `CONTINUITY_BOX.md`, `OPEN_QUESTIONS.md`.

This document records **stack and structural decisions** with rationale, trade-offs, and rejected options (brief §0, §1). Format: every decision states **Decision / Rationale / Rejected & why / Revisit when**. Settled brainstorming decisions (1–8) are treated as final; where this doc disagrees with the brief or a settled decision, it says so in a marked **Pushback** note and specs the decided approach anyway (§12).

Binding constraints carried through every decision:

- **EU data residency is non-negotiable** (§9) — it disqualified vendors outright, before DX or price.
- **Scale target: tens of tenants** (§1) — optimize for correctness, isolation, and low operating cost, not hypothetical scale.
- **Solo founder, full-time, self-host bias** (founder input, 2026-08-03) — every managed service must beat "run it in the app" on total cost including patch-cadence labor.
- **Three planes, one codebase, one database** (§2).
- **Nothing Naxdor-specific** (§12) — the architecture serves any tenant; Naxdor is tenant zero, not a schema assumption.

---

## 1. Decision log — core stack

### ARC-01 · Application framework & hosting — Next.js (App Router) + TypeScript + Tailwind on Vercel Pro, functions pinned to an EU region

- **Decision.** Next.js App Router, TypeScript (`strict`), Tailwind CSS; deployed as **one Vercel project on the Pro plan** ($20/seat/mo — Hobby prohibits commercial use). All serverless functions **pinned to `fra1` (Frankfurt)** to co-locate with the database (ARC-02). Node runtime only for data paths — no Edge runtime, because the tenancy transaction pattern requires interactive transactions over TCP (see ARC-02 and `TENANCY.md`). Note Next.js 16 renamed `middleware.ts` to [`proxy.ts`](https://nextjs.org/docs/messages/middleware-to-proxy); this doc uses the new name.
- **Rationale.** Brief §1 default, confirmed: one codebase serving three route-grouped planes (§2) is exactly the App Router's strength; Vercel Pro includes what v1 needs ([wildcard subdomains on all plans when we get there, generous domain limits](https://vercel.com/docs/multi-tenant/limits), cron jobs, WAF custom rules at $0). Server Components keep authorization and entitlement checks server-side by default, which is where the brief demands they live (§4).
- **Honest note on US edge processing.** Vercel is a US company and its edge network is global. Pinning functions to `fra1` keeps *compute* in the EU and Neon/R2 keep *data at rest* in the EU, but TLS termination and request routing happen at global POPs, and platform telemetry/control-plane data is processed by US-owned infrastructure. The defensible claim — which `SECURITY.md` must carry into the DPA and marketing must not overstate — is **"EU data-at-rest residency; EU-pinned compute; US-owned processors under SCCs/DPF for transit and control plane."** A client contract demanding *fully EU-controlled processing* is a vendor change (Hetzner/Scaleway-class), not a config change; flag it in the DPA template now (also true of Neon post-Databricks and Cloudflare — see ARC-02, ARC-06).
- **Rejected & why.** *Remix/SvelteKit/self-hosted Node* — no capability gap justifies deviating from the brief default and its ecosystem (Better Auth, Vercel cron, preview deployments). *Vercel Enterprise* — nothing v1 needs is Enterprise-gated except multi-tenant preview URLs, which we design around (§5). *EU-sovereign hosts* — real residency gain, but loses preview deployments, zero-config CDN, and cron; disproportionate ops load for a solo operator at v1.
- **Revisit when.** A signed tenant contract demands EU-controlled processing end-to-end; or Vercel usage pricing materially changes; or function duration limits block export jobs (§5).

### ARC-02 · Database — Neon Postgres, Frankfurt (`aws-eu-central-1`), pooled + direct URLs

- **Decision.** Neon serverless Postgres, project created in **`aws-eu-central-1` (Frankfurt)** — the EU region; London is UK, not EU, and [**region is immutable per project**](https://neon.com/docs/introduction/regions), so this is a create-time decision. Two connection strings from day 1: the **pooled URL** (PgBouncer transaction mode) as Prisma `url` for runtime, the **direct URL** as `directUrl` for migrations, [per Prisma's Neon guidance](https://www.prisma.io/docs/orm/v6/overview/databases/neon). Plain TCP from Vercel Node functions; the Neon serverless driver's HTTP mode is single-shot and cannot run the `set_config`-in-transaction tenancy pattern (`TENANCY.md`).
- **Rationale.** Brief default confirmed. Scale-to-zero fits tens of tenants at $5–20/mo ([pricing](https://neon.com/pricing)); branching gives **ephemeral per-CI-run databases** for the adversarial isolation suite (§8); transaction-mode pooling is exactly compatible with transaction-local `set_config('app.tenant_id', $1, true)` — the RLS session mechanism ([pooling docs](https://neon.com/docs/connect/connection-pooling)).
- **Known sharp edges (specified in `TENANCY.md`, listed here because they are architecture-shaping):** console-created roles carry `BYPASSRLS` via `neon_superuser` — the runtime role must be created via SQL and tables set `FORCE ROW LEVEL SECURITY` ([roles doc](https://neon.com/docs/manage/roles)); `pg_cron` does not fire under scale-to-zero, so scheduled work runs on Vercel cron (§5); a `databaseUrl`/`cell` column on **Tenant** from day 1 keeps physical isolation (project-per-tenant) a mechanical extraction later, not a rewrite.
- **Rejected & why.** *Supabase Postgres* — bundles auth/storage/RLS conventions that duplicate our own layers; we'd use a fraction and fight the rest. *RDS/Cloud SQL* — always-on cost and ops burden with no branching. *Project-per-tenant on Neon now* — dollar-cheap but operationally expensive (migrations ×N, no cross-tenant SQL for the platform plane); kept as the pressure valve for a future regulated tenant. *Schema-per-tenant* — effectively unsupported by Prisma (no dynamic schema selection); worst of both worlds.
- **Revisit when.** A tenant demands physical isolation (use the `cell` seam); sustained compute makes serverless pricing worse than provisioned; or Neon/Databricks changes EU processing terms.

### ARC-03 · ORM — Prisma

- **Decision.** Prisma ORM with versioned SQL migrations. RLS policies live **in migration files**; the tenant-scoped client is wrapped in one `withTenant()` unit-of-work helper and the raw client is module-private (`TENANCY.md`).
- **Rationale.** Brief default confirmed. Two properties earn it beyond familiarity: (1) **DMMF model enumeration** lets the CI isolation suite programmatically test *every* model for cross-tenant leakage — the suite can't silently miss a new table; (2) migrations-as-SQL keep RLS policies, `REVOKE`s, and triggers in reviewed, versioned files. Known escape hatches (nested writes/`connect`, `$queryRaw`) are closed by composite FKs + RLS, not by trusting the ORM (`TENANCY.md`).
- **Rejected & why.** *Drizzle* — fine ORM, but no DMMF equivalent for exhaustive isolation testing, younger migration tooling, and deviating from the brief default needs a reason it doesn't supply. *Kysely alone* — query builder, not a schema/migration system. *ZenStack* (declarative policies over Prisma) — genuinely close fit for visibility rules, but its v3 rewrite was still beta at research time and it would couple policy to the ORM layer; the explicit `authorize()` seam is easier to reason about. Noted as a deliberate spike candidate, not a default.
- **Revisit when.** Prisma's query-compiler transition breaks the extension patterns we depend on; or ZenStack v3 stabilizes and a spike shows real leverage.

### ARC-04 · Identity & sessions — Better Auth, self-hosted, data in Neon EU

- **Decision.** **Better Auth, self-hosted inside the Next.js app**, all identity data in our Neon Frankfurt database. Pin **≥ 1.6.11**; enable only the plugins we use — `twoFactor` (TOTP + backup codes), `passkeys`, `admin` (impersonation hooks feed `AuditEvent.impersonatorId`) — and keep SSO/SCIM/oidcProvider **off** until needed (they were the 2026 CVE surface). OAuth account auto-linking disabled. **Scope rule (from the approved plan):** Better Auth owns *identity, sessions, and invitation mechanics only*. All membership, roles, and assignments live in our own Prisma schema (**Member, Role, Permission, RolePermission, MemberRole, MemberClient, MemberProject**) — Better Auth's comma-separated `member.role` field is never consulted. Per settled decision #6, **members and Contacts are separate identity populations**: the member identity table may be called **User**; Contacts get their own tables, session namespace, and cookie (§3, §4 of this doc; `AUTHZ.md`).
- **Rationale.** The only option satisfying simultaneously: hard EU residency (auth data lives in our EU Postgres, not a US vendor), many-to-many member↔role (§3), three principal types, invite-only portal flows, and $0 marginal cost. Ecosystem risk is now low: Better Auth [was acquired by Vercel (July 2026) and maintains Auth.js](https://better-auth.com/blog), making it the default for this stack. First-class [`crossSubDomainCookies`](https://better-auth.com/docs/concepts/cookies) keeps the v2 subdomain move additive (§3).
- **Rejected & why.**
  - **Clerk — disqualified on EU residency, confirmed.** Clerk offers no regional residency; data lives on US infrastructure under DPF/SCCs — their own article states this is ["lawful data transfer, not in-region storage"](https://clerk.com/articles/clerk-pricing-explained). Additionally: [exactly one role per organization membership](https://clerk.com/docs/guides/organizations/control-access/roles-and-permissions) (conflicts with §3), and realistic cost ≈ $135/mo once MFA (Pro), custom roles (B2B add-on), and a satellite domain are added ([pricing](https://clerk.com/pricing)).
  - **WorkOS** — no EU region, and [publicly argues residency doesn't matter](https://workos.com/blog/data-residency-for-enterprise-saas) — the opposite of our constraint.
  - **Auth.js / NextAuth v5** — [maintenance mode under the Better Auth team, who point new projects to Better Auth](https://github.com/nextauthjs/next-auth/discussions/13252); also no first-class MFA.
  - **SuperTokens** — separate always-on core service to operate, MFA priced at a [$100/mo minimum](https://supertokens.com/pricing) — a cliff at our size.
  - **Kinde / Auth0 — the hosted EU-resident fallbacks.** [Kinde (Dublin, ~$25/mo)](https://docs.kinde.com/get-started/learn-about-kinde/supported-data-regions/) is the pick if we ever refuse to own auth code; Auth0 has EU tenants but practical B2B pricing starts ~$150/mo. Either way we'd still build the same app-level permission layer, so the hosted layer buys little.
- **Trade-off owned.** We own the patch cadence. 2026 saw critical CVEs in optional plugins ([SSO SSRF, CVSS 9.6](https://securityonline.info/better-auth-ssrf-cve-2026-53513/); SCIM 9.9) — mitigated by version pinning, minimal plugin surface, and subscribing to advisories. This is the explicit price of residency + control, and it is cheaper than $135/mo plus vendor lock-in on password hashes and MFA enrollments (migrating off a hosted provider forces re-enrollment).
- **Revisit when.** A large tenant demands SAML SSO (options: hardened `@better-auth/sso`, or bolt on WorkOS SSO at $125/connection passed through via entitlements); or patch cadence proves unsustainable solo (fallback: Kinde EU).

### ARC-05 · Authorization — hand-rolled RBAC + assignment tables; no policy engine

- **Decision.** Authorization is **our own code over our own tables** (Permission, Role, RolePermission, MemberRole, MemberClient, MemberProject), evaluated per-request in Postgres. The architecture is the **seam**: every check flows through exactly one `authorize(actor, action, resource)` and one `authorizedResourceIds(actor, resourceType)` filter; permission codes are immutable identifiers; no call site ever compares role names (lint-enforced). Resource scoping is deny-default with `client:view_all`-class permissions seeded only on senior role templates (settled decision #5). Sessions carry **no permissions** — per-request resolution is sub-ms at this scale and avoids the revocation hole; a per-tenant `permissionsVersion` enables short-TTL caching later. Full model in `AUTHZ.md`.
- **Rationale.** The founder's instinct (§3) is confirmed emphatically by research: nothing breaks without an engine at tens–hundreds of tenants. The assignment graph is depth ≤ 2 — member→client→project is a `JOIN`/`EXISTS`, not graph traversal. Every escalation guard the brief demands (grant-subset, last-owner protection, no-self-escalation) is transactional application code **under any option** — engines don't provide them, which deletes most of their claimed value here. Every hosted engine also adds a network hop per check from Vercel functions versus one indexed query on a connection we already hold.
- **Rejected & why.** *OpenFGA (self-host)* — an always-on service + own datastore [that does not run inside serverless](https://openfga.dev/docs/best-practices/running-in-production), plus the dual-write problem (every assignment row mirrored as a tuple, with [reconciliation as the documented adoption pattern](https://openfga.dev/docs/best-practices/adoption-patterns)). *AWS Verified Permissions / Cedar* — [cheap ($5/M calls)](https://aws.amazon.com/verified-permissions/pricing/) and Stockholm-resident, but drags an AWS control-plane dependency and entity-sync tax into a Vercel/Neon stack for a lookup problem. *Oso Cloud* — [visible repositioning toward agent security](https://www.osohq.com/pricing); vendor-direction risk. *Casbin* — [in-memory linear policy scan](https://casbin.org/docs/performance/), weak multi-tenant fit in Node. *Permit.io* — [~$150/mo tier](https://www.permit.io/blog/permit-new-pricing-model) + PDP sidecar + third-party data flow (relationship tuples are personal data — GDPR review); clearest over-engineering at this scale. *Cerbos* — noted as the best fallback if a policy layer is ever justified (stateless PDP, data stays home), still an extra deployed service.
- **What breaks without an engine, honestly:** discipline, not scale. Scattered ad-hoc checks are the failure mode — fixed by the single seam + the deny-matrix CI suite (§8), not by a vendor. Our tables map 1:1 to OpenFGA tuples, so the documented shadow-mode migration is contained inside `authorize()` if triggers ever appear.
- **Revisit when.** Any of: deep resource hierarchies with inheritance; user-to-user sharing graphs; multiple backend services consuming the same decisions; enterprise-authored ABAC conditions; authorization at thousands of RPS.

### ARC-06 · File storage — Cloudflare R2, EU-jurisdiction bucket

- **Decision.** **Two R2 buckets, both created with `jurisdiction=eu`** (immutable at creation; [stored objects guaranteed in EU data centers](https://developers.cloudflare.com/r2/reference/data-location/)), keys prefixed `tenantId/`, accessed via the dedicated endpoint `<account>.eu.r2.cloudflarestorage.com`: (1) the **general document bucket** for every `FileObject`, and (2) a **dedicated continuity bucket** for `ContinuityBox` blobs, carrying a bucket-wide [bucket lock](https://developers.cloudflare.com/r2/buckets/bucket-locks/) (90 days from write) and a **credential split** — the runtime credential has no delete permission there, and a separate scheduled cleanup credential deletes after lock expiry (`CONTINUITY_BOX.md` §2.6, INV-10). Two buckets rather than one because that regime is bucket-wide: applying a 90-day lock and a no-delete runtime credential to the document bucket would break ordinary `Document` deletion and GDPR erasure. Both are day-one provisioning (`PLAN.md` Phase 1) — jurisdiction is immutable, so neither can be re-created later. Short-lived presigned GETs (minutes) issued **only after an authorization check at issue time** (§9 of the brief); uploads via presigned PUT with `Content-Length` signed and a HEAD size-verify before the **FileObject** row commits (R2 has [no presigned POST](https://developers.cloudflare.com/r2/api/s3/presigned-urls/), so no `content-length-range` policy — this is the quota-enforcement consequence). Per-tenant quotas metered in Postgres at presign time. R2 lacks object versioning → **app-level immutable objects + FileVersion rows** (needed anyway for `ProjectVersion` semantics and provider portability). Lifecycle rule aborts incomplete multiparts (document bucket). Uploads get an extension/MIME allowlist and `Content-Disposition: attachment`; delivery is on a separate apex from the app by construction (§3).
- **Rationale.** Brief default confirmed, and the economics are decisive: **zero egress** ([pricing](https://developers.cloudflare.com/r2/pricing/): $0.015/GB-mo, egress $0) on a workload that *is* downloads — agencies and their clients pulling deliverables, reports, and one day continuity packages. 100 GB ≈ $1.40/mo; 1 TB ≈ $15/mo. EU jurisdiction gives a documented storage-residency guarantee; residual US-parent CLOUD Act exposure is identical across all candidates, so it cannot differentiate (control-plane metadata still transits US infrastructure — carried into the DPA per ARC-01's honesty rule).
- **Rejected & why.** *AWS S3 (eu-north-1)* — richer ecosystem (presigned POST, native versioning, scanning tools) but [egress at ~$0.09/GB](https://aws.amazon.com/s3/pricing/) punishes exactly our workload, plus a second cloud account to operate. *Backblaze B2* — [cheapest at $6/TB with native versioning](https://www.backblaze.com/cloud-storage/pricing), but Amsterdam-only in the EU, weaker tooling, no event-pipeline adjacency. *Supabase Storage* — a second vendor project next to Neon, worst economics at 1 TB, and its RLS-based access control duplicates our permission system.
- **Revisit when.** Portal upload volume justifies the event-driven AV pipeline (§5, v2); or a branded download domain is wanted (must be its own registered apex — §3).

### ARC-07 · Billing — Stripe Checkout + Customer Portal + Stripe Tax; webhook → local entitlements

- **Decision.** Stripe for tenant subscriptions (brief default confirmed): **Checkout** for purchase, **Customer Portal** for self-serve plan change/cancel/payment methods, **Stripe Tax** with [`tax_id_collection`](https://docs.stripe.com/tax/checkout/tax-ids) so EU B2B reverse charge applies automatically (we still file the *periodisk sammanställning* ourselves — Stripe calculates, never files). Stripe is the source of truth for exactly one fact — *which Price is this tenant paying for* — and a **webhook resolves plan code → the versioned `entitlements` JSON column on Tenant** (modules + numeric limits), read per-request (~1 ms), never baked into long-lived sessions. Webhook handler: raw-body signature verification, the `StripeWebhookEvent` idempotency ledger (`DATA_MODEL.md` §6.2), and the re-fetch-subscription pattern (never trust event ordering). Trials: 14 days, [`payment_method_collection=if_required`, `end_behavior=pause`](https://docs.stripe.com/payments/checkout/free-trials). Downgrades: **read-only grandfathering** — block creation past the new limit, never delete or hide ([the Trello model](https://community.atlassian.com/forums/Trello-questions/What-happens-to-the-boards-when-you-downgrade-to-free/qaq-p/1987366)); this product's brand is continuity, so data-destroying downgrades are off the table. **The continuity box is deliberately exempt from entitlement lapse** — a sealed box must survive non-payment (`CONTINUITY_BOX.md` owns the retention window).
- **Rejected & why.** *Stripe Entitlements API* — [boolean-only Features](https://docs.stripe.com/billing/entitlements); it structurally cannot express `maxClients`/`maxMembers`/`maxStorageBytes`, its webhook summary caps at 10 entitlements, mid-cycle attachments activate next period — and Stripe's own docs recommend persisting locally anyway. We'd maintain the local table *plus* a second half-source-of-truth. *Stripe Connect* — **not needed in v1**: the Platform bills tenants directly on its own account. Tenants charging *their* Clients through us is a v2+ question; nothing in the schema anticipates it beyond `stripeCustomerId` living on **Tenant** (never on User). *Custom billing UI* — proration edge cases for near-zero benefit; the Portal covers it (caveat: some price configurations only allow cancel — test our exact catalog before promising self-serve switching). *Querying Stripe per-request* — latency + availability coupling.
- **Costs.** [Billing 0.7% of volume, Tax 0.5%, EEA cards 1.5% + 1.80 kr, international 3.15% + 1.80 kr](https://stripe.com/en-se/pricing) — ~$35/mo Billing fee at $5k MRR. **Currency is sticky per Stripe customer** — SEK vs USD per tenant must be decided day 1 (`OPEN_QUESTIONS.md`, blocks Phase 7).
- **Revisit when.** Tenant-to-Client payments demand Connect (v2+); or volume justifies negotiated pricing.

### ARC-08 · Rate limiting & abuse — Upstash Redis (EU) + Vercel WAF free rules

- **Decision.** [`@upstash/ratelimit` over Upstash Redis in an EU region](https://upstash.com/pricing/redis) for the real work: per-principal, per-email, per-tenant keys on portal login, invite acceptance, magic links, signed-URL issuance, and downloads — the portal is the least-trusted surface (§9). Free tier (500k commands/mo) covers v1. Vercel's **free** WAF custom rules / IP blocking as the coarse outer shield.
- **Rejected & why.** *Vercel WAF paid rate limiting as primary* — on Pro it [keys only by IP/JA4, fixed-window, with per-region counters](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting); per-principal keys are Enterprise. *Roll-your-own in Postgres* — hot-path writes on the main DB for a solved problem.
- **Revisit when.** Sustained traffic outgrows the free tier (~$10/mo next step), or Vercel ships per-user keys on Pro.

### ARC-09 · Transactional email — Amazon SES `eu-central-1` (behind a thin adapter)

> **Naming.** Always write **"Amazon SES"** for the email provider. Bare **"SES"** in this document set means *Simple Electronic Signature* (eIDAS) — `SignatureLevel.SES` in `DATA_MODEL.md`, `portal.contract.sign` in `AUTHZ.md`, the Phase 4 click-to-accept flow. Two different things; never let the abbreviation float.

- **Decision (B4, settled 2026-08-08).** **Amazon SES in `eu-central-1` (Frankfurt)** as the v1 ESP for invites, notifications, continuity-box alerts, and billing emails — behind a one-interface mail adapter (`send(message)`) so the vendor stays swappable in a day. SPF + DKIM + DMARC on a **dedicated sending subdomain under `naxdor.com`** (ARC-11, decision 9) until the product apex is bought at Phase 7; the sender host is owned by the same config module as `APP_URL` (INV-D2), never hardcoded. Policy unchanged: **emails carry links, not data** — deep links to the canonical app domain (no tenant slugs, §3), no invoice PDFs or sensitive contents attached; this both minimizes personal data at the ESP and serves the seam rules.
- **Rationale.** The residency standard for this product was already fixed by the Neon choice: **data at rest in the EU, not vendor nationality** (`SECURITY.md` §9.2 lists Neon, R2, Stripe and Upstash as US-parent). Neon Frankfurt *is* `aws-eu-central-1` — AWS is already the substrate under the database, so naming Amazon SES adds **no new jurisdiction to the sub-processor chain** and buys one clean sentence: everything at rest in Frankfurt. Cost is ~$0 at v1 volume ([$0.10/1k, uniform across regions](https://aws.amazon.com/ses/pricing/)). Vendor longevity is the tiebreak that actually matters here, because continuity-box alerts are the highest-stakes email this product will ever send and they must still deliver years from now.
- **Costs accepted, stated plainly.** Worst DX of the candidates — React Email still works for templating, so what is lost is the unified send SDK, not JSX. Bounce/complaint events arrive via SNS rather than a plain webhook, so the app owns a subscription-confirmation handshake, message-signature verification, and an SQS dead-letter queue (SNS classifies every non-5xx/429 response as a *permanent* failure and does not retry — a rejected malformed event is discarded unless a DLQ is attached, and this webhook is the only path by which a failed continuity-box alert becomes visible).
- **Two pieces of folklore, corrected 2026-08-08 by adversarial verification — do not reintroduce them.** (1) Production access does **not** require SPF/DKIM/DMARC to be published first. [AWS's request-production-access page](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html) states only that verifying your domain beforehand "is a best practice that helps to get your production access request approved faster"; the sole required fields are mail type and website URL. Sandbox is 200 messages/24h to verified recipients, and AWS commits to an *initial response* within 24 hours — which is not the same as approval. Plan one business day, tolerate four. (2) **Sender warm-up is effectively zero here.** Warm-up matters for dedicated IPs and bulk volume; Fortleva is transactional-only on SES shared IPs at hundreds of mails/month. Treat a recipient-quality ramp as hygiene, not as a blocking phase. DNS still goes first in Phase 1 week 1, but for the honest reasons: Easy DKIM tokens do not exist until the identity is created, verification is what makes approval fast, and the whole record set is reversible in ten minutes on a 600-second TTL.
- **v1 sending domain — `mailer.naxdor.com`, with `bounce.mailer.naxdor.com` as the custom MAIL FROM.** A live DNS survey on 2026-08-08 found **`send.naxdor.com` is already occupied** by a pre-existing Amazon SES custom MAIL FROM pinned to **`eu-west-1` (Ireland)** — `MX 10 feedback-smtp.eu-west-1.amazonses.com` plus `TXT v=spf1 include:amazonses.com ~all`. That MX is region-pinned and there can be only one at the node, so reusing the subdomain would break the existing identity. `mailer.` is provably free (no TXT/MX/CNAME); note `*.naxdor.com` carries an **A-only wildcard** to Vercel edge, so subdomain existence must be tested with TXT/MX/CNAME, never A. The apex is SiteGround (`MX …antispam.mailspamprotection.com`, `SPF include:_spf.mailspamprotection.com`, `default._domainkey` selector) and is **never edited** — Fortleva's SPF lives only on the MAIL FROM subdomain, and Fortleva gets its own `_dmarc.mailer` record so it can later tighten to `p=quarantine`/`p=reject` without touching the apex policy governing Naxdor business mail. Note DMARCbis (**RFC 9989/9990/9991**, May 2026) obsoletes RFC 7489 and **deprecates `pct=`**, so the staged rollout is driven by `rua` monitoring, not percentages.
- **Sending credentials are IAM, not convention.** The app authenticates to Amazon SES with an IAM principal whose policy is scoped to `ses:SendEmail`/`ses:SendRawEmail` on the `mailer.naxdor.com` identity ARN in `eu-central-1`, with a **`ses:FromAddress` condition** restricting the From domain. This is what actually enforces "never send as the apex" — the INV-D2 config module is discipline, IAM is enforcement, and a leaked key without the condition turns `naxdor.com` into an open relay. Prefer short-lived credentials over a long-lived access key; AWS names compromised access keys and SMTP passwords as a documented cause of account suspension. SMTP credentials and IAM credentials are not interchangeable — pick the SESv2 API path.
- **Deferred, recorded so it is a decision and not an oversight: [SES Tenants](https://docs.aws.amazon.com/ses/latest/dg/quotas.html).** SES exposes tenants as a first-class resource with per-tenant suppression lists and reputation isolation, at ~$0.005/tenant/month. For a product where one agency's bad client-portal list can pause sending for *every* agency, this is the on-the-shelf answer to shared-reputation risk. Not taken in v1 (Naxdor is the only tenant through Phases 1–6); **revisit at Phase 7**, when self-signup makes shared reputation a real multi-tenant hazard.
- **Rejected & why.** *Resend* — **disqualified on verification, not preference.** Per [Resend's own region documentation](https://resend.com/docs/dashboard/domains/regions), region selection governs only where mail is *routed and sent from*; "all account data, including email metadata, logs, and API records, is stored in the United States regardless of the sending region you select" — and EU send-region is Pro-tier+. This resolves the prior "not verified" flag in this ARC **negative**. *Postmark* — no EU hosting and publicly no plans to add it; all data US, SCCs in the DPA. *SMTP from the app* — deliverability suicide.
- **Runner-up, deliberately not taken.** **[Scaleway TEM](https://www.scaleway.com/en/transactional-email-tem/)** (French, iliad Group) is the only candidate that would *upgrade* the residency story rather than match it: EU-only, no US sub-processors, free ≤300/day then ~€1/1k, native webhooks. It was rejected because that upgrade is **unrealizable at v1** — Neon, R2, Stripe and Upstash are all US-parent, so a zero-US-sub-processor chain cannot be honestly claimed no matter which ESP sends the mail; taking it would add a fourth vendor and change nothing we may say in §9.3. **Revisit the moment that stops being true** — i.e. a tenant's procurement demands a zero-US-sub-processor chain end to end, at which point the adapter swap is a day and the rest of the stack is the real work.
- **Revisit when.** Volume passes ~50k/mo (pricing still fine, DX pain compounds), an EU-only-processor contract lands (see runner-up), or the Phase 7 domain cutover moves the sending subdomain to the product apex.

### ARC-10 · Feature flags — no SaaS; a table and an env var

- **Decision.** **No feature-flag SaaS.** Engineering flags live in the **FeatureFlag** table (with env-var override for kill-switches), are engineering-owned, temporary, and deleted after rollout — never used for monetization (§4). They are the first gate in the four-gate call (§4 of this doc) so a broken module can be killed platform-wide instantly.
- **Rationale.** Brief §4 is explicit and research agrees: at solo scale, a per-tenant JSON of entitlements plus a tiny flag table covers everything. A flag SaaS adds cost, an external dependency on every request path, and a third-party data flow — for rollout complexity we do not have.
- **Rejected & why.** *LaunchDarkly/Statsig/PostHog flags* — capability we'd use at <5%, plus latency and data-flow review. *Env-vars only* — no per-tenant targeting for staged rollouts (e.g., enable new invoicing renderer for tenant zero first).
- **Revisit when.** A second engineer joins and multi-variant experimentation becomes real.

---

## 2. Domain & routing architecture (settled decision #8)

### ARC-11 · Domains — Naxdor subdomains in v1, dedicated product domain at Phase 7; admin and file surfaces kept off the app host from day 1

- **Decision (final #8, as amended by final #9).** v1 runs on **one app host**, and that host is a subdomain of the founder's existing `naxdor.com`. **No domain is purchased before Phase 1.** The dedicated product domain arrives at **Phase 7**, when the product stops being Naxdor's internal system and starts being sold.

  | Surface | v1 host (Phases 1–6) | Phase 7 host | Cookies |
  |---|---|---|---|
  | Marketing site | — does not exist until Phase 7 | `<product>.tld` | none |
  | Tenant app plane + Portal plane | `os.naxdor.com` | `app.<product>.tld` | member cookie + contact cookie, **host-only**, distinct names/audiences |
  | Platform plane (admin) | `ops.naxdor.com` | `<product-ops>.tld` — a **separate registered apex** | platform-admin cookie, host-only, MFA-mandatory |
  | Transactional email | dedicated sending subdomain (e.g. `mail.naxdor.com`), its own SPF/DKIM/DMARC | product apex | n/a |
  | File delivery (R2) | `<account>.eu.r2.cloudflarestorage.com` — separate apex by construction | unchanged | none — presigned URLs only |

  Subdomain-per-tenant and custom domains are **v2**, kept additive by the resolution seam (ARC-13).

- **Why Naxdor subdomains in v1 (decision #9, 2026-08-05).** Naxdor is the only tenant through Phases 1–6 — the brief's own ordering is "I run the product myself before I sell it" (§11) — so a Naxdor-branded host is not merely tolerable, it is *accurate*: there is no marketing site and no external tenant to confuse. It costs $0, it does not wait on trademark clearance, and a single non-wildcard subdomain needs only **one CNAME to Vercel**, leaving Naxdor's zone, DNS and email exactly where they are. The earlier "delegate the zone to Vercel nameservers while it is empty" requirement is real, but it is a requirement of **wildcard TLS for v2 subdomain-per-tenant** — not of v1. That delegation happens on the *product* domain at purchase time, which is precisely why the product domain is bought empty at Phase 7, ahead of the wildcard rollout (C6).
- **What v1 gives up, stated plainly.** This clause originally put the platform console on its own *registered apex*, so the boundary between the most- and least-privileged planes was a registered-domain boundary rather than a hostname one. Under `os.` / `ops.naxdor.com` the two planes are siblings inside one registered domain. That is a real, if narrow, downgrade:
  - **Still true:** `__Host-` cookies are host-only by definition — the prefix forbids a `Domain` attribute — so a cookie issued by `os.naxdor.com` is never sent to `ops.naxdor.com`, and no `Domain=`-scoped cookie can overwrite one. Browser-enforced, not policy.
  - **No longer true:** app and console no longer sit in different registered domains, so every *other* `naxdor.com` subdomain is now cookie-adjacent to both. A compromised Naxdor property could set `Domain=.naxdor.com` cookies that our hosts receive — it still cannot read or overwrite our `__Host-` ones — and gains phishing proximity to the admin console.
  - **INV-D1 (day 1, CI-enforced).** While the app lives under `naxdor.com`, **no cookie may ever carry a `Domain` attribute**; every session cookie stays `__Host-`-prefixed. The v2 plan of setting `Domain=.<apex>` for cross-subdomain tenant sessions is **forbidden until the product domain is live**, because `Domain=.naxdor.com` would broadcast app sessions to every Naxdor property.
  - **INV-D2 (day 1).** The host is never hardcoded. One config module is the single source for `APP_URL`, cookie names/attributes, and the mail sender. Decision #8 already demanded centralized cookie config; #9 widens it to the hostname itself, because at Phase 7 the cutover must be a config edit plus a DNS record — nothing more.
- **Why admin and file surfaces still stay off the app host from day 1.** Cookie isolation is cheap now and painful later: when v2 sets `Domain=.` `<product>.tld` cookies for cross-subdomain sessions, every subdomain of the app apex receives them — so the admin surface must not *be* one. Keeping the console on its own host from day 1 (`ops.naxdor.com` now, its own registered apex at Phase 7) means no member or Contact cookie can ever reach the Platform plane, phishing/XSS blast radius is partitioned, and impersonation flows demonstrably originate only from the ops host. Files: uploaded content served from a cookie-carrying origin is an XSS/session-theft vector (bigger practical risk than viruses at this scale); R2 presigned URLs only work on the S3 endpoint anyway, which is conveniently cookie-free. **Rule: any future branded download domain is its own registered apex (e.g. `<product-files>.tld`), never a subdomain of the app apex.**
- **§12 compliance.** The brief forbids Naxdor-specific assumptions **in the schema or the UI**. Decision #9 puts Naxdor in a *hostname* — configuration, moved before the first external tenant exists — and nothing Naxdor-shaped enters a table, a permission code, or a component. The original objection, that a platform product tied to one agency's brand poisons the multi-tenant positioning, is a **go-to-market** objection: it binds from Phase 7, which is exactly when the product domain lands.
- **Rejected & why.** *Subdomain-per-tenant in v1* — the research recommendation, declined by the founder (see Pushback below). *Path-based tenant slugs (`/t/acme/…`)* — leaks tenant identity into every URL and is the expensive-to-reverse direction of travel. *Custom domains in v1* — the domain/TLS layer is nearly free on Vercel, but the auth token-handoff across apexes (cookies never cross registered domains) plus tenant DNS support is real engineering for near-zero demand; **v2, premium tier, built when someone pays** ($25–50/mo price point per research).
- **Pushback (per §12).** Research recommended wildcard subdomains from day 1: cost on Vercel is ~$0, portals get a branded feel, and the migration asymmetry favors starting subdomain-first. The founder chose single-domain v1 for simpler day-1 machinery — **accepted and specced**, with this condition made explicit: the mitigations in ARC-13 are *load-bearing, not optional*. They must be CI-enforced (lint + tests), because if tenant slugs leak into URLs or cookie config scatters, the v2 subdomain move becomes exactly the rewrite the research warned against. With the seam enforced, the residual cost of deferring is one DNS/proxy/config change plus a redirect policy — acceptable.
- **Revisit when.** **Phase 7** — buy the product apex + ops apex, delegate the product zone to Vercel nameservers while empty, and cut the hostname over via the INV-D2 config module (`OPEN_QUESTIONS.md` B1). Then first paying demand for branded portals (v2 subdomains), then custom domains as premium (v2).

### ARC-12 · Three planes as route groups — separate middleware paths, session claims, layouts

One Vercel project, one codebase, one database (§2); **`proxy.ts` binds hosts to route groups** and each plane's root layout independently re-verifies its own session type — the proxy is coarse routing, never the only gate. A role check is never what separates a Contact from platform data; **plane separation is structural** (different cookie, different audience, different route group, different layout guard).

```
src/app/
├─ (marketing)/                    # <product>.tld — public, no session (Phase 7)
├─ (tenant)/                       # v1 os.naxdor.com → app.<product>.tld — Member sessions
│  ├─ layout.tsx                   #   verifies member session + active-tenant membership
│  ├─ dashboard/  clients/  projects/  invoices/  contracts/
│  ├─ files/  issues/  docs/  reports/  continuity/  settings/
│  └─ auth/                        #   member sign-in, MFA, invite acceptance
├─ (portal)/                       # v1 os.naxdor.com/portal → app.<product>.tld/portal — Contact sessions
│  ├─ layout.tsx                   #   verifies contact session; hardcoded capability set
│  └─ portal/
│     ├─ projects/  invoices/  contracts/  files/  issues/  continuity/
│     └─ auth/                     #   contact sign-in + invite acceptance ONLY (no signup)
├─ (platform)/                     # v1 ops.naxdor.com → <product-ops>.tld — platform-admin sessions
│  ├─ layout.tsx                   #   verifies platform session; MFA mandatory
│  └─ platform/
│     ├─ tenants/  plans/  entitlements/  health/
│     ├─ support-access/           #   reason-logged, time-boxed impersonation (§7)
│     └─ audit/
└─ api/
   ├─ auth/member/[...all]         # Better Auth handler — member identity (User)
   ├─ auth/portal/[...all]         # Better Auth handler — Contact identity (separate tables)
   ├─ auth/platform/[...all]
   ├─ webhooks/stripe/
   └─ cron/…                       # §5 — CRON_SECRET-protected
```

**Host ↔ route-group binding (enforced in `proxy.ts`):** requests for `(platform)` routes on the app apex return 404, and vice versa; `(portal)` and `(tenant)` are separated by path prefix + session audience in v1 and remain so under any future host scheme. **Session namespaces:**

| Plane | Cookie (host-only, v1) | Principal | Claims (no permissions — ARC-05) | MFA |
|---|---|---|---|---|
| Tenant app | `flv.member` | Member (User identity) | userId, sessionId, activeTenantId | available; mandatory for owner-equivalent roles |
| Portal | `flv.portal` | Contact | contactId, clientId, tenantId | available |
| Platform | `flv.platform` | Platform admin | adminId, mfaVerified | **mandatory** |

Per settled decision #6, the same email address can exist as both a User and a Contact — different tables, different sessions, no linkage. Portal signup does not exist; `(portal)/auth` accepts invitations only (§3 of the brief).

### ARC-13 · Tenant resolution — one seam, hostname-ready

- **Decision.** Exactly **one** function resolves tenant context, e.g. `resolveTenantContext(request) → { tenantId, source }`, called from proxy/layout level and feeding `withTenant()` (`TENANCY.md`).
  - **v1 behavior:** hostname branch first — `hostnameToTenantId(host)` returns null for canonical hosts (the stub); then **session/context**: the member session's `activeTenantId`, verified against membership, is the tenant. Portal requests resolve tenant + client from the Contact session.
  - **v2 behavior (additive):** the same `hostnameToTenantId` consults a hostname→tenantId table (subdomains, then custom domains). Nothing above the seam changes.
- **What the seam must not leak — CI-enforced rules, not conventions:**
  1. **No tenant slugs or IDs in absolute URLs.** All absolute URLs are minted by one `urlFor()` helper targeting the canonical app host; lint bans app-host string literals elsewhere. Emails, webhooks, and redirects deep-link entities by ID; tenant context derives from the session after login.
  2. **Centralized cookie configuration.** One module owns every cookie name/domain/path/SameSite; nothing else touches cookie APIs with literals. Scoping cookies to the apex for v2 subdomains (Better Auth `crossSubDomainCookies`) is then a config change, not a hunt.
  3. **Portal/tenant separation is independent of host.** Plane is decided by route group + session audience, never by hostname — so single-host v1 and multi-host v2 behave identically, and a portal cookie presented on tenant routes is rejected by audience alone.
  4. **Tenant.slug exists from day 1** with DNS-safe validation (lowercase, 63-char label limit) and a **reserved list** (`www`, `app`, `api`, `admin`, `auth`, `mail`, `status`, `portal`, `files`, `cdn`, `docs`, …) enforced at signup — v2 subdomains then require zero renames. The slug appears in **no URL** until v2.
  5. **Authorization never trusts host or `Origin`/`Referer`** for tenant identity — host (v2) only *selects* the tenant; membership still decides access.
- **Rationale.** This is the entire mechanism that makes settled decision #8 cheap to hold: the founder's single-domain choice costs little *if and only if* tenant identity stays out of URLs and cookie scope stays in one file. The [current `vercel/platforms` starter](https://github.com/vercel/platforms) demonstrates the Host→rewrite pattern but is a thin demo — we implement the seam ourselves.
- **Revisit when.** v2 subdomains land (fill the stub, scope cookies to apex, add redirects); custom domains add the token-handoff auth flow on top — the seam already isolates both.

---

## 3. Module boundaries

Modules are **folder-level boundaries mapped 1:1 to entitlement keys** — the shape the brief demands so entitlements never degenerate into scattered plan checks (§4).

| Module | Entitlement key | Folder | Scope |
|---|---|---|---|
| Invoicing | `invoicing` | `src/modules/invoicing` | v1 (Phase 4) — native invoice ledger, pay-now (decision #3, #7) |
| Contracts | `contracts` | `src/modules/contracts` | v1 (Phase 4) — upload + SES click-to-accept; BankID v1.5 gated |
| Performance reports | `reports` | `src/modules/reports` | v1-lite (report PDFs as client-visible **Document**s + CrUX charts); API sync v2 (decision #7) |
| Issue tracker | `issues` | `src/modules/issues` | v1 (Phase 5) — client request queue framing |
| Documentation | `documentation` | `src/modules/documentation` | v1 (Phase 2) — gates the structured-docs feature, **not** the underlying Document/FileObject storage, which is core |
| Continuity box | `continuity_box` | `src/modules/continuity-box` | v1 (Phase 8) — **exempt from entitlement lapse** (ARC-07) |
| Client portal | `portal` | `src/modules/portal` + the `(portal)` route group | v1 (Phase 3) |

**Core (never entitlement-gated):** tenancy + isolation, identity/authz/audit (`AuditEvent`), Clients/Contacts, Projects/ProjectVersions/Milestones, Services, Documents/FileObjects/FileVersions, TenantPreference, entitlements resolution itself.

**Boundary discipline.** Modules import core; modules never import each other's internals — only a module's public API (`index.ts`), enforced by ESLint import-boundary rules. A module registry maps entitlement key → routes/nav so disabling a module removes its entire surface uniformly (server-enforced; UI hiding is cosmetics, §4).

**The four-gate call.** Every module entry point passes one server-side gate, in order (§4 + research confirmation): **feature flag (engineering kill-switch) → entitlement (`Tenant.entitlements` JSON, versioned) → TenantPreference (entitled-but-disabled-by-choice) → Permission (via `authorize()`, ARC-05)**. One function call, not scattered conditionals; the portal capability check is the portal plane's hardcoded equivalent. Full semantics in `AUTHZ.md`.

---

## 4. i18n architecture

### ARC-14 · next-intl; locale as data, not assumption

- **Decision.** [**next-intl**](https://next-intl.dev) for all three planes. Message catalogs per locale (ICU MessageFormat), **Swedish + English shipped in v1**, and — per §12 — **no two-language assumption anywhere**: locales are a list, catalogs are files, adding a third language is content work, not code work. **No hardcoded strings**, enforced by lint (no-literal-strings in JSX/UX code) in CI from Phase 1.
- **Locale resolution order:** principal preference (Member or Contact) → tenant default (TenantPreference) → `Accept-Language` → `en`. App planes resolve locale from session/preference — **no locale prefixes in app URLs** (keeps the ARC-13 URL rules clean); the marketing site may use `/sv` `/en` paths for SEO.
- **Documents are locale-fixed at issuance.** An Invoice or Contract renders in the *document's* language (a property chosen at creation), never the viewer's — Swedish invoice-content requirements make this a compliance property, not a UX nicety (`DATA_MODEL.md`). Currency, date, and number formatting via `Intl` with explicit time zone (tenant preference, default `Europe/Stockholm`).
- **Rationale.** next-intl is App Router-native (works in Server Components without shipping catalogs to the client), ICU handles Swedish plural rules properly, and typed message keys catch missing translations at build time.
- **Rejected & why.** *react-i18next* — client-first architecture fights RSC. *Lingui* — solid, but macro build step and a smaller App Router track record. *Paraglide* — promising compile-time approach, younger. *Hand-rolled dictionaries* — dies at the first plural/gender rule.
- **Revisit when.** A tenant needs a locale we don't ship (process question, not architecture), or per-tenant custom terminology becomes a product feature.

---

## 5. Operational architecture

**Scheduled work — [Vercel cron](https://vercel.com/docs/cron-jobs)** hitting `CRON_SECRET`-protected route handlers. `pg_cron` is rejected: it [does not fire while Neon compute is scaled to zero](https://neon.com/docs/extensions/pg_cron). Jobs are idempotent and chunked (checkpoint rows) so function-duration limits never corrupt a run.

| Job | Cadence | Work | Lands with |
|---|---|---|---|
| `audit-retention` | monthly | Delete/pseudonymize `AuditEvent` per category windows (auth ~12 mo; admin/impersonation ~24 mo; documented in the ROPA — [CNIL guidance](https://www.cnil.fr/fr/la-cnil-publie-une-recommandation-relative-aux-mesures-de-journalisation)); runs as the privileged role (append-only enforcement stays intact) | Phase 1 |
| `storage-reconciliation` | daily | R2 listing vs FileObject rows; quota counter re-sync; complements the R2 lifecycle rule aborting incomplete multiparts | Phase 2 |
| `billing-reconciliation` | nightly | Re-fetch Stripe subscriptions, diff against `Tenant.entitlements`, alert on drift (webhooks are primary; this is the net) | Phase 7 |
| `continuity-reseal-reminders` | daily | Quarterly reseal-ritual nudges, staleness badges, forced-reseal escalation on Contact offboarding — content rot is the product risk | Phase 8 |
| `continuity-trigger-scan` | hourly | `ContinuityOpenRequest` veto-window countdowns, escalating notifications, dead-man corroboration signals (lapsed billing + no staff logins) — never auto-open | Phase 8 |
| `tenant-export-scheduler` | daily | Queue and push scheduled per-tenant exports (JSONL + files + manifest) **outside our infrastructure** — the platform-level continuity commitment | Phase 8 |

**Webhooks.** `POST /api/webhooks/stripe` — raw-body signature verification, idempotency ledger (`StripeWebhookEvent`, schema in `DATA_MODEL.md` §6.2: `eventId @unique` is the idempotency guarantee, enforced by the constraint rather than a read-then-write race; lands with Phase 7), re-fetch pattern, fast ACK with work deferred to the reconciliation net when needed. Lifecycle paths exercised with Stripe Test Clocks (§8).

**R2 event notifications — v2.** Wiring R2 events through Cloudflare Queues (paid Workers plan, ~$5/mo) enables async AV scanning (attachmentAV/ClamAV) and upload confirmation at volume. v1 ships the cheaper mitigations: allowlist, size verify at confirm time, attachment disposition, separate delivery apex (ARC-06, ARC-11).

**Preview deployments.** Multi-tenant preview URLs are Vercel-Enterprise-only, so previews use a **tenant fallback**: seeded demo tenant selected via environment (header/query permitted only when `VERCEL_ENV=preview`), never production data, never the hostname path. The seam's hostname branch is integration-tested locally instead. This fallback is built day 1 so previews stay useful for the whole life of the product.

---

## 6. Cost model

Fixed monthly costs, excluding Stripe's revenue-proportional fees. Targets: **v1 under $50/mo** (research-confirmed); modest growth at 50 tenants.

| Line | v1 (≤10 tenants) | ~50 tenants | Notes |
|---|---|---|---|
| Vercel Pro | $20 | $20 | 1 seat; includes usage credit, 1 TB transfer |
| Neon (Launch) | $5–20 | $25–60 | scale-to-zero off-hours; [pricing](https://neon.com/pricing) |
| R2 (EU bucket) | $0–2 | $5–15 | ~100 GB → ~$1.40; ~1 TB → ~$15; **egress $0** |
| Upstash Redis (EU) | $0 | $0–10 | 500k commands/mo free |
| Amazon SES (`eu-central-1`) | ~$0 | ~$5 | [$0.10/1k](https://aws.amazon.com/ses/pricing/), uniform across regions; volume is tiny (ARC-09) |
| Domains (2 apexes) | **$0 in v1** | ~$3 | v1 rides `naxdor.com` subdomains (ARC-11 / decision #9); product + ops apex bought at Phase 7, amortized |
| Cloudflare Workers paid (R2 events) | — (v2) | $5 | when the AV/event pipeline lands |
| AWS KMS (envelope-encryption seam) | — | $1–2 | when per-tenant DEKs land (`SECURITY.md`) |
| **Fixed total** | **< $50** | **~$80–135** | |
| Stripe (proportional) | 0.7% Billing + 0.5% Tax + cards (1.5% + 1.80 kr EEA; 3.15% intl) | ≈ $35 Billing at $5k MRR + card fees | scales with revenue, not tenant count |

**Gated, demand-triggered:** BankID e-signing via one pooled broker account — [Idura](https://www.idura.eu), **€139/mo incl. 200 signatures + €0.013/tx** — switched on when the first tenant asks, metered per tenant as an entitlement and priced through (the multi-tenant arbitrage vs €49–255/mo per-tenant vendor accounts; see research 10.3). **Deferred:** formal SaaS escrow ([Codekeeper](https://codekeeper.co)-class, ~$2.6k/yr) — platform continuity v1 is exports + runbook + wind-down commitment instead (`CONTINUITY_BOX.md`); escrow revisited at real traction, flagged as a possible marketing asset ("we escrow ourselves").

What changes at 50 tenants is *shape*, not order of magnitude: Neon compute hours dominate, R2 grows with tenant files, Upstash may leave free tier, and the ops burden (support, DNS if custom domains shipped) — not infrastructure — becomes the real cost.

---

## 7. Testing strategy summary

The brief's non-negotiables (§12): tests for tenant isolation, client-level scoping, file visibility, and privilege escalation. Layers and when they run:

| Layer | Tooling | What it proves | When |
|---|---|---|---|
| 1 · Static | `tsc --strict`, ESLint | Seam rules as lint: no role-name checks outside `authorize()`, no raw Prisma client imports, no app-host literals outside `urlFor()`, no cookie literals outside the cookie module, no hardcoded UI strings | every PR (merge-blocking) |
| 2 · Unit | Vitest | **Deny-matrix authz suite**: every permission code × role template × principal type, default-deny asserted; four-gate ordering; VAT-profile and invoice-numbering logic; escalation guard logic | every PR (merge-blocking) |
| 3 · Integration (real Postgres) | Vitest + **ephemeral Neon branch per CI run** | **Cross-tenant suite**: DMMF-enumerated models, adversarial reads/writes as tenant B against tenant A, RLS fail-closed with no GUC set, pooled-connection `set_config` leak check, nested-write/`connect` escapes blocked by composite FKs. **File-visibility suite**: portal principal vs `internal` documents (RESTRICTIVE policy), visibility flips audited. **Escalation suite**: grant-subset, last-owner, self-escalation under concurrent transactions. Audit append-only (UPDATE/DELETE rejected at the DB). Continuity open-once state transition (atomic, exactly one winner) | every PR (merge-blocking) — this is the §5 "runs in CI on every PR, not a one-off" requirement |
| 4 · E2E | Playwright vs preview deployment | Three-plane separation: portal cookie rejected on tenant routes by audience; platform routes 404 on the app apex; invite-only portal (no signup path exists); signed-URL issuance requires authorization at issue time | smoke per PR after deploy; full nightly |
| 5 · Billing lifecycle | Stripe Test Clocks | Trial → pause, dunning, downgrade read-only grandfathering, webhook idempotency and out-of-order delivery | nightly + before Phase 7 ships |
| 6 · Drills (operational, not CI) | scripted | Tenant export → restore into a clean environment (the platform-continuity promise is only real if restore is rehearsed); key-custody ceremony walkthrough | quarterly |

Layers 1–3 are merge-blocking from Phase 1 onward; a PR that adds a model without isolation coverage fails automatically because the suite enumerates models, not a hand-kept list.

---

## 8. Cross-references and open items

- Tenancy mechanics (withTenant, RLS policy text, Neon role setup, composite FKs): `TENANCY.md`.
- Permission catalog, role templates, four-gate semantics, template-drift policy: `AUTHZ.md`.
- Schema for every entity named here: `DATA_MODEL.md`.
- DPA/sub-processor honesty (Vercel/Neon/Cloudflare/Stripe/AWS US-transfer notes), encryption, signed-URL policy: `SECURITY.md`.
- Feeding `OPEN_QUESTIONS.md`: Neon Frankfurt project creation (blocks Phase 1); product-domain purchase (**no longer blocks Phase 1** — deferred to Phase 7 by decision #9, B1); SEK/USD currency split (blocks Phase 7); ~~ESP DPA/EU verification~~ (**settled** — Amazon SES `eu-central-1`, decision #10, ARC-09); Vercel WAF EU usage rates; Idura contract terms at v1.5.

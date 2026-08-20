# SECURITY.md — Fortleva

**Status:** Phase 0 specification (research + design, no application code). Date: 2026-08-03. **Amended 2026-08-16 (work-management plan, decisions 11–13):** §2.1/§2.3/§5.1 new visibility leak vectors + tripwires, §3.5 step-up + decision 13, §4 new limits, §6 v2 ciphertext / `TenantKey` / vault threat model, §7 must-capture additions, §9.2 processors-to-add table, **new §9.7 employee time data & monitoring posture**, §10 retention rows, §12/§13 open items. Amendments are dated inline; nothing earlier was deleted.
**Companions:** threat-relevant enforcement detail lives in `TENANCY.md` (RLS, isolation), `AUTHZ.md` (permission model, four gates), `DATA_MODEL.md` (schema incl. `AuditEvent`), `CONTINUITY_BOX.md` (sealing crypto, triggers, legal). This doc owns: threat model, authentication, encryption, rate limiting, file security, audit posture, impersonation rules, and the GDPR position (§9).

---

## 1. Posture in one page

1. **Fail closed.** Unset tenant context ⇒ zero rows; zero assignments ⇒ see nothing (decision #5); unknown file type ⇒ reject; missing entitlement ⇒ deny.
2. **Every control has exactly one seam.** One `authorize()` call, one `withTenant()` wrapper, one presign function, one `encrypt()` service, one `audit.record()` helper. Security reviews audit seams, not call sites.
3. **Server-side only.** UI hiding is cosmetics (§4). Entitlement → preference → permission gates are evaluated on the server for every request.
4. **The portal is the least-trusted surface** (§9). Contacts are a separate principal type with a separate identity stack (decision #6), a hardcoded small capability set, and the heaviest rate limiting.
5. **The platform operator is inside the threat model.** For the ContinuityBox, operator exclusion is cryptographic (client-side encryption + 2-of-3 Shamir, decision #1), not a promise. Everywhere else it is procedural (audit, impersonation rules, DPA) — and we say so honestly (§9.3 below).
6. **Residency claims must be exactly true.** Data at rest in the EU: yes. All processing in the EU: no (Vercel edge, Stripe). The marketing copy is constrained by §9.3 of this document.

---

## 2. Threat model

### 2.1 Assets, most valuable first

| Asset | Why it matters |
|---|---|
| ContinuityBox contents | Credentials-adjacent handover material; the product's trust anchor. Compromise = product-ending. |
| Cross-tenant data (any Tenant reading another) | Existential isolation failure (§5). |
| Internal-visibility Documents/notes exposed to a Contact | "The worst bug this product can have" (§5) — client↔client and internal↔client-visible boundaries. |
| Member/Contact credentials & sessions | Gateway to everything above. |
| Invoices, Contracts, ContractSignature evidence | Legal records (räkenskapsinformation, signature evidence); integrity > confidentiality. |
| AuditEvent integrity | The evidence trail for every other control, incl. box opens. |
| Field-encryption keys, Shamir platform shares | Key material; see §6 and `CONTINUITY_BOX.md`. |
| Vault credentials (`CredentialSecret` ciphertext, TOTP seeds, share-link tokens) *(added 2026-08-16 — decision 12)* | Live third-party logins for a tenant's clients. Server-side encrypted (§6.1) — a dump must not yield plaintext, and the operator's technical ability to decrypt is stated, not hidden (§6.3). Compromise = the tenant's clients get breached through us. |
| Employee time data + internal cost rates *(added 2026-08-16 — decision 11)* | Time entries are employee personal data (tidsredovisning, §9.7); cost rates are salary-grade. Leaking per-member time or cost to a Contact, a peer, or a CSV is a GDPR incident, not a UX bug. |
| `TenantKey` wrapped DEKs, root keyring *(added 2026-08-16)* | Per-tenant envelope keys; wrapped at rest, root keys in env only (§6.1). |

### 2.2 Trust zones (§2)

| Plane | Host | Route group | Principal | Trust | Session cookie |
|---|---|---|---|---|---|
| Platform | v1 `ops.naxdor.com` → Phase 7 **`<product-ops>.tld`, its own registered apex** (ARCHITECTURE.md ARC-11) | `(platform)` | Platform admin (`User.platformRole`) | Highest privilege, MFA mandatory, most audited | `__Host-flv.platform` **on the ops host** |
| Tenant | v1 `os.naxdor.com` → Phase 7 `app.<product>.tld` | `(tenant)` | Member (User identity) | Trusted within tenant scope only | `__Host-flv.member` |
| Portal | v1 `os.naxdor.com` → Phase 7 `app.<product>.tld` | `(portal)` | Contact | **Least trusted**; read-mostly, invite-only | `__Host-flv.portal` |

One codebase, one database, three route groups with separate middleware and session claims (§2). The platform console is served from **its own host from day 1** (decided — ARC-11): no member or Contact cookie can ever reach the platform plane, and when v2 scopes cookies to the app apex for tenant subdomains, the admin surface is not one of them. Requests for `(platform)` routes on the app host return 404 and vice versa. A role check is never the only barrier between a Contact and platform or cross-client data — plane checks, RLS, and client scoping stack beneath it (`TENANCY.md`).

**v1 caveat (decision #9).** Until Phase 7 the app and console hosts are siblings under one registered domain (`naxdor.com`) rather than two registered apexes. Cookie separation still holds and is browser-enforced — `__Host-` forbids a `Domain` attribute, so no cookie crosses between `os.` and `ops.`, and none can be overwritten by a `Domain=`-scoped one. What is lost is the registered-domain boundary: any other `naxdor.com` subdomain is cookie-adjacent to both hosts and phishing-adjacent to the console. Hence **INV-D1 (ARC-11, CI-enforced): no cookie carries a `Domain` attribute while the app is under `naxdor.com`** — the v2 `Domain=.<apex>` pattern is forbidden until the product domain is live, since `Domain=.naxdor.com` would broadcast app sessions to every Naxdor property. The full trade-off is argued in ARC-11.

### 2.3 Attacker stories

**T1 — Curious Contact.** Authenticated portal Contact tampers with URLs/IDs to reach another Client's projects or invoices, or opens the ContinuityBox out of impatience (§8 "abuse and accident"). *Controls:* deny-default client scoping as RESTRICTIVE RLS + composite FKs (`TENANCY.md`); unguessable UUIDs; presigned GETs authorization-checked at issue time (§5); box friction — warning, veto window, cooldown, fully audited and tenant-notified (`CONTINUITY_BOX.md`); portal rate limits (§4).

**T2 — Malicious or compromised Contact account.** Credential stuffing against the portal; hostile uploads (HTML/SVG/macro documents) via ~~Issue~~ request/comment attachments *(WorkItem kind=REQUEST — 2026-08-16)*; bulk scraping of client-visible Documents. *Controls:* invite-only — no signup surface to enumerate (§3.4); per-email + per-IP login limits (§4); upload allowlist + `Content-Disposition: attachment` + off-origin downloads (§5); download-issuance audit + limits; offboarding revokes sessions immediately and forces a box reseal if that Contact held the card.

**T3 — Malicious tenant Member (insider).** An employee assigned to three Clients tries to read the other twenty (§3), grant themselves permissions, tamper with the audit trail, or read a sealed box. *Controls:* assignment scoping (`MemberClient`/`MemberProject`), deny-default, `client:view_all` only on owner-equivalent templates (decision #5); escalation guards — grant-subset, no-self-escalation, last-owner — as transactional app code (`AUTHZ.md`); append-only `AuditEvent` under a DB role that cannot UPDATE/DELETE (§7); sealed boxes are ciphertext no Member can decrypt (no share remains with staff after sealing); exports permission-gated and audited.

**T4 — Compromised Member account.** Phished Member with real permissions. *Controls:* mandatory MFA on owner-equivalent roles (§3.5) shrinks the worst case; step-up re-auth for high-risk operations (§3.6); assignment scoping limits blast radius; immediate DB-backed session revocation on password/MFA change; anomalies visible in the tenant's own audit log (§7).

**T5 — Malicious Tenant (the organization).** Invitation spam, malware distribution through client-visible files, a defunct-but-hostile tenant vetoing box opens forever. *Controls:* per-tenant invitation/upload ceilings (§4); scanning path reserved (v2, §5); hostile-veto escalation to platform-mediated dispute (`CONTINUITY_BOX.md`); ToS; suspension does not disable box access (§10).

**T6 — Unauthenticated internet attacker.** Credential stuffing, enumeration, DoS, dependency CVEs. *Controls:* no public signup anywhere in v1 (tenant self-signup arrives Phase 7; Contacts invite-only forever); Vercel DDoS mitigation + free WAF rules as outer shield (§4); uniform "invalid credentials"/neutral invite responses against enumeration; dependency pinning + patch cadence (§3.2, §11).

**T7 — Platform operator / platform compromise (the continuity threat).** The operator — or anyone who fully compromises Vercel env, Neon, and R2 — attempts to read ContinuityBox contents. *Controls:* boxes are encrypted client-side before upload ([age](https://github.com/FiloSottile/age) via [typage](https://github.com/FiloSottile/typage/blob/main/README.md)); key split 2-of-3 ([audited Shamir library](https://github.com/privy-io/shamir-secret-sharing)) — client-held printed card, platform DB share (useless alone), trustee share (decision #1). The platform never holds two shares; key material is never emailed. R2 holds only ciphertext; Neon only metadata. *Honesty:* outside the box, the operator **can** technically read tenant data — that is what a processor is. Those accesses are governed procedurally: impersonation rules (§8), tenant-visible audit (§7), DPA (§9). Only the box carries a cryptographic guarantee; marketing must respect that line.

**T8 — Bulk data-at-rest compromise.** A leaked DB dump/backup or stolen R2 credentials. *Controls:* passwords hashed (Better Auth scrypt); TOTP secrets field-encrypted, backup codes hashed; integration credentials and payment details field-encrypted (§6); box blobs are client-side ciphertext (a dump "does not reveal them", §8); R2 token scoped to the single bucket, minimum verbs; runtime vs migration DB credentials separated (§7). Residual: plaintext business data in a full dump — accepted, mitigated by Neon disk encryption, access control, minimization (§6 rationale). *(Amended 2026-08-16.)* Vault secrets and cost-rate amounts are v2 ciphertext under per-tenant DEKs whose wrapped form sits in the same dump — useless without the root keyring, which lives only in Vercel env + the offline copy (§6.1). The CI test "DB dump contains no plaintext" (§6.3) pins this.

**T9 — Cross-audience leakage through the new surfaces** *(added 2026-08-16 — work-management plan).* Not a new attacker — T1/T2 (a Contact) or T3 (a scoped Member) — but a new *route*: search results, notification fan-out and digest bodies, `ProjectUpdate` snapshots, credential share links, mixed-visibility comment threads and "view as client" each build a second projection of the same rows, and each is a place where an INTERNAL fact or a per-member/cost figure can reach the wrong audience without any RLS policy being wrong. *Controls:* every projection is a class-B row or an allow-listed select under the RLS-scoped principal — never a system principal — and each ships with its tripwire test in the same commit; the full list is §5.1.

**T10 — Employee-monitoring drift** *(added 2026-08-16 — decision 11).* Not an external attacker: a future feature request ("show who is working now", "flag idle time", "rank by hours") that turns tidsredovisning into övervakning and puts every tenant in breach (DPIA-mandatory, MBL 11 §, NY/CT/DE notice statutes). *Controls:* the never-list is a product invariant (§9.7), deny-default aggregate views, cost never fanned onto entry rows, self-access + export for members. Written down so it is not re-litigated feature by feature.

### 2.4 Out of scope for v1 (marked per §12)

Nation-state targeting (**skip**); malicious insider at a sub-processor beyond contractual controls (**skip** — DPA + encryption is the mitigation); SOC 2 / ISO 27001 certification (**v2**, when selling upmarket); external penetration test (**v2** — scheduled before Phase 7 opens self-signup); bug bounty (**skip**); antivirus scanning of uploads (**v2**, §5).

---

## 3. Authentication

### 3.1 Decision: Better Auth, self-hosted, identity data in Neon EU

Per the approved research (§10.1): **Better Auth self-hosted inside the Next.js app; all identity data in our Neon Frankfurt Postgres via Prisma.** It is the only evaluated option that simultaneously satisfies hard EU residency (identity data never leaves our EU database), many-to-many member↔role (§3), three principal types, and invite-only portal flows — at $0 marginal cost. Rejected (rationale in `ARCHITECTURE.md`): Clerk — [no EU residency, US-only infrastructure](https://clerk.com/articles/clerk-pricing-explained), one role per org membership; WorkOS — [no EU region by design](https://workos.com/blog/data-residency-for-enterprise-saas); Auth.js v5 — [maintenance mode](https://github.com/nextauthjs/next-auth/discussions/13252); SuperTokens — [MFA $100/mo minimum](https://supertokens.com/pricing). Kinde (Dublin) is the hosted fallback if we ever refuse to own auth code.

**Boundary rule:** Better Auth owns identity, sessions, and invitation mechanics **only**. All authorization — `Role`, `Permission`, `RolePermission`, `MemberRole`, `MemberClient`, `MemberProject` — lives in our own Prisma schema (`AUTHZ.md`, `DATA_MODEL.md`). Better Auth's comma-separated org roles are never consulted for authorization.

### 3.2 Plugin surface and CVE posture

Better Auth had a run of serious 2026 CVEs, all in **optional plugins**: [SSRF in `@better-auth/sso`, CVSS 9.6](https://securityonline.info/better-auth-ssrf-cve-2026-53513/), SCIM authorization bypass (9.9), [OAuth auto-link account takeover (CVE-2026-53516)](https://advisories.gitlab.com/npm/better-auth/CVE-2026-53516/), insecure OIDC-provider defaults. Policy:

| Rule | Detail |
|---|---|
| Version floor | Pin **≥ 1.6.11** (all 2026 advisories patched); exact-pin in lockfile, no `^` drift on auth packages. |
| Plugins enabled (v1) | `twoFactor` (TOTP + backup codes), `passkey` (WebAuthn, **member/platform instance only** — the `Passkey` model in `DATA_MODEL.md` §6.1, matching ARCHITECTURE.md ARC-04), `admin` (platform impersonation mechanics). Nothing else. |
| Plugins forbidden until needed | `organization`, `sso`, `scim`, `oidcProvider`, `deviceAuthorization`. `sso`/`scim`/`oidcProvider`/`deviceAuthorization` are the 2026 vulnerability surface; SSO is **v2** (larger tenants), adopted only on a post-hardening release, or bolted on via WorkOS SSO per-connection if safer then. **`organization` is forbidden for a structural reason, not a CVE one:** membership, roles and assignments live in our own schema (`DATA_MODEL.md` §6.1 — the plugin stores roles as a comma-separated string, which is not relational), and its org/member rows do not exist in our schema at all. Invitations are ours (`MemberInvite`), not the plugin's. |
| Social login | **Skip** (v1). Email + password + TOTP (+ passkey as a second factor/alternative on the member and platform stacks) only; no OAuth providers ⇒ auto-linking takeover class is structurally absent. Passkeys on the **Contact** stack: **v2**, with contact MFA (§3.5). |
| Patch cadence ownership | The platform owner (solo founder) owns it, named in the ROPA: subscribed to GitHub security advisories for `better-auth` + all enabled plugins; monthly routine update window; **≤ 48 h** apply-and-deploy SLA for critical advisories. This is the accepted cost of self-hosting — it is written down so it cannot be silently dropped. |

### 3.3 Two identity stacks (decision #6 — final)

Member identity and Contact identity are **separate accounts even for the same email address**: separate tables, separate session namespaces, separate cookies, separate audiences.

| | Members (+ platform admins) | Contacts |
|---|---|---|
| Identity table | `User` (Better Auth core tables; global identity, tenant-scoped `Member` rows) | `Contact` + its own credential/session satellite tables (namespaced; shapes in `DATA_MODEL.md`) |
| Auth mount | Better Auth instance A at `/api/auth/member` | Better Auth instance B at `/api/auth/portal` (own table prefix, own secret) |
| Cookie | `__Host-flv.member` (platform sessions: `__Host-flv.platform`) | `__Host-flv.portal` |
| Session audience | Session row carries `plane = MEMBER \| PLATFORM`; middleware of each route group accepts only its own cookie **and** plane value | `plane = CONTACT` only |
| Capability model | Roles/permissions per tenant (`AUTHZ.md`) | Hardcoded small portal capability set; never `Role` rows |
| Cross-plane presentation | 401. A valid member session on a portal route (or vice versa) is rejected, never coerced. | Same |

The `__Host-` cookie prefix (Secure, host-only, no `Domain`) is correct for the decided setup: a **single app host for the tenant and portal planes** (decision #8), while **the platform console has its own host** (§2.2, ARC-11) — so `__Host-flv.platform` is issued by, and only ever presented to, the ops host. Cookie configuration is centralized in one module, as decision #8 requires and INV-D2 widens to the hostname itself, so the v2 move to tenant subdomains is a config change: drop `__Host-` for `__Secure-` + `Domain=<apex>` + Better Auth `crossSubDomainCookies`, and authorize from Host + membership, never from the cookie alone. **That relaxation is gated on the product domain being live (INV-D1)** — it must never be applied while the app runs under `naxdor.com`, where `Domain=.naxdor.com` would leak sessions to every sibling Naxdor property. Platform sessions stay host-only forever.

### 3.4 Invite-only enforcement — in our code, not the library's

Better Auth does not prevent self-signup by itself; this boundary is application discipline, and it is our most sensitive line (§3 "invite-only — no self-signup for contacts, ever"):

- Portal instance: public sign-up disabled (`disableSignUp`); the **only** account-creation path is the invitation-accept flow — single-use token, ≤ 72 h expiry, bound to the invited email; the link grants enrollment, never a session.
- Contact invitations require `client:manage_contacts` on that Client (`AUTHZ.md` §3.2 — there is no `contact:*` namespace in the catalog); issuance and acceptance are audited. Member invitations use **our own `MemberInvite` table** (single-use token stored as a hash, 48 h `expiresAt`, `proposedRoleIds` subset-checked against the inviter — `DATA_MODEL.md` §6.3), gated by `member:invite` and the `maxMembers` entitlement. The Better Auth `organization` plugin is not enabled (§3.2), so no vendor invitation flow exists to fall back on.
- Tenant self-signup does not exist until Phase 7; until then tenants are platform-provisioned.
- CI test: POST to every conceivable portal/member signup route asserts 404/403 (§12 non-negotiable tests).

### 3.5 MFA policy (§9)

| Principal | Policy | Mechanics |
|---|---|---|
| Platform admins | **Mandatory**, no exceptions | TOTP enrolled at first login before any platform action; 10 single-use backup codes (hashed at rest); trusted-device remembering **off** on the platform plane. |
| Members holding an owner-equivalent system role | **Mandatory** | Granting the role to a Member without MFA forces enrollment at next login before anything else; the grant itself is allowed (otherwise last-owner recovery deadlocks) but the session is hard-gated. |
| All other Members | Available (v1); tenant-enforced "require MFA for all members" as a TenantPreference (**v2**) | TOTP + backup codes; 30-day trusted devices allowed. |
| Contacts | **v2** — deliberate deviation from "MFA available everywhere" (§9), recorded once in `DATA_MODEL.md` Pushback P5 | The portal is invite-only, rate-limited and read-mostly in v1, and no `ContactTwoFactor` model exists in the v1 schema. The second Better Auth instance makes adding one purely additive — likely alongside BankID, which is itself a stronger factor. |

TOTP secrets are field-encrypted, backup codes hashed (§6). Passkeys: **v1 on the member/platform stack** (ARC-04, `Passkey` model in `DATA_MODEL.md`); **v2 on the Contact stack**, with contact MFA.

**Amended 2026-08-16 (work-management plan; decision 13) — step-up mechanics and the extended ✦ set.**

- **Enforcement lands in Phase 1b, not "later".** `authorize()` denies with a distinct **`MFA_REQUIRED`** result (not `FORBIDDEN`) whenever the requested code is ✦ (`requiresMfa`) and the session has no recent second factor; the UI turns `MFA_REQUIRED` into the step-up dialog (one shared component for every ✦ action), never into a generic error. `MFA_REQUIRED` is also returned when the holder of a ✦ code has not yet enrolled — the AUTHZ §7.5 "flag for forced enrollment" rule made executable.
- **`requireRecentMfa(minutes)`** — the sudo-window helper. Reads the session's `lastMfaAt` (stamped on TOTP/passkey/backup-code verification and on interactive re-verify) and throws `MFA_REQUIRED` if older than `minutes` or absent. Defaults: **10 min** for the vault (`vault.stepUpMinutes`, tenant-tunable 1–60), 10 min for the AUTHZ §7.5 step-up list (`continuity_box:edit|configure`, `tenant:export`), 15 min for the §3.6 "fresh session" operations. Trusted-device remembering satisfies *login*, never step-up: a step-up always requires an interactive factor.
- **Extended ✦ set** (AUTHZ §3.2 is normative; listed here so the MFA policy is complete): the original set (billing, `role:edit`, `member:manage_roles`, `settings:manage_modules`, `tenant:export`, `invoice:manage_series`, `continuity_box:*`) **plus** `rate:view_cost`, `rate:manage_cost` (2T — salary-grade data, §9.7), `credential:reveal`, `credential:share`, `credential:export`, `credential:change_visibility` (3V). Share / export / visibility-change on credentials **always** step up regardless of window (CP4 default).
- **Decision 13 — who must have MFA to reveal a credential.** `credential:reveal` is seeded **CMA** (CEO / Manager / Admin templates), *not* on Employee, with ✦. Consequence per AUTHZ §7.5: only members who are deliberately granted the code are forced to enrol — enabling the `vault` entitlement does **not** silently make every employee MFA-mandatory, and the "tenant-enforced MFA for all members" preference stays v2 (C16). The alternative — seed CMAE and accept vault ⇒ all-employee MFA — is the recorded CP4 fallback if Naxdor prefers it. Either way: **no reveal without a recent second factor, ever**; there is no "MFA optional" path for `credential:reveal`.
- The MFA deny-matrix (every ✦ code × {no MFA enrolled, enrolled but stale, fresh}) is a Phase 1b CI test and is regenerated whenever the ✦ set grows.

### 3.6 Session policy

Sessions are DB-backed (Better Auth), so revocation is immediate — no JWT revocation hole; permissions are **not** embedded in the session (per-request resolution + per-tenant `permissionsVersion`, see `AUTHZ.md`).

| Plane | Idle timeout | Absolute lifetime | Notes |
|---|---|---|---|
| Platform | 12 h | 7 days | MFA at every fresh login. Impersonation sessions: see §8 (≤ 60 min). |
| Tenant (Member) | 7 days rolling | 30 days | Step-up below. |
| Portal (Contact) | 30 days rolling | 90 days | Longest-lived because lowest-privilege; portal adoption depends on low friction. |

- Cookie flags everywhere: `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, `__Host-` prefix (v1).
- **Step-up ("fresh session") rule:** role/permission changes, Member removal, entitlement-affecting settings, ContinuityBox edits/reseals, data exports, and invoice-series changes require authentication ≤ 15 min old or an interactive re-verify (password or TOTP). *(Amended 2026-08-16.)* Implemented by one helper, `requireRecentMfa(minutes)` (§3.5); vault reveal/copy/TOTP use a 10-min window; credential share/export/visibility-change and cost-rate decrypt step up too (`time:reprice` and `time:manage_locks` are audited but are **not** ✦ and do not step up — `AUTHZ.md` §7.5 is normative for the ✦ set). Password-only re-verify is accepted **only** for members without MFA enrolled and never for a ✦ code.
- Revocation triggers: password change, MFA enrollment/removal, Member removed from Tenant, Contact offboarded, platform suspension. All sessions of the principal die in the same transaction.
- CSRF: Better Auth origin checks + `SameSite=Lax` + state-changing operations as POST only. Strict CSP; uploaded or principal-authored content is never rendered inline on app origins (§5).
- **PWA shell / service worker** *(added 2026-08-20 — decision 15, ARC-25)*: the worker is **network-only for navigations and `/api/*`** and precaches only immutable hashed static assets — no response that carried a session cookie is ever written to Cache Storage, so revocation and visibility changes take effect on the next request exactly as without a worker. Sign-out and every revocation trigger above also send `Clear-Site-Data: "cache", "storage"` where the browser honours it. The ops host serves no manifest and no worker (un-installable admin plane). Offline caching of tenant data is v1.5 and needs its own §2 threat-model pass (shared/lost device, two accounts on one browser profile) before code.

---

## 4. Rate limiting and abuse protection (§9)

**Architecture: [Upstash Redis](https://upstash.com/pricing/redis) (EU region) + `@upstash/ratelimit` as the real limiter; free Vercel WAF as the outer shield.**

- Upstash gives sliding-window/token-bucket limits on **arbitrary keys** — per-Contact, per-Member, per-email, per-Tenant — which is what a portal actually needs. Free tier (500k commands/mo) covers v1; EU region keeps counter data resident.
- Rate-limit keys derived from emails are **HMAC-hashed** before leaving our process, so Upstash never stores plaintext identifiers (keeps it a low-risk sub-processor, §9.2).
- Free Vercel WAF layer: custom rules (IP/ASN blocks, challenge mode on auth paths during incident), platform DDoS mitigation. Denied traffic doesn't bill.
- **Rejected: Vercel's paid WAF rate limiting.** On Pro it can [key only by IP + JA4](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting) (per-principal/per-email keys are Enterprise), is fixed-window only, counters are **per-region** (a "100/min" limit multiplies across regions), and it is [usage-priced per allowed request](https://vercel.com/docs/vercel-firewall/vercel-waf/usage-and-pricing). Wrong keys, wrong window semantics, wrong price shape for this product.

Initial limits (tunable constants, one config module; all violations audited above a threshold):

| Surface | Key(s) | Limit (v1 proposal) |
|---|---|---|
| Login (member & portal, separately) | hashed email; IP | 5 / 15 min per email; 30 / h per IP |
| TOTP verify | session | 5 consecutive failures → 15 min lock |
| Password reset request | hashed email; IP | 3 / h per email |
| Invitation issuance (Member or Contact) | member; tenant | 20 / h per member; 100 / day per tenant |
| Invitation / magic-link acceptance | token; IP | 10 / h per IP |
| Presigned GET issuance (downloads) | principal | 120 / 5 min (burst-friendly) |
| Presigned PUT issuance (uploads) | principal; tenant | 60 / h per principal + tenant storage quota check |
| ~~Issue + IssueComment creation~~ → WorkItem `kind=REQUEST` + Comment creation *(renamed 2026-08-16 — Issue absorbed into WorkItem)* | contact | 20 / h |
| Full tenant export | tenant | 2 / day |
| ContinuityOpenRequest | box | 1 active request; 30-day cooldown after veto (app rule in `CONTINUITY_BOX.md`, not just a limiter) |
| Credential reveal / copy / TOTP *(added 2026-08-16 — 3V)* | member | **reveal budget** `vault.revealBudgetPerHour` (default 30 / h per member); exceeding ⇒ deny + `vault.reveal_budget_exceeded` audit; **fails closed** to an in-Postgres counter when Redis is down |
| Credential share-link resolution *(added 2026-08-16 — 3V)* | token; IP; hashed recipient email | 5 attempts / token; 20 / h per IP; email-OTP 3 sends / h per email, 5 verify attempts / code |
| Portal credential submission form *(added 2026-08-16 — 3V)* | contact | 10 / h |
| Search queries *(added 2026-08-16 — 2W)* | principal | 120 / min member; 30 / min contact |
| Timer start/stop, time-entry writes *(added 2026-08-16 — 2T)* | member | 120 / 5 min (burst-friendly; the one-running-timer partial unique index is the real guard) |
| Notification digest / email per recipient *(added 2026-08-16 — 2W/5)* | hashed recipient email | outbox-level cap 50 / h per recipient (assignment/mention debounced 2 min; digests once per cadence) |

**Failure mode:** if Redis is unreachable, limits **fail open with a structured alert** (availability of login beats a perfect limiter, and the WAF shield remains) — **except** ContinuityOpenRequest creation, impersonation start, and export initiation, which **fail closed**: rare, high-stakes, human-retryable. *(Amended 2026-08-16.)* Two more fail-closed surfaces: the **credential reveal budget** (falls back to an in-Postgres per-member counter — never unlimited reveals) and **share-link OTP verification** (a missed limit here is a credential leak, not an inconvenience).

---

## 5. File security (§5, §9, §10.6)

Storage is **two Cloudflare R2 buckets, both created with the EU jurisdictional restriction** (guarantees stored objects remain in-EU; [set at creation, immutable](https://developers.cloudflare.com/r2/reference/data-location/) — creating both buckets correctly is a day-one, cannot-redo step, `PLAN.md` Phase 1), addressed via the `<account>.eu.r2.cloudflarestorage.com` endpoint, keys prefixed `tenantId/`. Zero egress fees fit a download-heavy product ([R2 pricing](https://developers.cloudflare.com/r2/pricing/)).

| Bucket | Holds | Regime |
|---|---|---|
| **General document bucket** | every `FileObject` (documents, invoice/contract PDFs, evidence, exports, thumbnails) | runtime credential may write and delete; lifecycle rules; ordinary deletion on retention/erasure |
| **Dedicated continuity bucket** | `ContinuityBox` blobs only (never a `FileObject`) | [bucket lock](https://developers.cloudflare.com/r2/buckets/bucket-locks/), 90 days from write; the **runtime credential has no delete permission** (INV-10); a separate cleanup credential deletes after lock expiry — `CONTINUITY_BOX.md` §2.6 |

Two buckets, not one, because the continuity regime is bucket-wide: a 90-day bucket lock and a no-delete runtime credential cannot be applied to the general document bucket without breaking ordinary `Document` deletion and GDPR erasure. The presign machinery, quota metering and HEAD-verify pattern are shared code across both.

**Download path.**
- Files are served **only** via short-lived presigned GETs (TTL 2–5 min). Never public buckets; never long-lived links (§9).
- The presign endpoint runs the full authorization stack **at issue time** (§9): entitlement → tenant preference → permission → tenant scope → client scope → `visibility` flag. A Contact can only ever be issued URLs for `client_visible` objects of their own Client.
- Every issuance writes an `AuditEvent` (`file.download_url_issued`) — downloads are must-capture (§7).
- Presigned URLs live on the R2 endpoint — **off-origin by construction**. Rule: file bytes are never proxied through an app origin, and uploaded content is never served from a host carrying app cookies. Rationale: at this scale **XSS is the realistic payload, not viruses** — uploaded HTML/SVG rendered on the app origin is session theft; the same file force-downloaded from a cookie-less foreign host is inert. A vanity download domain, if ever added, must be a separate registrable domain (v2; R2 presigned URLs don't work on custom domains — it would need a Worker).

**Upload path.**
- **Contact uploads are brokered, never direct writes to the file layer** (decided; stated identically in `TENANCY.md` §7.2 and `DATA_MODEL.md` §2.3). A Contact attaching a file to an Issue hits a server action that runs `authorizePortal()` first, then re-enters `withTenant()` as the **`system` principal** to presign and to create the `Document` (forced `clientId` = the contact's client, forced `CLIENT_VISIBLE`) / `FileVersion` / `FileObject` rows. `FileObject`/`FileVersion` keep the `portal_deny` RESTRICTIVE policy with no INSERT exception; the `createdByContactId`/`uploadedByContactId` columns are attribution only. Rate limits still key on the **contact** (§4), because the contact is who caused the write.
- Presigned PUT (R2 has no presigned POST, hence no `content-length-range` policy): **sign `Content-Length` and `Content-Type` into the URL**, check the tenant's storage quota (metered in Postgres) at presign, then **HEAD-verify real size and type before committing the `FileObject` row**. No row, no file; orphans are garbage-collected.
- Lifecycle rule aborts incomplete multiparts; a scheduled reconciliation job diffs the bucket against `FileObject`/`FileVersion` rows to catch quota drift.
- **Extension + MIME allowlist** (documents: pdf/docx/xlsx/pptx/csv/txt/md; images: png/jpg/webp/svg; archives: zip); everything else rejected at presign; `html/htm/js/exe/...` never accepted.
- Everything stored and served with `Content-Disposition: attachment`; SVG is allowlisted but **never** rendered inline.
- Previews: `sharp` thumbnails generated at upload (app-generated derivatives are safe to inline); PDFs client-side via `pdfjs-dist`; no Vercel Image Optimization on signed URLs (bills per view).
- Virus scanning: **v2** — `FileObject.scanStatus` reserved in the schema now; [attachmentAV](https://attachmentav.com/blog/antivirus-for-cloudflare-r2/) via R2 event notifications when portal upload volume is real.

ContinuityBox blobs follow a stricter, separate path (client-side encrypted before upload, bucket lock, 7-day presign window on open) — `CONTINUITY_BOX.md`.

*(Amended 2026-08-16.)* "A Contact attaching a file to an Issue" above now reads "to a WorkItem (`kind=REQUEST`), Comment or ProjectUpdate" — `Issue` was absorbed into `WorkItem` (decision 11 series; `AttachableType` gains `WORK_ITEM | COMMENT | PROJECT_UPDATE | CREDENTIAL | ASSET`, `DATA_MODEL.md`). The brokered-write pattern is unchanged and is generalised in §5.1.

### 5.1 Visibility beyond files — the new leak vectors and their tripwires *(added 2026-08-16 — work-management plan)*

The brief's "worst bug" (§2.1) used to have one surface: Documents and notes. The work-management plan adds six more projections of the same rows, and each is a place where an INTERNAL fact or a per-member/cost figure can reach a Contact **without any RLS policy being wrong** — because the leak happens in a body built server-side, a denormalised copy, or a second read path. Rules, then vectors.

**Three standing rules (all data-layer, all tested):**

1. **`portal_enabled` is denormalised, not joined.** `Project.portalEnabled` is copied as `portal_enabled boolean NOT NULL DEFAULT false` onto **every project-scoped class-B table** (WorkItem, WorkItemActivity, Comment, ProjectUpdate, project Documents, Milestone, ProjectVersion, Service, ProjectTimeSummary, `search_index` rows with a projectId), maintained by an `AFTER UPDATE OF portal_enabled ON project` trigger fanning out in the same transaction. The RESTRICTIVE `portal_gate` clause is `client_id = current_setting('app.client_id') AND visibility = 'CLIENT_VISIBLE' AND portal_enabled`. Rationale: a JOIN to `project` from inside a policy would need the contact to be able to read `project`, and a project flip must take effect for every row atomically. Registry posture test: every `projectScoped` table has `client_id`, `visibility`, `portal_enabled` and a `portal_gate` policy; feature test: `portalEnabled=false` ⇒ **0 rows for a contact across all tables**. (`TENANCY.md` §7.2 owns the policy text.)
2. **The contact-writable census is exact and closed.** A Contact principal may INSERT/UPDATE precisely: `Comment` (INSERT, WITH CHECK `visibility='CLIENT_VISIBLE' AND client_id=app.client_id AND author_contact_id=app.principal_id`), `ProjectVersion` approval columns, `Document` approval columns, `Notification.readAt/archivedAt` on its own receiver rows, `ContinuityOpenRequest`. **Every other contact-caused write** — REQUEST creation, completing an own-assigned task, credential submission, file attach — is **brokered**: `authorizePortal()` first, then `withTenant(tenantId, {type:'system'})` in `src/modules/*/portal.ts`, forcing `clientId`, `CLIENT_VISIBLE`, and attribution columns. Rate limits still key on the contact. **Portal *reads* never run under a system principal** — a projection built under `system` has lost the RLS net and is the archetype of this bug. Census test regenerated in the same commit as any change.
3. **Portal projections are allow-lists under the contact principal, and "view as client" is the same code.** Every `modules/*/portal.ts` select is explicit; a **forbidden-columns grep** (rates, cost, `internalNotes`, `repoUrl`, `hostingNotes`, non-billable, per-member breakdown, state *names*, labels, links, `assigneeMemberId`, INTERNAL activity, ciphertext) and a **"no INTERNAL fact to a Contact"** fixture suite ship with each feature. **View-as-Contact reuses the exact same functions** (asserted by import graph; byte-identical JSON to a real contact session) — a separate "preview" renderer is how previews lie.

**Vectors and tripwires (each ships in the same commit as its feature):**

| Vector | Phase | Why it leaks | Tripwire |
|---|---|---|---|
| **Search index** | 2W | A trigger-fed `search_index` row copies title/body/meta text; if the copy carries INTERNAL text or lacks `visibility`/`portal_enabled`, a contact's search finds words from private items. Also GIN/trgm indexes are dead under FORCE RLS (non-leakproof quals never become index quals), so any "fast path" that bypasses RLS is a leak. | `search_index` is class B with the same `tenant_isolation` + `portal_gate` policies; per-row `visibility`, `portal_enabled`, `client_id`; secrets never indexed (credential name/username/url/tags only). **Lexeme probe**: an INTERNAL body word never matches under a contact principal. Modelling rule: no member-only free-text column on any entity that can be CLIENT_VISIBLE. |
| **Notification fan-out + digest bodies** | 2W / 5 | `notify.emit()` chooses receivers; a CONTACT receiver row for an INTERNAL comment, or a digest body rendered under a member/system principal, carries private facts by email. | Static kind catalog with `audience`; every CONTACT-audience kind is `clientVisibleOnly` (CI-tested); `Notification.clientId` required for CONTACT rows; **digests for contacts are built under the portal role** — a digest built under the contact principal cannot contain INTERNAL rows (test); `params` are ids only, bodies rendered at send time under the receiver's principal; suppression honoured. Test: INTERNAL comment never notifies a contact; CLIENT_VISIBLE change never emails another client's contacts. |
| **ProjectUpdate snapshots** | 3 | The published update freezes metrics; a snapshot with per-member hours or cost on a contact-selectable row is a leak frozen forever. | Two rows: `ProjectUpdate.portalSnapshot` (portal-safe: tasks done/total, milestones, versions, hours only when `hoursSharingMode` allows) and **`ProjectUpdateInternalSnapshot` (class A, 1:1: by-member, cost, budget)** — per-member/cost never sit on a class-B row by construction. Immutable after publish (trigger). Forbidden-columns grep covers `portalSnapshot`. |
| **Client hours** | 2T / 3 | Any portal read of `time_entry` (class A) or a view over it. | The only portal time surface is the physical class-B `ProjectTimeSummary` (recomputed per (project, month) in the entry transaction; **no member id column by construction**; visibility derived from `hoursSharingMode`; property test `summary == SUM(time_entry)`). A SQL view was rejected — under FORCE RLS it returns 0 rows to a contact. |
| **Credential share links** | 3V | A link is a bearer that crosses the portal boundary by design; resolving it under `withPlatform` would skip RLS entirely; a guessable or replayable token is a credential leak. | Token `<tenantId>.<random>` (hash of the random part at rest); resolved via **`withTenant(tenantId, {type:'system'})` — never `withPlatform`** from a portal/tenant route (ESLint import-boundary rule + test); recipient must be an authenticated Contact of that client **or** pass mandatory email OTP; `maxViews=1`, TTL ≤ 7 d, view-once consumed atomically with the audit row (concurrency test); tenant preference to disable external links. |
| **Mixed-visibility comment threads** | 2W / 3 | One thread, two audiences: an INTERNAL reply nested under a CLIENT_VISIBLE comment, or a Contact mentioned/assigned on an INTERNAL item, or a Contact-authored comment landing INTERNAL. | Each `Comment` carries its own `visibility` (defaulted from parent, child ≤ parent by CHECK/trigger; parent flip to INTERNAL refused while a child is CLIENT_VISIBLE); contact-authored comments **forced** CLIENT_VISIBLE by WITH CHECK; two-mode composer ("Internal note" default / "Reply to client"); warning when mentioning/assigning a Contact on an INTERNAL item; contact assignee ⇒ CLIENT_VISIBLE by CHECK. Fixture: INTERNAL comment on CLIENT_VISIBLE item invisible to the contact. |
| **View-as-Contact** | 3 | A preview that renders "what the client sees" through different code than the client's own request. | Same projection functions (import-graph assertion), red banner, `project.viewed_as_contact` audited, output byte-compared to a real contact session in CI. |
| **Activity / timeline** | 2W / 3 | `WorkItemActivity` records every field change; the Client Timeline is a UNION. | Activity rows carry their own `visibility` — INTERNAL unless the field is portal-safe (`stateCategory`, `title`, `targetDate`, `milestoneId`, `assigneeContactId`); portal reads `stateCategory` only, never state *names* (`WorkflowState` is class A). Timeline never reads `AuditEvent`. |

The list is expected to grow (push payloads, reply-by-email, exports). The rule for any new surface: name the vector, decide class A/B, write the tripwire, land both in one commit. `PLAN.md` §2 carries these as the phase definition of done.

---

## 6. Field-level encryption (§9)

Baseline: Neon encrypts disks; the brief demands more than disk-level (§9). We add an application-layer service for a **short, deliberate list of fields**.

**Service design (own code, ~80 lines over Node `crypto`; spec, not code):**
- AES-256-GCM, random 96-bit IV per operation, 128-bit tag.
- **AAD binds ciphertext to its location**: `tenantId || model || field`, so a ciphertext moved to another row/tenant fails authentication. *(Amended 2026-08-16: the shipped v1 code in `src/crypto/field-encryption.ts` does **not** pass AAD — a known gap; v2 (§6.1) closes it and adds `rowId`.)*
- Ciphertext format: **`v1.<keyId>.<iv>.<ct>.<tag>`** (base64url segments). The version + keyId prefix is what makes rotation and the KMS seam cheap later; unversioned ciphertext "becomes archaeology". *(Amended 2026-08-16: superseded for new writes by **v2** — §6.1; v1 stays decryptable.)*
- Rejected: [`prisma-field-encryption`](https://github.com/47ng/prisma-field-encryption) (year-stale, pinned ≤ Prisma 6.13, single maintainer), `pgcrypto` (keys travel inside SQL → statement logs / `pg_stat_statements`), per-tenant KMS keys now (cost/complexity, no threat-model payoff at tens of tenants).

**Key custody.**
- **v1:** one 256-bit key in a keyring env var (`{keyId: key}` + active-key pointer) on Vercel. Honest limit: anyone with Vercel project admin can read it — acceptable at one operator, documented in the ROPA.
- A **documented offline copy** of the keyring lives outside Vercel (printed + in the founder's password manager with emergency access), listed in the platform-continuity runbook (`CONTINUITY_BOX.md`). Losing the key is losing the data — written down, owned.
- Rotation: add key N+1 to the keyring, new writes use it, background job re-encrypts old ciphertexts, retire old key when unreferenced.
- **Seam to v2:** the service signature is `encrypt(tenantId, model, field, plaintext)`. v1 ignores `tenantId` for key selection; v2 selects a per-tenant DEK wrapped by one KMS root key (AWS KMS eu-north-1 Stockholm, ~$1/mo + pennies). Ciphertext format already carries `keyId`, so migration is incremental, not a rewrite. *(Amended 2026-08-16: v2 is now specified in §6.1 — per-tenant DEK **yes**, KMS **not yet**; the deviation is stated there.)*

### 6.1 v2 ciphertext format and per-tenant keys *(added 2026-08-16 — decision 12; ARC-20; lands in Phase 1b, before any encrypted app data exists — one-way door)*

The vault (decision 12) and encrypted cost rates (decision 11) put real secrets behind this service for the first time, so the v2 half of the seam is pulled forward and pinned.

- **Format:** **`v2.<rootKeyId>.<tenantKeyId>.<iv>.<ct>.<tag>`** (base64url segments; AES-256-GCM, 96-bit random IV, 128-bit tag, unchanged primitives).
- **AAD:** **`tenantId:model:rowId:field`** — v1's location binding *plus the row id*, so a ciphertext copied between rows of the same model and tenant also fails authentication (row-swap and tenant-swap both tested). Convention (normative strings in `DATA_MODEL.md` §4): `model` = the physical snake_case table name, `rowId` = the primary key of the row that stores the ciphertext, `field` = the logical field name without the `Ciphertext` suffix — `tenantId:credential_secret:<id>:secret`, `tenantId:credential_secret:<id>:totp_secret`, `tenantId:rate_card:<id>:amount`; rows are therefore encrypted *after* the id is known (insert with id generated in app code, or two-step in the same transaction).
- **Envelope:** `encrypt(tenantId, model, rowId, field, plaintext)` resolves the tenant's **active `TenantKey`**, unwraps its DEK with the root key named by `rootKeyId`, encrypts with the DEK. One DEK per tenant (per key version); root keys never touch data directly.
- **`TenantKey(tenantId, keyId, wrappedDek, rootKeyId, status {ACTIVE, RETIRING, RETIRED}, createdAt, retiredAt?)`** — `@@unique([tenantId, keyId])`, at most one `ACTIVE` per tenant (partial unique). The wrapped DEK is `v1`-style ciphertext under the **existing env root keyring** (`{rootKeyId: key}` + active pointer). Created lazily on first encrypt for a tenant; **back-filled for existing tenants** before 3V ships. Audit: `tenant_key.created|rotated` (platform-visible; metadata = key ids only).
- **Stated deviation from the original v2 seam:** the DEK is wrapped by the **env root keyring, not by KMS**. Per-tenant DEKs are the part that pays now (tenant-scoped rotation, tenant erasure = retire the DEK, blast-radius bound per tenant); KMS root custody is the part that costs (an AWS account, IAM, latency, another processor row) and buys little while one operator holds Vercel admin anyway. **KMS stays the next step**: `rootKeyId` already names the wrapping key, so moving root custody to AWS KMS eu-north-1 is a re-wrap of `TenantKey` rows only — ciphertext is untouched. Recorded in §9.2 as "pre-announced when adopted".
- **Rotation, two levels:** root rotation = re-wrap every `TenantKey` (cheap, no data rewrite); tenant DEK rotation = new `TenantKey` ACTIVE, old → RETIRING, background job re-encrypts that tenant's rows, old → RETIRED when unreferenced. Both are ordinary jobs, both audited.
- **v1 stays decryptable** (`v1.` prefix dispatches to the v1 path with the v1 AAD); new writes are v2 only; the two existing v1 fields (member/platform TOTP secrets) migrate opportunistically on next write and by a one-off job before Phase 3V. Tests (Phase 1b): v2 round-trip; AAD mismatch (row swap, tenant swap, field swap) fails; v1 decrypts; unknown version/rootKeyId fails closed.
- Loss model unchanged: losing the root keyring loses every tenant's DEK and therefore the data — the offline copy runbook above now covers *every* vault, so it is rehearsed before 3V ships (restore drill, §11).

**What is encrypted — and what is not (one-way door: decide per field before data exists):**

| Data | Encrypted? | Why |
|---|---|---|
| TOTP secrets (member + platform stack; the Contact stack has none in v1 — contact MFA is v2, §3.5) | **Yes** | Verification needs recoverable plaintext; a dump must not yield MFA seeds. (Backup codes: **hashed**, verify-only.) |
| Integration credentials — future Fortnox/Google refresh tokens, SMTP creds (v2 entities) | **Yes** | Bearer secrets for third-party systems. |
| Tenant payment details stored for invoice rendering (bankgiro/IBAN fields) | **Yes** | Never searched; cheap to protect. |
| Personnummer-typed fields (none stored in v1; BankID `ContractSignature` evidence is v2) | **Yes** | Sensitive national ID; minimize + encrypt + retention-bound. |
| `Client.orgNr` / VAT IDs | **No** | Needed for invoice rendering, dedupe, VIES lookup; org numbers are public registry data (Bolagsverket). **Documented caveat:** an enskild firma's orgnr *is* the owner's personnummer — recorded in the ROPA as personal data processed under the tenant's instruction; it appears on lawful invoices regardless. |
| Names, emails, addresses, notes, ~~Issue~~ WorkItem/Comment text *(2026-08-16)*, Invoice contents, Project metadata | **No** | Search/sort/filter must work (encryption kills ORDER BY/LIKE/range forever; blind indexes restore only exact match and leak equality). GDPR Art. 32 requires *appropriate* measures, not blanket encryption — compensating controls: disk encryption, RLS, authz, audit, minimization. |

**ContinuityBox contents are explicitly *not* in this scheme** — they get the stronger client-side model (age + Shamir 2-of-3, decision #1) precisely because the platform must be unable to decrypt them (T7). This service protects data *from a dump*; the box protects data *from us*.

### 6.2 Encryption inventory — additions *(added 2026-08-16 — decisions 11 & 12; the ROPA encryption inventory (§9.5) is this table plus the one above)*

| Data | Phase | Encrypted? | Format / AAD | Why |
|---|---|---|---|---|
| `RateCard.amountCiphertext` (COST cards only; BILL amounts stay plaintext `Decimal`) | 2T | **Yes** | v2, AAD `tenantId:rate_card:<id>:amount` | Internal cost rate = salary-grade personal data (§9.7). Encrypted **on the card only**; `TimeEntry` stores `costRateCardId`, never the amount; aggregation decrypts a handful of cards behind `rate:view_cost` ✦ + recent MFA. Never in CSV by default, audit metadata, or any portal-reachable row. |
| `CredentialSecret.secretCiphertext` (password / key / JSON secret fields) | 3V | **Yes** | v2, AAD `tenantId:credential_secret:<id>:secret` | The vault's reason to exist. Class-A row, 1:1 with class-B `CredentialItem` metadata; a contact principal cannot SELECT it even for a CLIENT_VISIBLE item; Prisma `omit` keeps it out of every list/detail select. |
| `CredentialSecret.totpSecretCiphertext` (per-item TOTP seed) | 3V | **Yes** | v2, AAD `tenantId:credential_secret:<id>:totp_secret` | Codes generated server-side on `…/totp` (audited `credential.totp_generated`); the seed is never returned. |
| `CredentialVersion` payloads (last N) | 3V | **Yes** | v2, AAD `tenantId:credential_version:<id>:<field>` | History carries the same secrets. |
| `CredentialShareLink` token | 3V | **Hashed** (random part), not encrypted | — | Verify-only, like invite tokens. `tenantId` prefix is plaintext by design (§5.1). |
| Email-OTP codes (share links, later contact flows) | 3V | **Hashed**, TTL-bound | — | Verify-only. |
| `PushSubscription` keys (`p256dh`, `auth`) | 5 | **Yes** | v2, AAD `tenantId:push_subscription:<id>:keys` | Bearer material for a device endpoint; payloads are content-free anyway (§9.2). |
| Integration credentials (Bokio/Fortnox tokens, SES/SMTP), BankID evidence | 4 / v2 | **Yes** | v2 | As already listed above; now v2 by default. |
| `TimeEntry`, `ProjectBudget`, `ProjectTimeSummary`, `WorkItem`, `Comment`, `ProjectUpdate` bodies, `search_index` | 2W–3 | **No** | — | Same rationale as business data above: rollups/search/sort must work; protected by RLS + scoping + visibility + audit. `TimeEntry` is class A (no `visibility` column) — never portal-reachable. |
| Staff notice acknowledgments, `Member.workCountry/timezone` | 2T | **No** | — | Needed for gating and locale; low sensitivity. |

### 6.3 Vault threat model — what server-side encryption does and does not promise *(added 2026-08-16 — decision 12; CP4)*

**The honest sentence, for the DPA and ROPA:** *Fortleva's credential vault uses server-side envelope encryption; the platform operator holds the root keys and can, technically, decrypt stored credentials. Access is procedurally controlled (audit, MFA step-up, no support backdoor) and every reveal is logged to the tenant.* This is the same posture §1 item 5 and T7 already state for all non-box data — the vault simply makes it worth repeating in the DPA vault annex, the ROPA, and the marketing rule (§9.3): only the ContinuityBox may be described as "Fortleva cannot read it".

**Why E2EE was rejected (recorded once, so it is not re-litigated at CP4):** a passphrase/E2EE vault removes the operator from the threat model but (a) breaks server-side TOTP generation, share links with OTP, portal credential submission, search over credential metadata, and export-on-offboarding; (b) turns "forgot the passphrase" into permanent data loss for a 3–15 person agency with no key-management discipline — Infisical dropped its E2EE mode, IT Glue's Vault is a documented support burden; (c) still leaves the *browser* as the decrypting endpoint under our JS, which is not materially stronger than server-side against a compromised operator. The ContinuityBox already offers the E2EE tier where it matters (rare, high-stakes, offline card). E2EE vault stays on the skip list; the seam is not designed for it.

**Mitigations (all procedural except the first two — and all tested before UI, no exceptions):**

| Mitigation | Mechanism |
|---|---|
| AAD-bound ciphertext | `tenantId:model:rowId:field` — a copied ciphertext is unusable in any other row/tenant; a dump yields nothing without root keys (§6.1). |
| Per-tenant DEK | Blast radius per tenant; tenant erasure = retire the DEK; rotation without a global rewrite. |
| Class split + `omit` | Ciphertext lives on class-A `CredentialSecret`, never on the class-B metadata row; portal principals cannot SELECT it; Prisma `omit` keeps it out of every default select (belt two); secrets never in `search_index`, never in logs (log-scrub test). |
| MFA step-up | `credential:reveal` ✦ + `requireRecentMfa(vault.stepUpMinutes=10)`; share/export/visibility-change always step up (§3.5). |
| Audited reveal, one field at a time | Reveal, Copy and TOTP are separate calls, each decrypting **one** field and writing `credential.revealed|copied|totp_generated` in the same transaction; metadata = credential id + field name, never the value. Masked by default in every UI. |
| Per-member reveal budget | `vault.revealBudgetPerHour` (30) — exceeding ⇒ deny + `vault.reveal_budget_exceeded`; fails closed to a Postgres counter (§4). Bulk exfiltration by a legitimate member is slow and loud. |
| No support backdoor | Impersonation is read-only and never reaches ciphertext (§8) — a platform admin sees `CredentialItem` metadata, never a reveal; there is no platform-plane decrypt endpoint. Operator decryption would require running code against the root keyring outside the product, which is exactly what the DPA sentence discloses. |
| Offboarding rotation flags | Removing a member flags every credential they revealed in the last 90 d as "needs rotation" (`credential.rotation_flagged`); the tenant rotates at the source system. |
| Export | `credential:export` ✦ (CEO), audited, produces the tenant's secrets in a documented format — the vault is never a lock-in. |
| Tests before UI | DB dump contains no plaintext; AAD mismatch fails; reveal without recent MFA ⇒ `MFA_REQUIRED`; budget exceeded ⇒ deny + audit; contact principal ⇒ 0 rows on `credential_secret`; share-link view-once atomic under concurrency; `withPlatform` unreachable from portal routes; TOTP vectors. |

---

## 7. Append-only audit log (§9) — summary

Full schema in `DATA_MODEL.md`; capture points per permission in `AUTHZ.md`. Security-relevant commitments:

- **One event model, two audiences** (§9): single `AuditEvent` table; write-time `visibility` enum (`TENANT | PLATFORM`) fixed by a **static event catalog**, never ad hoc. Tenant activity page = `tenantId = ? AND visibility = 'TENANT'`; platform log = everything. Fields include `actorType (MEMBER|CONTACT|PLATFORM_ADMIN|SYSTEM)`, `impersonatorId`, `requestId`, DB-side `now()`.
- **Capture:** explicit `audit.record()` inside the same `$transaction` as the mutation. Prisma `$extends` auto-capture rejected — documented rollback/transaction bugs ([prisma#20016](https://github.com/prisma/prisma/discussions/20016)), and CRUD noise isn't a tenant-readable feed.
- **Append-only enforcement:** the runtime DB role has **no UPDATE/DELETE on `AuditEvent`** (`REVOKE`), plus a `BEFORE UPDATE OR DELETE` raise-exception trigger. Neon's default role is owner-equivalent, so the restricted runtime role is created in Phase 1 with separate migration credentials (`DATABASE_URL` restricted, `DIRECT_URL` owner) — retrofitting role hygiene is fiddly.
- **Must-capture events** (§9 + SOC 2/CNIL practice): login success/failure (all three planes), MFA enable/disable, password/email change, **impersonation start/stop with both identities**, role/permission grants+revocations, Member/Contact invites and removals, `MemberClient`/`MemberProject` assignment changes, entitlement/plan changes, TenantPreference module toggles, data exports and report generation, **file download-URL issuance**, visibility flips (internal ↔ client_visible), Contract issuance/signature events, Invoice issuance/credit, GDPR requests, platform access to tenant data, and **every ContinuityBox lifecycle event** (seal, reseal, share events, open request, veto, open, download issuance).
- **Retention** (documented in the ROPA; [CNIL's 6–12-month guidance](https://www.cnil.fr/fr/la-cnil-publie-une-recommandation-relative-aux-mesures-de-journalisation) is the only concrete EU-DPA number; IMY publishes none — what matters is a documented, enforced schedule): auth/session/download events **12 months**; role/permission/entitlement/impersonation/export events **24 months**; ContinuityBox events retained for the life of the box + 24 months (evidentiary; final word to the lawyer list). Enforced by a Vercel cron job under a privileged role (pg_cron doesn't fire on scale-to-zero).
- **GDPR erasure vs. audit integrity:** erasure requests **pseudonymize the actor and keep the event** — identity row deleted/anonymized, `actorId` becomes an opaque pseudonym, `ip`/`userAgent` nulled, action/target/timestamps retained. Audit rows are never cascade-deleted inside the retention window.
- **Minimization:** `metadata` never contains plaintext of encrypted fields, document contents, or full before/after dumps of personal data. *(Amended 2026-08-16.)* Nor a **cost-rate amount** (even aggregated — `rate_card.cost_revealed` records that a decrypt happened, per session), nor a credential value (`credential.*` metadata = id + field name).
- **Must-capture additions** *(added 2026-08-16 — work-management plan; full catalog in `AUTHZ.md`/`DATA_MODEL.md`)*: WorkItem/Comment `visibility_changed` and bulk visibility changes; `project.portal_enabled|disabled|hours_sharing_changed`, `project.viewed_as_contact`; `project_update.published|archived|visibility_changed`; portal-brokered writes (`portal.request_created|comment_created|task_completed`); `time.exported`, `time_entry.locked|unlocked|repriced|edited_by_other`, `rate_card.created|closed|cost_revealed`, `staff_notice.published|acknowledged`; **every** `credential.revealed|copied|totp_generated|shared|share_viewed|share_revoked|exported|visibility_changed|rotation_flagged`, `tenant_key.created|rotated`, `vault.step_up_required|reveal_budget_exceeded`; `search.index_rebuilt`; system jobs write **one summary `job.run` event per run** (TENANCY §12), not one per row. Routine field edits go to `WorkItemActivity`, not `AuditEvent`.
- **Member self-access** *(added 2026-08-16 — §9.7)*: a member can read the audit rows *about them* (actor or target = self) through the tenant activity page — Art. 15 assistance is a query, not a ticket.

---

## 8. Platform support access and impersonation (§7)

"Support access is not a backdoor." Mechanics via the Better Auth `admin` plugin; **policy is ours and stricter**:

| Rule | Enforcement |
|---|---|
| Exceptional + reason-logged | Impersonation start requires a reason category + free text; recorded in the `AuditEvent` (`impersonation.started`, both identities). |
| Time-boxed | Impersonation session auto-expires ≤ 60 min; no renewal without a fresh start + reason. |
| Read-only, unconditionally (v1) | The impersonated session's resolved permission set is intersected with a read-only mask server-side. **v1 offers no write elevation at all — no write-mode flag exists** (`AUTHZ.md` §9). There is nothing to toggle, so there is no toggle to misuse, and the DPA/impersonation audit only ever has to describe reads. **v2** (only if support reality demands it): scoped write elevation as a separate start-time flag with its own reason, separately audited, and visually loud — `AUTHZ.md` §9 owns that decision. |
| Tenant-visible | Impersonation events are `visibility = TENANT` — the tenant sees every start/stop in their own audit log, with duration and reason category. Nothing platform-initiated inside a tenant is invisible to that tenant. |
| Separate from ordinary administration | The platform plane operates on aggregates (usage, health, billing state) without entering tenant data; impersonation is the *only* path to tenant-plane reads, so the audit trail is complete by construction. |
| UI honesty | Persistent banner during impersonation; impersonator cannot dismiss it. |
| Lawful basis | Documented in the DPA: support access is processing on the tenant's documented instruction (Art. 28), scoped by these rules; the ROPA references it (§9.5). |

---

## 9. GDPR posture (§9)

### 9.1 Controller/processor chain

| Data | Controller | Our role |
|---|---|---|
| Client/Contact personal data, project/invoice/box contents entered by a tenant | **Tenant** (or processor for *their* clients — their problem to classify) | **Processor** (Art. 28). We process only on documented instruction; the DPA is the instruction. |
| Member/User account data, tenant billing data, platform audit + security logs, rate-limit state | **Platform** (us) | Controller (contract performance / legitimate interest in securing the service). |

Deliverables (Phase 7 at the latest; drafted under the planned lawyer engagement): a standard, non-negotiated **DPA** offered to every tenant covering the Art. 28(3) clauses — documented instructions, confidentiality, Art. 32 measures (this document is the technical annex), sub-processor authorization with **30-day advance notice** of changes, DSR assistance (§9.4), breach notification (§9.5), deletion/return on termination (§10) — plus the published sub-processor list below.

### 9.2 Sub-processor list (v1) — with honest transfer notes

| Sub-processor | Function | Residency reality | Transfer mechanism / note |
|---|---|---|---|
| Vercel Inc. (US) | Hosting, serverless compute | Functions pinned to EU regions (fra1/arn1); **edge network is global** — TLS termination and request routing can transit non-EU POPs; no customer data at rest | [DPA](https://vercel.com/legal/dpa) + SCCs/DPF. Honest note: EU *compute pinning*, not full EU processing. |
| Neon (a Databricks company, US parent) | Postgres — all app + identity data | **Data at rest: Frankfurt `aws-eu-central-1`** (the only true-EU Neon region; London is UK). Region immutable per project — created correctly on day one. | DPA + SCCs. US parent ⇒ CLOUD Act reachability in principle (equally true of AWS/GCP/Azure). |
| Cloudflare Inc. (US) | R2 object storage | **Stored objects guaranteed in-EU** ([EU jurisdictional restriction](https://developers.cloudflare.com/r2/reference/data-location/)); control-plane/API metadata may be processed via US infrastructure (Enterprise data-localization not purchased) | DPA + SCCs/DPF. Box blobs additionally client-side encrypted ⇒ provider jurisdiction nearly irrelevant for them. |
| Stripe Payments Europe / Stripe Inc. (US) | Tenant subscription billing (platform-side) | **Payment and billing data is processed in the US**; card data never touches our infrastructure | [Stripe DPA](https://stripe.com/legal/dpa) + SCCs. "EU residency" is **never** claimed for payment data. |
| Upstash Inc. (US) | Rate-limit counters | Redis in EU region; keys are HMAC-hashed identifiers only (§4) | DPA + SCCs. Deliberately minimized to near-zero personal data. |
| Amazon Web Services (AWS EMEA SARL, Luxembourg — US parent) — **Amazon SES** | Transactional email: invites, notifications, continuity alerts | **Sent from and stored at rest in `eu-central-1` (Frankfurt)** — the same region as Neon, which runs on the same AWS substrate. Email inherently leaves EU control at the *recipient's* mail server regardless of provider. | [AWS GDPR DPA](https://aws.amazon.com/compliance/gdpr-center/) (incorporated into the AWS Customer Agreement) + SCCs. US parent ⇒ CLOUD Act reachability in principle, as for Neon. Hard rule: **no key material, credentials, or box contents in email, ever.** |
| (v2, pre-announced when adopted) AWS KMS eu-north-1; attachmentAV; Idura (BankID signatures — evidence contains personnummer, EU storage, minimized) | — | — | Added to the list with 30-day notice per DPA. |

**To be added when the introducing phase lands** *(added 2026-08-16 — work-management plan; each row moves into the table above, with 30-day DPA notice, in the phase that ships it — never before, so the published list stays exactly true)*:

| Sub-processor / outbound endpoint | Introducing phase | What leaves our infrastructure | Residency / note |
|---|---|---|---|
| **Apple Push Notification service (Apple), Firebase Cloud Messaging / Google, Mozilla autopush** — Web Push (VAPID) | 5 (opt-in per member) | The browser-issued **push endpoint URL + an opaque subscription id**; payloads are **content-free** ("You have new activity in Fortleva" + a deep-link id — never a title, comment, client name or amount). Subscription keys encrypted at rest (§6.2). | Endpoints are chosen by the user's browser vendor and are **US-operated global services**; a member who opts in accepts that their device token transits them. Personal data content: none beyond "this device is a Fortleva user". Listed as a sub-processor for honesty even though the payload is opaque. |
| **Have I Been Pwned range API** (Troy Hunt / Cloudflare) — breached-password check for vault items | later (vault, behind a preference; not 3V) | The **first 5 hex chars of a SHA-1 hash** of a candidate password (k-anonymity range query); the password itself never leaves the process. | US/global CDN. No personal data by construction; the prefix is not reversible. Preference default **off** until enabled by the tenant. |
| **RDAP registries** (ICANN-accredited registry/registrar RDAP servers, per TLD) — domain expiry auto-check | later (`AssetCheck`, not 3V) | The **domain name** of a `ClientAsset(type DOMAIN)`. | Whichever registry operates the TLD (IIS for `.se`, Verisign for `.com`, …). A domain name is public data but *the fact that this tenant asked about it* is a weak signal — checks are batched from a fixed egress, never per-user. |
| **Riksbank SWEA API** (Sveriges riksbank) — FX rates for SEK totals on non-SEK invoices | 4 | A currency pair + date. **No personal data.** | Swedish public authority; EU. Cached daily; listed for completeness of the outbound inventory, not as a processor. |
| **Bokio / Fortnox APIs** — accounting export connectors | 4 (v1.5/v2 connectors) | Invoice data the tenant explicitly pushes (customer name, org nr, lines) — the tenant's own data on the tenant's instruction, under *their* processor contract with the accounting vendor. | Sweden/EU. Tokens field-encrypted (§6.2). Fortleva is the tenant's *försystem* (§9.6). |
| **SES inbound receiving** (AWS eu-central-1) — reply-by-email / email-in | 5 (behind entitlement `work.email_intake`, only if wanted) | Nothing new leaves; inbound MIME **arrives** and is stored 30 d (§10). | Same AWS row as above; extends its function description. |

### 9.3 What "EU residency" claims may honestly say

Permitted:
- "All customer data **at rest** is stored in the EU — database in Frankfurt, files in an EU-jurisdiction bucket, cache state in an EU region."
- "Application compute is pinned to EU regions."
- "Continuity box contents are **end-to-end encrypted; Fortleva cannot read them**" — the one claim that is cryptographic rather than contractual (decision #1).

Not permitted:
- "All processing occurs in the EU" — false: Vercel's global edge handles TLS/routing metadata; Stripe processes billing data in the US; email transits the ESP.
- "Your data is beyond the reach of US law" — false for every US-parent provider regardless of region; our mitigations are minimization, encryption, and — for the box — client-side crypto.
- Any unqualified "GDPR-compliant" badge-waving; the honest formulation is "EU data-at-rest residency, EU processors where available, SCC/DPF-covered US sub-processors listed here."

Marketing copy touching residency is diffed against the sub-processor list on every change (a checklist item, not a hope).

*(Amended 2026-08-16 — decisions 11 & 12.)* Two more sentences join the same diff-on-every-change rule, because each is a factual claim about the product that a single feature could falsify:
- **Vault:** "Fortleva encrypts stored credentials; Fortleva's operator holds the keys and could technically decrypt them; every reveal is logged to you." Never "zero-knowledge", never "we cannot read your passwords" — that phrasing is reserved for the ContinuityBox (§6.3).
- **Time:** "**Fortleva records only time your staff report themselves; it does not capture screenshots, keystrokes, browsing or idle time.**" This is the DPA annex sentence (§9.7) and the marketing sentence, verbatim. It is diffed against the feature list — specifically the never-list — on every release; if a feature would falsify it, the feature does not ship (§9.7).

### 9.4 Data-subject rights plumbing

- **Export paths (per §9, also platform-continuity assets):** per-**Tenant** full export (JSONL per entity + all files + manifest with schema version) and per-**Client** package (that client's projects, invoices, contracts, files, issues) — both self-serve, permission-gated, audited. These serve Art. 15/20 assistance obligations and offboarding. *(Amended 2026-08-16.)* Plus a per-**Member** self-export of own time entries and audit rows about them (§9.7.3, no permission beyond `time:track`), and vault export behind `credential:export` ✦ (§6.3); "issues" now reads WorkItems/comments/updates.
- **Erasure:** per-Contact and per-Client erasure flows with carve-outs applied automatically: issued Invoices retained (BFL, §9.6 — legal obligation, Art. 6(1)(c) via the tenant's duty), `AuditEvent` pseudonymization not deletion (§7), signed Contracts retained for the contract's evidentiary life (lawyer question).
- **Responsibility split:** data subjects of a tenant's clients address the **tenant** (controller); we assist within DPA SLAs. Subjects of platform-controlled data address us.

### 9.5 ROPA and breach handling

- **ROPA** maintained from Phase 1 (Art. 30(1) as controller, 30(2) as processor — the small-company exemption doesn't apply: processing is not occasional): purposes, categories, sub-processors, retention schedules (§7, §10), the encryption inventory (§6), the named patch-cadence owner (§3.2).
- **Breach:** as processor, notify affected tenant controllers **without undue delay** after awareness (internal target ≤ 24 h); as controller, notify IMY within 72 h where required (Art. 33) and subjects where high-risk (Art. 34). One runbook, one contact path, tested annually. DPO: assessed as not required at this scale/profile (lawyer to validate); a named privacy contact is published regardless.

### 9.6 Swedish bookkeeping notes for the ToS (BFL)

Invoices issued in Fortleva are the tenant's **räkenskapsinformation** under [Bokföringslagen (1999:1078)](https://www.riksdagen.se/sv/dokument-och-lagar/dokument/svensk-forfattningssamling/bokforingslag-19991078_sfs-1999-1078/): 7-year retention (7 kap. 2 §), stored in Sweden by default. **7 kap. 3a §** permits machine-readable storage in another EU country if **Skatteverket is notified** of the location, immediate electronic access is granted, and printouts in Sweden are possible ([BFN FAQ](https://www.bfn.se/fragor-och-svar/arkivering/)). Our database is in Frankfurt, so ToS/onboarding must: (a) surface the tenant's notification duty in plain Swedish; (b) position the tenant's own accounting system as the archival source of truth, with Fortleva as a *försystem*; (c) promise export (PDF/CSV + JSONL) at any time and at offboarding. The platform's own Stripe records fall under the same law on our side. *(Amended 2026-08-16.)* **Invoiced time entries** are räkenskapsinformation too — the underlying record of an invoice line (BFL 7 kap. 2 §, 7 y) — hence retention class R1 in §10 and the "member pseudonymised, entry kept" erasure rule; whether *per-task* entries not yet invoiced share that status is a lawyer question (§13).

### 9.7 Employee time data & monitoring posture *(added 2026-08-16 — decision 11 reverses the time-tracking skip; this section is the legal spine of Phase 2T)*

Time tracking (decision 11) makes Fortleva a processor of **employee** personal data on behalf of every tenant — a different regulatory object from client/project data. The posture in one line: **tidsredovisning, never övervakning.** Everything below follows from that line.

**9.7.1 Lawful basis and why consent is not it**
- A member's own start/stop of a timer, manual entries, and manager-visible totals per project are processed under **Art. 6(1)(b)** (necessary for the employment contract — reporting worked/billable time is part of the job) and **Art. 6(1)(f)** (the tenant's legitimate interest in billing clients, planning capacity and knowing profitability). Purposes are declared to staff as exactly **billing / planning / profitability — explicitly *not* performance evaluation** — and `StaffNotice.purposes[]` records that declaration.
- **Consent is not a valid basis in the employment relationship** (IMY guidance on kontroll och övervakning i arbetslivet; Art. 29 WP Opinion 2/2017: the power imbalance means consent is not freely given). Fortleva therefore never asks a member to "consent" to time tracking; it *informs* and records **acknowledgment** (`StaffNoticeAcknowledgment`), which is notice, not consent.
- **Sweden has no Art. 88 statute.** Unlike e.g. Germany, no national law specifies employee-data processing; the vehicles are the GDPR itself, IMY guidance, and **collective agreements** (Art. 88 expressly allows them). Hence the MBL points in 9.7.5 — for a kollektivavtal-bound tenant the agreement, not a statute, is where a "viktigare förändring" is negotiated.
- **Tidsredovisning vs övervakning** (IMY's own distinction): time the employee reports themself, aggregated for billing/planning, is ordinary tidsredovisning — permitted, contract-necessary, no DPIA by default. Systematic capture of activity the employee did not volunteer — what they typed, browsed, when they were idle, where they were — is övervakning: DPIA-mandatory (systematic monitoring of employees is on the Art. 35(3) / IMY list), MBL 11 §-negotiable for kollektivavtal-bound employers, and squarely inside the US notice statutes in 9.7.6. Fortleva is built so that the tenant **cannot cross that line with our software**.

**9.7.2 The never-list — a product invariant, not a roadmap item**
Fortleva will never implement, in any tier, behind any preference or entitlement: **idle detection · screenshots or screen recording · application / URL / keystroke capture · presence or "who is working now" broadcast · per-minute activity heatmaps · leaderboards or hour rankings · geolocation / IP-based location of entries · peer-visible timelines** (a member seeing another member's entries). Also never: reading a member's calendar/mail to auto-fill time, or any "productivity score". Timestamps are server-authoritative but a `TimeEntry` never stores IP, device or location. This list lives in `PLAN.md`'s skip list, here, and in the DPA sentence (§9.3); a feature that would falsify it is refused at design time. Reference tools that ship these (Hubstaff, Timely, Clockify desktop, Time Doctor) are explicitly *not* followed. Rationale beyond law: the products that win with 3–15 person agencies (Harvest, Toggl, Kimai) sell trust to the person holding the timer.

*Amended 2026-08-20 (D1 — shifts).* The self-reported **shift clock (clock-in/out + breaks)** is the same tidsredovisning class — every timestamp is the member's own act. The presence line of the never-list binds it concretely: **no live "who is on shift" surface exists in any tier** (every attendance competitor ships one; the absence is this product's stance) — team views aggregate **closed** shifts only for members other than the viewer, and no query helper selects an open/active flag for another member. Statutory-break handling is **warn-only**: the system never auto-inserts or auto-deducts a break — auto-deduction fabricates records (Personio's API cannot distinguish auto from employee-entered breaks; US auto-deduct case law; German BAG guidance) — a closed span over 5 h without a recorded break simply gets a rast warning badge (ATL).

**9.7.3 Who sees what — deny-default aggregate views**
- Employee: **own** entries and own totals, always (`time:track`); the personal timer is a personal tool.
- Manager (`time:view_team`, inside client/project scope): hours per member per project/week for billing and planning; bill rates and budgets with `rate:view_bill` / `budget:view`. Per-member dashboards are a **management need with a declared purpose**, not a default feed — the tenant enables them knowingly (DPIA-lite checklist, 9.7.7). *2026-08-20 (D1):* the same view carries per-member **day totals** of worked/break time from **closed** shifts (Δ vs `Member.hoursPerDay`); never a live clock state. Row-level detail of another member's day appears only in the explicit, audited correction path (`time:edit_any` → `shift.edited_by_other`), not in the ambient view.
- CEO/finance: cost and margin (`rate:view_cost` ✦, `rate:manage_cost` ✦, recent MFA).
- Contact (portal): **never** an entry, a member name, a per-member figure or a rate — only the class-B `ProjectTimeSummary` when `hoursSharingMode ≠ NONE`, and *(2026-08-20, D3)* explicitly **published `TimeReport` snapshots** (PUBLISHED + CLIENT_VISIBLE + portal-enabled; member-free and INTERNAL-name-folded by construction), CONTACT_PRIMARY only (§5.1).
- Nothing per-member on the `/projects/[key]/team` page beyond open items and estimates; no presence, no "last active".
- **Member self-access + export:** every member can list and export their **own** entries (CSV/JSONL) and read the audit rows about them (§7) without asking anyone — Art. 15/20 handled by a button. Erasure of a member pseudonymises un-invoiced entries per the tenant's HR retention and keeps invoiced ones (BFL, §10).

**9.7.4 Cost rates are salary-grade personal data**
An internal hourly cost rate is a derivative of salary. Therefore: encrypted on the `RateCard` only (§6.2, v2 with row-bound AAD); readable only with `rate:view_cost` ✦ + recent MFA; **never fanned onto `TimeEntry` rows** (entry stores `costRateCardId`; aggregation is `SUM(seconds) GROUP BY cost_rate_card_id` → decrypt a handful of cards); **never in CSV by default** (an explicit "include cost" toggle, ✦, audited `time.exported` with `includesCost=true`); **never in `AuditEvent` metadata**; **never on any portal-reachable row** (`ProjectUpdateInternalSnapshot` is class A precisely so cost never sits beside the portal snapshot). Bill rates are commercial data, not employee data, and stay plaintext on the entry snapshot.

**9.7.5 Staff notice, acknowledgment, and MBL (Sweden)**
- `StaffNotice(locale, version, purposes[], jurisdictionTags[])` + `StaffNoticeAcknowledgment` (unique per member/notice/version). **Timers refuse to start until the member has acknowledged the current version** in their locale (sv/en drafts ship in the seed so 2T is demoable; the tenant can edit and republish — republishing requires re-acknowledgment). Content: what is recorded (self-reported time, task, project, note, billable flag; *2026-08-20:* + self-reported shift clock-in/out and breaks — a recorded break = **rast**, unpaid; paus is working time and is simply not clocked), what is not (the never-list, verbatim — incl. no live on-shift indicator), purposes (billing/planning/profitability **+ working-time records / arbetstidsregistrering** *(2026-08-20)* — explicitly not performance evaluation), who sees what (9.7.3), retention (§10), the member's rights and self-export, the tenant's contact. *The v1 seed text covers shifts from the start — shipping attendance later under a notice that omitted it would force tenant-wide re-acknowledgment.*
- **MBL notes for tenants** (surfaced in the DPIA-lite checklist, plain Swedish): a kollektivavtal-bound employer introducing a new time-recording system should treat it as a possible **MBL 11 §** "viktigare förändring" (primary negotiation duty before the decision); with a union member and *no* kollektivavtal, **MBL 13 §** may still oblige negotiation — **lawyer question** (§13); **MBL 19 §** (information duty to the union) applies to how the data is used. Fortleva provides the notice text and the fact sheet; the negotiation is the tenant's.
- **MBL notes for Naxdor (tenant zero):** the same applies to us before Naxdor's own staff use timers — notice + acknowledgment is a go-live gate for 2T (PLAN.md), and the MBL 13 § check happens if any Naxdor employee is a union member.

**9.7.6 US staff — notice statutes and FLSA**
Tenants with staff in the US (and any future US tenant) get a **one-page electronic-monitoring notice** template — cheap, and the statutes are notice-based, not consent-based: **New York Civil Rights Law §52-c** (written notice + acknowledgment at hire, posted notice, for employers monitoring email/internet/phone — our self-reported timer is arguably outside it, but the notice costs nothing and removes the argument), **Connecticut Gen. Stat. §31-48d** (prior written notice of the types of electronic monitoring), **Delaware 19 Del. C. §705** (one-time notice + acknowledgment). `Member.workCountry` + `StaffNotice.jurisdictionTags[]` select the right addendum. **FLSA**: for non-exempt US staff the tenant must keep accurate time records for **2 years** (29 CFR 516) — the un-invoiced HR retention default is therefore **3 y for US** work countries vs 2 y SE (§10), tenant-configurable upward, never below the statutory floor for that country.

**9.7.7 Tenant-facing artefacts (Phase 2T ships them; Phase 7 packages them)**
- **Notice templates** (sv/en; US addendum) in the seed, editable per tenant, versioned.
- **DPIA-lite checklist** shown when the tenant enables the `time` module and again when enabling **per-member dashboards**: purposes declared? notice published and acknowledged? kollektivavtal / union member (MBL 11 § / 13 §)? US staff (NY/CT/DE notice)? retention chosen? who holds `rate:view_cost`? — with the answers stored on the tenant (`preference.changed` audited) so the tenant can show its own accountability trail.
- **ROPA row** (our processor ROPA and a template row for the tenant's controller ROPA): "Employee working-time records — categories: member identity, project/task, self-reported start/stop/duration, billable flag, note; purposes: client billing, capacity planning, profitability; basis Art. 6(1)(b)/(f); recipients: tenant managers per scope, finance for cost; retention per §10; no automated decision-making; no monitoring."
- **DPA annex sentence**, verbatim and diffed against features on every release (§9.3): "Fortleva records only time your staff report themselves; it does not capture screenshots, keystrokes, browsing or idle time."
- *2026-08-20 (D1):* **Monthly working-time statement** per member (CSV + printable view in 2T; PDF with the Phase-6 stack): per-day start/end/break/worked/Δ + period totals + an övertid/mertid section — usable as the tenant's **ATL §11 arbetstidsjournal** evidence (retention: the journal's calendar year + 2 following years; Denmark's 2024 law — objective/reliable/accessible system, employee self-access, 5-y retention — is the Nordic benchmark the export meets, ahead of a Swedish CCOO transposition). Member self-access to their own statement is a button (Art. 15/20, as 9.7.3).
- Naxdor's own version of all of the above is a 2T go-live gate.

---

## 10. Retention and deletion per entity type (§9)

**Tenant lifecycle (proposal):** cancellation → 30-day read-only export window → suspended-retained → **hard delete at day 90**, with export reminders at each step. Suspension for non-payment keeps data intact and — deliberately — **keeps the ContinuityBox request/open path functional** (settled: the box survives billing lapse; an entitlement that seals the box on a missed invoice defeats the product's reason to exist).

| Entity | Active retention | On Client/Contact offboarding | On tenant offboarding (after grace) | Erasure carve-outs |
|---|---|---|---|---|
| Tenant, TenantPreference, entitlements JSON | Life of tenancy | — | Deleted day 90; billing/accounting records we control kept 7 y (our BFL duty) | — |
| User / Member / MemberRole / assignments | Life of membership | — | Deleted | AuditEvent references pseudonymized (§7) |
| Contact (identity + portal credentials) | Life of portal access | Sessions revoked immediately; identity deleted on request; **card-holding Contact forces box reseal** | Deleted | Audit pseudonymization |
| Client, Project, ProjectVersion, Milestone, Service | Life of relationship | Export package offered; deleted on tenant instruction | Deleted | — |
| Document / FileObject / FileVersion | Life of parent entity | Included in client export | Deleted from R2 + DB (reconciliation verifies) | — |
| Contract / ContractSignature | Contract life + evidentiary period (lawyer question; signature evidence minimized, personnummer encrypted **v2**) | Included in export | Exported then deleted | Evidentiary retention overrides erasure during period |
| InvoiceSeries / Invoice / InvoiceLine | **7 years (BFL)** — never deleted or renumbered while tenancy lives; credit notes, never deletes | Included in export | **Export is a contractual promise**; then deleted — the tenant carries the archive. Paid "archive mode" = open question | **Erasure requests cannot touch issued invoices** (legal obligation) |
| ~~Issue / IssueComment~~ → WorkItem / Comment / WorkItemActivity / ProjectUpdate *(renamed 2026-08-16 — Issue absorbed)*; PerformanceReport | Life of parent (WorkItem archive is explicit, never silent; `autoArchiveMonths?` per project is a tenant choice) | Included in export | Deleted | Author pseudonymized on Contact/Member erasure |
| AuditEvent | 12 mo (auth/downloads) / 24 mo (privileged) / box events life-of-box + 24 mo | Retained per schedule | Tenant-visibility rows deleted with tenant at day 90 **except** ContinuityBox and impersonation events, retained per schedule | Pseudonymize actor, keep event |
| AuditEvent `ip` / `userAgent` *(added 2026-08-16)* | **Pseudonymised (nulled / hashed) at 90 d** by the retention cron; the event itself keeps its 12/24-mo schedule | — | — | Already covered by pseudonymization |

**Rows added 2026-08-16 (decisions 11 & 12; retention classes R1 = bookkeeping, HR = tenant-configurable employee data):**

| Entity | Active retention | On Client/Contact offboarding | On tenant offboarding (after grace) | Erasure carve-outs |
|---|---|---|---|---|
| **TimeEntry — invoiced** (`lockedReason ∈ {INVOICED, BILLED_EXTERNAL}`; `invoiceLineId` set) | **R1 — 7 y (BFL 7 kap. 2 §)**: it is the underlying record of an invoice line | Included in client export; kept | Export is a contractual promise; then deleted — the tenant carries the archive (as for invoices) | **Member erasure pseudonymises `memberId`, keeps the entry** (seconds, project, billable, rate snapshot); note text redacted on request |
| **TimeEntry — un-invoiced** (incl. non-billable, written-off, draft-locked) | **HR class — tenant-configurable; default 2 y (SE work country) / 3 y (US: FLSA 2 y floor + margin)**; never below the statutory floor for `Member.workCountry` | Included in export | Deleted | Member erasure: pseudonymise; delete after HR window |
| **RateCard** BILL | Life of tenancy (immutable rows; closed cards kept — entries reference them) | — | Exported, deleted | — |
| **RateCard COST** (`amountCiphertext`) | **Retained as long as an entry references it** (margin history), encrypted; **exported per member** on Art. 15/20 request (decrypted by a `rate:view_cost` holder, audited) | — | Exported (✦), deleted with the tenant DEK | Member erasure: card kept while entries reference it (pseudonymised member), amount stays encrypted |
| ProjectBudget / BudgetAlert / ProjectTimeSummary | Life of project; summaries recomputed, never authoritative | Included in export | Deleted | — |
| StaffNotice / StaffNoticeAcknowledgment | Life of tenancy (evidence of notice) + the HR window after the member leaves | — | Exported, deleted | Kept while any entry of that member is retained (it is the notice for that data) |
| **Notification** | **90 d** or **500 per receiver** (auto-archive oldest); read/archived rows first | Contact rows deleted with the Contact | Deleted | — |
| **EmailOutbox** | `params` (rendering inputs) **90 d**; delivery metadata (`status`, `sesMessageId`, timestamps) **12 mo** | — | Deleted | Recipient email hashed after `params` purge |
| EmailSuppression | Life of address (bounce/complaint) — platform-owned | — | Retained (platform controller) | — |
| **InboundEmail** (Phase 5, if built) | Raw MIME **30 d** (parsed comment/attachment lives on as WorkItem data) | Included in export | Deleted | — |
| PushSubscription | Until unsubscribed / 3 consecutive endpoint failures | — | Deleted | — |
| CredentialItem / CredentialSecret | Life of client relationship | Included in **client export** (secrets decrypted only via `credential:export` ✦); deleted on tenant instruction | Exported (✦), then deleted; tenant DEK retired ⇒ any stray ciphertext is unrecoverable | — |
| **CredentialVersion** | **Last N versions** (`vault.versionsToKeep`, default 5); older versions hard-deleted on write | With the item | With the item | — |
| CredentialShareLink | TTL ≤ 7 d; consumed/expired rows kept 90 d for audit correlation, then deleted | — | Deleted | Recipient email hashed at expiry |
| ClientAsset / ExpirationReminderSent | Life of client relationship; box auto-fill reads it at seal time | Included in export | Deleted | — |
| TenantKey | Life of tenancy; RETIRED keys kept until no ciphertext references them | — | **Destroyed at day 90** — the cryptographic erasure of every vault/cost ciphertext | — |
| search_index | Derived; rebuilt on demand (`search.index_rebuilt`); no independent retention | Follows source rows | Deleted | Follows source rows |
| ContinuityBox / ContinuityOpenRequest | Life of client relationship; quarterly reseal ritual | Contact change forces reseal | **Survives lapse and offboarding sealed for a defined window — proposed 12 months** (final number in `OPEN_QUESTIONS.md`), then destroyed with notice | Sealed blob is ciphertext; erasure = destroy blob + shares |
| Sessions / Invitations | TTL-bound (§3.6; invites ≤ 72 h) | Revoked | Deleted | — |

**Rows added 2026-08-20 (founder time-tracking extensions — DATA_MODEL §6.15 D1/D3/D5):**

| Entity | Active retention | On Client/Contact offboarding | On tenant offboarding (after grace) | Erasure carve-outs |
|---|---|---|---|---|
| **Shift / ShiftBreak** | **Working-time/HR class — tenant-configurable; default 2 y SE (covers the ATL §11 journal rule: its calendar year + 2 following) / 3 y US**; never below the statutory floor for `Member.workCountry` | — (never client data; class A) | Exported, deleted | Member erasure: pseudonymise `memberId`, keep within the window (working-time-records evidence); note text redacted on request |
| **TimeReport** | Life of project; **published reports gain R1-adjacent retention once referenced by an invoice (Phase 4)** — a published report is a statement the client relied on | Included in client export | Exported, deleted | Snapshot carries no member data by construction — nothing member-level to erase |
| **WorkType** | Life of tenancy (archived rows kept — entries reference them) | — | Exported, deleted | — |

---

## 11. Engineering practices that back the model

- **CI security suites (non-negotiable, §12):** adversarial cross-tenant deny-matrix over all models (DMMF-enumerated, ephemeral Neon branches — `TENANCY.md`); client-scoping and visibility-flag tests; privilege-escalation tests (grant-subset, last-owner, self-escalation); portal invite-only boundary test (§3.4); RLS fail-closed test (no GUC ⇒ zero rows). *(Amended 2026-08-16.)* Plus the cross-cutting tripwires from §5.1 and §6.3: registry posture test, contact-writable census test, portal forbidden-columns grep, "no INTERNAL fact to a Contact" fixtures, search lexeme probe, kind-catalog audience test, `withPlatform` import-boundary test, MFA deny-matrix, catalog count + ✦ set pinned per phase (63 → 80 → 96 → 97 → 108 — *re-based 2026-08-20, AUTHZ §3.2*), AAD-binding and DB-dump-no-plaintext tests, `ProjectTimeSummary == SUM(time_entry)`, one-running-timer, one-open-shift and share-link view-once concurrency tests, and the TimeReport no-member-key / no-INTERNAL-name snapshot fixtures *(2026-08-20)*.
- **Restore drill before 3V** *(added 2026-08-16)*: the root-keyring offline copy is exercised end-to-end (fresh env → decrypt a `TenantKey` → decrypt a vault row) before the first real credential is stored — losing the keyring now loses every tenant's vault, not just TOTP seeds.
- **Secrets:** Vercel env vars only; nothing in the repo; keyring offline copy per §6; R2 token scoped to the one bucket with minimum verbs; runtime vs migrate DB roles separated (§7).
- **Backups/recovery:** Neon PITR window ≥ 7 days; restore drill before Phase 7; R2 reconciliation job doubles as integrity check.
- **Dependencies:** lockfile-pinned; GitHub advisories watched (auth packages exact-pinned, §3.2); monthly update window, ≤ 48 h critical SLA.
- **Pre-GA:** external penetration test before Phase 7 opens tenant self-signup (**v2** budget line).

---

## 12. Pushback notes (§12)

1. **Platform console origin — raised, and resolved in favor of the pushback.** Decision #8 (single app domain v1) covers the *tenant and portal* planes, and plane separation there rides on route groups, distinct `__Host-` cookies, and session audiences. The pushback was to carve the *platform* console onto its own hostname anyway: near-zero cost now, removes the last cookie-adjacency between the most and least privileged planes, and it never gets cheaper. **That is now the decided design** (ARCHITECTURE.md ARC-11, reflected in §2.2/§3.3 above): the console lives on its own host, files are separate by construction via the R2 endpoint, and no item remains open. **Amended by decision #9 (2026-08-05):** the console's own host is `ops.naxdor.com` through Phases 1–6 and becomes a separate registered apex at Phase 7. The pushback's substance — the console is never cookie-adjacent to the app — survives intact via `__Host-` cookies; what is deferred is the registered-domain boundary, with INV-D1 as the compensating control (§2.2). Recorded here rather than deleted so the reasoning survives.
2. **Personnummer scoping (refinement, not disagreement).** The synthesis says "encrypt personnummer." Specced as: personnummer-**typed** fields are always encrypted (none exist in v1; BankID evidence v2), while `Client.orgNr` stays plaintext even though an enskild firma's orgnr numerically equals one — encrypting it breaks search/dedupe/VIES, and it lawfully appears on every invoice anyway. Documented in the ROPA instead (§6). Flagged for the cross-doc reviewer to confirm `DATA_MODEL.md` matches.
3. **Rate-limit fail-open default** (§4) trades a sliver of protection for login availability during a Redis outage; the three fail-closed exceptions are where a missed limit is unacceptable. Fail-closed on logins is a one-constant change if preferred — but it makes Upstash a login-availability dependency. *(Amended 2026-08-16: five fail-closed exceptions now — reveal budget and share-link OTP added.)*
4. **The vault is a liability the founder is choosing** *(added 2026-08-16 — decision 12).* Comparable agency suites (Copilot, Moxie, SuiteDash) ship none. Server-side crypto means the operator can technically decrypt; that is disclosed, not hidden (§6.3, §9.3), and mitigations are procedural and tested before UI. E2EE would remove the risk but breaks search/share/TOTP/portal submission and strands small agencies — rejected once, in writing, so CP4 does not reopen it by accident. Accepted.
5. **Time tracking is a legal object, not just a feature** *(added 2026-08-16 — decision 11).* Self-reported timers are fine; anything captured without the employee's act is övervakning. The never-list (§9.7.2) is deliberately absolute — a future tenant asking for "idle detection like Hubstaff" is told no, and the reason is written here. Cost rates are treated as salary data (encrypted, never on entry rows), which makes the money page slightly slower (decrypt a handful of cards per query) — accepted.
6. **Per-tenant DEK without KMS** *(added 2026-08-16 — §6.1).* Buys tenant-scoped rotation and cryptographic erasure now; leaves root custody in Vercel env as before. KMS is a re-wrap away; recorded so nobody mistakes "per-tenant keys" for "HSM-backed keys" in a sales conversation.
7. **Marketing / DPA sentence rule** *(added 2026-08-16).* Three sentences — residency (§9.3), vault ("operator holds the keys"), time ("records only time your staff report themselves; no screenshots, keystrokes, browsing or idle time") — are treated as **release-gated claims**: each is diffed against the sub-processor list and the feature list on every release, and a feature that would falsify one either changes the sentence with 30-day DPA notice or does not ship. Cheap to run, and it is how "honest by construction" survives a solo founder's memory.

## 13. Items feeding `OPEN_QUESTIONS.md`

Box retention window after tenant churn (proposed 12 mo — C2); paid invoice "archive mode" after offboarding (C15); ESP choice (Resend vs Postmark, EU region) — changes the sub-processor list (B4); continuity-event audit retention + Contract evidentiary period (lawyer list, C9); DPA template source (lawyer, C9); tenant-enforced MFA preference (**v2**, C16). **Not open any more:** the platform-console hostname (pushback #1) is decided — its own host from day 1 per ARC-11 (`ops.naxdor.com` in v1, a separate registered apex from Phase 7, decision #9).

*(Added 2026-08-16 — work-management plan.)* Decisions **11** (time tracking + never-list), **12** (vault module, server-side envelope; box stays pointer-only), **13** (`credential:reveal` seeded CMA ✦) are recorded in `OPEN_QUESTIONS.md`. **Lawyer questions from the legal track — see `OPEN_QUESTIONS.md` (lawyer list), pointer only here:** (a) **MBL 13 §** — does an employer *without* kollektivavtal but *with* a union member have to negotiate before introducing self-reported time tracking? (b) **BFL status of per-task time entries** that are not (yet) invoiced — räkenskapsinformation or not (drives the un-invoiced retention class, §10)? (c) **retention of un-invoiced entries** — is 2 y SE a defensible default, and what is the floor for time records under Swedish arbetstidslag / kollektivavtal? (d) **Art. 15 access to audit rows** — must a member's subject-access request include audit rows where they are the *actor* only, and does that conflict with another subject's data in the same row? (e) whether the **DPA vault annex** ("operator can technically decrypt") needs a separate signature or rides in the standard DPA; (f) whether the **US notice statutes** (NY §52-c / CT §31-48d / DE §705) reach a self-reported timer at all — we send the notice regardless (§9.7.6). Also open: `vault.versionsToKeep` default (5?), HR-class default for other work countries than SE/US, and whether the never-list should be a contractual ToS clause rather than a product invariant only.

# SECURITY.md — Fortleva

**Status:** Phase 0 specification (research + design, no application code). Date: 2026-08-03.
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

**T2 — Malicious or compromised Contact account.** Credential stuffing against the portal; hostile uploads (HTML/SVG/macro documents) via Issue attachments; bulk scraping of client-visible Documents. *Controls:* invite-only — no signup surface to enumerate (§3.4); per-email + per-IP login limits (§4); upload allowlist + `Content-Disposition: attachment` + off-origin downloads (§5); download-issuance audit + limits; offboarding revokes sessions immediately and forces a box reseal if that Contact held the card.

**T3 — Malicious tenant Member (insider).** An employee assigned to three Clients tries to read the other twenty (§3), grant themselves permissions, tamper with the audit trail, or read a sealed box. *Controls:* assignment scoping (`MemberClient`/`MemberProject`), deny-default, `client:view_all` only on owner-equivalent templates (decision #5); escalation guards — grant-subset, no-self-escalation, last-owner — as transactional app code (`AUTHZ.md`); append-only `AuditEvent` under a DB role that cannot UPDATE/DELETE (§7); sealed boxes are ciphertext no Member can decrypt (no share remains with staff after sealing); exports permission-gated and audited.

**T4 — Compromised Member account.** Phished Member with real permissions. *Controls:* mandatory MFA on owner-equivalent roles (§3.5) shrinks the worst case; step-up re-auth for high-risk operations (§3.6); assignment scoping limits blast radius; immediate DB-backed session revocation on password/MFA change; anomalies visible in the tenant's own audit log (§7).

**T5 — Malicious Tenant (the organization).** Invitation spam, malware distribution through client-visible files, a defunct-but-hostile tenant vetoing box opens forever. *Controls:* per-tenant invitation/upload ceilings (§4); scanning path reserved (v2, §5); hostile-veto escalation to platform-mediated dispute (`CONTINUITY_BOX.md`); ToS; suspension does not disable box access (§10).

**T6 — Unauthenticated internet attacker.** Credential stuffing, enumeration, DoS, dependency CVEs. *Controls:* no public signup anywhere in v1 (tenant self-signup arrives Phase 7; Contacts invite-only forever); Vercel DDoS mitigation + free WAF rules as outer shield (§4); uniform "invalid credentials"/neutral invite responses against enumeration; dependency pinning + patch cadence (§3.2, §11).

**T7 — Platform operator / platform compromise (the continuity threat).** The operator — or anyone who fully compromises Vercel env, Neon, and R2 — attempts to read ContinuityBox contents. *Controls:* boxes are encrypted client-side before upload ([age](https://github.com/FiloSottile/age) via [typage](https://github.com/FiloSottile/typage/blob/main/README.md)); key split 2-of-3 ([audited Shamir library](https://github.com/privy-io/shamir-secret-sharing)) — client-held printed card, platform DB share (useless alone), trustee share (decision #1). The platform never holds two shares; key material is never emailed. R2 holds only ciphertext; Neon only metadata. *Honesty:* outside the box, the operator **can** technically read tenant data — that is what a processor is. Those accesses are governed procedurally: impersonation rules (§8), tenant-visible audit (§7), DPA (§9). Only the box carries a cryptographic guarantee; marketing must respect that line.

**T8 — Bulk data-at-rest compromise.** A leaked DB dump/backup or stolen R2 credentials. *Controls:* passwords hashed (Better Auth scrypt); TOTP secrets field-encrypted, backup codes hashed; integration credentials and payment details field-encrypted (§6); box blobs are client-side ciphertext (a dump "does not reveal them", §8); R2 token scoped to the single bucket, minimum verbs; runtime vs migration DB credentials separated (§7). Residual: plaintext business data in a full dump — accepted, mitigated by Neon disk encryption, access control, minimization (§6 rationale).

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

### 3.6 Session policy

Sessions are DB-backed (Better Auth), so revocation is immediate — no JWT revocation hole; permissions are **not** embedded in the session (per-request resolution + per-tenant `permissionsVersion`, see `AUTHZ.md`).

| Plane | Idle timeout | Absolute lifetime | Notes |
|---|---|---|---|
| Platform | 12 h | 7 days | MFA at every fresh login. Impersonation sessions: see §8 (≤ 60 min). |
| Tenant (Member) | 7 days rolling | 30 days | Step-up below. |
| Portal (Contact) | 30 days rolling | 90 days | Longest-lived because lowest-privilege; portal adoption depends on low friction. |

- Cookie flags everywhere: `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, `__Host-` prefix (v1).
- **Step-up ("fresh session") rule:** role/permission changes, Member removal, entitlement-affecting settings, ContinuityBox edits/reseals, data exports, and invoice-series changes require authentication ≤ 15 min old or an interactive re-verify (password or TOTP).
- Revocation triggers: password change, MFA enrollment/removal, Member removed from Tenant, Contact offboarded, platform suspension. All sessions of the principal die in the same transaction.
- CSRF: Better Auth origin checks + `SameSite=Lax` + state-changing operations as POST only. Strict CSP; uploaded or principal-authored content is never rendered inline on app origins (§5).

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
| Issue + IssueComment creation | contact | 20 / h |
| Full tenant export | tenant | 2 / day |
| ContinuityOpenRequest | box | 1 active request; 30-day cooldown after veto (app rule in `CONTINUITY_BOX.md`, not just a limiter) |

**Failure mode:** if Redis is unreachable, limits **fail open with a structured alert** (availability of login beats a perfect limiter, and the WAF shield remains) — **except** ContinuityOpenRequest creation, impersonation start, and export initiation, which **fail closed**: rare, high-stakes, human-retryable.

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

---

## 6. Field-level encryption (§9)

Baseline: Neon encrypts disks; the brief demands more than disk-level (§9). We add an application-layer service for a **short, deliberate list of fields**.

**Service design (own code, ~80 lines over Node `crypto`; spec, not code):**
- AES-256-GCM, random 96-bit IV per operation, 128-bit tag.
- **AAD binds ciphertext to its location**: `tenantId || model || field`, so a ciphertext moved to another row/tenant fails authentication.
- Ciphertext format: **`v1.<keyId>.<iv>.<ct>.<tag>`** (base64url segments). The version + keyId prefix is what makes rotation and the KMS seam cheap later; unversioned ciphertext "becomes archaeology".
- Rejected: [`prisma-field-encryption`](https://github.com/47ng/prisma-field-encryption) (year-stale, pinned ≤ Prisma 6.13, single maintainer), `pgcrypto` (keys travel inside SQL → statement logs / `pg_stat_statements`), per-tenant KMS keys now (cost/complexity, no threat-model payoff at tens of tenants).

**Key custody.**
- **v1:** one 256-bit key in a keyring env var (`{keyId: key}` + active-key pointer) on Vercel. Honest limit: anyone with Vercel project admin can read it — acceptable at one operator, documented in the ROPA.
- A **documented offline copy** of the keyring lives outside Vercel (printed + in the founder's password manager with emergency access), listed in the platform-continuity runbook (`CONTINUITY_BOX.md`). Losing the key is losing the data — written down, owned.
- Rotation: add key N+1 to the keyring, new writes use it, background job re-encrypts old ciphertexts, retire old key when unreferenced.
- **Seam to v2:** the service signature is `encrypt(tenantId, model, field, plaintext)`. v1 ignores `tenantId` for key selection; v2 selects a per-tenant DEK wrapped by one KMS root key (AWS KMS eu-north-1 Stockholm, ~$1/mo + pennies). Ciphertext format already carries `keyId`, so migration is incremental, not a rewrite.

**What is encrypted — and what is not (one-way door: decide per field before data exists):**

| Data | Encrypted? | Why |
|---|---|---|
| TOTP secrets (member + platform stack; the Contact stack has none in v1 — contact MFA is v2, §3.5) | **Yes** | Verification needs recoverable plaintext; a dump must not yield MFA seeds. (Backup codes: **hashed**, verify-only.) |
| Integration credentials — future Fortnox/Google refresh tokens, SMTP creds (v2 entities) | **Yes** | Bearer secrets for third-party systems. |
| Tenant payment details stored for invoice rendering (bankgiro/IBAN fields) | **Yes** | Never searched; cheap to protect. |
| Personnummer-typed fields (none stored in v1; BankID `ContractSignature` evidence is v2) | **Yes** | Sensitive national ID; minimize + encrypt + retention-bound. |
| `Client.orgNr` / VAT IDs | **No** | Needed for invoice rendering, dedupe, VIES lookup; org numbers are public registry data (Bolagsverket). **Documented caveat:** an enskild firma's orgnr *is* the owner's personnummer — recorded in the ROPA as personal data processed under the tenant's instruction; it appears on lawful invoices regardless. |
| Names, emails, addresses, notes, Issue text, Invoice contents, Project metadata | **No** | Search/sort/filter must work (encryption kills ORDER BY/LIKE/range forever; blind indexes restore only exact match and leak equality). GDPR Art. 32 requires *appropriate* measures, not blanket encryption — compensating controls: disk encryption, RLS, authz, audit, minimization. |

**ContinuityBox contents are explicitly *not* in this scheme** — they get the stronger client-side model (age + Shamir 2-of-3, decision #1) precisely because the platform must be unable to decrypt them (T7). This service protects data *from a dump*; the box protects data *from us*.

---

## 7. Append-only audit log (§9) — summary

Full schema in `DATA_MODEL.md`; capture points per permission in `AUTHZ.md`. Security-relevant commitments:

- **One event model, two audiences** (§9): single `AuditEvent` table; write-time `visibility` enum (`TENANT | PLATFORM`) fixed by a **static event catalog**, never ad hoc. Tenant activity page = `tenantId = ? AND visibility = 'TENANT'`; platform log = everything. Fields include `actorType (MEMBER|CONTACT|PLATFORM_ADMIN|SYSTEM)`, `impersonatorId`, `requestId`, DB-side `now()`.
- **Capture:** explicit `audit.record()` inside the same `$transaction` as the mutation. Prisma `$extends` auto-capture rejected — documented rollback/transaction bugs ([prisma#20016](https://github.com/prisma/prisma/discussions/20016)), and CRUD noise isn't a tenant-readable feed.
- **Append-only enforcement:** the runtime DB role has **no UPDATE/DELETE on `AuditEvent`** (`REVOKE`), plus a `BEFORE UPDATE OR DELETE` raise-exception trigger. Neon's default role is owner-equivalent, so the restricted runtime role is created in Phase 1 with separate migration credentials (`DATABASE_URL` restricted, `DIRECT_URL` owner) — retrofitting role hygiene is fiddly.
- **Must-capture events** (§9 + SOC 2/CNIL practice): login success/failure (all three planes), MFA enable/disable, password/email change, **impersonation start/stop with both identities**, role/permission grants+revocations, Member/Contact invites and removals, `MemberClient`/`MemberProject` assignment changes, entitlement/plan changes, TenantPreference module toggles, data exports and report generation, **file download-URL issuance**, visibility flips (internal ↔ client_visible), Contract issuance/signature events, Invoice issuance/credit, GDPR requests, platform access to tenant data, and **every ContinuityBox lifecycle event** (seal, reseal, share events, open request, veto, open, download issuance).
- **Retention** (documented in the ROPA; [CNIL's 6–12-month guidance](https://www.cnil.fr/fr/la-cnil-publie-une-recommandation-relative-aux-mesures-de-journalisation) is the only concrete EU-DPA number; IMY publishes none — what matters is a documented, enforced schedule): auth/session/download events **12 months**; role/permission/entitlement/impersonation/export events **24 months**; ContinuityBox events retained for the life of the box + 24 months (evidentiary; final word to the lawyer list). Enforced by a Vercel cron job under a privileged role (pg_cron doesn't fire on scale-to-zero).
- **GDPR erasure vs. audit integrity:** erasure requests **pseudonymize the actor and keep the event** — identity row deleted/anonymized, `actorId` becomes an opaque pseudonym, `ip`/`userAgent` nulled, action/target/timestamps retained. Audit rows are never cascade-deleted inside the retention window.
- **Minimization:** `metadata` never contains plaintext of encrypted fields, document contents, or full before/after dumps of personal data.

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

### 9.4 Data-subject rights plumbing

- **Export paths (per §9, also platform-continuity assets):** per-**Tenant** full export (JSONL per entity + all files + manifest with schema version) and per-**Client** package (that client's projects, invoices, contracts, files, issues) — both self-serve, permission-gated, audited. These serve Art. 15/20 assistance obligations and offboarding.
- **Erasure:** per-Contact and per-Client erasure flows with carve-outs applied automatically: issued Invoices retained (BFL, §9.6 — legal obligation, Art. 6(1)(c) via the tenant's duty), `AuditEvent` pseudonymization not deletion (§7), signed Contracts retained for the contract's evidentiary life (lawyer question).
- **Responsibility split:** data subjects of a tenant's clients address the **tenant** (controller); we assist within DPA SLAs. Subjects of platform-controlled data address us.

### 9.5 ROPA and breach handling

- **ROPA** maintained from Phase 1 (Art. 30(1) as controller, 30(2) as processor — the small-company exemption doesn't apply: processing is not occasional): purposes, categories, sub-processors, retention schedules (§7, §10), the encryption inventory (§6), the named patch-cadence owner (§3.2).
- **Breach:** as processor, notify affected tenant controllers **without undue delay** after awareness (internal target ≤ 24 h); as controller, notify IMY within 72 h where required (Art. 33) and subjects where high-risk (Art. 34). One runbook, one contact path, tested annually. DPO: assessed as not required at this scale/profile (lawyer to validate); a named privacy contact is published regardless.

### 9.6 Swedish bookkeeping notes for the ToS (BFL)

Invoices issued in Fortleva are the tenant's **räkenskapsinformation** under [Bokföringslagen (1999:1078)](https://www.riksdagen.se/sv/dokument-och-lagar/dokument/svensk-forfattningssamling/bokforingslag-19991078_sfs-1999-1078/): 7-year retention (7 kap. 2 §), stored in Sweden by default. **7 kap. 3a §** permits machine-readable storage in another EU country if **Skatteverket is notified** of the location, immediate electronic access is granted, and printouts in Sweden are possible ([BFN FAQ](https://www.bfn.se/fragor-och-svar/arkivering/)). Our database is in Frankfurt, so ToS/onboarding must: (a) surface the tenant's notification duty in plain Swedish; (b) position the tenant's own accounting system as the archival source of truth, with Fortleva as a *försystem*; (c) promise export (PDF/CSV + JSONL) at any time and at offboarding. The platform's own Stripe records fall under the same law on our side.

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
| Issue / IssueComment / PerformanceReport | Life of parent | Included in export | Deleted | Author pseudonymized on Contact erasure |
| AuditEvent | 12 mo (auth/downloads) / 24 mo (privileged) / box events life-of-box + 24 mo | Retained per schedule | Tenant-visibility rows deleted with tenant at day 90 **except** ContinuityBox and impersonation events, retained per schedule | Pseudonymize actor, keep event |
| ContinuityBox / ContinuityOpenRequest | Life of client relationship; quarterly reseal ritual | Contact change forces reseal | **Survives lapse and offboarding sealed for a defined window — proposed 12 months** (final number in `OPEN_QUESTIONS.md`), then destroyed with notice | Sealed blob is ciphertext; erasure = destroy blob + shares |
| Sessions / Invitations | TTL-bound (§3.6; invites ≤ 72 h) | Revoked | Deleted | — |

---

## 11. Engineering practices that back the model

- **CI security suites (non-negotiable, §12):** adversarial cross-tenant deny-matrix over all models (DMMF-enumerated, ephemeral Neon branches — `TENANCY.md`); client-scoping and visibility-flag tests; privilege-escalation tests (grant-subset, last-owner, self-escalation); portal invite-only boundary test (§3.4); RLS fail-closed test (no GUC ⇒ zero rows).
- **Secrets:** Vercel env vars only; nothing in the repo; keyring offline copy per §6; R2 token scoped to the one bucket with minimum verbs; runtime vs migrate DB roles separated (§7).
- **Backups/recovery:** Neon PITR window ≥ 7 days; restore drill before Phase 7; R2 reconciliation job doubles as integrity check.
- **Dependencies:** lockfile-pinned; GitHub advisories watched (auth packages exact-pinned, §3.2); monthly update window, ≤ 48 h critical SLA.
- **Pre-GA:** external penetration test before Phase 7 opens tenant self-signup (**v2** budget line).

---

## 12. Pushback notes (§12)

1. **Platform console origin — raised, and resolved in favor of the pushback.** Decision #8 (single app domain v1) covers the *tenant and portal* planes, and plane separation there rides on route groups, distinct `__Host-` cookies, and session audiences. The pushback was to carve the *platform* console onto its own hostname anyway: near-zero cost now, removes the last cookie-adjacency between the most and least privileged planes, and it never gets cheaper. **That is now the decided design** (ARCHITECTURE.md ARC-11, reflected in §2.2/§3.3 above): the console lives on its own host, files are separate by construction via the R2 endpoint, and no item remains open. **Amended by decision #9 (2026-08-05):** the console's own host is `ops.naxdor.com` through Phases 1–6 and becomes a separate registered apex at Phase 7. The pushback's substance — the console is never cookie-adjacent to the app — survives intact via `__Host-` cookies; what is deferred is the registered-domain boundary, with INV-D1 as the compensating control (§2.2). Recorded here rather than deleted so the reasoning survives.
2. **Personnummer scoping (refinement, not disagreement).** The synthesis says "encrypt personnummer." Specced as: personnummer-**typed** fields are always encrypted (none exist in v1; BankID evidence v2), while `Client.orgNr` stays plaintext even though an enskild firma's orgnr numerically equals one — encrypting it breaks search/dedupe/VIES, and it lawfully appears on every invoice anyway. Documented in the ROPA instead (§6). Flagged for the cross-doc reviewer to confirm `DATA_MODEL.md` matches.
3. **Rate-limit fail-open default** (§4) trades a sliver of protection for login availability during a Redis outage; the three fail-closed exceptions are where a missed limit is unacceptable. Fail-closed on logins is a one-constant change if preferred — but it makes Upstash a login-availability dependency.

## 13. Items feeding `OPEN_QUESTIONS.md`

Box retention window after tenant churn (proposed 12 mo — C2); paid invoice "archive mode" after offboarding (C15); ESP choice (Resend vs Postmark, EU region) — changes the sub-processor list (B4); continuity-event audit retention + Contract evidentiary period (lawyer list, C9); DPA template source (lawyer, C9); tenant-enforced MFA preference (**v2**, C16). **Not open any more:** the platform-console hostname (pushback #1) is decided — its own host from day 1 per ARC-11 (`ops.naxdor.com` in v1, a separate registered apex from Phase 7, decision #9).

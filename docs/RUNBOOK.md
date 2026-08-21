# RUNBOOK.md — Operating and self-hosting Fortleva

> **Status:** skeleton, opened 2026-08-17 (Phase 2 close-out; owed since Phase 1b). Kept current every phase — this is the credibility artifact behind `CONTINUITY_BOX.md` §10.2 ("you could run this without me" must be checkable). Sections marked *(TODO)* are headings with a one-line intent until the phase that fills them lands. Product decisions live in the other docs; this file is only *how to run it*.

## 0. What you are running

One Next.js 16 app (App Router, `src/app`) serving three planes on two hosts (`ARCHITECTURE.md` ARC-11): tenant + portal on `APP_URL`, the platform console on `OPS_URL`. Postgres (Neon today; any Postgres ≥ 15 with RLS works), S3-compatible object storage (Cloudflare R2, EU jurisdiction; any S3 works — the transport is `src/storage`), Better Auth for identity, next-intl for sv/en. No queue, no cache, no third daemon in v1. Jobs are plain functions under `src/jobs/` invoked by cron (Vercel Cron in production; `pnpm tsx` locally).

## 1. Environment variables

Every variable is read in exactly one place (`src/config/index.ts` for hosts/mail/storage/limits, `src/db/client.ts` for database roles, `src/crypto/root-keyring.ts` for key material). Nothing else touches `process.env`.

| Variable | Required | Read by | Purpose |
|---|---|---|---|
| `APP_URL` | prod | `src/config` | Canonical tenant/portal origin (`https://os.naxdor.com` today). All absolute URLs, cookies (`__Host-flv.<plane>`), Better Auth `baseURL`. |
| `OPS_URL` | prod | `src/config` | Platform-console origin. Falls back to `APP_URL` in dev. |
| `DATABASE_URL` | yes | `src/db/client.ts` | **Pooled** connection as `app_runtime` (RLS enforced, no BYPASSRLS). All tenant/portal work. |
| `PLATFORM_DATABASE_URL` | prod | `src/db/client.ts` | Pooled connection as `app_platform` (BYPASSRLS — every use audited via `withPlatform()`). Platform console + jobs. |
| `DIRECT_URL` | migrate | `prisma.config.ts` | **Unpooled owner** connection for `prisma migrate` and seed only. Never used at runtime. |
| `BETTER_AUTH_SECRET` | yes | Better Auth | Session/cookie signing. Rotating it signs everyone out. |
| `FIELD_ENCRYPTION_KEY`, `FIELD_ENCRYPTION_KEY_ID` | yes | `src/crypto/root-keyring.ts` | Root key (base64, 32 bytes) + id that wraps every tenant DEK (`TenantKey.wrappedDek`) and encrypts auth secrets. **Losing it loses every encrypted column.** See §5. |
| `FIELD_ENCRYPTION_KEY_PREVIOUS` | rotation | `src/crypto/root-keyring.ts` | Previous root key during a rotation window (`<id>:<base64>`). |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | prod | `src/config` → `src/storage/r2.ts` | Object storage. All four present ⇒ R2 transport at `https://<account>.eu.r2.cloudflarestorage.com`; absent ⇒ local-disk dev transport (`.dev-storage/`, refuses production). Any S3 endpoint works with a one-line change to the endpoint builder in `src/config`. |
| `DEV_STORAGE_SECRET` | dev | `src/config` | HMAC secret for the dev transport's signed URLs (falls back to `BETTER_AUTH_SECRET`). |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | prod (recommended) | `src/config` → `src/ratelimit` | Sliding-window rate limits on sign-in / sign-up / invite-accept / step-up. Absent ⇒ **fail-open no-op**, logged once at boot. |
| `MAIL_FROM_NAME`, `MAIL_FROM_ADDRESS` | prod | `src/config` → `src/mailer` | Sender identity. *(TODO Phase 5: SES credentials + outbox settings.)* |
| `NODE_ENV` | — | everywhere | `production` turns on the production-only refusals (local transport, dev routes). |

Local dev: copy the values into `.env.local` (git-ignored). `prisma.config.ts` loads `.env.local` then `.env` for the CLI; Next loads them itself at runtime.

## 2. Database: roles, migrations, RLS

- **Three roles** (`TENANCY.md` §6.1): the owner (migrations only), `app_runtime` (RLS enforced; the app), `app_platform` (BYPASSRLS; console + jobs). Migration `20260808191500_security_foundations` creates the roles and policies; grants are re-asserted by every later migration that adds a table. A fresh Postgres needs the two roles to exist with passwords before `DATABASE_URL` / `PLATFORM_DATABASE_URL` can point at them.
- **Migrate:** `pnpm prisma migrate deploy` (uses `DIRECT_URL`). Never `migrate reset` / `db push` against a database with data. Every migration is hand-reviewed SQL under `prisma/migrations/`; RLS policies, triggers and role grants live there, not in the schema file.
- **Seed:** `pnpm prisma db seed` runs `prisma/seed.ts` — the permission catalog (63 codes, `src/authz/catalog.ts`) and B3 additive template propagation into existing tenants' system roles (`runTemplatePropagation`). Idempotent. It does **not** create feature flags, and it does **not** create a tenant: tenant zero comes from `pnpm exec tsx scripts/seed-naxdor.ts` (`scripts/seed-naxdor.ts:58-67`), which is for an empty database only. *(Corrected 2026-08-19 — this line previously claimed feature flags and tenant zero; `prisma/seed.ts` is 68 lines and does neither.)*
- **Verify posture after any migration:** `pnpm test:db` (runs as the real `app_runtime` role; a superuser false-passes RLS). The registry posture test (`src/db/isolation.dbtest.ts`) fails if a tenant table lacks its policies; `src/db/model-registry.test.ts` fails if a model is unclassified; `src/export/manifest.test.ts` fails if a tenant model is missing from the export census.
- **Neon specifics:** the pooler is PgBouncer in transaction mode — GUCs are set with `set_config(..., true)` (transaction-local) by `withTenant()`; do not add session-level `SET`s. Branching is fine for previews; production is the `main` branch. *(TODO: PITR window + how to restore a branch to a point in time.)*
- **Any-Postgres restore** (`CONTINUITY_BOX.md` §10.2): `pg_dump` from Neon → `pg_restore` into the target → create the two roles → point the three URLs → `migrate deploy` (no-op if current) → seed (idempotent). *(TODO: rehearse once and record timings.)*

## 3. Storage: buckets, keys, migration to any S3

- Two buckets are planned: general (documents, exports) and continuity (sealed boxes, bucket lock; Phase 8). Keys are opaque `<tenantId>/<fileObjectId>`; the DB row (`FileObject`) is the source of truth for existence, size, sha256, kind.
- Uploads never pass through the app (presigned PUT with signed `Content-Length` + `Content-Type`, HEAD-verified on commit). Downloads are presigned GETs with `Content-Disposition: attachment`, off-origin. Server-produced blobs (tenant export zips) are written with `putObject()`.
- **R2 → any S3:** copy objects key-for-key (`rclone sync`), point the four `R2_*` variables (and the endpoint builder in `src/config`) at the new endpoint. No key rewrite is needed; `FileObject.r2Key` is endpoint-agnostic.
- Reconciliation: `src/jobs/expire-pending-uploads.ts` releases stale PENDING reservations (call from cron; not scheduled yet). *(TODO: bucket↔DB orphan sweep once R2 env exists.)*

## 4. Backups and exports

- **Platform backups:** Neon PITR + daily logical dump *(TODO: where the dump lands, retention, restore drill cadence)*.
- **Tenant exports (the continuity commitment):** any member holding `tenant:export` (✦, step-up) generates a full export at `/settings/export`: one JSONL per tenant table, `manifest.json` (`schemaVersion`, per-model row counts + sha256, file pointers), file bytes bundled when ≤ 200 MB, stored as an `EXPORT` document and downloadable like any file. Encrypted bank fields and wrapped DEKs never leave. Audit: `export.requested` / `export.generated` / `export.downloaded`. Reading an export needs nothing from Fortleva: `unzip`, then one JSON object per line. *(TODO Phase 8: scheduled exports pushed to a tenant-owned bucket, `CONTINUITY_BOX.md` §10.1.)*

## 5. Key material

- **Root key** (`FIELD_ENCRYPTION_KEY`, id `FIELD_ENCRYPTION_KEY_ID`): wraps every per-tenant DEK (`TenantKey`) and encrypts auth secrets (TOTP). Stored only in the deployment's secret store (Vercel env) and in the founder's Bitwarden vault with Emergency Access configured (`CONTINUITY_BOX.md` §10.3). **No key ⇒ no decryption of `Tenant.iban/bic/bankgiro/plusgiro`, `TwoFactor.secret`, and (from Phase 3V) every vault credential.** Exports deliberately omit these columns for that reason.
- **Rotation:** set the new key as `FIELD_ENCRYPTION_KEY`/`_ID`, the old one as `FIELD_ENCRYPTION_KEY_PREVIOUS`, deploy, run the re-wrap job *(TODO: job not built yet — `SECURITY.md` §6 rotation lands with 3V)*, then drop `_PREVIOUS`.
- **Better Auth secret:** rotating signs everyone out; no data loss.
- **R2 / Upstash / Neon credentials:** rotate at the provider, update env, redeploy. The runtime R2 credential must never gain delete rights on the continuity bucket (INV-10).

## 6. Deploy

- **Vercel (Pro):** `pnpm build` (`next build`), region **fra1/arn1** (EU), env per §1, cron entries for jobs *(TODO: list as they land)*. Preview deployments use a Neon branch and the local/dev-safe values; never production keys.
- **Self-host:** any Node 20+ host: `pnpm install --frozen-lockfile && pnpm build && pnpm start` behind a TLS-terminating proxy that forwards `Host` and `x-forwarded-for` (rate limits and audit rows use it). Two hostnames (or one, with `OPS_URL` unset in single-host dev mode) — see `ARCHITECTURE.md` ARC-11.
- **Pre-flight checks (CI runs the same):** `pnpm typecheck` · `pnpm lint --max-warnings 0` · `pnpm test` · `pnpm test:db` (against a real Postgres as `app_runtime`) · `pnpm build` · `pnpm test:e2e` (§7).
- **Smoke after deploy:** sign in → `/home` renders in the member's locale/time zone → upload a file → generate an export and open the zip.

## 7. Browser tests (the e2e harness)

Added 2026-08-17. The unit and DB suites cannot see a control that lies about the database or a theme re-applied on mount — both were real founder-reported bugs. This suite runs the real app in a real browser and exists to catch that class.

- **Run:** `pnpm test:e2e` (headless, list reporter + HTML report) or `pnpm test:e2e:ui`. First run needs the browser once: `pnpm exec playwright install chromium` (~700 MB on disk; chromium + headless shell only — no other engine, and on Linux add `--with-deps` for the OS packages).
- **The server is not yours to start.** `playwright.config.ts` runs `pnpm build && pnpm start` itself on `http://127.0.0.1:3000` with `APP_URL` pinned to that origin — Better Auth pins `baseURL`/`trustedOrigins` to `APP_URL` (INV-D2), so a foreign origin makes every sign-in POST fail as cross-origin. It is a production build on purpose: `next dev` double-mounts under Strict Mode and would mask exactly the mount-time bugs this suite hunts. Locally an already-running server on that port is reused; in CI it never is. Env comes from `.env.local` / `.env` (§1) — the same secrets the app and `pnpm test:db` need.
- **What it covers** (one worker, serialised, ~6 min cold): `e2e/theme.spec.ts` (the light/dark preference survives navigation, reload and every later mount of the toggle, with the OS scheme emulated both ways), `e2e/visibility.spec.ts` (a document's visibility control agrees with the stored row in both directions, on `/files` and on the client Files tab, and a failed change says so instead of looking like a silent revert), and `e2e/visual.spec.ts` (§ `UI.md` 10.14 — 38 stops × light/dark × desktop/mobile, screenshots to `.design-shots/`, plus a per-stop DOM audit: one `h1`, no invisible text, no untranslated keys, no horizontal overflow at 390 px, no console errors or failed requests).
- **Fixtures — the data-safety contract** (`e2e/fixtures/tenant.ts`, `e2e/fixtures/seed-cli.ts`): `global-setup` provisions a throwaway tenant with slug `e2e-<random>` through the ordinary `provisionTenant()`, an owner at `@test.invalid` whose password is generated per run and passed to the fixture process in an env var (never written to a file, never printed), and a workspace to photograph — clients (one archived, one long-named), projects across three statuses, contacts, services, milestones, documents at every visibility, a pending invitation. Sign-in goes through the real login form; the resulting session is stored in `.auth/` (git-ignored). **No tenant the fixture did not create is ever read or written — `naxdor` least of all.** The DB work runs under `tsx` in its own process because the generated Prisma client is ESM and Playwright transpiles tests to CJS.
- **Teardown guarantee:** `global-teardown` runs after the whole run — passed, failed or interrupted — and deletes the rows, the tenant, the owner, the audit trail, the stored bytes and the session state. It refuses outright to delete a tenant whose slug is not `e2e-`-prefixed, and every fixture write asserts the same prefix first. It is idempotent, so CI runs it a second time with `if: always()` after a cancellation. **Verify after a run:** `select slug from "Tenant" where slug like 'e2e-%'` must return nothing.
- **CI:** the `e2e` job in `.github/workflows/ci.yml` — runs after `check`, shares the `isolation-db` concurrency group with the isolation suite (one shared dev database; the two must never run at once), caches `~/.cache/ms-playwright`, installs chromium, runs the suite, force-cleans the fixture, and uploads the HTML report as an artifact on failure. It is **blocking**: if it starts flaking, add `continue-on-error: true` to that job rather than deleting it.

## 8. Incident quick reference *(TODO)*

- Kill-switch a module for one tenant or all: `FeatureFlag` row (`module.<key>`, `tenantOverrides`) — gate 1 in `src/entitlements/resolver.ts`.
- Suspend a tenant / a member: platform console (`tenant.suspended`, `member.suspended` audit events).
- Sign everyone out: rotate `BETTER_AUTH_SECRET`.
- Storage compromised: rotate R2 keys; presigned URLs are ≤ 15 min (PUT) / 60 s (GET).

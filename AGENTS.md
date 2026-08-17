<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Fortleva — project instructions

*Loaded into every session via `CLAUDE.md` → `@AGENTS.md`. Kept deliberately short: it states the rules that are expensive to violate and points at the documents that hold the detail. Everything below the Next.js block is ours; `next dev` only rewrites the marked block above.*

## Start here

1. **`docs/PLAN.md` §0 "Next session starts here"** — current state, the ordered next actions, open provisioning, standing traps. It is the source of truth for build progress and is updated at every context boundary.
2. **`docs/research/2026-08-16-work-management-plan.md` §3 "spec pins"** — the settled design decisions for phases 2W/2T/3/3V (hierarchy, ordering key, rate model, visibility mechanism, vault crypto…). **Settled: implement them, do not re-litigate them.**
3. **`docs/UI.md`** before touching any UI; **`docs/DATA_MODEL.md`** (§6.14–§6.19 for the phases ahead) before any schema work; `AUTHZ.md`, `TENANCY.md`, `SECURITY.md` for the rules they own.

## Vocabulary (law — the schema depends on it)

**Tenant** = a subscribing company · **Member** = a person who works at a tenant · **Client** = a customer *of a tenant* (a company record, never a login) · **Contact** = a person at a client (the portal principal) · **Platform** = the layer above all tenants. Never write "user" for both a Member and a Contact. In the UI a `WorkItem` is called a **Task**.

## Non-negotiable engineering rules

- **One DB seam.** All database access goes through `withTenant` / `withPlatform` / `withUser` from `@/db`. Never import `@/db/client` or the generated client outside `src/db` and `src/auth` (ESLint enforces it). `withPlatform` is importable only from `(platform)`, `jobs/`, `src/db` and tests.
- **Every new Prisma model** is registered in `MODEL_CLASSES` *and* exactly one `RLS_CLASSES` subclass in `src/db/model-registry.ts`, and ships a **hand-written migration** granting `app_runtime` and applying `ENABLE`+`FORCE ROW LEVEL SECURITY` with `tenant_isolation` plus `portal_deny` (class A) or `portal_gate` (class B). Never run `prisma migrate reset` or `prisma db push`.
- **Every mutation**: `requireAccess()` → `assertInScope()` → mutate → `audit.record()` **in the same transaction**. The action must already exist in `src/audit/catalog.ts`.
- **Three namespaces, never mixed**: permission codes `resource:verb` (immutable forever — deprecate, never rename), audit actions `entity.verb`, portal capabilities `portal.area.verb`.
- **Visibility is safety-critical.** `INTERNAL` is the default everywhere; the portal gate is `client_id = app.client_id AND visibility = 'CLIENT_VISIBLE' AND portal_enabled`, enforced in the database. `portal_enabled` is trigger-derived from the project — never write it on a child row. The worst bug this product can have is a client seeing internal data.
- **Portal reads** run under the contact principal via RLS; contact-*caused writes* are brokered under `withTenant(tenantId, {type:'system'})` after `authorizePortal()`, and live in `modules/*/portal.ts`.
- **Server actions** derive tenant and member from `requireTenantContext()` — never from form parameters.
- **i18n**: no literal JSX strings (ESLint enforces); every key exists in **both** `src/messages/en.json` and `sv.json`, with idiomatic Swedish.
- **UI**: design tokens and existing components only — no raw Tailwind colour utilities, hex literals, or arbitrary radii/shadows/heights. See `docs/UI.md`.
- **Config**: no hostnames or cookie names outside `src/config`; no cookie ever carries a `Domain` attribute (INV-D1, CI-enforced).
- **Nothing tenant-specific in schema or UI.** If only Naxdor needs it, it is a `TenantPreference`.

## Rules for automated agents

- **Never create users, members, roles, sessions or credentials**, and never write to the database, outside a throwaway tenant your own test provisions and tears down (slug prefixed `e2e-`). Never touch the `naxdor` tenant. An agent once created an owner-level account in tenant zero to render a page; it had to be revoked.
- **Never print, log or commit** passwords, tokens or cookies.
- **Verify by code, tests and `pnpm build`** — and check **exit codes**, not just output (a piped `tail` once hid a failing test).
- Re-audit any data-safety claim independently before repeating it.

## Standing traps (each cost a real bug — details in `docs/PLAN.md` §0)

- React 19 **resets a `<form action>`** at the start of every action; a native `<select>` inside one will show stale server state. Call the action in a transition with `useOptimistic` instead.
- An action failure must **never look like a revert** — return a typed `ActionResult` and toast it.
- `[&_tr:last-child]:border-0` on a table body **deletes row-level left cues**; use `border-b-0`.
- A `"use client"` module's exported constant interpolated into a **server** component's `className` becomes a throwing client reference.
- State a shared component must reflect is a **required prop** (or its own store), never a default.
- **Never run `pnpm build`, `pnpm start` or the e2e suite while `next dev` is running.** The production build rewrites `.next` underneath the dev server, whose browser runtime then requests chunks that no longer exist and reports only "An unexpected Turbopack error". Stop the dev server first; if it happens, kill the process, `rm -rf .next`, and restart. Background dev servers survive killing the `pnpm` wrapper — check with `netstat -ano | grep LISTENING`.

## Commands

`pnpm dev` · `pnpm build` · `pnpm typecheck` · `pnpm exec eslint src e2e --max-warnings 0` · `pnpm test` (unit) · `pnpm test:db` (against Neon, sequential, ~3 min) · `pnpm test:e2e` (Playwright; `pnpm exec playwright test visual` regenerates 128 screenshots into `.design-shots/`).

Commit in small reviewable steps; end commit messages with the `Co-Authored-By:` trailer. Do not push unless asked.

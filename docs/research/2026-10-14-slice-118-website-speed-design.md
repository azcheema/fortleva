# Slice 118 — THE WEBSITE SPEED CHARTS (Phase 6 step 4; founder decision C94)

*Design written 2026-10-14 by the building session, before any code; the migration is reviewed by a fresh agent before it is applied (§11). C94's answers are in `docs/OPEN_QUESTIONS.md`; this document is how they are built. The method for the charts is the dataviz skill's (form first, colour by job, a table twin for every chart), as slice 117's was.*

## 0. What C94 decided, and the readings this design takes

| C94 | Decision | Reading taken here |
|---|---|---|
| — | The website speed charts next; the WHOLE SITE is measured (the origin of `Project.productionUrl`), the THREE Core Web Vitals in plain words with Google's Good / Needs work / Poor bands | One series per project, per device kind: Google's Chrome UX Report **History API** (`records:queryHistoryRecord`, `origin`), up to 40 rolling 28-day periods a week apart, refreshed by Google on Mondays. LCP = "How fast the page loads", INP = "How fast it reacts to a tap", CLS = "How much it jumps around". |
| (a) | **A client sees them only after someone switches them on** — a per-project "Show to the client" switch, OFF at first | `project.portal_show_speed`, false by default; the rows' `visibility` is DERIVED from it in the database (§2.3), so the portal gate — not a projection — decides. |
| (b) | **Phones first, computers one tap away** | Two series kept per project (`PHONE`, `DESKTOP`); every surface opens on phones with a `?device=desktop` link beside it. Tablets are not fetched (Google's third kind; a tap away from nothing anyone asked for). |
| (c) | **Keep our own weekly copy** — history grows past Google's ~10 months, no page waits on Google | A new table, `website_speed_week`: one row per project × device × period end. The weekly job (§5) asks Google for the 40 periods and inserts only the period ends it does not hold; a page view reads our rows only. |
| (d) | **The team sees them on the project's page**, a Website speed section beside its Production URL, where the switch lives | The Overview tab, a card under Details (§6.1). The client's side is the portal's Reports page (§6.2), above the monthly report files. |

**Read by the design, not asked (stated to the founder when the slice is reported):**

- **Which projects are measured.** Every project with a Production URL that is not archived, in every workspace that is trialing, active or past due (the digests' set) and whose `reports` module is open — the switch does not gate the FETCH (a team sees its own site's numbers without ever sharing them). A project whose URL changes starts a new series: the rows carry the origin they measured, and the charts draw only the rows of the CURRENT origin (old rows stay as history nobody draws — the data export has them).
- **Who sees them on the team's side**: `report:view` (CMAE — catalogued since Phase 1 as "View performance reports / CrUX charts", declared ahead for exactly this) on a project the member can open. No new permission code, no seed.
- **Who may switch**: `project:manage_portal` — the portal sections' code, because the switch changes what a client is shown. Audited `project.speed_sharing_changed` `{ shown }` (a new catalogue action).
- **Who sees them on the client's side**: `portal.report.view` — every profile, the capability slice 115 made, whose own comment says the charts ride on it. The Reports nav entry is drawn when the client has a published report OR a shared speed series.
- **The client sees the project's portal, or nothing.** A project whose portal is off (`portal_enabled`) shows no speed on the portal whatever the speed switch says — the three-term gate, as for every project-scoped row. The team's switch says so in words when the portal is off.
- **No Recharts** (slice 117's amendment of ARC-24 holds): the weekly line is inline SVG, server-rendered on the chart tokens, with a table twin; the bands' shares are a stacked meter. Nothing client-side.
- **Not enough visitors is a state, not a blank** (Phase 6's non-negotiable): Google answers "no data" for most small sites, and the card says so in words with the date it last asked; a refusal and an outage each have their own line. A project with no Production URL says what to set.
- **The key is the founder's**, set as an environment variable on the server (`CRUX_API_KEY`), never asked for in chat, never printed, never in a log line; the transport is OFF unless `CRUX_TRANSPORT` says `live` (production) or `fake` (the harnesses) — the Fortnox pattern.

## 1. The numbers kept, and what each surface draws

Per period (Google's rolling 28 days, ending on a Saturday) and per device kind, from the History API's `percentilesTimeseries.p75s` and `histogramTimeseries[].densities`:

| Metric | p75 kept as | Google's bands (p75) | Shares kept |
|---|---|---|---|
| LCP — How fast the page loads | `lcp_p75_ms` (integer ms) | Good ≤ 2500 ms · Needs work ≤ 4000 ms · Poor | `lcp_good`, `lcp_needs_work`, `lcp_poor` (0–1) |
| INP — How fast it reacts to a tap | `inp_p75_ms` (integer ms) | Good ≤ 200 ms · Needs work ≤ 500 ms · Poor | `inp_good`, `inp_needs_work`, `inp_poor` |
| CLS — How much it jumps around | `cls_p75` (numeric(6,3)) | Good ≤ 0.1 · Needs work ≤ 0.25 · Poor | `cls_good`, `cls_needs_work`, `cls_poor` |

A metric Google has no data for in a period is NULL (its p75 `null`, its densities `"NaN"`); a period with all three NULL is not stored. The bands are Google's own thresholds, held in one module (`src/modules/reports/speed-bands.ts`, unit-tested) and used by every surface; the chart draws the band edges, the chip names the band of the LATEST period's p75.

**Each surface** (team card and portal section alike, one component family): the device toggle (Phones · Computers); then one block per metric — its plain-words name, the latest p75 as a number ("2.1 s", "180 ms", "0.05") with its band chip, the share meter of the latest period (Good · Needs work · Poor, a part-to-whole bar with its legend and the percentages as text), and the weekly p75 line over the weeks we hold (at most the last 52 period ends), the band edges drawn as hairlines with their labels, the latest point labelled — and a "Show as a table" twin listing every period's p75 and shares. The period's dates are said once above the blocks ("Each point is the 28 days ending that Saturday, as Chrome visitors experienced the whole site; Google updates it weekly.").

## 2. Schema — migration `20261023090000_website_speed` (DDL only, no DML)

### 2.1 `website_speed_week` — class B, **projectScoped**

```sql
CREATE TYPE "speed_form_factor" AS ENUM ('PHONE', 'DESKTOP');
CREATE TABLE website_speed_week (
  id text PRIMARY KEY, tenant_id text NOT NULL, client_id text NOT NULL, project_id text NOT NULL,
  origin text NOT NULL, form_factor speed_form_factor NOT NULL,
  period_start date NOT NULL, period_end date NOT NULL,
  lcp_p75_ms integer, inp_p75_ms integer, cls_p75 numeric(6,3),
  lcp_good numeric(5,4), lcp_needs_work numeric(5,4), lcp_poor numeric(5,4),
  inp_good numeric(5,4), inp_needs_work numeric(5,4), inp_poor numeric(5,4),
  cls_good numeric(5,4), cls_needs_work numeric(5,4), cls_poor numeric(5,4),
  visibility "Visibility" NOT NULL DEFAULT 'INTERNAL',
  portal_enabled boolean NOT NULL DEFAULT false,
  fetched_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (tenant_id, project_id, form_factor, period_end), UNIQUE (tenant_id, id)
);
```

FKs to `tenant` and `(tenant_id, client_id) → client` (RESTRICT), `(tenant_id, project_id) → project` ON DELETE CASCADE — with the project, as `project_update` is (the product archives; the hard delete is the harnesses' and the teardown's). Index `(tenant_id, project_id, origin, form_factor, period_end)` (the unique — PER SITE: `20261023090000` left the origin out, and the slice's own dbtest showed a project whose URL moved could never store the new site's periods, since the old origin's rows hold the same period ends; corrected forward by `20261023100000`), `(tenant_id, client_id, visibility)`.

CHECKs: `period_end - period_start = 27` (Google's 28 days); each p75 NULL or ≥ 0; each share NULL or in [0, 1]; a metric's three shares all NULL or all set, and NULL exactly when its p75 is; at least one p75 NOT NULL; `origin ~* '^https?://[^/?#@]+$'` (an origin, never a page or a credential); `origin` ≤ 2048.

**Why projectScoped and not clientScoped**: a project's speed must leave the portal with the project (`portal_enabled` off → nothing), by the column comparison every other project row uses — never by a join in a policy (TENANCY §7.2). So the table takes the WHOLE mechanism, as `project_update` did in `20260925200000` and the gate's `20260928180000`: the `<t>_stamp_portal_enabled` trigger (`stamp_portal_enabled()`, try-only), the `<t>_portal_heal` deferred constraint trigger, a twelfth leg in `project_portal_enabled_fanout()` (re-created word for word plus one UPDATE, last) and in `portal_switch_reconcile()` (its UPDATE … SKIP LOCKED leg and its count term, last). The registry's `B_projectScoped` gains `websiteSpeedWeek`, which is what `isolation.dbtest.ts` pins the two bodies against (and `PORTAL_FANOUT_LEGS` in `src/projects/service.ts` widens itself). `portal-gate.dbtest.ts` and `portal-switch-gate.dbtest.ts` each gain the table's seeder / vehicle.

### 2.2 `website_speed_check` — class A (portal_deny)

One row per project: `tenant_id`, `project_id` (UNIQUE with tenant), `origin` (what was asked), `checked_at`, `outcome` (`speed_check_outcome`: `OK`, `NO_DATA`, `REFUSED`, `FAILED`), `detail` (a short token — `bad_url`, `key`, `rate`, `shape`, `network`; never Google's message text). Staff bookkeeping the card reads for its empty states; no contact has any business reading it. FK `(tenant_id, project_id) → project` RESTRICT.

### 2.3 The switch and the derived visibility

`project.portal_show_speed boolean NOT NULL DEFAULT false`. The rows' `visibility` is derived, the `project_time_summary` / `hours_sharing_mode` shape (migration `20260820220000`, `20260821120000`):

- `website_speed_week_stamp_visibility` — BEFORE INSERT OR UPDATE OF project_id, visibility: `NEW.visibility := CASE WHEN p.portal_show_speed THEN 'CLIENT_VISIBLE' ELSE 'INTERNAL' END` read from the project (a direct write to `visibility` is overwritten, like `portal_enabled`);
- `project_speed_sharing_fanout` — AFTER UPDATE OF portal_show_speed ON project: `UPDATE website_speed_week SET visibility = …` for the project's rows. The project's exact trigger set is pinned in `isolation.dbtest.ts` (the slice-102 pin) and gains this name.

**The race, and how it is closed**: the stamp's plain SELECT could read the switch's OLD value for a row the switch's fan-out then cannot see (the hours-sharing precedent accepts this; `setHoursSharingMode` "has no lock bound or retry"). Here the only writer of `website_speed_week` is the weekly job, so it is closed at the writer: the job's per-project write transaction first takes `SELECT … FROM project … FOR SHARE` on the project row (bounded by `lockTimeoutMs`), which serialises it with the switch's UPDATE (FOR NO KEY UPDATE) in either order. The job holds no other lock before it, so no wait-for cycle is possible (the slice-74 analysis concerned a stamp that waits inside EVERY writer; this is one writer, waiting before it writes anything). `portal_enabled` on the new rows is the gate's own business (try G, fail closed, heal, reconcile) — untouched.

### 2.3b The site is the gate's too — migration `20261023110000_website_speed_origin_gate`

*(Added after the security review, its 1.)* As first built, a project whose Production URL moved kept the previous site's rows CLIENT_VISIBLE in the database, and only the projection's `where` kept them from a contact — against the rule that the gate decides. The stamp and the fan-out now derive `visibility` from the switch AND whether the row's `origin` equals the origin of the project's CURRENT Production URL (`website_speed_origin_of(url)`, an IMMUTABLE SQL function: scheme and host, lower-cased, a default port dropped — what `originOf` answers for an ASCII host); the fan-out fires on a change of `portal_show_speed` OR `production_url`. A URL move makes the old site's rows INTERNAL in the same transaction; a row of another site is born INTERNAL whatever the switch says. An IDN host (which `new URL` re-spells as punycode) matches nothing in SQL: such a site's rows stay INTERNAL — the team sees them, the client never does — fail closed. A URL the app refuses — a credential or whitespace before the path — is no origin to the database either (`20261023120000`). So a gated row IS a current-site row, and the nav's count is one Prisma count over gated rows: it agrees with the list in every state.

### 2.4 Prisma

`model WebsiteSpeedWeek` (`@@map("website_speed_week")`), `model WebsiteSpeedCheck`, `enum SpeedFormFactor`, `enum SpeedCheckOutcome`; `Project.portalShowSpeed Boolean @default(false) @map("portal_show_speed")` (INTERNAL-ONLY — in `PORTAL_NEVER_SELECTED`'s spirit: the portal never selects it; the gate carries its effect) plus the two relations. `MODEL_CLASSES.tenant` and `RLS_CLASSES` (B_projectScoped / A) gain the two models; the tenant export dumps both with every other model.

## 3. The transport — `src/integrations/crux/`

`types.ts`: `CruxTransport { kind: "fake" | "live"; history(origin, formFactor, deadline): Promise<CruxHistory | null> }` — null is Google's "no data for this origin" (HTTP 404 `NOT_FOUND`); `CruxHistory` is the parsed periods (`{ start, end, lcp: { p75, good, needsWork, poor } | null, inp…, cls… }[]`). `CruxError(kind)`: `refused` (400 — a bad origin; 403 — the key refused, restricted or over its daily budget), `rate` (429), `unknown` (5xx, timeout, network), `shape` (an answer out of the shape read). Google's message text is never kept or logged — a 400's text can echo the origin, nothing worse, but the rule is the Fortnox one.

`live.ts`: `POST https://chromeuxreport.googleapis.com/v1/records:queryHistoryRecord` — the key in the `X-Goog-Api-Key` HEADER (the pre-apply review: a URL reaches fetch logs and error causes, a header does not) — with `{ origin, formFactor, metrics: [largest_contentful_paint, interaction_to_next_paint, cumulative_layout_shift], collectionPeriodCount: 40 }`, a 15 s timeout under the deadline, `parse.ts` reading `record.collectionPeriods[]` and the three metrics' `percentilesTimeseries.p75s[i]` and `histogramTimeseries[0..2].densities[i]` (`"NaN"` → null; a density may come as a string). The key appears only in that header of the request it sends; the host lives in `src/config` (INV-D2).

`fake.ts`: deterministic from the origin's hash — 40 periods ending on the Saturdays before `now`, p75s that drift week by week around a per-origin baseline (phones slower than desktops), shares derived from the p75's band; a host beginning `nodata.` answers null, `down.` throws `unknown`, `refused.` throws `refused` — so a dbtest and the e2e can plant every state. No file: pure and stateless.

`src/config`: `CRUX_TRANSPORT` (`live` | `fake`; anything else off — the default), `CRUX_API_KEY`; `live` without a key stops the boot; `fake` on a production build off loopback stops the boot (PUSH/FX/FORTNOX's rule); `cruxTransportKind`, `cruxApiKey()` (a function, like `fortnoxClientCredentials`), `cruxHistoryUrl`. `vitest.db.config.ts` and `playwright.config.ts` set `fake`; RUNBOOK names the two variables; the founder sets them on the server.

## 4. The service — `src/modules/reports/speed.ts` and `speed-fetch.ts`

- **`fetchWebsiteSpeed(tenantId, { transport, now, deadline })`** — the per-workspace body of the job, under `withTenant(tenantId, { type: "system", job: "website-speed" })`: `moduleOpenUnderSystem(reports)` else `{ skipped: "module" }`; the projects DUE — not archived, `production_url` set, with no check row, or one `checked_at` older than 6 days, or a `FAILED` one older than 6 hours — oldest check first, at most 40 per workspace per run (*after the slice:* a Production URL moved to ANOTHER site through `updateProject` deletes the project's check row in the same transaction, so the new site is asked on the next run rather than a week on); for each: the origin of the URL (`new URL(url).origin`, `http(s)` only, else outcome `REFUSED`/`bad_url` and no call); PHONE then DESKTOP through the transport, each answer parsed; then ONE write transaction (lock timeout 3 s): `FOR SHARE` on the project row (§2.3), `createMany … skipDuplicates` of the periods not yet held (the unique key is the dedupe — Google's past periods never change), the check row upserted (`OK` / `NO_DATA` when both kinds answered null / `REFUSED` / `FAILED`). A project's failure is its own (counted, logged by id and error kind, never message); `rate` ends the run for every workspace (the quota is per Google project, shared), reported as `outOfQuota`. Returns counts.
- **`runWebsiteSpeed(now, { budgetMs })`** (`src/jobs/website-speed.ts`): `null` transport → `{ off: true }`; discovery under `withPlatform` (read-only, ids only): sending tenants with at least one not-archived project carrying a Production URL; a fair shuffle; 45 s a run; the per-workspace body above. Called from `POST /api/jobs/run` after the Fortnox send (its failure its own), and AGENTS.md's jobs paragraph gains its sentence: **the route ASKS GOOGLE about every measured site** whenever `CRUX_TRANSPORT` is `live` — at most 80 calls a workspace, well under Google's 150 a minute; a dbtest calls `fetchWebsiteSpeed(<its own tenant>, { transport: fake })`, never the job or the route.
- **`readWebsiteSpeed(ctx, projectId)`** — the team's read, under the member: `requireAccess(report:view)`, the project in scope (`loadInScope`), then the check row and the current origin's rows (≤ 52 period ends × 2 kinds), newest last; `{ origin, productionUrl, check, shown: portalShowSpeed, portalEnabled, series: { PHONE: Week[], DESKTOP: Week[] } }`. ONE transaction, reads in sequence.
- **`setSpeedShared(ctx, projectId, shown)`** — `project:manage_portal`, in scope, compare, `UPDATE project SET portal_show_speed` (select id only), audit `project.speed_sharing_changed` `{ shown }`; the fan-out does the rows. `setPortalSection`'s shape: no archived guard (an archived project publishes nothing), no gate machinery.
- **`listPortalWebsiteSpeed(principal)`** (`src/modules/reports/portal.ts`, the projection scanned by `portal-projections.test.ts`): `authorizePortal(portal.report.view)`, then `website_speed_week` rows of `principal.clientId` restating the gate's terms (`visibility: CLIENT_VISIBLE`, `portalEnabled: true`) joined to the project's `key`, `name`, `archivedAt: null` and its CURRENT `productionUrl`'s origin (the rows of an old origin are not drawn) — selecting the period, the kind, the three p75s and nine shares and nothing else; ≤ 52 period ends per project and kind; `countPortalWebsiteSpeed(principal)` for the nav (`reportsShown` = reports > 0 || speed > 0).

## 5. The job's bounds and Google's quota

150 queries a minute per Google project, shared with the daily API, free, not raisable. A run: ≤ 40 projects × 2 calls per workspace, 45 s overall, and `rate` stops the run. Every project refreshes about weekly (the 6-day rule spreads them over the week; Google publishes on Mondays ~04:00 UTC, so a project checked on a Tuesday sees the new period a week later at the latest). At Naxdor's size this is a handful of calls a week.

## 6. Screens

### 6.1 The team — the project's Overview tab, a "Website speed" card under Details

Drawn when the member holds `report:view` (the page's `caps` gain `viewSpeed`); the card's `actions` slot holds the **Show to the client** switch (drawn with `project:manage_portal`, disabled on an archived project; a transition, a typed `ActionResult`, a toast — never a revert) and under it one line: "The client sees it under Reports in their portal." / "The project's portal is off, so the client can't see it yet." (`portalEnabled` false) / "Only your team can see it." (switch off). Body by state:

| State | Body |
|---|---|
| no Production URL | "Set the Production URL above and Google's speed numbers for the site appear here after the next weekly check." |
| transport off | "Not switched on for this server." (muted; the switch still works — it decides what the client sees once numbers exist) |
| no check yet | "Not checked yet — the first numbers arrive after the next weekly check." |
| `NO_DATA` | "Google has no speed data for this site yet. Google publishes numbers only for sites with enough Chrome visitors. Last checked 14 Oct." |
| `REFUSED` | "Google refused the request (checked 14 Oct). Check that the Production URL is a real site address." — `key`: "…the server's Google key." |
| `FAILED` | "Couldn't reach Google at the last check (14 Oct). It's tried again automatically." (with the last numbers below when there are any) |
| rows | the device toggle, the three metric blocks (§1), the twins; "Measured: example.com · checked 14 Oct" |

Phones first: the toggle is two links (`?device=phone` · `?device=desktop`, the page's own search param), the current one `aria-current`. The card is a server component; the switch is the only client island.

### 6.2 The client — `/portal/reports` (+ `/view-as/reports`, the one component)

Above the monthly cards, one **Website speed** card per project with shared rows (project name as the card title; the device toggle; the three metric blocks; the twin), the same sentence about Google's 28 days. Nothing else changes: the empty state shows when there is neither a report nor a speed series; the nav entry follows `reportsShown`. The weekly summary does NOT count speed (numbers change every week; nothing is "new" to tell).

### 6.3 Components — `src/components/semantic/`

`speed-metric.tsx` (server, no directive): the block above — number, chip (`StatusBadge` tones: success / caution / danger with the band's WORD, never colour alone), the share meter (`--chart-active` Good? no: the bands carry severity, so the meter reuses the health tones `--tone-success`, `--tone-caution`, `--tone-danger` with their text, as the budget meter does), the `TrendLine` (inline SVG, `viewBox` 0 0 320 96, `preserveAspectRatio="none"` for the plot and absolutely positioned HTML labels for the band edges and the latest value, so text never stretches; `aria-label` from t(), the twin the accessible form) and the `ChartTable` twin with the period, p75 and the three shares (the shares at `priority: "low"` — the phone keeps the date and the number).

## 7. Catalogue changes

- Audit action `project.speed_sharing_changed` (TENANT).
- No permission code, no capability, no seed. `report:view`'s description already says charts; AUTHZ.md §3.2's row notes the slice.

## 8. Tests

**Migration-level** (`isolation.dbtest.ts`, `portal-gate.dbtest.ts`, `portal-switch-gate.dbtest.ts`): the new table rides the registry — the posture pins (columns, `portal_gate` with `portal_enabled`, the stamp and heal triggers by name, the fan-out's and reconcile's legs, the project's exact trigger set now with `project_speed_sharing_fanout`), the behavioural flip (0 rows for a contact with the portal off), the vehicle through the gate.

**`src/modules/reports/website-speed.dbtest.ts`** (prefix `wspd-`, registered in `DBTEST_PREFIXES`):

- the fake fetch writes rows for both kinds, INTERNAL, with the check `OK`; a second fetch inserts nothing new (the unique key); a project with no URL is not due; `nodata.` → no rows, check `NO_DATA`; `down.` → `FAILED`; `refused.` → `REFUSED`; a page URL is reduced to its origin; the module off → skipped; an archived project not fetched; the 6-day rule;
- the CHECKs: a 29-day period, a share of 1.5, a p75 without its shares, a page as origin — each refused;
- the switch: on → every row CLIENT_VISIBLE and the audit row; a row inserted AFTER → born CLIENT_VISIBLE; a direct `UPDATE … SET visibility` overwritten by the stamp; off → INTERNAL again; `project:manage_portal` missing → refused; `report:view` missing → the read refused;
- the portal: the contact sees rows only with the switch on AND the project's portal on; the portal switched off → 0 rows (the fan-out); another client's contact → none; the reports module off → refused; rows of a previous origin not listed; `countPortalWebsiteSpeed` and the nav's rule;
- the race (§2.3): a fetch's write transaction held open across a switch press — the rows end with the switch's value, both orders.

**Unit**: `speed-bands.test.ts` (the thresholds at their edges); `crux/parse.test.ts` (a recorded History API answer, `"NaN"` densities, a missing metric, a short series); `crux/fake.test.ts` (determinism, the three planted hosts); `config.test.ts` (off by default, `live` without a key refused, `fake` off loopback in production refused); the i18n parity.

**e2e `e2e/website-speed.spec.ts`** (the fixture's ACTIVE project carries `https://example.invalid`; `seed-cli plant-speed <tenantId> <projectId>` runs the fake fetch during provisioning): the owner's Overview shows the card with numbers and the phones/computers toggle; the contact's Reports page shows no speed and no nav entry while the switch is off; the owner turns it on → the toast → the contact's Reports page shows the card; off again (the fixture is left as found). `/view-as/reports` is already byte-compared by `view-as.spec.ts`.

**Visual walk**: the existing `project-overview` stop now photographs the card (the fixture's project has rows, switch ON after provisioning so `portal-reports` photographs it too — the spec turns it off and back on). No new stop.

## 9. Docs

DATA_MODEL §6.10 rewritten as built (two tables, the derived visibility, the twelfth leg); §2.3's table lists; TENANCY §7.2's projectScoped list; AUTHZ §3.2 (`report:view`'s row, `project:manage_portal`'s), §8 (`portal.report.view` covers the charts); SECURITY.md (the key: an environment secret, never logged); ARCHITECTURE §5's cron rows (the weekly fetch); UI.md (the Overview card, the portal Reports page); RUNBOOK (`CRUX_TRANSPORT`, `CRUX_API_KEY`, the key's application restriction at go-live); AGENTS.md (the jobs paragraph); PLAN §0 and Phase 6's line; OPEN_QUESTIONS C94.

## 10. Order of work

1. Migration drafted; a fresh read-only agent reviews THIS document and the migration against the code before it is applied; `migrate status`, then `migrate deploy` on dev; the ledger's checksum verified.
2. Prisma schema + generate; registry; the gate suites' seeders; `PORTAL_FANOUT_LEGS` self-widens.
3. Config + the transport (+ unit tests).
4. The service, the job, the route, AGENTS.md's sentence.
5. The dataviz skill, then the components, the team card, the portal section, the switch action, messages en + sv.
6. The dbtest, the e2e, the seed command.
7. Gates once each (typecheck, ESLint, unit, build, the new dbtest + the three gate suites locally, the e2e locally on 3457); `/code-review` + `/security-review` by fresh read-only agents; fix or disposition; commit; push; read CI.

## 11. Reviews

**The pre-apply migration review** (a fresh read-only agent, before `20261023090000` was applied): **no path found for a contact to read an INTERNAL row, another client's, or a switched-off project's; no HIGH.** Taken: the composite unique's name (66 characters — Postgres truncates at 63; named by hand, `map:` in Prisma); the API key moved from the URL to the `X-Goog-Api-Key` header (fetch logs and error causes print URLs); `portalShowSpeed` onto the never-list and the portal projection never selecting the row's `origin`; `setSpeedShared` bounded by `lockTimeoutMs` with `PORTAL_SWITCH_BUSY`; the parser NULLing a whole metric when any of its four values is missing (one half-row would reject the batch); a CHECK violation classed `shape` (waits the week); the write transaction taking `client_id` from its own `FOR SHARE` read; the design doc's FK wording (CASCADE, as `project_update`); the isolation pin's regex widened to the speed switch. Recorded: the gate suites' seeders need the switch on (done in the build).

**The slice's own dbtest found a design flaw before any review**: the dedupe key left out the origin, so a project whose Production URL moved could never store the new site's weeks (the old origin's rows hold the same period ends). Corrected forward by `20261023100000` (the key is per site).

**Code review** (fresh, read-only, on the finished tree — gates: typecheck 0, ESLint 0, unit 186 / 2 895, the new dbtest 11/11 + the three gate suites, build 0, e2e 12 / 2 skipped): no HIGH. **TAKEN, all twelve** — M1 the nav's count and the list disagreed after a URL move (now the same rule, and the database's own since §2.3b); M2 the team's card went blank after a URL move (the check row's `origin` is read; a check of another site is "not checked yet"); L3 a kind already answered is kept when the other fails, and Google's quota writes no check row (the site stays due); L4 a refused key ends the run and is retried on the six-hour rule; L5 with the transport off the card says so whatever the last check said; L6 the marker sits on the last MEASURED point; L7 every non-200 answer's body is cancelled; NITs: a status-less refusal is the key, the dead `latest` message removed, the split comment lines joined, a skipped write not counted as a project asked, one read per device kind so neither starves the other.

**Security review** (fresh, read-only, in parallel): **no HIGH or MEDIUM; the client-facing path holds** (the three-term gate, the derived visibility, the standard legs, an allow-listed projection, the key only in the live transport's header). **TAKEN**: L1 a previous site's rows stayed CLIENT_VISIBLE in the database with only the projection keeping them out — the gate now knows the site (§2.3b, `20261023110000`); L2 turning the switch ON is refused on an archived project (OFF always allowed); L3 a non-`CruxError` from the transport is the project's own failure, never the workspace's; L4 = the code review's L3; NITs: the design doc's three stale lines (the header, CASCADE, no `.env.example`), the origin's reaching the client said plainly (`portal.ts`'s header: the client's own `productionUrl`, a card only where Google holds public data for exactly that origin), the comment artefact. **RECORDED**: the dbtest's 400 ms "still waiting" assertions are timing-based — the final-state assertions are the proof.

### 11.1 The narrow re-check of the fixes

A fresh read-only agent verified each fix: **no HIGH or MEDIUM; every fix correct and complete.** Two LOWs, TAKEN: the SQL origin function answered `https://example.com` for `https://example.com@evil.com` or an authority with a space, where the app's `originOf` answers null — one such edit of a Production URL would have left the rows CLIENT_VISIBLE with the nav's count saying 1 over an empty page; `20261023120000_website_speed_origin_authority` makes such a URL no origin at all (every row INTERNAL), dbtested; and the card's "Checked …" date came from the check row whatever site it was of — now only for this site. NITs TAKEN: a quota met on the first call counted the project as asked; the isolation pin's comment named one of the fan-out's two columns; the archived-OFF test hit the no-change return (the switch is now set first); the four comment blocks in the projections test carried stray backslashes. RECORDED: "the run stops" is proven by the flag alone (one due project at a time in that fixture). Its finding that the projections test refuses raw SQL in a portal file sent the nav's count back to one Prisma count — correct now that the database itself holds the current-site rule.


## 12. Not built

Tablets; per-page URLs; the daily (non-history) API; the speed in the weekly summary or the Project health table (C94 (d) chose the project page); a speed column in a monthly PDF (a later slice); a per-project "ask Google now" button (the weekly rhythm is Google's); alerts when a site drops a band.

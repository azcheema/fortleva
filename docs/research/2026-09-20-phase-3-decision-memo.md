# Phase 3 (client portal) — decision memo

*Written 2026-09-20, for the founder, to be read once and answered. Not a spec: `docs/research/2026-08-16-work-management-plan.md` §3.2 and the Phase 3 entry in §4 are the spec, and AGENTS.md says they are settled. This memo says **what they do not settle**, what has already been built, and what has changed underneath them since they were written five weeks and roughly forty slices ago.*

---

## 1. The headline: the database half is built, the application half is not

This is the most useful thing to know before deciding, and it is not obvious from the plan.

**Already in the product, tested:**

| Pinned mechanism | State |
|---|---|
| `app.principal_id` GUC in `withTenant()` | Shipped (`src/db/with-tenant.ts`) |
| `portal_enabled` denormalised + `AFTER UPDATE` fan-out trigger | Shipped — **ten** tables, one transaction |
| `portal_gate` RLS policy (`client_id = app.client_id AND visibility = 'CLIENT_VISIBLE' AND portal_enabled`) | Shipped across 7 migrations |
| `RLS_CLASSES` `B_clientScoped` / `B_projectScoped` + posture test | Shipped (`src/db/model-registry.ts`) |
| "`portalEnabled=false` ⇒ 0 rows for a contact across every table" | **Proven** (`src/db/portal-gate.dbtest.ts`) |
| `Contact`, `ProjectVersion`, `ProjectTimeSummary` models | Shipped |

**Not built at all:**

| Pinned mechanism | State |
|---|---|
| `ContactSession` / `ContactAccount` / `ContactVerification` + the portal Better Auth instance | Absent — zero models |
| `authorizePortal()` | Absent (named in a comment in `src/authz/authorize.ts`) |
| `modules/*/portal.ts` (projections + brokered writes) | Absent — no such file exists |
| `ProjectUpdate` / `ProjectUpdateInternalSnapshot` | Absent — not in the schema |
| Portal capability namespace (`portal.work_item.view`, …) | Absent |
| `project:manage_portal` | **Absent from the catalogue** — see §3.1 |

**What this means for the decision.** The riskiest part of Phase 3 — "the worst bug this product can have is a client seeing internal data" — is the part that is already built *and already has a passing deny-matrix*. What remains is a second auth stack, a projection layer and roughly eight screens. That is a lot of work, but it is not a lot of *danger* per unit of work, and the danger that exists is concentrated in one place (§2.2).

---

## 2. What the pins do not settle

### 2.1 The second cookie jar — genuinely new, post-dates the pins

The pins were written before `Session.activeTenantId` became mutable (slice 26) and before the stale-tab fence (slice 29, `src/lib/workspace-watch.ts`). That fence exists because **cookies are per origin, not per tab**, so a member with two tabs can act on a workspace they are not looking at.

A contact session is a *third* principal on the same machine, and possibly the same browser profile: a Naxdor member who is also a contact of another agency, or — far more likely — **a member using View-as-Contact while signed in as themselves**. The pins say View-as-Contact "reuses the exact same functions (asserted by import graph)" but say nothing about the *session* it runs under.

Three answers exist and the pins pick none:

1. **View-as renders under the member's own session**, calling the contact projections with a synthesised contact principal. No second cookie. Simplest, and the import-graph assertion still holds — but the thing you are testing is then not quite the thing a contact gets, and the pins' "byte-identical JSON" test is what would catch a drift.
2. **A real contact session on a separate origin** (the ops-host pattern from `betterauth-plane-traps`). Truest, most expensive, and it makes View-as a login rather than a button.
3. **A real contact session on the same origin, distinct cookie name.** Cheapest of the two "real" options and the one that collides with the stale-tab fence — two principals, one jar.

**My recommendation: (1).** The byte-identity test the pins already require is precisely the guard that makes a synthesised principal safe, and it keeps one cookie jar. Note that (1) makes the fence a non-issue and (3) makes it a design problem.

### 2.2 Where the danger actually concentrates

Not in the RLS — that is done and tested. It concentrates in **`modules/*/portal.ts`**, because the pins put two different things in one file: allow-listed projections (reads) and brokered writes under `{type:'system'}`. A system principal bypasses RLS by design. So the file that is easiest to get wrong is also the file where the database stops helping.

The pins mandate a forbidden-columns grep test and a "no INTERNAL fact to a Contact" fixture suite "in the same commit as each feature". **That is the single most important line in the Phase 3 spec** and it is worth over-honouring: I would want the grep test to fail on a `select` that is not an explicit allow-list at all, not merely on known-bad column names — a new internal column added next year is not in today's forbidden list.

**Decision needed:** do you want the brokered writes split into their own file (`portal-writes.ts`) so that "this file runs as system" is a property of a filename rather than of a function? The pins say one file. I would split them.

### 2.3 `setPortalEnabled` becomes load-bearing, and it has a known failure

Slice 40 recorded this and Phase 3 promotes it from a footnote to a risk: turning a project's portal **off** is the emergency "stop showing this client our data" switch, and it can currently fail with **P2028** — the fan-out across ten tables blocks behind a bulk edit holding `FOR NO KEY UPDATE`, and dies on `withTenant`'s 5 s interactive budget. A deadlock retry landed; a *blocking* wait is not a deadlock and is not retried.

Today nobody has a portal, so nobody can be hurt. **On the day Phase 3 ships, this is a safety control that can fail under load.** It wants a transaction budget sized for the fan-out and measured on real row counts, and it should land *before* the first real client logs in, not after.

### 2.4 The portal's routes are outside every gate the last two days built

The visual walk has 48 stops; Phase 3 adds roughly eight portal routes plus a Portal tab and an Updates tab. None of them exist in `e2e/fixtures/stops.ts`, so none is covered by: the craft audit, `KNOWN_OVERFLOW` (now empty — an unlisted stop is held to 0), `offscreenRowActions`, or the Swedish width walk.

This is cheap to fix and easy to forget. **Every portal slice should add its stops in the same commit**, and the portal walk needs an *anonymous-ish* fixture — a contact session — which the harness has no concept of today (`e2e/fixtures/tenant.ts` provisions members only).

### 2.5 Small things the pins assume and the code does not have

- **`project:manage_portal` is not in the catalogue.** The pins name it (module `portal`, CM). Only `client:manage_contacts` exists there. Adding it is trivial — but `src/authz/enforcement.test.ts` now asserts an *equality*, so a code added without a guard fails the suite until it is either enforced or declared. That is working as intended; just know it will bite in the first portal slice.
- **Portal capabilities are a third namespace** (`portal.area.verb`), not permission codes. They do not go in the permission catalogue and are not covered by the enforcement test. They need their own registry and their own equivalent guard, or they will drift exactly the way permission codes did.
- **`"Only mentions"` is a dead setting** and Phase 3 is when it stops being: mentions are deferred to Phase 3 (UI.md §5.6), and `comment.mentioned` is the only kind that mails at that level. Until then a member who picks it gets no email at all. Removing the option needs a migration or `withCurrentOption`'s treatment, because a stored `MENTIONS` value would otherwise land on a select with no matching option.

---

## 3. Suggested slice order

The pins give scope, not sequence. This order front-loads the parts that can be *proven* and defers the parts that need design.

1. **Contact identity stack** — `ContactSession/Account/Verification`, the portal Better Auth instance, invite-only flow. Heed `betterauth-plane-traps`: a field missing from an instance schema reads as `undefined`, cookie signatures ignore the cookie *name*, and a distinct URL is needed.
2. **`authorizePortal()` + the deny matrix.** No UI. The pins' cross-client / cross-tenant / INTERNAL / audience / self-signup matrix, as dbtests. This is the slice that makes everything after it safe.
3. **`modules/work/portal.ts` — reads only.** One projection (shared tasks), the forbidden-columns grep, the "no INTERNAL fact" fixtures, and the first portal route + its walk stop.
4. **The Portal tab (member side)** — the master switch and "what the client sees". Do §2.3's transaction budget here, because this is where the switch gets its UI.
5. **View-as-Contact**, with the byte-identity test — once there is something to view.
6. **Brokered writes**: request intake, then contact "Done", then comments. Each with its census-test update in the same commit, as the pins require.
7. **`ProjectUpdate`** + composer + publish/snapshot. Largest single slice; entirely additive; can slip without blocking anything above.
8. **Hours widget** from `ProjectTimeSummary`, **Client Timeline**, **Document approvals**. Independent of each other.

**DoD is the pins' own:** one real Naxdor client logs in, sees exactly its shared items, submits a request that lands in triage. That needs **SES production access** — which is not provisioned (PLAN §0, 2026-09-16). It blocks only *real* client invites; the dev outbox carries everything else, so it does not block slices 1–8, only the demo.

---

## 4. What I need from you

1. **View-as-Contact session model** — (1), (2) or (3) in §2.1. My recommendation: (1).
2. **Split the brokered writes** out of `portal.ts` into their own file? My recommendation: yes.
3. **Start order** — take §3 as written, or reorder. The only ordering I would defend strongly is that **2 comes before 3**.
4. **`setPortalEnabled`'s transaction budget** — fix it as slice 4 above, or earlier as its own thing? My recommendation: slice 4, since nobody can be hurt until the portal exists.
5. **Model and effort.** Opus 5 at high throughout, and `/security-review` on **every** Phase 3 slice regardless of what the diff appears to touch — not only when it looks portal-shaped. The `/members` gap in slice 41 was found by a reviewer reading what a single grep hit actually was; that is the class of finding Phase 3 will produce most of.

---

*Nothing in this memo has been built. Phase 3 remains a hard stop until answered.*

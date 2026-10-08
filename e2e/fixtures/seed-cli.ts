/**
 * Fixture worker for the browser harness — the ONLY place the e2e suite
 * touches the database.
 *
 * It runs under tsx in its own process because the generated Prisma
 * client is ESM (`import.meta`) and Playwright transpiles test files to
 * CommonJS; the DB suite reaches the same code through Vite. Keeping
 * the data work here also keeps every Prisma connection out of the test
 * workers.
 *
 * DATA SAFETY (see e2e/fixtures/tenant.ts for the full contract):
 * everything the BROWSER harness creates lives inside a tenant this file
 * provisions, slug "e2e-" + random suffix. The owner password arrives in
 * an env var, lives in memory, and is never written or printed.
 *
 * `removeTenant` — which `teardown`, `sweep` and `sweep-dbtests` all go
 * through — carries TWO guards, and it is worth being precise about
 * them because one of them used to be the only one: the slug must match
 * the "e2e-" prefix OR the explicit DBTEST_PREFIXES allow-list below,
 * AND the tenant must hold no member whose email is outside
 * "@test.invalid". The second is the guard that actually matters: a slug
 * is a naming convention, a real address is evidence.
 *
 * Usage: tsx e2e/fixtures/seed-cli.ts <provision|teardown> <seedFile>
 *        tsx e2e/fixtures/seed-cli.ts visibility <documentId>
 *        tsx e2e/fixtures/seed-cli.ts set-visibility <documentId> <value>
 *        tsx e2e/fixtures/seed-cli.ts item-visibility <projectId> <number>
 *        tsx e2e/fixtures/seed-cli.ts contact-comment <projectId> <number> <visibility>
 *        tsx e2e/fixtures/seed-cli.ts milestone <milestoneId>
 *        tsx e2e/fixtures/seed-cli.ts big-project <tenantId> [size]
 *        tsx e2e/fixtures/seed-cli.ts drop-project <projectId>
 *        tsx e2e/fixtures/seed-cli.ts portal-requests <tenantId>
 *        tsx e2e/fixtures/seed-cli.ts clear-portal-requests <tenantId> <contactEmail>
 *        tsx e2e/fixtures/seed-cli.ts notifications <tenantId>
 *        tsx e2e/fixtures/seed-cli.ts reset-notifications <tenantId>
 *        tsx e2e/fixtures/seed-cli.ts reset-signoffs <tenantId>
 *        tsx e2e/fixtures/seed-cli.ts reset-sealed-asks <tenantId>
 *        tsx e2e/fixtures/seed-cli.ts flag-login <tenantId> <loginName>
 *        tsx e2e/fixtures/seed-cli.ts reset-portal-sections <tenantId>
 *        tsx e2e/fixtures/seed-cli.ts reset-update-schedule <tenantId> <projectKey>
 *        tsx e2e/fixtures/seed-cli.ts client-summary-link <tenantId> <contactEmail>
 *        tsx e2e/fixtures/seed-cli.ts remove-users <email> [email…]
 *        tsx e2e/fixtures/seed-cli.ts sweep [maxAgeMinutes]
 *        tsx e2e/fixtures/seed-cli.ts sweep-dbtests [maxAgeMinutes]
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });
// The no-op limiter, as in the server this harness starts and in CI — the
// fixtures call services that spend a bucket (`portal-requests`), and they
// must not spend it in the founder's dev Redis. `playwright.config.ts` has
// the reasoning.
delete process.env["UPSTASH_REDIS_REST_URL"];
delete process.env["UPSTASH_REDIS_REST_TOKEN"];

const SLUG_PREFIX = "e2e-";
const EMAIL_DOMAIN = "@test.invalid";

/**
 * The vitest DB suite's throwaway tenant prefixes. Unlike the browser
 * harness, that suite has never swept its own: a crashed `beforeAll`, or
 * a run killed on a timeout, leaves the tenant behind, and fifteen had
 * accumulated on the shared dev database by 2026-09-02 — the oldest
 * three weeks old.
 *
 * An EXPLICIT list, never a wildcard, because it is one of the two
 * guards standing between a cleanup command and a real tenant.
 *
 * IT COMES FROM TWO MECHANISMS, and the first version of this list got
 * that wrong by reading dbtest FILE NAMES instead — it invented
 * `attach-`/`counters-`, which no fixture produces, and missed sixteen
 * real ones, so a sweep would have reported success while leaving most
 * orphans behind. Regenerate it with BOTH of these:
 *
 *   grep -rhoE 'setupTenant\("[^"]+"' src --include=*.ts
 *   grep -rhoE 'slug: *[`"][^`"$]*'    src --include=*.ts
 *
 * The first is `setupTenant(label)` (src/members/dbtest-fixture.ts builds
 * `${label}-${run}`); the second is the handful of suites that create a
 * tenant directly.
 *
 * **BOTH GREPS ARE BLIND TO A SHORTHAND PROPERTY** (2026-09-20,
 * regenerating this list after a review): a fixture that builds its slug
 * into a variable and passes `{ …, slug }` matches neither pattern, so it
 * is invisible to the recipe that is supposed to keep this list honest —
 * which is how `pauthz-` was missed the day it was written. A dbtest that
 * creates a tenant directly must spell the literal out at the `slug:` key
 * so the second grep can see it. That regeneration also turned up four
 * PRE-EXISTING misses (`desc-`, `portalc-`, `switch-*`, `tree-`), whose
 * orphans no sweep had ever collected — the same failure mode the
 * paragraph above records, a second time. Re-run the greps, do not trust
 * the list.
 */
const DBTEST_PREFIXES = [
  // Slice 84, account recovery and "Your devices" — `src/auth/account-security.dbtest.ts`,
  // `setupTenant("acsec")` and two tenants built directly (`slug: \`acsec-self-…\``,
  // `slug: \`acsec-other-…\``), all under this one prefix.
  "acsec-",
  "admin-",
  // Phase 3V slice 87, the asset registry — `src/modules/vault/assets.dbtest.ts`,
  // `setupTenant("assets")`.
  "assets-",
  "bulk-",
  "census-",
  // Phase 3, the invite slice — `src/clients/contact-access.dbtest.ts`,
  // which calls `setupTenant("cinv")` POSITIONALLY, so the first of the
  // two regeneration greps finds it unaided. (The shorthand-property
  // caveat above applies only to suites that build a tenant row
  // directly; an earlier version of this comment claimed it applied
  // here and pointed at a `slug:` key that does not exist.)
  "cinv-",
  "clients-",
  "copy-",
  // Phase 3 slice 77, a contact's last sign-in — `src/clients/contact-sign-ins.dbtest.ts`,
  // `setupTenant("csign")`.
  "csign-",
  // Phase 5 slice 101, the clients' weekly summary — `src/notify/client-digests.dbtest.ts`,
  // `setupTenant("csum")`.
  "csum-",
  "ctask-",
  "ctr-a-",
  "ctr-b-",
  "desc-",
  // Phase 5 slice 100, the team's summary email — `src/notify/digests.dbtest.ts`,
  // `setupTenant("digest")`.
  "digest-",
  "docs-",
  "enc-a-",
  "enc-b-",
  "exp-a-",
  "exp-b-",
  // Phase 3V slice 88, the expirations feed — `src/modules/vault/expirations.dbtest.ts`,
  // `setupTenant("expir")`.
  "expir-",
  "export-",
  "gate-",
  "inbox-",
  "iso-a-",
  "iso-b-",
  "members-",
  "mfa-",
  "money-",
  "ordering-",
  "pauthz-",
  // Phase 3 slice 75, a client's comment on a shared task —
  // `src/modules/work/portal-comment.dbtest.ts`, `setupTenant("pcomm")`.
  "pcomm-",
  // Phase 3, the portal files slice — `src/documents/portal.dbtest.ts`,
  // `setupTenant("pfil")`.
  "pfil-",
  "portalc-",
  // Phase 3, progress updates — `src/modules/work/updates.dbtest.ts`,
  // `setupTenant("pupd")`.
  "pupd-",
  // Phase 3, the hours & retainer widget — `src/modules/time/portal.dbtest.ts`,
  // `setupTenant("phrs")`.
  "phrs-",
  "prefs-",
  "prefs-notify-",
  "preq-",
  // Phase 3, the Client Timeline — `src/modules/work/portal-timeline.dbtest.ts`,
  // `setupTenant("ptl")`.
  "ptl-",
  // **A HISTORICAL PREFIX WITH NO LIVE CREATOR — do not delete it when
  // regenerating this list.** Nothing in `src/`, `e2e/` or `scripts/`
  // creates a `probe-` tenant today, so BOTH greps above come back
  // empty for it and a regeneration would drop it as dead. It is here
  // because an orphan was found in the dev database on 2026-09-22 (one
  // day old, from an ad-hoc script since deleted), and without the
  // entry `sweep-dbtests` could never collect it — the `pauthz-`
  // failure mode arriving by a different door: that one was invisible
  // because the grep could not see its shape, this one because its
  // creator is gone. The greps keep this list COMPLETE; they cannot
  // keep it CORRECT, and a prefix costs nothing but a `startsWith`.
  "probe-",
  "projects-",
  // Phase 3 slice 80, the per-section portal switches — `src/projects/portal-sections.dbtest.ts`,
  // `setupTenant("psect")`.
  "psect-",
  // Phase 3, the portal files-and-services slice — `src/services/portal.dbtest.ts`,
  // `setupTenant("pser")`.
  "pser-",
  // Phase 3, version sign-off — `src/portal/signoff.dbtest.ts`,
  // `setupTenant("psign")`.
  "psign-",
  // Phase 3 slice 74, the portal switch gate — `src/projects/portal-switch-gate.dbtest.ts`,
  // `setupTenant("pstamp")`.
  "pstamp-",
  "pvas-",
  "pview-",
  "pwork-",
  // Phase 3V slice 89, the renewal reminders — `src/modules/vault/reminders.dbtest.ts`,
  // `setupTenant("remind")`.
  "remind-",
  // Phase 5 slice 100, the workspace's reply address — `src/notify/reply-address.dbtest.ts`,
  // `setupTenant("replyto")`.
  "replyto-",
  "reports-",
  "roles-",
  "scope-",
  "search-",
  "split-",
  "switch-",
  "tadmin-",
  "time-",
  "totals-",
  "tree-",
  "triage-",
  // Phase 5 slice 102, the progress-update reminders —
  // `src/modules/work/update-reminders.dbtest.ts`, `setupTenant("updrem")`.
  "updrem-",
  // Phase 3V slice 99, the door's alarm — `src/modules/vault/door-alarm.dbtest.ts`,
  // `setupTenant("valarm")`.
  "valarm-",
  // Phase 3V slice 98, the agency asking a client for a login —
  // `src/modules/vault/asks.dbtest.ts`, `setupTenant("vask")`.
  "vask-",
  // Phase 3V slice 1, the vault core — `src/modules/vault/vault.dbtest.ts`,
  // `setupTenant("vault")`, and the tenant-key back-fill —
  // `src/crypto/tenant-key-backfill.dbtest.ts`, `setupTenant("vkey")`.
  "vault-",
  // Phase 3V slice 95, the plaintext export — `src/modules/vault/export.dbtest.ts`,
  // `setupTenant("vexp")`.
  "vexp-",
  // Phase 3V slice 97, logins in search — `src/modules/vault/search.dbtest.ts`,
  // `setupTenant("vfind")`.
  "vfind-",
  "vkey-",
  // Phase 3V slice 90, share links — `src/modules/vault/share.dbtest.ts`,
  // `setupTenant("vlink")`.
  "vlink-",
  // Phase 3V slice 94, offboarding flags — `src/modules/vault/offboarding.dbtest.ts`,
  // `setupTenant("voff")`.
  "voff-",
  // Phase 3V slice 91, the logins shown to a client —
  // `src/modules/vault/portal-logins.dbtest.ts`, `setupTenant("vport")`.
  "vport-",
  // Phase 3V slice 99, the vault's retention — `src/modules/vault/retention.dbtest.ts`,
  // `setupTenant("vret")`.
  "vret-",
  // Phase 3V slice 92, the sealed layer's staff side —
  // `src/modules/vault/seal.dbtest.ts`, `setupTenant("vseal")`.
  "vseal-",
  // Phase 3V slice 93, the client's ask and the wait —
  // `src/modules/vault/sealed.dbtest.ts`, `setupTenant("vsask")`.
  "vsask-",
  // Phase 3V slice 93b, the silent path in time (CI only) —
  // `src/modules/vault/sealed-time.dbtest.ts`, `setupTenant("vstime")`.
  "vstime-",
  // Phase 3V slice 96, portal submission — `src/modules/vault/submission.dbtest.ts`,
  // `setupTenant("vsub")`.
  "vsub-",
  // Phase 3 slice 72, the sharing UI — `src/modules/work/visibility.dbtest.ts`,
  // `setupTenant("vshare")`.
  "vshare-",
  "work-",
  "wu-",
] as const;

const isThrowawaySlug = (slug: string): boolean =>
  slug.startsWith(SLUG_PREFIX) || DBTEST_PREFIXES.some((p) => slug.startsWith(p));

/**
 * THE PEOPLE MEMBER ACCOUNT RECOVERY NEEDS (C30), and the ONLY users this
 * file ever deletes outside `removeTenant`. They belong to NO workspace —
 * a reset or a confirmation happens before anybody is anybody's member —
 * so `removeTenant`'s "every member of the tenant" loop never reaches
 * them, and without an explicit rule of their own nothing would ever
 * collect them.
 *
 *  - `e2e-reset-` / `e2e-confirm-` — the two the fixture seeds so the new
 *    screens have links that stand still (`provision`);
 *  - `e2e-recovery-` — the ones `member-recovery.spec.ts` signs up through
 *    the real form.
 *
 * An EXPLICIT list, like `DBTEST_PREFIXES`, and narrower than "any `e2e-`
 * address": the vitest suites mint `e2e-portal-…`, `e2e-member-…` and
 * similar users of their own, which this path has no business deleting
 * (`sweep-dbtests` collects the suites' bare users, `DBTEST_USER_PREFIXES`). Every deletion also requires `@test.invalid`, no membership
 * anywhere and no console role (`removeRecoveryUsers`).
 */
const RECOVERY_USER_PREFIXES = ["e2e-reset-", "e2e-confirm-", "e2e-recovery-"] as const;

const isRecoveryAddress = (email: string): boolean =>
  email.endsWith(EMAIL_DOMAIN) && RECOVERY_USER_PREFIXES.some((p) => email.startsWith(p));

/**
 * THE VITEST DB SUITE'S BARE USERS — people a dbtest creates with no tenant
 * around them, so `DBTEST_PREFIXES` (tenant slugs) can never reach them, and a
 * run killed before its `afterAll` would leave them on the shared dev database
 * for good (C30's review). Some are CONSOLE principals on purpose — the suites
 * that prove a SUPERADMIN is declined a reset, or reset by the operator's
 * script — which is why `sweep-dbtests` may take a console role for exactly
 * these prefixes and no others.
 *
 * Kept by hand, like `DBTEST_PREFIXES`: `grep -n "@test.invalid" src/**\/*.dbtest.ts`
 * and look for any address a dbtest turns into a USER with no tenant around
 * it — by `user.create` OR through a sign-up (`signUpEmail(`, `/sign-up/email`),
 * which a grep for `user.create` alone misses (the fix review found two that
 * way). Today:
 *   - `plane-ep-`   src/auth/plane-endpoints.dbtest.ts (slice 58)
 *   - `member-rec-` src/auth/member-recovery.dbtest.ts (C30)
 *   - `ops-reset-`  src/jobs/reset-ops-password.dbtest.ts (C30)
 *   - `auth-`       src/auth/auth.dbtest.ts (a sign-up)
 *   - `e2e-member-` src/auth/portal.dbtest.ts (a sign-up; no browser fixture uses it)
 */
export const DBTEST_USER_PREFIXES = ["plane-ep-", "member-rec-", "ops-reset-", "auth-", "e2e-member-"] as const;
/** Single-line, machine-readable result channel (stdout also carries logs). */
const MARKER = "__E2E_RESULT__";

type PlatformDb = ReturnType<typeof import("../../src/db/client").getPlatformClient>;

export type E2ESeed = {
  readonly tenantId: string;
  readonly tenantSlug: string;
  /** The workspace's display name — what the header shows, and how a
   *  spec tells the two workspaces apart after a switch. */
  readonly tenantName: string;
  readonly userId: string;
  readonly email: string;
  readonly memberId: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly projectId: string;
  readonly projectKey: string;
  readonly milestoneId: string;
  /**
   * A milestone that HAS a due date and is CLIENT_VISIBLE — the subject
   * of hazard H1's round-trip test: editing its name through an inline
   * edit must leave both of those columns untouched.
   */
  readonly datedMilestoneId: string;
  readonly datedMilestoneName: string;
  /**
   * The portal timeline's fixture (Phase 3): a CLIENT_VISIBLE milestone
   * already reached, a CLIENT_VISIBLE one still to come, and the label
   * of the one shipped version — each an entry on the contact's rail.
   * The INTERNAL "Lansering" milestone beside them is the negative
   * control and is deliberately NOT in this type: nothing on the portal
   * plane may need its name.
   */
  readonly reachedMilestoneName: string;
  readonly upcomingMilestoneName: string;
  readonly shippedVersion: string;
  /**
   * The sign-off fixture (Phase 3): a SECOND shipped version whose
   * sign-off the seed REQUESTS, so the contact's home carries a "Waiting
   * on you" card and the rail an approve / request-changes control —
   * and so `e2e/portal-signoff.spec.ts` has something to decide. The
   * shared deliverable below is asked about too. Both are put back to
   * PENDING by that spec's teardown (`resetSignoffs`), so the walks that
   * follow it photograph the seeded state whether or not it ran.
   */
  readonly pendingVersion: string;
  readonly pendingVersionId: string;
  /** Seeded CLIENT_VISIBLE document — the one BUG 1 is reproduced on. */
  readonly clientVisibleDocId: string;
  readonly clientVisibleDocName: string;
  /**
   * The portal files fixture (Phase 3): a shared DELIVERABLE on the
   * portal-enabled project, in two versions — first on the contact's
   * files list, two entries on their rail — and the INTERNAL deliverable
   * beside it, which is the negative control and must appear on no
   * portal surface. The shared agreement `/portal/company` draws, and
   * the sentinel planted in its staff-only notes.
   */
  readonly deliverableDocId: string;
  readonly deliverableDocName: string;
  readonly internalDeliverableDocName: string;
  readonly serviceName: string;
  readonly serviceNotesSentinel: string;
  /**
   * The hours & retainer fixture (Phase 3): the project shares hours
   * and amounts, carries a monthly hours budget, has two months of the
   * employee's time and one PUBLISHED time report grouped by task.
   * `hoursInternalTaskTitle` is the INTERNAL task an entry sits on — the
   * report folds it into "Other work", and the title must appear
   * nowhere on the portal.
   */
  readonly timeReportTitle: string;
  readonly hoursInternalTaskTitle: string;
  /** Seeded INTERNAL document — the reverse direction. */
  readonly internalDocId: string;
  readonly internalDocName: string;
  /** Temp dir holding the fixture's bytes; removed at teardown. */
  readonly storageDir: string;

  /* ── A SECOND workspace for the same owner ─────────────────────────
   * The owner belongs to two tenants, so `/dashboard` is a picker with
   * something to pick and the account menu's "Switch workspace" item
   * (offered only above one membership, UI.md rule 8) exists at all.
   * Without it neither the offer nor the switch could be tested in a
   * browser: every assertion could only ever be an ABSENCE.
   *
   * Deliberately EMPTY — no client, project or document. It is the
   * destination of a switch, and an empty workspace makes "am I in the
   * other one?" unmistakable. It is torn down with the first. */
  readonly secondTenantId: string;
  readonly secondTenantSlug: string;
  readonly secondTenantName: string;

  /* ── Visual-sweep fixture (e2e/visual.spec.ts) ──────────────────────
   * A one-row table hides every alignment defect there is, and an
   * empty state that is empty because nothing was seeded proves
   * nothing. These rows exist so the screenshots show the app as a
   * working workspace looks: several clients (one archived, one with a
   * name long enough to truncate), projects in three statuses,
   * contacts, services, milestones with and without dates, documents
   * at both visibilities and at all three scopes, and one pending
   * invitation — which is also what /invite/[token] renders. */
  readonly longClientId: string;
  readonly longClientName: string;
  readonly archivedClientId: string;
  /** ACTIVE project, carries a production URL (header action button). */
  readonly activeProjectKey: string;
  /** COMPLETED project — the third status badge in the list. */
  readonly completedProjectKey: string;
  /**
   * The same project's id. It belongs to the OTHER client, so it is out
   * of the employee's scope — which is what makes it the control in the
   * `/api/version` 404-parity probe (AUTHZ.md §4: a denial and a missing
   * row must be indistinguishable).
   */
  readonly completedProjectId: string;
  /** Tenant-scoped document: no client, no project, INTERNAL by law. */
  readonly tenantDocId: string;
  /** Project-scoped CLIENT_VISIBLE document (project Files tab). */
  readonly projectDocId: string;
  /**
   * Raw token of a PENDING invitation into the throwaway tenant. It is
   * worthless the moment teardown deletes the row, it is never printed,
   * and it lives only in the gitignored seed file.
   */
  readonly inviteToken: string;
  readonly inviteEmail: string;

  /* ── The portal plane's principal ──────────────────────────────────
   * The CONTACT_PRIMARY contact of `clientId`, ACTIVE, invited and
   * credentialled, so the harness can hold a real portal session. Its
   * password is never in this file: global-setup generates it, passes it
   * to the worker in an env var and signs in with it once. */
  readonly contactEmail: string;
  readonly contactName: string;

  /**
   * THE PORTAL'S TASK PAGE FIXTURE (Phase 3 slice 75): the shared
   * accessibility task and the three comments on it, oldest first — the
   * agency's to the client, the contact's own (Astrid's) after it, and an
   * INTERNAL note that no contact surface may ever show.
   */
  readonly sharedTaskId: string;
  /** Its member-side key ("E1A2-4"), for opening the peek at `backlog?item=`. */
  readonly sharedTaskKey: string;
  readonly sharedTaskTitle: string;
  /** The agency's comment to the client — the thread's first. */
  readonly agencyCommentText: string;
  /** The contact's own comment after it — the newest the client can see. */
  readonly clientCommentText: string;
  readonly internalNoteText: string;

  /**
   * A LIVE PORTAL INVITATION — the raw token of a PENDING
   * `contact_invite` for a third contact of `clientId`, who sits at
   * INVITED. The acceptance page has no other stable address to be
   * photographed at, and nothing consumes this: a visit only previews.
   * Worthless the moment teardown deletes the row, never printed, and
   * it lives only in the gitignored seed file — the same contract as
   * `inviteToken`.
   */
  readonly contactInviteToken: string;
  readonly contactInviteEmail: string;

  /**
   * A LIVE PASSWORD-RESET LINK for the ACTIVE contact above — the raw
   * token of a `contact_verification` row, so the new-password screen has
   * a stable address to be photographed at. A visit only reads it; the
   * form's POST would spend it AND revoke the contact's shared session, so
   * no spec may ever submit it. Same contract as `contactInviteToken`.
   */
  readonly contactResetToken: string;

  /* ── Member account recovery (C30) ─────────────────────────────────
   * Two people who belong to NO workspace, each with a link that stands
   * still, so the member plane's recovery screens have addresses to be
   * photographed at (`e2e/fixtures/stops.ts`). Both tokens are worthless
   * the moment teardown deletes their user, are never printed, and live
   * only in the gitignored seed file — `contactResetToken`'s contract.
   *
   * NOTHING MAY SPEND EITHER. A visit only reads (`memberResetHolder`,
   * `confirmEmailHolder`); the walks photograph the pages and never press
   * their buttons. `member-recovery.spec.ts` signs up people of its own
   * for everything that submits. */
  /** A CONFIRMED user with a credential and a live reset link. */
  readonly memberResetEmail: string;
  /** The raw token of that link — `/reset-password/<token>`. */
  readonly memberResetToken: string;
  /** An UNCONFIRMED user with a credential — the confirmation page's subject. */
  readonly memberConfirmEmail: string;
  /** A sign-up confirmation JWT for that address — `/confirm-email/<token>`. */
  readonly memberConfirmToken: string;

  /* ── Member-plane scoping fixture (e2e/scoping.spec.ts) ─────────────
   * An employee — the template role WITHOUT client:view_all — assigned
   * to exactly one client. The long-name client and its completed
   * project double as the forbidden targets: the employee holds no
   * assignment there, so reaching them must be a 404. The password is
   * worthless the moment teardown deletes the tenant, is never printed,
   * and lives only in the gitignored seed file (same contract as
   * inviteToken above). */
  readonly employeeEmail: string;
  readonly employeePassword: string;

  /* ── Vault fixture (Phase 3V slice 85, founder decision C52) ────────
   * A MANAGER with an ENROLLED authenticator, assigned directly to the
   * client — the one member in the harness who can open the vault (the
   * owner has no factor, and every spec shares the owner's session). The
   * spec signs them in with a code computed from `vaultTotpSecret` (the
   * HMAC key's UTF-8 text, as Better Auth keeps it), which stamps a fresh
   * factor exactly as a real sign-in does. Two logins are written through
   * the vault's own service; their values are sentinels the spec looks
   * for on screen and in the clipboard. All of it is worthless once
   * teardown deletes the tenant, never printed, and lives only in the
   * gitignored seed file. */
  readonly vaultEmail: string;
  readonly vaultPassword: string;
  readonly vaultTotpSecret: string;
  /* ── A second OWNER with an enrolled authenticator (3V slice 93b) ────
   * The fixture's first owner has no factor and every spec shares that
   * session; the owner-only and ✦ vault verbs — show a login to the client
   * (C59), unseal and delete a sealed login (C60), answer a client's ask
   * (C61) — need an owner who can step up. Named "E2E Vault Owner" so no
   * spec's `/E2E Owner/` match reaches it. It is the fourth fixture member:
   * `settings.spec.ts` counts four. Never printed; worthless after
   * teardown; in the gitignored seed file only. */
  readonly vaultOwnerEmail: string;
  readonly vaultOwnerPassword: string;
  readonly vaultOwnerTotpSecret: string;
  readonly vaultLoginName: string;
  readonly vaultLoginPassword: string;
  readonly vaultApiKeyName: string;
  /** One of the AGENCY'S OWN logins (no client — C49), for `/vault` (slice 86). */
  readonly vaultAgencyLoginName: string;
  /**
   * A login SEALED for the client (3V slice 93), so Astrid's Logins page has
   * a sealed section — a count and the way to ask (C61 (a)). Its name must
   * never reach the portal before an ask opens it.
   */
  readonly vaultSealedLoginName: string;
  /**
   * A LIVE SHARE LINK's token (3V slice 90) to the vault login's password,
   * for the visual walk's share page. Never pressed: a visit previews only.
   */
  readonly vaultShareToken: string;
};

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

async function provision(seedFile: string): Promise<void> {
  const password = process.env["E2E_OWNER_PASSWORD"];
  if (!password) throw new Error("E2E_OWNER_PASSWORD is not set");
  // BEFORE anything is written, not beside the row that needs it: this
  // check used to sit 400 lines down, next to the contact credential, so
  // a manual `tsx seed-cli.ts provision` without the new var built the
  // whole tenant and then threw — leaving an orphan for the 90-minute
  // sweep to find (review).
  const contactPassword = process.env["E2E_CONTACT_PASSWORD"];
  if (!contactPassword) throw new Error("E2E_CONTACT_PASSWORD is not set");

  // THE SECRET THE CONFIRMATION LINK IS SIGNED WITH, resolved BEFORE the
  // first write for the reason the two checks above give. It is read off
  // the MEMBER INSTANCE ITSELF — `(await auth.$context).secret`, the very
  // value `confirmEmailHolder` and `/verify-email` verify with — rather
  // than off an env var by hand, because the library resolves it from
  // three variables (`BETTER_AUTH_SECRETS`, then `BETTER_AUTH_SECRET`,
  // then `AUTH_SECRET`, create-context.mjs) and a copy of that order here
  // is one more thing to drift. The instance sets no `secret` of its own
  // (src/auth/index.ts).
  //
  // BUT THE LIBRARY HAS A DEFAULT, and that is why this refuses rather than
  // trusting it: with none of the three set, a process that is not
  // production — this one — silently signs with Better Auth's built-in
  // test secret, while the production server the harness runs refuses to
  // start on it. The link would then verify nowhere, and the stop would
  // photograph the dead-link state under the live state's name. Nothing
  // here prints the value.
  if (!process.env["BETTER_AUTH_SECRETS"] && !process.env["BETTER_AUTH_SECRET"] && !process.env["AUTH_SECRET"]) {
    throw new Error(
      "BETTER_AUTH_SECRET is not set (nor BETTER_AUTH_SECRETS / AUTH_SECRET): the member " +
        "confirmation link cannot be signed with the secret the app verifies it with",
    );
  }
  const { auth: memberAuth } = await import("../../src/auth/index");
  const memberSecret = (await memberAuth.$context).secret;

  const { hashPassword } = await import("better-auth/crypto");
  const { getPlatformClient } = await import("../../src/db/client");
  const { provisionTenant } = await import("../../src/members/provisioning");
  const { assignMemberToClient } = await import("../../src/clients/assignments");
  const { archiveClient, createClient, createContact, updateClient } = await import(
    "../../src/clients/service"
  );
  const { createProject, setPortalEnabled, updateProject } = await import(
    "../../src/projects/service"
  );
  const { createService } = await import("../../src/services/service");
  const { createRateCard } = await import("../../src/modules/time");
  const {
    assignItem,
    changeItemVisibility,
    changeState,
    createComment,
    createItem,
    createLabel,
    createUpdateDraft,
    publishUpdate,
    setItemLabel,
    setItemMilestone,
    updateItemFields,
  } = await import("../../src/modules/work");
  const { dateColumn, localDateString } = await import("../../src/lib/duration");
  const { addDays } = await import("../../src/lib/week");
  const { completeMilestone, createMilestone, setMilestoneStatus } = await import(
    "../../src/projects/milestones"
  );
  const { createVersion, requestVersionSignoff, shipVersion } = await import("../../src/projects/versions");
  const { addVersion, commitUpload, createUpload, requestDocumentSignoff } = await import(
    "../../src/documents/service"
  );
  const { LocalDiskTransport, setStorage } = await import("../../src/storage");

  const run = randomUUID().slice(0, 8);
  const slug = `${SLUG_PREFIX}${run}`;
  const email = `e2e-owner-${run}${EMAIL_DOMAIN}`;
  const storageDir = join(tmpdir(), `fortleva-e2e-${run}`);
  mkdirSync(storageDir, { recursive: true });
  // Set before anything can call getStorage(): the fixture's bytes live
  // in a temp dir of their own, never in the repo's .dev-storage.
  const storage = new LocalDiskTransport(storageDir);
  setStorage(storage);

  const db = getPlatformClient();
  const user = await db.user.create({
    data: { name: "E2E Owner", email, emailVerified: true, locale: "en" },
  });
  await db.account.create({
    data: {
      userId: user.id,
      providerId: "credential",
      accountId: user.id,
      password: await hashPassword(password),
    },
  });

  const tenantName = `E2E ${run}`;
  const { tenantId, ownerMemberId } = await provisionTenant({
    name: tenantName,
    slug,
    ownerUserId: user.id,
  });

  // A SECOND workspace for the same owner, left empty. It exists so the
  // browser can test the two things a single membership makes
  // untestable: that the account menu OFFERS "Switch workspace" above
  // one membership, and that choosing a row actually switches. Its slug
  // carries the same `e2e-` prefix, so every teardown guard and the
  // orphan sweep apply to it unchanged.
  const secondSlug = `${SLUG_PREFIX}${run}-b`;
  const secondTenantName = `E2E ${run} B`;
  const { tenantId: secondTenantId } = await provisionTenant({
    name: secondTenantName,
    slug: secondSlug,
    ownerUserId: user.id,
  });

  // Seeding runs as the owner would: no ✦ code is involved, so the
  // browser session (which has no TOTP) can do the same work.
  const ctx = {
    tenantId,
    actor: { memberId: ownerMemberId, mfa: { enrolled: false, verifiedAt: null } },
  };

  const clientName = `E2E Client ${run}`;
  const { id: clientId } = await createClient(ctx, { name: clientName });
  const { id: projectId, key: projectKey } = await createProject(ctx, {
    clientId,
    key: `E${run.slice(0, 3).toUpperCase()}`,
    name: `E2E Project ${run}`,
  });
  const { id: milestoneId } = await createMilestone(ctx, {
    projectId,
    name: `E2E Milestone ${run}`,
  });

  /**
   * `scope` is the document's owner: a client, a project, or neither
   * (tenant-wide, which the model only allows to be INTERNAL).
   */
  /** Presign + the browser's half of the upload, performed in process; returns the PENDING object's id. */
  const putBytes = async (name: string, body: Uint8Array, scope: { clientId?: string; projectId?: string }) => {
    const presigned = await createUpload(ctx, {
      name,
      contentType: "text/plain",
      sizeBytes: body.byteLength,
      sha256: sha256(body),
      ...scope,
    });
    const key = new URL(presigned.uploadUrl).pathname
      .replace(/^\/api\/dev-storage\//, "")
      .split("/")
      .map(decodeURIComponent)
      .join("/");
    const res = await storage.handlePut(
      new Request(presigned.uploadUrl, {
        method: "PUT",
        headers: { ...presigned.headers },
        body: Buffer.from(body),
      }),
      key,
    );
    if (res.status !== 200) throw new Error(`fixture upload failed: ${res.status}`);
    return presigned.fileObjectId;
  };
  const document = async (
    name: string,
    visibility: "INTERNAL" | "CLIENT_VISIBLE",
    scope: { clientId?: string; projectId?: string } = { clientId },
    /** Phase 3, the portal files slice: a DELIVERABLE sits first on the client's list and on their rail. */
    kind: "GENERAL" | "DELIVERABLE" = "GENERAL",
  ) => {
    const fileObjectId = await putBytes(name, new TextEncoder().encode(`${name}\n`), scope);
    const { documentId } = await commitUpload(ctx, { fileObjectId, ...scope, visibility, kind });
    return documentId;
  };
  /** A further version of a document, through the real service — one more entry on the client's rail. */
  const version = async (documentId: string, scope: { clientId?: string; projectId?: string }, text: string) => {
    const fileObjectId = await putBytes(`v-${run}.txt`, new TextEncoder().encode(text), scope);
    await addVersion(ctx, { documentId, fileObjectId, note: "Slutversion" });
  };

  // ── Phase 3, the portal files slice ────────────────────────────────
  // A shared DELIVERABLE on the portal-enabled project, in TWO versions,
  // so the contact's files list photographs a deliverable with "Version
  // 2" and the rail carries two delivery entries; and an INTERNAL
  // deliverable beside it as the negative control. Created HERE, before
  // the milestones and the update below, so its versions are older than
  // every "today" event and `e2e/portal-project.spec.ts` can pin the
  // rail's order.
  const deliverableDocName = `e2e-leverans-${run}.txt`;
  const deliverableDocId = await document(deliverableDocName, "CLIENT_VISIBLE", { projectId }, "DELIVERABLE");
  await version(deliverableDocId, { projectId }, `Slutversion av leveransen ${run}\n`);
  const internalDeliverableDocName = `e2e-intern-leverans-${run}.txt`;
  await document(internalDeliverableDocName, "INTERNAL", { projectId }, "DELIVERABLE");

  // ── Visual-sweep fixture ───────────────────────────────────────────
  // Everything below exists so the screenshots show populated tables,
  // several statuses and a real invitation rather than a workspace of
  // one row. All of it is inside the throwaway tenant and all of it is
  // removed by teardown() below.
  await updateClient(ctx, clientId, {
    orgNr: "556677-8899",
    city: "Stockholm",
    countryCode: "SE",
    billingEmail: `billing-${run}${EMAIL_DOMAIN}`,
  });

  const longClientName = `Långnamn Förvaltning & Digital Byrå Aktiebolag ${run}`;
  const { id: longClientId } = await createClient(ctx, {
    name: longClientName,
    city: "Göteborg",
    countryCode: "SE",
  });
  const { id: archivedClientId } = await createClient(ctx, { name: `E2E Archived ${run}` });
  await archiveClient(ctx, archivedClientId);

  const contactEmail = `astrid-${run}${EMAIL_DOMAIN}`;
  const contactName = "Astrid Lindqvist";
  const { id: contactId } = await createContact(ctx, clientId, {
    name: contactName,
    email: contactEmail,
    title: "Marknadschef",
    phone: "+46 70 123 45 67",
    portalProfile: "CONTACT_PRIMARY",
  });
  await createContact(ctx, clientId, {
    name: "Bo Nilsson",
    email: `bo-${run}${EMAIL_DOMAIN}`,
    title: "Utvecklare",
    portalProfile: "CONTACT_COLLABORATOR",
  });

  // ── A contact with a LIVE INVITATION, so the acceptance page has a
  // token that stands still ──────────────────────────────────────────
  //
  // Three contacts now, one in each of the states a member can see on
  // the Contacts tab: ACTIVE (Astrid, below), NO_ACCESS (Bo) and
  // INVITED (Carina). That is the fixture doing what it is for — the
  // visual and Swedish-width walks photograph the tab, and a tab that
  // only ever showed one status was photographing a third of it.
  //
  // **THE ROW IS WRITTEN DIRECTLY, NOT THROUGH `inviteContact()`, for
  // the same reason the member invitation above is**: the service sends
  // mail after it commits, and a fixture must not leave an envelope in
  // `.dev-outbox` for a spec to trip over — `portal-invite.spec.ts`
  // reads that file and takes the LAST line for its address, and a
  // second invitation in there would be a puzzle nobody needs. Same
  // columns, same hash, both stamps (`portalStatus` and `invitedAt`, the
  // pair `authorizePortal` and the credential trigger both read).
  //
  // The raw token goes into the seed exactly as `inviteToken` does for
  // the member plane, and is what `stops.ts` points the acceptance page
  // at. Nothing consumes it — a visit only previews — so it stays
  // PENDING for the life of the fixture.
  const contactInviteEmail = `carina-${run}${EMAIL_DOMAIN}`;
  const { id: invitedContactId } = await createContact(ctx, clientId, {
    name: "Carina Ek",
    email: contactInviteEmail,
    title: "Projektledare",
    portalProfile: "CONTACT_COLLABORATOR",
  });
  const contactInviteToken = randomBytes(32).toString("base64url");
  await db.contactInvite.create({
    data: {
      tenantId,
      contactId: invitedContactId,
      email: contactInviteEmail,
      tokenHash: createHash("sha256").update(contactInviteToken).digest("hex"),
      invitedByMemberId: ownerMemberId,
      // Three days, spelled out: `day` is declared further down the file.
      expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    },
  });
  await db.contact.update({
    where: { tenantId_id: { tenantId, id: invitedContactId } },
    data: { portalStatus: "INVITED", invitedAt: new Date(), invitedById: ownerMemberId },
  });

  const { id: activeProjectId, key: activeProjectKey } = await createProject(ctx, {
    clientId,
    key: `A${run.slice(0, 3).toUpperCase()}`,
    name: `Webbplats ${run}`,
    type: "Website",
    status: "ACTIVE",
  });
  await updateProject(ctx, activeProjectId, {
    productionUrl: "https://example.invalid",
    scopeSummary: "Ny webbplats, tre språk, e-handel.",
  });
  const { id: completedProjectId, key: completedProjectKey } = await createProject(ctx, {
    clientId: longClientId,
    key: `C${run.slice(0, 3).toUpperCase()}`,
    name: `Designsystem ${run}`,
    status: "COMPLETED",
  });

  const day = 24 * 60 * 60 * 1000;
  // ── The project's plan, as the portal's one-screen page reads it ───
  // (Phase 3, the Client Timeline slice). Four milestones in plan order
  // — one reached, one in progress (the header's "Phase:"), one INTERNAL
  // (the negative control: it must appear on no portal surface), one
  // shared and still to come (the header's "Next milestone:") — and one
  // shipped version with release notes, so the contact's timeline
  // photographs with every kind of entry on it and
  // `e2e/portal-project.spec.ts` has each to assert on. Every row goes
  // through the real service, so the audit trail and the stamps are the
  // product's own.
  const datedMilestoneName = "Designgranskning";
  const { id: datedMilestoneId } = await createMilestone(ctx, {
    projectId,
    name: datedMilestoneName,
    description: "Genomgång av flöden och komponenter med kunden.",
    dueAt: new Date(Date.now() - 14 * day),
    visibility: "CLIENT_VISIBLE",
  });
  await setMilestoneStatus(ctx, datedMilestoneId, "IN_PROGRESS");
  await createMilestone(ctx, {
    projectId,
    name: "Lansering",
    dueAt: new Date(Date.now() + 21 * day),
  });
  // APPENDED, NOT PREPENDED — the plan's rank order is what the item
  // panel's milestone picker lists, and `e2e/item-properties.spec.ts`
  // addresses its rows by ORDINAL (`item-milestone-0` is "E2E Milestone",
  // `-1` is Designgranskning). A reached milestone placed first would
  // have shifted both (a fresh code review caught it before CI did). The
  // portal orders by date, never by rank, so nothing there notices.
  const reachedMilestoneName = "Sidmallar";
  const { id: reachedMilestoneId } = await createMilestone(ctx, {
    projectId,
    name: reachedMilestoneName,
    description: "Sidmallar och navigation godkända.",
    dueAt: new Date(Date.now() - 21 * day),
    visibility: "CLIENT_VISIBLE",
  });
  await completeMilestone(ctx, reachedMilestoneId);
  const upcomingMilestoneName = "Innehållsinläsning";
  await createMilestone(ctx, {
    projectId,
    name: upcomingMilestoneName,
    dueAt: new Date(Date.now() + 7 * day),
    visibility: "CLIENT_VISIBLE",
  });
  const shippedVersion = "1.0";
  const { id: shippedVersionId } = await createVersion(ctx, {
    projectId,
    version: shippedVersion,
    title: "Staging",
    releaseNotes: "Sidmallar och navigation på plats. Formulär och sök återstår.",
  });
  await shipVersion(ctx, shippedVersionId, { shippedAt: new Date(Date.now() - 7 * day) });
  // The sign-off fixture: a second version, shipped two days ago, whose
  // sign-off is REQUESTED — one more `version_shipped` entry on the rail
  // (between the deliverable's versions and 1.0) with the control on it,
  // and a row on the home's "Waiting on you" card. The shared deliverable
  // is asked about too, at its second version. Both asks are made HERE,
  // after the portal switch above, because the service refuses an ask the
  // client could not see.
  const pendingVersion = "1.1";
  const { id: pendingVersionId } = await createVersion(ctx, {
    projectId,
    version: pendingVersion,
    title: "Formulär och sök",
    releaseNotes: "Kontaktformulär och sökfunktion på plats. Vänligen granska.",
  });
  await shipVersion(ctx, pendingVersionId, { shippedAt: new Date(Date.now() - 2 * day) });
  // The two ASKS are made further down, once the portal switch is on:
  // the service refuses an ask the client could not see.

  // SHARED with the client (Phase 3, the portal files-and-services
  // slice), so `/portal/company` photographs an agreement and
  // `e2e/portal-files.spec.ts` has one to assert on — and carrying the
  // staff-only notes column as a SENTINEL, the one string on this row a
  // client must never read. "Migrering" below stays INTERNAL and on a
  // portal-OFF project: the negative control twice over.
  const serviceName = "Förvaltning";
  const serviceNotesSentinel = `SENTINEL-INTERNAL-NOTES-${run}`;
  const { id: maintenanceServiceId } = await createService(ctx, {
    clientId,
    name: serviceName,
    description: "Löpande underhåll, säkerhetsuppdateringar och support.",
    kind: "RECURRING",
    billingInterval: "MONTHLY",
    priceExVat: "7500.00",
    currency: "SEK",
    startedAt: new Date(Date.now() - 200 * day),
    renewsAt: new Date(Date.now() + 30 * day),
    internalNotes: serviceNotesSentinel,
    visibility: "CLIENT_VISIBLE",
  });
  await createService(ctx, {
    clientId,
    projectId: activeProjectId,
    name: "Migrering",
    kind: "ONE_TIME",
    priceExVat: "42000.00",
    currency: "SEK",
  });

  // 2T: two BILL rate cards — the workspace default and the agreement's
  // own — so /settings/rates and the Agreements tab photograph with rows
  // and e2e/settings.spec.ts has something to assert. BILL cards are
  // rate:manage_bill (no ✦), so the owner's session could do the same.
  await createRateCard(ctx, { kind: "BILL", scope: "TENANT", amount: "950", currency: "SEK", effectiveFrom: "2026-01-01" });
  await createRateCard(ctx, {
    kind: "BILL",
    scope: "SERVICE",
    serviceId: maintenanceServiceId,
    amount: "1200",
    currency: "SEK",
    effectiveFrom: "2026-01-01",
  });

  // 2W: a handful of tasks on the main project so the board and the
  // backlog photograph as a working project (cards in three columns,
  // one assigned, one client-visible, estimates, a priority) and
  // e2e/work.spec.ts has neighbours to drop between. Written through
  // the services — numbering, rank, state machine, activity, audit —
  // exactly as the owner's session would. The first create seeds the
  // project's states lazily (ensureProjectStates); the rest read them.
  // Due dates put the owner's three assigned tasks in three of /home's
  // queue groups (overdue, next 7 days, later) for e2e/home.spec.ts and
  // the sweep. THREE DAYS each side of today, in the tenant's default
  // zone: a run that crosses midnight between this seed and the test
  // still finds each task in the same group.
  const today = localDateString(new Date(), "Europe/Stockholm");
  const dueIn = (days: number): Date => dateColumn(addDays(today, days));
  const firstTask = await createItem(ctx, { projectId, title: "Sätt upp staging-miljö" });
  await updateItemFields(ctx, firstTask.id, { priority: "HIGH", estimateMinutes: 120, targetDate: dueIn(-3) });
  await assignItem(ctx, firstTask.id, ownerMemberId);
  const workStates = await db.workflowState.findMany({
    where: { tenantId, projectId },
    select: { id: true, category: true },
    // Rank order makes stateIdOf deterministic now that IN_PROGRESS has
    // two states (In progress + In review, 2W-R): `find` takes the first
    // by rank — exactly the column the specs drag into. Keyed on
    // category and rank, never on a name: since 2026-09-01 a seeded
    // state has no stored name at all.
    orderBy: { rank: "asc" },
  });
  const stateIdOf = (category: string): string => {
    const s = workStates.find((w) => w.category === category);
    if (!s) throw new Error(`seed: no ${category} state on the project`);
    return s.id;
  };
  // The tenant's label vocabulary, so the board card and the backlog row
  // photograph WITH chips (2026-09-16). Three of them, and one task wears
  // all three: the row's cap is 2, so that task is the sweep's only view
  // of the folded `+1` chip, while two other tasks stay unlabelled and
  // keep the "no group at all" case in frame. Swedish words — this is a
  // Swedish agency's workspace, and `Label.name` is tenant data that is
  // never translated (UI.md §8).
  const labelIds: string[] = [];
  for (const name of ["Brådskande", "Design", "Väntar på kund"]) {
    labelIds.push((await createLabel(ctx, { name })).label.id);
  }

  const task = async (
    title: string,
    opts: {
      category?: string;
      priority?: "LOW" | "MEDIUM" | "HIGH" | "URGENT";
      hours?: number;
      assign?: boolean;
      clientVisible?: boolean;
      /** How many of the tenant's labels to file it under, in name order. */
      labels?: number;
    },
  ): Promise<string> => {
    const { id } = await createItem(ctx, { projectId, title });
    if (opts.priority || opts.hours) {
      await updateItemFields(ctx, id, {
        ...(opts.priority ? { priority: opts.priority } : {}),
        ...(opts.hours ? { estimateMinutes: Math.round(opts.hours * 60) } : {}),
      });
    }
    if (opts.assign) await assignItem(ctx, id, ownerMemberId);
    if (opts.clientVisible) await changeItemVisibility(ctx, id, "CLIENT_VISIBLE");
    if (opts.category) await changeState(ctx, id, stateIdOf(opts.category));
    for (const labelId of labelIds.slice(0, opts.labels ?? 0)) {
      await setItemLabel(ctx, id, labelId, true);
    }
    return id;
  };
  // Three labels: past the row's cap of 2, so this is the one task that
  // photographs the folded `+1` chip beside a truncating name.
  const specTaskId = await task("Skriv kravspecifikation", {
    category: "IN_PROGRESS",
    hours: 4,
    clientVisible: true,
    assign: true,
    labels: 3,
  });
  // Kept: the employee assigns this one to the owner below, which is
  // what puts a real notification in the owner's inbox.
  // One label — the common case, under the cap, nothing folded.
  // Named once: an hour of the hours-widget fixture below sits on this
  // INTERNAL task, and its title is the negative control the portal
  // spec searches the whole surface for — derived, so a rename cannot
  // leave the spec searching for a string that no longer exists.
  const hoursInternalTaskTitle = "Designgranskning med kunden";
  const reviewTaskId = await task(hoursInternalTaskTitle, { priority: "MEDIUM", hours: 1.5, labels: 1 });
  await updateItemFields(ctx, reviewTaskId, { targetDate: dueIn(3) });
  const dnsTaskId = await task("Migrera DNS till ny leverantör", { category: "DONE", hours: 1 });
  // Named once: the portal task-page spec and the visual walk address it
  // by title, so it is derived rather than typed twice (slice 75).
  const a11yTaskTitle = "Tillgänglighetsgranskning";
  const a11yTaskId = await task(a11yTaskTitle, { category: "BACKLOG" });

  // ── Phase 3: the portal fixture ────────────────────────────────────
  // Three shared tasks in three different portal categories, so the
  // `/portal` stop photographs the grouped list rather than one row, and
  // one of them carries the CLIENT_VISIBLE milestone so the "Phase:" line
  // is in frame. Everything else in this project stays INTERNAL, which is
  // what makes the stop a NEGATIVE control as well as a positive one: the
  // walk's screenshots are the only place a human ever looks at what a
  // contact sees.
  await changeItemVisibility(ctx, dnsTaskId, "CLIENT_VISIBLE");
  await changeItemVisibility(ctx, a11yTaskId, "CLIENT_VISIBLE");
  // ONE REPLY THE CLIENT CAN SEE, on the shared spec task (Phase 3 slice
  // 72): the one child that makes "Private to team" on KEY-2 ASK first —
  // "Make this task private, together with 1 comment?" — which is what
  // the visual walk's rail-question stop photographs. Through the real
  // comment service, by the owner; the stop only ever opens the question
  // and NEVER confirms it, so KEY-2 stays shared for every later spec.
  await createComment(ctx, specTaskId, {
    doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Utkastet är klart för granskning." }] }] },
    visibility: "CLIENT_VISIBLE",
  });
  await setItemMilestone(ctx, a11yTaskId, datedMilestoneId);
  await updateItemFields(ctx, a11yTaskId, { targetDate: dueIn(10) });
  // A CONVERSATION ON THE SHARED ACCESSIBILITY TASK (Phase 3 slice 75):
  // the agency's note to the client, the client's question after it, and
  // an internal note the client must never see — so the portal's task page
  // photographs a real thread signed two ways ("Your agency" and the
  // contact's own name), and `portal-comments.spec.ts` has a negative
  // control on the very page it reads. The client's comment is written
  // RAW, as `contact-comment` does: through the portal writer it would
  // announce itself to the project's people, and an inbox row planted
  // here would move every inbox count the other specs pin. The two
  // member comments go through the real service; the task has no
  // assignee, so neither notifies anybody.
  //
  // THE CLIENT'S COMMENT IS THE NEWEST ONE THE CLIENT CAN SEE, ON PURPOSE
  // (slice 76): "Your agency replied" (C45) is raised by an agency comment
  // that is newest, and `portal-comments.spec.ts` raises and clears it on
  // THIS task itself, so it must start with the client's word. (The spec
  // task above DOES carry an agency comment as its newest, so the portal's
  // cards show one real reply row by default — which the visual walk
  // photographs, and which `portal-signoff.spec.ts` counts around: it
  // counts its own sign-off rows only.)
  const agencyCommentText = "Vi har börjat granska sidorna – säg till om något särskilt ska kontrolleras.";
  const clientCommentText = "Kan ni också granska kontrasten i sidfoten?";
  const internalNoteText = "Intern anteckning: sidfoten ingår inte i offerten.";
  const { number: a11yTaskNumber } = await db.workItem.findUniqueOrThrow({
    where: { id: a11yTaskId },
    select: { number: true },
  });
  await createComment(ctx, a11yTaskId, {
    doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: agencyCommentText }] }] },
    visibility: "CLIENT_VISIBLE",
  });
  await db.comment.create({
    data: {
      tenantId,
      subjectType: "WORK_ITEM",
      subjectId: a11yTaskId,
      authorContactId: contactId,
      body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: clientCommentText }] }] },
      bodyText: clientCommentText,
      visibility: "CLIENT_VISIBLE",
    },
    select: { id: true },
  });
  await createComment(ctx, a11yTaskId, {
    doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: internalNoteText }] }] },
    visibility: "INTERNAL",
  });
  // THROUGH THE REAL SWITCH, not a column write: `setPortalEnabled` is
  // the emergency "stop showing this client our data" control, its
  // trigger fans `portal_enabled` out across ten tables, and a fixture
  // that set the column directly would leave every child row at false
  // and the portal list empty for a reason nobody could see.
  await setPortalEnabled(ctx, projectId, true);
  // The sign-off fixture's two ASKS, now that the client can see the rows
  // (the service refuses an ask on a portal-off project): version 1.1,
  // shipped above, and the shared deliverable at its second version.
  await requestVersionSignoff(ctx, pendingVersionId);
  await requestDocumentSignoff(ctx, deliverableDocId);

  // ONE PUBLISHED PROGRESS UPDATE (Phase 3, DATA_MODEL §6.16), through
  // the real publish path so the number, the snapshots and the audit
  // row are the service's own. AT_RISK rather than the default, so the
  // health chip on the project header and the portal card is visibly a
  // choice; CLIENT_VISIBLE, so `portal-home` and the contact's updates
  // stop have a post to draw. `updates.spec.ts` publishes a SECOND one
  // and archives it before its test ends, so this stays the newest for
  // the visual sweep that runs after it; a failure before that step
  // leaves #2 as the newest, which changes screenshots and nothing that
  // is asserted.
  const paragraph = (text: string) => ({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });
  const { id: seededUpdateId } = await createUpdateDraft(ctx, projectId, {
    health: "AT_RISK",
    title: "Vecka 38: designgranskning klar, lansering flyttad",
    periodStart: addDays(today, -14),
    periodEnd: today,
    body: {
      sections: [
        { key: "SUMMARY", body: paragraph("Designgranskningen är klar och sidmallarna godkända. Lanseringen flyttas en vecka för att hinna med tillgänglighetsarbetet.") },
        { key: "DONE", body: paragraph("Staging-miljön är uppe och DNS-posterna är förberedda.") },
        { key: "NEXT", body: paragraph("Tillgänglighetsgranskning och innehållsinläsning under nästa vecka.") },
        { key: "DECISIONS_NEEDED", body: paragraph("Bekräfta det nya lanseringsdatumet senast fredag.") },
      ],
      metrics: { include: { tasks: true, milestones: true, versions: true, requests: true, hours: true } },
    },
  });
  await publishUpdate(ctx, seededUpdateId, { visibility: "CLIENT_VISIBLE" });

  // The invitation row is written directly rather than through
  // createInvite(): the service also sends mail, and a fixture must not
  // leave an envelope in .dev-outbox behind. Same columns, same hash.
  const inviteToken = randomBytes(32).toString("base64url");
  const inviteEmail = `e2e-invitee-${run}${EMAIL_DOMAIN}`;
  await db.memberInvite.create({
    data: {
      tenantId,
      email: inviteEmail,
      proposedRoleIds: [],
      tokenHash: createHash("sha256").update(inviteToken).digest("hex"),
      invitedByMemberId: ownerMemberId,
      expiresAt: new Date(Date.now() + 7 * day),
    },
  });

  // ── Member-plane scoping fixture ───────────────────────────────────
  // A real employee: sign-in-capable (verified email + credential
  // account, exactly like the owner above), holding the Employee
  // template role — the one WITHOUT client:view_all — and one client
  // assignment, written through the real service so the fixture walks
  // the same requireAccess → assertInScope → audit path a member would.
  const employeeEmail = `e2e-employee-${run}${EMAIL_DOMAIN}`;
  const employeePassword = randomBytes(24).toString("base64url");
  const employeeUser = await db.user.create({
    data: { name: "E2E Employee", email: employeeEmail, emailVerified: true, locale: "en" },
  });
  await db.account.create({
    data: {
      userId: employeeUser.id,
      providerId: "credential",
      accountId: employeeUser.id,
      password: await hashPassword(employeePassword),
    },
  });
  const employeeMember = await db.member.create({
    data: { tenantId, userId: employeeUser.id, title: null },
  });
  const employeeRole = await db.role.findFirst({
    where: { tenantId, templateKey: "employee" },
    select: { id: true },
  });
  if (!employeeRole) throw new Error("provisionTenant seeded no employee role");
  await db.memberRole.create({
    data: { tenantId, memberId: employeeMember.id, roleId: employeeRole.id },
  });
  await assignMemberToClient({
    tenantId,
    actor: ctx.actor,
    memberId: employeeMember.id,
    clientId,
  });

  // ── Vault fixture (Phase 3V slice 85, C52) ─────────────────────────
  // See `E2ESeed.vaultEmail`. The factor row is written the way Better
  // Auth's own `/two-factor/enable` + verify leave it: the secret and the
  // backup codes encrypted with `symmetricEncrypt` under the MEMBER
  // instance's secret config, `verified`, and the user's flag set.
  const vaultEmail = `e2e-vault-${run}${EMAIL_DOMAIN}`;
  const vaultPassword = randomBytes(24).toString("base64url");
  const vaultTotpSecret = randomBytes(24).toString("base64url");
  const { symmetricEncrypt } = await import("better-auth/crypto");
  const memberSecretConfig = (await memberAuth.$context).secretConfig;
  const vaultUser = await db.user.create({
    data: { name: "E2E Vault Manager", email: vaultEmail, emailVerified: true, locale: "en", twoFactorEnabled: true },
  });
  await db.account.create({
    data: {
      userId: vaultUser.id,
      providerId: "credential",
      accountId: vaultUser.id,
      password: await hashPassword(vaultPassword),
    },
  });
  await db.twoFactor.create({
    data: {
      userId: vaultUser.id,
      secret: await symmetricEncrypt({ key: memberSecretConfig, data: vaultTotpSecret }),
      backupCodes: await symmetricEncrypt({
        key: memberSecretConfig,
        data: JSON.stringify(Array.from({ length: 10 }, () => randomBytes(5).toString("hex"))),
      }),
      verified: true,
    },
  });
  const vaultMember = await db.member.create({ data: { tenantId, userId: vaultUser.id, title: null } });
  const managerRole = await db.role.findFirst({
    where: { tenantId, templateKey: "manager" },
    select: { id: true },
  });
  if (!managerRole) throw new Error("provisionTenant seeded no manager role");
  await db.memberRole.create({ data: { tenantId, memberId: vaultMember.id, roleId: managerRole.id } });
  await assignMemberToClient({ tenantId, actor: ctx.actor, memberId: vaultMember.id, clientId });

  // ── A second owner with an authenticator (3V slice 93b) ─────────────
  // See `E2ESeed.vaultOwnerEmail`. The factor row as the manager's above.
  const vaultOwnerEmail = `e2e-vault-owner-${run}${EMAIL_DOMAIN}`;
  const vaultOwnerPassword = randomBytes(24).toString("base64url");
  const vaultOwnerTotpSecret = randomBytes(24).toString("base64url");
  const vaultOwnerUser = await db.user.create({
    data: { name: "E2E Vault Owner", email: vaultOwnerEmail, emailVerified: true, locale: "en", twoFactorEnabled: true },
  });
  await db.account.create({
    data: {
      userId: vaultOwnerUser.id,
      providerId: "credential",
      accountId: vaultOwnerUser.id,
      password: await hashPassword(vaultOwnerPassword),
    },
  });
  await db.twoFactor.create({
    data: {
      userId: vaultOwnerUser.id,
      secret: await symmetricEncrypt({ key: memberSecretConfig, data: vaultOwnerTotpSecret }),
      backupCodes: await symmetricEncrypt({
        key: memberSecretConfig,
        data: JSON.stringify(Array.from({ length: 10 }, () => randomBytes(5).toString("hex"))),
      }),
      verified: true,
    },
  });
  const vaultOwnerMember = await db.member.create({ data: { tenantId, userId: vaultOwnerUser.id, title: null } });
  const ownerRole = await db.role.findFirst({ where: { tenantId, templateKey: "owner" }, select: { id: true } });
  if (!ownerRole) throw new Error("provisionTenant seeded no owner role");
  await db.memberRole.create({ data: { tenantId, memberId: vaultOwnerMember.id, roleId: ownerRole.id } });

  // Through the vault's own service, as the manager would — encrypted,
  // audited — with the fresh factor the door wants.
  const { createCredential } = await import("../../src/modules/vault");
  const vaultCtx = { tenantId, actor: { memberId: vaultMember.id, mfa: { enrolled: true, verifiedAt: new Date() } } };
  const vaultLoginName = `E2E WordPress admin ${run}`;
  const vaultLoginPassword = `pw-${randomBytes(12).toString("base64url")}`;
  const vaultLogin = await createCredential(vaultCtx, {
    clientId,
    type: "LOGIN",
    name: vaultLoginName,
    username: "admin@wp.e2e.test",
    url: "https://wp.e2e.test/wp-admin",
    secret: { password: vaultLoginPassword },
    totp: "JBSWY3DPEHPK3PXP",
  });
  // 3V slice 91: client logins switched ON for the workspace and this login
  // SHOWN to the client, through the services as the owner would — with the
  // fresh factor showing always asks — so Astrid (CONTACT_PRIMARY) has a
  // Logins entry and one login behind her door for the whole run. No spec
  // may switch it off: that hides every shown login for good (C59 (b)).
  const { showLoginToClient } = await import("../../src/modules/vault");
  const { updatePreferences } = await import("../../src/preferences/service");
  const ownerFresh = { tenantId, actor: { memberId: ownerMemberId, mfa: { enrolled: true, verifiedAt: new Date() } } };
  await updatePreferences(ownerFresh, { vault: { allowPortalCredentials: true } });
  await showLoginToClient(ownerFresh, vaultLogin.id);
  const vaultApiKeyName = `E2E Stripe ${run}`;
  await createCredential(vaultCtx, {
    projectId,
    type: "API_KEY",
    name: vaultApiKeyName,
    secret: { apiKey: `pk_test_${run}`, apiSecret: `sk_test_${randomBytes(12).toString("base64url")}` },
  });
  // 3V slice 90: ONE LIVE SHARE LINK to that login's password, made through
  // the share service as the manager would (a fresh factor, `credential:
  // share`), so the visual walk has a share page that stands still. A visit
  // only previews — loading the page never mails a code or opens it — and
  // no spec may press anything on it: `vault-share.spec.ts` makes its own.
  const { createShareLink } = await import("../../src/modules/vault");
  // Its OWN fresh factor: a share wants one no older than a minute, and
  // `vaultCtx`'s was stamped before the two logins above were written.
  const shareCtx = { tenantId, actor: { memberId: vaultMember.id, mfa: { enrolled: true, verifiedAt: new Date() } } };
  const vaultShare = await createShareLink(shareCtx, vaultLogin.id, {
    field: "password",
    recipientEmail: `e2e-share-seed-${run}${EMAIL_DOMAIN}`,
    expiresInHours: 168,
    includeUsername: true,
  });
  const vaultShareToken = vaultShare.url.slice(vaultShare.url.indexOf("/portal/share/") + "/portal/share/".length);
  // Slice 86: one of the agency's OWN logins — no client, no project — which
  // the manager reaches because their scope is the whole tenant (C49).
  const vaultAgencyLoginName = `E2E Registrar ${run}`;
  await createCredential(vaultCtx, {
    type: "LOGIN",
    name: vaultAgencyLoginName,
    username: "hostmaster@e2e.test",
    secret: { password: `reg-${randomBytes(12).toString("base64url")}` },
  });
  // 3V slice 93: ONE login SEALED for the client, through the vault's own
  // services as the manager would (anyone who may edit a login seals it,
  // C52 (e)), so Astrid's Logins page has a sealed section — a count and the
  // way to ask (C61 (a)). `portal-logins.spec.ts` asks and withdraws again;
  // nothing approves it, so its name never reaches the portal.
  const { sealLogin } = await import("../../src/modules/vault");
  const vaultSealedLoginName = `E2E Hosting panel ${run}`;
  const sealedLogin = await createCredential(vaultCtx, {
    clientId,
    type: "LOGIN",
    name: vaultSealedLoginName,
    username: "root@host.e2e.test",
    url: "https://panel.e2e.test",
    secret: { password: `host-${randomBytes(12).toString("base64url")}` },
  });
  await sealLogin(
    { tenantId, actor: { memberId: vaultMember.id, mfa: { enrolled: true, verifiedAt: new Date() } } },
    sealedLogin.id,
  );

  // 3V slice 87: the client's Assets tab, through the registry's own service
  // as the owner — a domain renewing in 20 days (the "coming up" strip's
  // caution line), the project's hosting, which renews by itself, and a
  // licence that lapsed three days ago. No factor needed: assets are not
  // behind the vault's door.
  const { createAsset } = await import("../../src/modules/vault");
  const utcDayFromNow = (days: number) => {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + days);
    return d;
  };
  await createAsset(ctx, {
    clientId,
    type: "DOMAIN",
    name: "e2e-acme.se",
    provider: "Loopia",
    identifier: "e2e-acme.se",
    url: "https://e2e-acme.se",
    expiresAt: utcDayFromNow(20),
    autoRenew: false,
    renewalCost: "149",
    fields: { nameservers: "ns1.loopia.se, ns2.loopia.se" },
  });
  await createAsset(ctx, {
    clientId,
    projectId,
    type: "HOSTING",
    name: "E2E website hosting",
    provider: "Hetzner",
    expiresAt: utcDayFromNow(200),
    autoRenew: true,
    renewalCost: "1200",
    fields: { plan: "CX22", server: "web1.e2e.test" },
  });
  await createAsset(ctx, {
    clientId,
    type: "LICENSE",
    name: "E2E Elementor Pro",
    provider: "Elementor",
    expiresAt: utcDayFromNow(-3),
    autoRenew: false,
    fields: { seats: 3 },
  });

  // 2W notifications: the one notification in the standing fixture, and
  // it is PRODUCED rather than inserted — the employee (who now holds
  // the client) assigns a task to the owner, so `notify.emit` runs
  // inside the same transaction the assignment does, exactly as it will
  // in production. That is what gives /inbox a row and the rail its
  // badge for e2e/inbox.spec.ts and the visual sweep. It also enqueues
  // one EmailOutbox row, which teardown removes; no worker runs here,
  // so nothing is ever sent and .dev-outbox stays empty.
  await assignItem(
    { tenantId, actor: { memberId: employeeMember.id, mfa: { enrolled: false, verifiedAt: null } } },
    reviewTaskId,
    ownerMemberId,
  );

  // ── Hours & retainer fixture (Phase 3, the hours widget slice) ─────
  // The employee's time on the portal-enabled project, written by the
  // owner (`time:edit_any` — another member's row needs no staff-notice
  // acknowledgment, so the employee's own first timer in time.spec
  // still meets the notice). Dated 35 and 70 days back, so the entries
  // fall in two different months and never the current one: the week
  // exports in time.spec, the owner's "this week" strip on /home and
  // the money tab's period never see them, and the widget's "this
  // month" tile reads zero whatever else has run. The project shares
  // HOURS AND AMOUNTS — money on a client's screen is the case worth
  // photographing and asserting — and carries a monthly hours budget,
  // so the budget tile has a fact to show. One entry sits on the
  // INTERNAL task, so the published report's task grouping folds it
  // into "Other work": that task's title is the negative control
  // portal-project.spec.ts searches the whole surface for.
  const { createBudget, createEntry, generateReport, publishReport } = await import("../../src/modules/time");
  const { setHoursSharingMode } = await import("../../src/projects/service");
  await updateProject(ctx, projectId, { billingCurrency: "SEK" });
  const entryOn = (localDate: string, workItemId: string, durationText: string) =>
    createEntry(ctx, {
      memberId: employeeMember.id,
      workItemId,
      durationText,
      localDate,
      billable: true,
      description: "E2E hours fixture",
    });
  await entryOn(addDays(today, -70), specTaskId, "2h 30m");
  await entryOn(addDays(today, -35), specTaskId, "3h");
  await entryOn(addDays(today, -35), reviewTaskId, "1h");
  await setHoursSharingMode(ctx, projectId, "BILLABLE_AMOUNT");
  await createBudget(ctx, {
    projectId,
    kind: "HOURS",
    billingModel: "RETAINER",
    amount: "40",
    period: "MONTHLY",
    periodAnchor: `${today.slice(0, 7)}-01`,
  });
  const timeReportTitle = `Tidrapport ${run}`;
  const { id: timeReportId } = await generateReport(ctx, {
    projectId,
    title: timeReportTitle,
    periodStart: addDays(today, -75),
    periodEnd: addDays(today, -30),
    groupBy: "WORK_ITEM",
    includeAmounts: true,
  });
  await publishReport(ctx, timeReportId);

  // ── Portal-plane fixture: a contact who can really sign in ─────────
  // The portal has no sign-up and no invite flow yet, so the credential
  // is written the way invite acceptance will write it — directly, into
  // `contact_account`, after the row is ACTIVE and STAMPED AS INVITED.
  // Both stamps are load-bearing rather than decorative: the database
  // trigger `contact_account_requires_invite` refuses a credential for a
  // contact that is neither INVITED nor ACTIVE, and `authorizePortal()`
  // requires `invitedAt` on the row — an activation path that forgets it
  // produces a contact who can hold a session and do nothing
  // (src/portal/policy.ts).
  //
  // The password is generated per run by the test worker and arrives in
  // an env var, exactly like the owner's: never written to the seed file,
  // never printed.
  await db.contact.update({
    where: { tenantId_id: { tenantId, id: contactId } },
    data: {
      emailVerified: true,
      portalStatus: "ACTIVE",
      invitedAt: new Date(Date.now() - 7 * day),
      activatedAt: new Date(Date.now() - 6 * day),
      invitedById: ownerMemberId,
    },
  });
  await db.contactAccount.create({
    data: {
      contactId,
      accountId: contactId,
      providerId: "credential",
      password: await hashPassword(contactPassword),
    },
  });

  // ── A LIVE PASSWORD-RESET LINK for Astrid, so the new-password screen
  // has an address that stands still ─────────────────────────────────
  //
  // Written directly, for the reason Carina's invitation is: asking
  // `/request-password-reset` would MAIL it, and a fixture must not leave
  // an envelope in `.dev-outbox` for a spec to trip over.
  //
  // **NOTHING MAY EVER SPEND IT.** A visit only reads (`portalResetHolder`);
  // only the form's POST consumes a link, and a reset REVOKES every session
  // the contact holds — five specs share Astrid's one session, and her
  // password lives nowhere after global setup, so a spent link here would
  // sign the rest of the run out with no way back in. The walks photograph
  // the page and never press its button.
  //
  // STORED AS THE INSTANCE STORES IT — `verification.storeIdentifier:
  // "hashed"`, the SHA-256 of the whole identifier in base64url without
  // padding (better-auth/dist/db/verification-token-storage.mjs). A plain
  // row would still resolve through the library's fallback, and the stop
  // would then be photographing a path production never takes.
  const contactResetToken = randomBytes(18).toString("hex");
  await db.contactVerification.create({
    data: {
      identifier: createHash("sha256")
        .update(`reset-password:${contactResetToken}`)
        .digest("base64url"),
      value: contactId,
      expiresAt: new Date(Date.now() + 3 * day),
    },
  });

  // ── MEMBER ACCOUNT RECOVERY (C30): two people who belong to no
  // workspace, each holding a link that stands still ──────────────────
  //
  // Both links are written directly, for the reason Astrid's is: asking
  // `/request-password-reset` or signing up would MAIL them, and a fixture
  // must not leave envelopes in `.dev-outbox` for `member-recovery.spec.ts`
  // to trip over. Neither person is anybody's member, so `removeTenant`
  // never reaches them: `teardown` deletes both by address, and the sweep
  // collects them if a run is killed (`RECOVERY_USER_PREFIXES`). Their
  // passwords are random, used by nobody and never kept.
  //
  // THE RESET LINK, STORED AS THE MEMBER INSTANCE STORES IT —
  // `storedResetIdentifierOf`, the very function its
  // `verification.storeIdentifier` override hashes with, so no copy of the
  // `pwreset#` form lives here to drift. A plain row would never resolve at
  // all: `memberResetHolder` looks up the stored form only. Twenty-four
  // URL-safe characters, the length Better Auth mints.
  const { storedResetIdentifierOf } = await import("../../src/auth/reset-identifier");
  const credentialFor = async (userId: string): Promise<void> => {
    await db.account.create({
      data: {
        userId,
        providerId: "credential",
        accountId: userId,
        password: await hashPassword(randomBytes(24).toString("base64url")),
      },
    });
  };
  const memberResetEmail = `e2e-reset-${run}${EMAIL_DOMAIN}`;
  const resetUser = await db.user.create({
    data: { name: "E2E Reset", email: memberResetEmail, emailVerified: true, locale: "en" },
  });
  await credentialFor(resetUser.id);
  const memberResetToken = randomBytes(18).toString("base64url");
  await db.verification.create({
    data: {
      identifier: storedResetIdentifierOf(memberResetToken),
      value: resetUser.id,
      expiresAt: new Date(Date.now() + 3 * day),
    },
  });

  // THE CONFIRMATION LINK, SIGNED AS BETTER AUTH SIGNS ONE — its own
  // `createEmailVerificationToken`, with the member instance's secret
  // (resolved at the top of this function) and no `updateTo`, which is
  // what makes it a SIGN-UP link rather than a change-of-address one
  // (`isSignUpLink`). Three days, like every token here, not the hour a
  // mailed one gets: it must outlive the run. A JWT writes no row, so
  // there is nothing to delete but the person.
  const { createEmailVerificationToken } = await import("better-auth/api");
  const memberConfirmEmail = `e2e-confirm-${run}${EMAIL_DOMAIN}`;
  const confirmUser = await db.user.create({
    data: { name: "E2E Confirm", email: memberConfirmEmail, emailVerified: false, locale: "en" },
  });
  await credentialFor(confirmUser.id);
  const memberConfirmToken = await createEmailVerificationToken(
    memberSecret,
    memberConfirmEmail,
    undefined,
    3 * 24 * 60 * 60,
  );

  // PROVE BOTH LINKS ARE LIVE, through the SAME reads the two pages make.
  // Without this a link the pages refuse is not a failure anywhere: the
  // stop still renders one h1 and an icon, and photographs "Link not
  // available" under the name of the live state. (The stops also assert
  // the live form is on screen, which is what catches a SERVER that
  // resolved a different secret; this catches the seed disagreeing with
  // the instance's own reads.) Reads only — neither consumes anything.
  const { memberResetHolder } = await import("../../src/auth/member-recovery");
  const { confirmEmailHolder } = await import("../../src/auth/member-screens");
  const resetHolder = await memberResetHolder(memberResetToken);
  if (!resetHolder || resetHolder.email !== memberResetEmail || resetHolder.twoFactor) {
    throw new Error("seed: the member reset link does not resolve the way /reset-password/[token] reads it");
  }
  const confirmHolder = await confirmEmailHolder(memberConfirmToken);
  if (!confirmHolder || confirmHolder.email !== memberConfirmEmail || confirmHolder.confirmed) {
    throw new Error("seed: the confirmation link does not verify the way /confirm-email/[token] reads it");
  }

  const clientVisibleDocName = `e2e-shared-${run}.txt`;
  const internalDocName = `e2e-private-${run}.txt`;
  const seed: E2ESeed = {
    tenantId,
    tenantSlug: slug,
    tenantName,
    userId: user.id,
    email,
    memberId: ownerMemberId,
    clientId,
    clientName,
    projectId,
    projectKey,
    milestoneId,
    datedMilestoneId,
    datedMilestoneName,
    reachedMilestoneName,
    upcomingMilestoneName,
    shippedVersion,
    pendingVersion,
    pendingVersionId,
    clientVisibleDocId: await document(clientVisibleDocName, "CLIENT_VISIBLE"),
    clientVisibleDocName,
    internalDocId: await document(internalDocName, "INTERNAL"),
    internalDocName,
    deliverableDocId,
    deliverableDocName,
    internalDeliverableDocName,
    serviceName,
    serviceNotesSentinel,
    timeReportTitle,
    hoursInternalTaskTitle,
    storageDir,
    secondTenantId,
    secondTenantSlug: secondSlug,
    secondTenantName,
    longClientId,
    longClientName,
    archivedClientId,
    activeProjectKey,
    completedProjectKey,
    completedProjectId,
    tenantDocId: await document(`e2e-tenant-${run}.txt`, "INTERNAL", {}),
    projectDocId: await document(`e2e-projekt-${run}.txt`, "CLIENT_VISIBLE", { projectId }),
    inviteToken,
    inviteEmail,
    contactEmail,
    contactName,
    sharedTaskId: a11yTaskId,
    sharedTaskKey: `${projectKey}-${a11yTaskNumber}`,
    sharedTaskTitle: a11yTaskTitle,
    agencyCommentText,
    clientCommentText,
    internalNoteText,
    contactInviteToken,
    contactInviteEmail,
    contactResetToken,
    memberResetEmail,
    memberResetToken,
    memberConfirmEmail,
    memberConfirmToken,
    employeeEmail,
    employeePassword,
    vaultEmail,
    vaultPassword,
    vaultTotpSecret,
    vaultOwnerEmail,
    vaultOwnerPassword,
    vaultOwnerTotpSecret,
    vaultLoginName,
    vaultLoginPassword,
    vaultApiKeyName,
    vaultAgencyLoginName,
    vaultSealedLoginName,
    vaultShareToken,
  };

  mkdirSync(dirname(seedFile), { recursive: true });
  writeFileSync(seedFile, JSON.stringify(seed, null, 2), "utf8");
  await db.$disconnect();
  process.stdout.write(`${MARKER}${JSON.stringify({ tenantSlug: slug })}\n`);
}

/**
 * Remove everything the fixture created — rows first, then the tenant,
 * the owner (sessions and credentials cascade) and the audit trail.
 */
/**
 * Delete every row a throwaway tenant owns, then the tenant itself.
 * Guarded twice: the caller must have matched the slug prefix, and this
 * refuses anything else outright. Audit rows need the maintenance GUC —
 * the table is append-only to every ordinary path.
 */
async function removeTenant(
  db: PlatformDb,
  tenantId: string,
  slug: string,
): Promise<void> {
  if (!isThrowawaySlug(slug)) {
    throw new Error(`refusing to remove non-throwaway tenant "${slug}"`);
  }
  // The BELT, and the one that actually matters: a slug is a naming
  // convention, but a member with a real address is evidence. Even if a
  // prefix above were ever wrong, a tenant holding one non-synthetic
  // user is refused outright.
  const outsider = await db.member.findFirst({
    where: { tenantId, user: { email: { not: { endsWith: EMAIL_DOMAIN } } } },
    select: { user: { select: { email: true } } },
  });
  if (outsider) {
    throw new Error(
      `refusing to remove tenant "${slug}": it has a real member (${outsider.user.email})`,
    );
  }
  // 2T: time rows reference projects/members/tenant with RESTRICT; published
  // reports and locked entries refuse deletion outside the maintenance GUCs.
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.time_maintenance', 'on', true)`;
    await tx.$executeRaw`SELECT set_config('app.time_lock_bypass', 'on', true)`;
    // Phase 3: a published progress update refuses DELETE outside the
    // work-maintenance GUC (20260925200000), and the project cascade
    // below would run that trigger.
    await tx.$executeRaw`SELECT set_config('app.work_maintenance', 'on', true)`;
    await tx.projectUpdate.deleteMany({ where: { tenantId } });
    await tx.timeReport.deleteMany({ where: { tenantId } });
    await tx.budgetAlert.deleteMany({ where: { tenantId } });
    await tx.projectBudget.deleteMany({ where: { tenantId } });
    await tx.timeEntry.deleteMany({ where: { tenantId } });
    await tx.shiftBreak.deleteMany({ where: { tenantId } });
    await tx.shift.deleteMany({ where: { tenantId } });
    await tx.rateCard.deleteMany({ where: { tenantId } });
    await tx.projectTimeSummary.deleteMany({ where: { tenantId } });
    await tx.staffNoticeAcknowledgment.deleteMany({ where: { tenantId } });
    await tx.staffNotice.deleteMany({ where: { tenantId } });
    await tx.workType.deleteMany({ where: { tenantId } });
    await tx.tenantKey.deleteMany({ where: { tenantId } });
  });
  // 2W: tenant-scoped rows that RESTRICT the tenant (and comment/label,
  // which RESTRICT the project) — a spec that assigns a task or crosses a
  // budget threshold leaves notification + email_outbox rows behind.
  await db.comment.deleteMany({ where: { tenantId } }); // mentions cascade
  await db.label.deleteMany({ where: { tenantId } }); // work_item_label cascades
  await db.workItemActivity.deleteMany({ where: { tenantId } });
  // `work_item` has TWO self-referencing foreign keys and both must be
  // unwound before the delete. `parent_id` is handled by the two passes
  // below; `duplicate_of_id` is `ON DELETE RESTRICT`
  // (20260820170000:502) and is NOT satisfied by the referencing row
  // being deleted in the same statement, so a single DUPLICATE row left
  // in a tenant made `removeTenant` throw `23503`.
  //
  // IT HAD NO WRITER UNTIL SLICE 6b, which is why this was never
  // needed and why it is needed now: `sweepDbtests` loops over stale
  // tenants with no try/catch, so ONE orphan holding a duplicate would
  // abort the whole sweep and leave every later tenant uncollected.
  // Found by both fresh reviews; the dbtest's own teardown already did
  // exactly this and the harness was not given the same treatment.
  await db.workItem.updateMany({
    where: { tenantId, duplicateOfId: { not: null } },
    data: { triageStatus: null, triageReason: null, duplicateOfId: null },
  });
  await db.workItem.deleteMany({ where: { tenantId, parentId: { not: null } } });
  await db.workItem.deleteMany({ where: { tenantId } });
  // `assignee_contact_id` (slice 6c, its own first writer) is RESTRICT
  // too — and needs nothing here, because it points at `contact`, which
  // this function deletes LATER. Checked rather than assumed: the
  // residue above exists because a "no path reaches this" disposition
  // had not looked in `e2e/`, and the next column with a restricting FK
  // deserves the same two minutes.
  await db.workflowState.deleteMany({ where: { tenantId } });
  await db.tenantCounter.deleteMany({ where: { tenantId } }); // work_item:<project> numbering (RESTRICTs the tenant)
  await db.notification.deleteMany({ where: { tenantId } });
  await db.emailOutbox.deleteMany({ where: { tenantId } });
  await db.subscription.deleteMany({ where: { tenantId } });
  await db.notificationPreference.deleteMany({ where: { tenantId } });
  await db.workflowPreset.deleteMany({ where: { tenantId } });
  await db.projectTemplate.deleteMany({ where: { tenantId } });
  // RESTRICTs the tenant. The browser fixture never writes one, so this
  // was missing until a dbtest tenant that HAD set a preference (the
  // 2T exports suite flips `hoursSharingMode`) refused to delete on
  // 2026-09-02 with a 23001 on `tenant_preference_tenant_id_fkey`.
  await db.tenantPreference.deleteMany({ where: { tenantId } });
  await db.$executeRaw`DELETE FROM search_index WHERE tenant_id = ${tenantId}`;
  await db.fileVersion.deleteMany({ where: { tenantId } });
  await db.document.deleteMany({ where: { tenantId } });
  await db.fileObject.deleteMany({ where: { tenantId } });
  await db.milestone.deleteMany({ where: { tenantId } });
  await db.projectVersion.deleteMany({ where: { tenantId } });
  await db.service.deleteMany({ where: { tenantId } });
  // 3V: a credential RESTRICTs its client, project and tenant; its secret
  // and versions go with it (ON DELETE CASCADE).
  await db.credentialItem.deleteMany({ where: { tenantId } });
  // 3V slice 87: an asset RESTRICTs its client, project and tenant too.
  await db.clientAsset.deleteMany({ where: { tenantId } });
  // 3V slice 89: the renewal reminders' dedupe RESTRICTs the tenant (a run
  // of `POST /api/jobs/run` against a fixture tenant writes it).
  await db.expirationReminderSent.deleteMany({ where: { tenantId } });
  // Phase 5 slice 102: the update reminders' dedupe RESTRICTs the tenant too
  // (it also goes with its project, which is deleted below).
  await db.projectUpdateReminderSent.deleteMany({ where: { tenantId } });
  await db.memberProject.deleteMany({ where: { tenantId } });
  await db.memberClient.deleteMany({ where: { tenantId } });
  // A contact's password-reset rows have no FK to it — a row is looked up
  // BY its token — so deleting the contact takes nothing with it, and the
  // fixture seeds one (`contactResetToken`). By `value`, the contact id.
  const contactIds = (await db.contact.findMany({ where: { tenantId }, select: { id: true } })).map(
    (c) => c.id,
  );
  await db.contactVerification.deleteMany({ where: { value: { in: contactIds } } });
  await db.contact.deleteMany({ where: { tenantId } });
  await db.project.deleteMany({ where: { tenantId } });
  await db.client.deleteMany({ where: { tenantId } });
  await db.memberInvite.deleteMany({ where: { tenantId } });
  await db.memberRole.deleteMany({ where: { tenantId } });
  await db.rolePermission.deleteMany({ where: { tenantId } });
  await db.role.deleteMany({ where: { tenantId } });
  const members = await db.member.findMany({ where: { tenantId }, select: { userId: true } });
  await db.member.deleteMany({ where: { tenantId } });
  await db.tenant.deleteMany({ where: { id: tenantId } });
  for (const { userId } of members) {
    await db.user.deleteMany({
      where: { id: userId, email: { endsWith: EMAIL_DOMAIN }, memberships: { none: {} } },
    });
  }
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.audit_maintenance', 'on', true)`;
    await tx.auditEvent.deleteMany({ where: { tenantId } });
  });

  // Prove it. Reporting a teardown that did not happen is worse than
  // failing: eight orphaned tenants accumulated in the shared dev
  // database behind a "torn down" log line before this check existed.
  const survivor = await db.tenant.findUnique({ where: { id: tenantId }, select: { slug: true } });
  if (survivor) {
    throw new Error(`teardown did not remove throwaway tenant "${survivor.slug}" (${tenantId})`);
  }
}

/**
 * DELETE THE RECOVERY FIXTURE'S PEOPLE BY ADDRESS — the seeded pair at
 * teardown, the spec's sign-ups from its `afterAll`, and stale ones from
 * `sweep`. The one path in this file that deletes a user who is not a
 * member of a throwaway tenant, so it carries its own guards, all checked
 * for EVERY address before ANYTHING is deleted:
 *
 *  1. the address must be a recovery fixture's own (`isRecoveryAddress`:
 *     one of `RECOVERY_USER_PREFIXES`, and `@test.invalid`);
 *  2. the user must be a member of NO workspace — a membership is
 *     evidence somebody depends on the person, and this is not the path
 *     that unwinds one;
 *  3. and must hold no console role.
 *
 * Their `verification` rows go first, BY `value` (the user id): a reset
 * link, a two-factor challenge or a trusted device has no key to `user`,
 * so deleting the person takes none of them along. `session`, `account`,
 * `two_factor` and the `auth_mail` ledger cascade from the user row.
 * No audit rows exist to remove — `recordForUserMemberships` writes one
 * per ACTIVE membership, and these people have none.
 *
 * Returns how many users were removed; an address with no user is not an
 * error (the spec's `afterAll` names addresses a failed test never made).
 */
async function removeRecoveryUsers(db: PlatformDb, requested: readonly string[]): Promise<number> {
  const emails = [...new Set(requested.map((e) => e.trim().toLowerCase()))];
  const outside = emails.filter((e) => !isRecoveryAddress(e));
  if (outside.length > 0) {
    throw new Error(`refusing to remove users outside the recovery fixture: ${outside.join(", ")}`);
  }
  // An empty `in` matches nothing, but an empty call has nothing to do and
  // should not reach the database at all.
  if (emails.length === 0) return 0;
  const users = await db.user.findMany({
    where: { email: { in: emails } },
    select: { id: true, email: true, platformRole: true, _count: { select: { memberships: true } } },
  });
  const held = users.filter((u) => u._count.memberships > 0 || (u.platformRole ?? "") !== "");
  if (held.length > 0) {
    throw new Error(
      `refusing to remove ${held.map((u) => u.email).join(", ")}: a workspace member or a console principal`,
    );
  }
  const ids = users.map((u) => u.id);
  if (ids.length === 0) return 0;
  await db.verification.deleteMany({ where: { value: { in: ids } } });
  // The guards AGAIN, in the statement itself: the check above and this
  // delete are two statements, and a membership granted between them
  // must stop the delete rather than be cascaded into.
  const { count } = await db.user.deleteMany({
    where: { id: { in: ids }, email: { endsWith: EMAIL_DOMAIN }, memberships: { none: {} }, platformRole: null },
  });
  // Prove it, as `removeTenant` does: a cleanup that silently did less
  // than it said is how orphans accumulate.
  const left = await db.user.findMany({ where: { id: { in: ids } }, select: { email: true } });
  if (left.length > 0) {
    throw new Error(`did not remove recovery user(s): ${left.map((u) => u.email).join(", ")}`);
  }
  return count;
}

/**
 * Sweep throwaway tenants an interrupted run left behind. Teardown is
 * keyed on a seed file, so a killed process (or a webServer that dies
 * mid-suite) orphans its tenant; without this they accumulate in the
 * shared dev database. Only "e2e-"-prefixed tenants older than the age
 * guard are touched, so a concurrent run is never harmed.
 *
 * And the recovery fixture's PEOPLE (C30), under the same age guard: they
 * belong to no tenant, so a killed run would otherwise leave them for
 * good — the seeded pair when teardown never ran, a spec's sign-ups when
 * its `afterAll` never did. `removeRecoveryUsers` carries the guards; the
 * query narrows to what it will accept, so one person it would refuse
 * cannot abort the sweep of the rest.
 */
async function sweep(maxAgeMinutesRaw: string | undefined): Promise<void> {
  const maxAgeMinutes = Number(maxAgeMinutesRaw ?? 60);
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60_000);
  const { getPlatformClient } = await import("../../src/db/client");
  const db = getPlatformClient();
  const stale = await db.tenant.findMany({
    where: { slug: { startsWith: SLUG_PREFIX }, createdAt: { lt: cutoff } },
    select: { id: true, slug: true },
  });
  for (const t of stale) await removeTenant(db, t.id, t.slug);
  const staleUsers = await db.user.findMany({
    where: {
      createdAt: { lt: cutoff },
      email: { endsWith: EMAIL_DOMAIN },
      OR: RECOVERY_USER_PREFIXES.map((prefix) => ({ email: { startsWith: prefix } })),
      memberships: { none: {} },
      platformRole: null,
    },
    select: { email: true },
  });
  const sweptUsers = await removeRecoveryUsers(
    db,
    staleUsers.map((u) => u.email),
  );
  await db.$disconnect();
  process.stdout.write(`${MARKER}${JSON.stringify({ swept: stale.length, sweptUsers })}\n`);
}

/** `remove-users <email>…` — `member-recovery.spec.ts`'s `afterAll`. */
async function removeUsers(emails: readonly string[]): Promise<void> {
  // Before the client is even built: a call with no address is a caller's
  // mistake, and must not read as "removed nothing, all clean".
  if (emails.length === 0) throw new Error("remove-users needs at least one address");
  const { getPlatformClient } = await import("../../src/db/client");
  const db = getPlatformClient();
  try {
    const removed = await removeRecoveryUsers(db, emails);
    process.stdout.write(`${MARKER}${JSON.stringify({ removed })}\n`);
  } finally {
    await db.$disconnect();
  }
}

/**
 * Remove the vitest DB suite's abandoned tenants — and, since C30, its
 * abandoned bare users (`DBTEST_USER_PREFIXES`). Manual, and age-gated
 * so it cannot take a tenant a run is still using — a local suite once
 * deleted a live CI fixture, which is why the age guard exists at all.
 *
 * Exits NON-ZERO if any tenant was refused. The deletes are not one
 * transaction, so a refusal can mean a half-emptied tenant, and a
 * cleanup that half-worked must not look the same as one that worked.
 */
async function sweepDbtests(maxAgeMinutesRaw: string | undefined): Promise<void> {
  const parsed = Number(maxAgeMinutesRaw ?? 90);
  // A floor, not just a NaN check: "" parses to 0, which would set the
  // cutoff to NOW and sweep a tenant a concurrent run is still using.
  const maxAgeMinutes = Number.isFinite(parsed) && parsed >= 30 ? parsed : 90;
  const cutoff = new Date(Date.now() - maxAgeMinutes * 60_000);
  const { getPlatformClient } = await import("../../src/db/client");
  const db = getPlatformClient();
  // Narrowed in SQL, like `sweep` — never "every tenant, filtered in JS".
  const stale = await db.tenant.findMany({
    where: {
      createdAt: { lt: cutoff },
      OR: DBTEST_PREFIXES.map((prefix) => ({ slug: { startsWith: prefix } })),
    },
    select: { id: true, slug: true },
  });
  const removed: string[] = [];
  const refused: string[] = [];
  for (const t of stale) {
    try {
      // removeTenant carries both guards: the prefix allow-list and the
      // real-member belt. Nothing here re-implements them.
      await removeTenant(db, t.id, t.slug);
      removed.push(t.slug);
    } catch (e) {
      refused.push(`${t.slug}: ${(e as Error).message}`);
    }
  }
  // THE BARE USERS (`DBTEST_USER_PREFIXES`), under the same age guard: never
  // a workspace member — a membership is somebody depending on the person —
  // and always `@test.invalid`, checked in the query AND in the delete. Their
  // `verification` rows go first, by user id (no key to `user`), and so do the
  // platform audit rows that NAME them (the operator script's suite writes
  // `platform.password_changed` with the user as target; the append-only
  // table allows a delete only under `app.audit_maintenance`, as `removeTenant`
  // does). That suite's `platform.system_job` rows carry the run only in their
  // free-text reason, which no sweep can match safely: they are left. Sessions,
  // credentials, factors and the mail ledger cascade.
  const bareWhere = {
    email: { endsWith: EMAIL_DOMAIN },
    OR: DBTEST_USER_PREFIXES.map((prefix) => ({ email: { startsWith: prefix } })),
    memberships: { none: {} },
  };
  const bare = await db.user.findMany({
    where: { ...bareWhere, createdAt: { lt: cutoff } },
    select: { id: true },
  });
  let removedUsers = 0;
  if (bare.length > 0) {
    const ids = bare.map((u) => u.id);
    await db.verification.deleteMany({ where: { value: { in: ids } } });
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.audit_maintenance', 'on', true)`;
      await tx.auditEvent.deleteMany({ where: { tenantId: null, targetId: { in: ids } } });
    });
    ({ count: removedUsers } = await db.user.deleteMany({ where: { ...bareWhere, id: { in: ids } } }));
  }
  await db.$disconnect();
  process.stdout.write(
    `${MARKER}${JSON.stringify({ maxAgeMinutes, removed, refused, removedUsers })}\n`,
  );
  if (refused.length > 0) process.exitCode = 1;
}

async function teardown(seedFile: string): Promise<void> {
  let seed: E2ESeed;
  try {
    seed = JSON.parse(readFileSync(seedFile, "utf8")) as E2ESeed;
  } catch {
    process.stdout.write(`${MARKER}{"removed":false}\n`);
    return;
  }
  const { getPlatformClient } = await import("../../src/db/client");
  const db = getPlatformClient();
  const { tenantId } = seed;

  // BOTH workspaces, and the main one FIRST: `removeTenant` deletes the
  // owner only once they hold no membership anywhere
  // (`memberships: { none: {} }`), so the second pass is what actually
  // removes the user. `secondTenantId` is read defensively — a seed file
  // written before this field existed would otherwise throw here and
  // strand the tenant it CAN remove.
  const ids = [tenantId, seed.secondTenantId].filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
  for (const id of ids) {
    const tenant = await db.tenant.findUnique({ where: { id }, select: { slug: true } });
    const slug = tenant?.slug ?? (id === tenantId ? seed.tenantSlug : seed.secondTenantSlug);
    if (tenant && !tenant.slug.startsWith(SLUG_PREFIX)) {
      throw new Error(`refusing to tear down non-throwaway tenant "${tenant.slug}"`);
    }
    await removeTenant(db, id, slug);
  }
  // The recovery fixture's two people (C30), who belong to no tenant and
  // so were reached by nothing above. Read defensively, like
  // `secondTenantId`: a seed file written before these fields existed must
  // still tear down what it can.
  await removeRecoveryUsers(
    db,
    [seed.memberResetEmail, seed.memberConfirmEmail].filter(
      (email): email is string => typeof email === "string" && email.length > 0,
    ),
  );
  await db.$disconnect();

  rmSync(seed.storageDir, { recursive: true, force: true });
  rmSync(seedFile, { force: true });
  process.stdout.write(`${MARKER}{"removed":true}\n`);
}

/**
 * Refuse to touch anything but a throwaway tenant — an `e2e-` slug OR one
 * of the vitest suites' prefixes, the wider rule the sweeps need to clean
 * the DB suite's orphans (`removeTenant` applies the same slug rule
 * inline, plus its member-email belt). The notification helpers below
 * write and read whole-tenant, so they need it more, not less — a stale
 * `.seed` or a hand-typed id must not be able to blank a real tenant's
 * inbox state. A command a spec aims at a row or a tenant of ITS OWN
 * fixture uses the stricter `assertE2ETenant` instead.
 */
async function assertThrowawayTenant(db: PlatformDb, tenantId: string): Promise<void> {
  const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { slug: true } });
  if (!tenant) throw new Error(`no such tenant ${tenantId}`);
  if (!isThrowawaySlug(tenant.slug)) {
    throw new Error(`refusing to touch non-throwaway tenant "${tenant.slug}"`);
  }
}

/**
 * The guard of a command that WRITES into the tenant the browser harness
 * provisioned: an `e2e-` slug and nothing else — stricter than
 * `assertThrowawayTenant`, which also admits the vitest suites' prefixes
 * so the sweeps can clean their orphans. Every writing command a spec
 * can aim at a row or a tenant takes it before its first write:
 * `set-visibility`, `client-visible-comment`, `big-project` (a
 * caller-supplied tenant id), `drop-project` (a caller-supplied
 * project id, checked through its tenant) and `reset-portal-sections`
 * (slice 80). The older resets of the seeded tenant — `reset-signoffs`,
 * `reset-notifications` — still take the looser guard; recorded, not
 * changed, by slice 80's fix-pass review.
 */
async function assertE2ETenant(db: PlatformDb, tenantId: string): Promise<void> {
  const tenant = await db.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { slug: true } });
  if (!tenant.slug.startsWith(SLUG_PREFIX)) {
    throw new Error(`refusing to write outside a throwaway tenant ("${tenant.slug}")`);
  }
}

/**
 * The tenant's notification rows, as the database holds them.
 *
 * e2e/inbox.spec.ts asserts on THESE and not on a toast: the one
 * assertion in this suite whose timing depends on render scheduling
 * rather than a server answer is the one that has flaked twice
 * (PLAN.md §0). Read-state is a stored fact, so read the stored fact.
 */
async function notifications(tenantId: string): Promise<void> {
  const { getPlatformClient } = await import("../../src/db/client");
  const db = getPlatformClient();
  await assertThrowawayTenant(db, tenantId);
  const rows = await db.notification.findMany({
    where: { tenantId },
    select: { id: true, kind: true, readAt: true, archivedAt: true, snoozedTill: true },
    orderBy: { createdAt: "desc" },
  });
  await db.$disconnect();
  process.stdout.write(
    `${MARKER}${JSON.stringify(
      rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        read: r.readAt !== null,
        archived: r.archivedAt !== null,
        snoozed: r.snoozedTill !== null,
      })),
    )}
`,
  );
}

/**
 * Put every notification back to unread, un-archived and un-snoozed.
 * The standing fixture's one notification is what the rail badge and
 * the visual sweep photograph, so a spec that reads or files it must
 * hand it back exactly as it found it — the same doctrine work.spec.ts
 * follows for the row it drops into the photographed project.
 */
async function resetNotifications(tenantId: string): Promise<void> {
  const { getPlatformClient } = await import("../../src/db/client");
  const db = getPlatformClient();
  await assertThrowawayTenant(db, tenantId);
  const { count } = await db.notification.updateMany({
    where: { tenantId },
    data: { readAt: null, archivedAt: null, snoozedTill: null },
  });
  await db.$disconnect();
  process.stdout.write(`${MARKER}{"reset":${count}}
`);
}

/**
 * Put every decided sign-off of the standing fixture back to PENDING —
 * the seeded ask on version 1.1 and on the shared deliverable, which
 * `portal-signoff.spec.ts` decides. A contact cannot undo a decision and
 * the member's "Request sign-off" refuses an APPROVED version by design,
 * so the only way back to the seeded state is the database: the four
 * decision columns cleared, the ask kept. The audit rows the decisions
 * wrote stay (they are immutable and name nothing the walks read); the
 * inbox rows go with `reset-notifications`. Throwaway tenant only, like
 * every write here.
 */
async function resetSignoffs(tenantId: string): Promise<void> {
  const { getPlatformClient } = await import("../../src/db/client");
  const db = getPlatformClient();
  await assertThrowawayTenant(db, tenantId);
  const cleared = {
    approvalStatus: "PENDING" as const,
    approvalDecidedAt: null,
    approvalByContactId: null,
    approvalNote: null,
  };
  const decided = { in: ["APPROVED", "CHANGES_REQUESTED"] as ("APPROVED" | "CHANGES_REQUESTED")[] };
  const versions = await db.projectVersion.updateMany({
    where: { tenantId, approvalStatus: decided },
    data: cleared,
  });
  const documents = await db.document.updateMany({
    where: { tenantId, approvalStatus: decided },
    data: cleared,
  });
  await db.$disconnect();
  process.stdout.write(`${MARKER}{"reset":${versions.count + documents.count}}
`);
}

/**
 * Delete every ask to open sealed logins in the throwaway tenant (3V slice
 * 93b): `portal-logins.spec.ts` asks, has the ask denied and approved, and
 * a denial shuts asking for 30 days and three asks fill the day — so each
 * of its sealed tests, and a retry of any, starts from none. The guard has
 * no DELETE rule (rows go with their client); the platform connection may
 * delete, and only in an `e2e-` tenant (`assertThrowawayTenant`).
 *
 * It also deletes the tenant's COUNTED PASSWORD CHECKS at the client's door
 * (`portal.logins_unlock_started` / `portal.logins_password_refused` — the
 * audit rows the per-contact hourly budget of ten counts): one pass of the
 * spec spends up to six, and a retry of the serial group would otherwise
 * run Astrid out for a reason unrelated to the product (the review's low).
 * Audit rows are append-only; this is the fixture's own maintenance switch,
 * as the dbtest fixture's teardown uses it, in a throwaway tenant only.
 */
async function resetSealedAsks(tenantId: string): Promise<void> {
  const { getPlatformClient } = await import("../../src/db/client");
  const db = getPlatformClient();
  await assertThrowawayTenant(db, tenantId);
  const { count } = await db.sealedOpenRequest.deleteMany({ where: { tenantId } });
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.audit_maintenance', 'on', true)`;
    await tx.auditEvent.deleteMany({
      where: { tenantId, action: { in: ["portal.logins_unlock_started", "portal.logins_password_refused"] } },
    });
  });
  await db.$disconnect();
  process.stdout.write(`${MARKER}{"reset":${count}}
`);
}

/**
 * Show every portal section of every project of the throwaway tenant
 * again (Phase 3 slice 80, C47) — `portal-sections.spec.ts`'s teardown.
 * That spec hides all four on the shared seeded project, and it sorts
 * before `portal-signoff`, `view-as`, `visual` and the Swedish width
 * walk, every one of which photographs or byte-compares that project's
 * page with its sections drawn. Written straight to the columns, as
 * `resetSignoffs` is, so the undo does not depend on the UI the spec
 * may have failed in; run from `afterAll`, never a `finally`.
 */
async function resetPortalSections(tenantId: string): Promise<void> {
  const { getPlatformClient } = await import("../../src/db/client");
  const db = getPlatformClient();
  // The STRICT guard, `e2e-` only — see the list above `assertE2ETenant`.
  await assertE2ETenant(db, tenantId);
  const { count } = await db.project.updateMany({
    where: {
      tenantId,
      OR: [
        { portalShowTasks: false },
        { portalShowUpdates: false },
        { portalShowMilestones: false },
        { portalShowFiles: false },
      ],
    },
    data: { portalShowTasks: true, portalShowUpdates: true, portalShowMilestones: true, portalShowFiles: true },
  });
  await db.$disconnect();
  process.stdout.write(`${MARKER}{"reset":${count}}
`);
}

/**
 * One seeded project's update schedule back to none — the cadence NONE and
 * the day Friday (Phase 5 slice 102; the schedule spec's setup and
 * teardown, so a retry starts where the first attempt did). The STRICT
 * guard, `e2e-` only, like every write here.
 */
async function resetUpdateSchedule(tenantId: string, projectKey: string): Promise<void> {
  const { getPlatformClient } = await import("../../src/db/client");
  const db = getPlatformClient();
  await assertE2ETenant(db, tenantId);
  const { count } = await db.project.updateMany({
    where: { tenantId, key: projectKey },
    data: { updateCadence: "NONE", updateWeekday: 5 },
  });
  await db.$disconnect();
  process.stdout.write(`${MARKER}{"reset":${count}}
`);
}

/**
 * Forget one member's staff-notice acknowledgments, so the next timer
 * start is that member's FIRST again — the only state in which a task's
 * timer control shows the notice. A spec that asserts on the notice
 * calls this before it runs, which keeps it true on a retry (the first
 * attempt acknowledged). Throwaway tenant only, like every write here;
 * the member is found by email inside that tenant and nowhere else.
 */
async function forgetNotice(tenantId: string, email: string): Promise<void> {
  const { getPlatformClient } = await import("../../src/db/client");
  // An undefined filter is silently DROPPED by Prisma, which would make
  // this "the tenant's first member" — refuse a missing email outright.
  if (!email) throw new Error("forget-notice needs a member email");
  const db = getPlatformClient();
  await assertE2ETenant(db, tenantId);
  const member = await db.member.findFirstOrThrow({
    where: { tenantId, user: { email } },
    select: { id: true },
  });
  const { count } = await db.staffNoticeAcknowledgment.deleteMany({
    where: { tenantId, memberId: member.id },
  });
  await db.$disconnect();
  process.stdout.write(`${MARKER}{"forgotten":${count}}
`);
}

/**
 * Put a seeded document back to a known visibility so each spec starts
 * from the same fixture, whatever the previous one changed or left
 * behind after a failure. Throwaway tenant only, like everything here.
 */
async function setVisibility(documentId: string, value: string): Promise<void> {
  if (value !== "INTERNAL" && value !== "CLIENT_VISIBLE") {
    throw new Error(`bad visibility "${value}"`);
  }
  const { getPlatformClient } = await import("../../src/db/client");
  const db = getPlatformClient();
  const doc = await db.document.findUniqueOrThrow({
    where: { id: documentId },
    select: { tenantId: true },
  });
  await assertE2ETenant(db, doc.tenantId);
  await db.document.update({ where: { id: documentId }, data: { visibility: value } });
  await db.$disconnect();
  process.stdout.write(`${MARKER}${JSON.stringify({ visibility: value })}
`);
}

/**
 * A CLIENT_VISIBLE comment under one of the throwaway tenant's tasks —
 * the child that makes `work_item_visibility_downgrade_guard` refuse to
 * make the task private, which is the `V` picker's "explains" case.
 * Written raw, as work.dbtest.ts writes it: no comment UI exists yet.
 * The task is addressed by project id + number, which is what a spec
 * can read off the peek's URL.
 */
async function clientVisibleComment(projectId: string, number: string): Promise<void> {
  const { getPlatformClient } = await import("../../src/db/client");
  const db = getPlatformClient();
  const item = await db.workItem.findFirstOrThrow({
    where: { projectId, number: Number(number), deletedAt: null },
    select: { id: true, tenantId: true },
  });
  // The writing commands' guard: an `e2e-` slug and nothing else.
  await assertE2ETenant(db, item.tenantId);
  const author = await db.member.findFirstOrThrow({
    where: { tenantId: item.tenantId },
    orderBy: { joinedAt: "asc" },
    select: { id: true },
  });
  const comment = await db.comment.create({
    data: {
      tenantId: item.tenantId,
      subjectType: "WORK_ITEM",
      subjectId: item.id,
      authorMemberId: author.id,
      body: {},
      bodyText: "visible reply",
      visibility: "CLIENT_VISIBLE",
    },
    select: { id: true },
  });
  await db.$disconnect();
  process.stdout.write(`${MARKER}${JSON.stringify({ commentId: comment.id })}\n`);
}

/**
 * A task's stored visibility and how many of its live comments the
 * client can see — the read side of the sharing specs (Phase 3 slice
 * 72): the rail's chip is the member's view, this is what was stored.
 * Read-only, addressed by project id + number like `client-visible-comment`.
 */
async function itemVisibility(projectId: string, number: string): Promise<void> {
  const { getPlatformClient } = await import("../../src/db/client");
  const db = getPlatformClient();
  const item = await db.workItem.findFirstOrThrow({
    where: { projectId, number: Number(number) },
    select: { id: true, visibility: true },
  });
  const clientVisibleComments = await db.comment.count({
    where: { subjectType: "WORK_ITEM", subjectId: item.id, visibility: "CLIENT_VISIBLE", deletedAt: null },
  });
  await db.$disconnect();
  process.stdout.write(
    `${MARKER}${JSON.stringify({ visibility: item.visibility, clientVisibleComments })}\n`,
  );
}

/**
 * A comment WRITTEN BY THE CLIENT'S CONTACT under one of the throwaway
 * tenant's tasks, at a chosen visibility — founder decision C37's fixture:
 * an INTERNAL one is what a make-private left behind, and a share must
 * bring it back. Raw, as `client-visible-comment` is: no portal comment
 * writer exists yet. The author is the item's client's first ACTIVE
 * contact, the one the harness signs in as.
 */
async function contactComment(projectId: string, number: string, value: string): Promise<void> {
  if (value !== "INTERNAL" && value !== "CLIENT_VISIBLE") {
    throw new Error(`bad visibility "${value}"`);
  }
  const { getPlatformClient } = await import("../../src/db/client");
  const db = getPlatformClient();
  const item = await db.workItem.findFirstOrThrow({
    where: { projectId, number: Number(number), deletedAt: null },
    select: { id: true, tenantId: true, clientId: true },
  });
  await assertE2ETenant(db, item.tenantId);
  const contact = await db.contact.findFirstOrThrow({
    where: { tenantId: item.tenantId, clientId: item.clientId, portalStatus: "ACTIVE" },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  const comment = await db.comment.create({
    data: {
      tenantId: item.tenantId,
      subjectType: "WORK_ITEM",
      subjectId: item.id,
      authorContactId: contact.id,
      body: {},
      bodyText: "a reply from the client",
      visibility: value,
    },
    select: { id: true },
  });
  await db.$disconnect();
  process.stdout.write(`${MARKER}${JSON.stringify({ commentId: comment.id })}\n`);
}

/**
 * The three columns an inline edit of a milestone must NOT disturb.
 *
 * Hazard H1: `AutoForm` posts the whole FormData, and `updateMilestone`
 * used to read an absent field as an erase — so editing the name alone
 * could blank the due date and reset the visibility to INTERNAL. This
 * is the read side of that regression test.
 */
async function milestone(milestoneId: string): Promise<void> {
  const { getPlatformClient } = await import("../../src/db/client");
  const db = getPlatformClient();
  const row = await db.milestone.findUniqueOrThrow({
    where: { id: milestoneId },
    select: { name: true, dueAt: true, visibility: true },
  });
  await db.$disconnect();
  process.stdout.write(
    `${MARKER}${JSON.stringify({
      name: row.name,
      dueAt: row.dueAt ? row.dueAt.toISOString() : null,
      visibility: row.visibility,
    })}
`,
  );
}

/**
 * A project with more rows than the virtualisation threshold, created
 * and dropped by the ONE spec that needs it.
 *
 * It exists because virtualisation is inert at or below 200 rows, so the
 * ordinary fixture (five tasks) and all 61 visual stops exercise the
 * UNWINDOWED path and could never catch a defect in the windowed one.
 * Without this the feature would ship having never run.
 *
 * DELIBERATELY NOT THROUGH THE SERVICES, and this is the one place in
 * the harness that takes that liberty. `createItem` is one transaction
 * per row with a counter lock and a rank lock; 250 of them is minutes,
 * on every CI run, forever. This is a single `createMany` with
 * pre-computed fractional ranks — the same keys `ranksBetween` would
 * have produced — because what the spec is testing is the RENDERER, not
 * the write path, which `work.dbtest.ts` and `ordering.dbtest.ts`
 * already cover exhaustively. It lives in the throwaway `e2e-` tenant
 * and is deleted by the same command that made it.
 */
async function bigProject(tenantId: string, sizeArg: string | undefined): Promise<void> {
  const size = Number(sizeArg ?? "250");
  if (!Number.isInteger(size) || size < 1 || size > 1000) {
    throw new Error(`big-project size must be 1..1000, got "${sizeArg ?? ""}"`);
  }
  const { getPlatformClient } = await import("../../src/db/client");
  const { ranksBetween } = await import("../../src/lib/rank");
  const db = getPlatformClient();
  // A caller-supplied TENANT id, and a thousand rows to plant under it:
  // the guard first, before the first read even.
  await assertE2ETenant(db, tenantId);

  const client = await db.client.findFirstOrThrow({
    where: { tenantId },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  const owner = await db.member.findFirstOrThrow({
    where: { tenantId },
    select: { id: true },
    orderBy: { joinedAt: "asc" },
  });
  const projectId = randomUUID();
  const key = "BIG";
  await db.project.create({
    data: { id: projectId, tenantId, clientId: client.id, key, name: "Big backlog" },
  });

  // The states this project needs, seeded the way ensureProjectStates
  // would: no name, a durable seed key (DATA_MODEL §6.14).
  const shape = [
    { seedKey: "BACKLOG", category: "BACKLOG" },
    { seedKey: "TODO", category: "TODO", isDefault: true },
    { seedKey: "IN_PROGRESS", category: "IN_PROGRESS" },
    { seedKey: "IN_REVIEW", category: "IN_PROGRESS" },
    { seedKey: "DONE", category: "DONE", requiresApproval: true },
    { seedKey: "CANCELLED", category: "CANCELLED" },
    { seedKey: "TRIAGE", category: "TRIAGE", isHidden: true },
  ] as const;
  const stateRanks = ranksBetween(null, null, shape.length);
  const stateIds = shape.map(() => randomUUID());
  await db.workflowState.createMany({
    data: shape.map((st, i) => ({
      id: stateIds[i]!,
      tenantId,
      projectId,
      seedKey: st.seedKey,
      category: st.category,
      rank: stateRanks[i]!,
      isDefault: "isDefault" in st ? st.isDefault : false,
      isHidden: "isHidden" in st ? st.isHidden : false,
      requiresApproval: "requiresApproval" in st ? st.requiresApproval : false,
    })),
  });
  const todo = stateIds[1]!;

  const ranks = ranksBetween(null, null, size);
  const ids = Array.from({ length: size }, () => randomUUID());
  await db.workItem.createMany({
    data: ids.map((id, i) => ({
      id,
      tenantId,
      clientId: client.id,
      projectId,
      number: i + 1,
      type: "TASK" as const,
      // The index is IN the title so a spec can assert which slice of the
      // list is mounted without counting DOM nodes.
      title: `Row ${String(i + 1).padStart(4, "0")}`,
      stateId: todo,
      stateCategory: "TODO" as const,
      rootId: id,
      rank: ranks[i]!,
      visibility: "INTERNAL" as const,
      createdByMemberId: owner.id,
    })),
  });
  // The counter must agree, or a later create through the real service
  // would mint a duplicate number.
  await db.tenantCounter.upsert({
    where: { tenantId_key: { tenantId, key: `work_item:${projectId}` } },
    create: { tenantId, key: `work_item:${projectId}`, value: size },
    update: { value: size },
  });
  await db.$disconnect();
  process.stdout.write(`${MARKER}${JSON.stringify({ projectId, key, size })}\n`);
}

/** Remove the big project and everything under it. */
async function dropProject(projectId: string): Promise<void> {
  const { getPlatformClient } = await import("../../src/db/client");
  const db = getPlatformClient();
  const project = await db.project.findUnique({ where: { id: projectId }, select: { tenantId: true } });
  if (project) {
    // The project id came back from big-project, but nothing stops a spec
    // from passing another: the tenant is checked before the deletes.
    await assertE2ETenant(db, project.tenantId);
    await db.workItemActivity.deleteMany({ where: { projectId } });
    await db.workItem.deleteMany({ where: { projectId } });
    await db.workflowState.deleteMany({ where: { projectId } });
    await db.tenantCounter.deleteMany({
      where: { tenantId: project.tenantId, key: `work_item:${projectId}` },
    });
    await db.project.delete({ where: { id: projectId } });
  }
  await db.$disconnect();
  process.stdout.write(`${MARKER}${JSON.stringify({ dropped: Boolean(project) })}\n`);
}

/**
 * THE DB HALF OF THE PORTAL REQUEST SPEC (Phase 3 slice 6a).
 *
 * The browser can only see what the portal renders back, and the claim
 * that matters about an intake is about columns the portal never shows:
 * `kind`, `source`, `visibility`, the triage status, who it is
 * attributed to, and the actor on its audit row. Those are facts in the
 * database, so the spec asserts on them here rather than inferring them
 * from a list item.
 *
 * It reads the AUDIT row alongside, because the audit actor is the one
 * property of a brokered write that a service-level dbtest and a browser
 * test could both pass while the real HTTP path wrote SYSTEM: the
 * principal comes from a cookie, and only a real request has one.
 */
async function portalRequests(tenantId: string): Promise<void> {
  const { getPlatformClient } = await import("../../src/db/client");
  const db = getPlatformClient();
  await assertE2ETenant(db, tenantId);
  const rows = await db.workItem.findMany({
    where: { tenantId, kind: "REQUEST", source: "PORTAL" },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      number: true,
      title: true,
      descriptionText: true,
      visibility: true,
      portalEnabled: true,
      stateCategory: true,
      triageStatus: true,
      // C31: whether the agency took the request on before it ended it —
      // the fact behind "Cancelled" against "Declined" on the portal.
      acceptedAt: true,
      reportedByContactId: true,
      createdByMemberId: true,
      clientId: true,
      projectId: true,
    },
  });
  const events = await db.auditEvent.findMany({
    where: { tenantId, action: "portal.request_created" },
    select: { targetId: true, actorType: true, actorId: true },
  });
  const byTarget = new Map(events.map((e) => [e.targetId, e]));
  await db.$disconnect();
  process.stdout.write(
    `${MARKER}${JSON.stringify(
      rows.map((r) => ({
        ...r,
        auditActorType: byTarget.get(r.id)?.actorType ?? null,
        auditActorId: byTarget.get(r.id)?.actorId ?? null,
      })),
    )}
`,
  );
}

/**
 * Hand the fixture back the way it was provisioned.
 *
 * WITHOUT THIS, a request submitted by the browser would still be in the
 * shared tenant when `view-as.spec.ts`, `visual.spec.ts` and the Swedish
 * width walk run — all three sort after `portal-requests.spec.ts` — and
 * the portal's 204-shot stop would gain a "Requested" group whose
 * presence depended on whether the whole suite or one file had been run.
 * That is the cross-spec contamination the locale restore in
 * `view-as.spec.ts` already records, and the same rule applies to the
 * timing: the caller runs it from `afterAll`, never a `finally`, because
 * a Playwright test TIMEOUT abandons the body and every await inside a
 * `finally` then fails immediately.
 */
async function clearPortalRequests(tenantId: string, contactEmail: string): Promise<void> {
  const { getPlatformClient } = await import("../../src/db/client");
  const db = getPlatformClient();
  await assertE2ETenant(db, tenantId);
  // SCOPED BY SUBMITTER, not by kind and not by a CLOCK.
  //
  // By kind alone (the first cut) it deleted every `kind=REQUEST,
  // source=PORTAL` row of the shared tenant — safe today, because
  // nothing else in `e2e/` creates one, and silently wrong the moment
  // the triage-lane slice seeds a REQUEST fixture, at which point an
  // unrelated spec's `afterAll` would delete it (code review).
  //
  // The second cut fixed that with a `createdAt >= <the run started>`
  // window, and that was the WRONG INSTRUMENT: the rows are stamped by
  // Postgres and the cutoff came from the test runner's own clock, so a
  // few seconds of skew between this machine and Neon would have made
  // the cleanup quietly delete nothing — leaving a request in the
  // shared project's backlog for `visual` and the Swedish width walk,
  // which is precisely the cross-spec contamination the scoping exists
  // to prevent. It is the same two-clocks mistake the intake's own rate
  // budget had to fix, which is how it was spotted.
  //
  // The submitter is the honest key: this harness can sign in as exactly
  // one contact, so "requests reported by that contact" is exactly the
  // set this spec can have created — with no clock in it at all.
  const contact = await db.contact.findFirst({
    where: { tenantId, email: contactEmail },
    select: { id: true },
  });
  const rows = contact
    ? await db.workItem.findMany({
        where: { tenantId, kind: "REQUEST", source: "PORTAL", reportedByContactId: contact.id },
        select: { id: true },
      })
    : [];
  const ids = rows.map((r) => r.id);
  if (ids.length > 0) {
    await db.$executeRaw`DELETE FROM search_index WHERE tenant_id = ${tenantId} AND entity_type = 'WORK_ITEM' AND entity_id = ANY(${ids})`;
    await db.emailOutbox.deleteMany({
      where: { tenantId, kind: "work_item.request_received", notificationIds: { isEmpty: false } },
    });
    await db.notification.deleteMany({ where: { tenantId, entityId: { in: ids } } });
    await db.workItemActivity.deleteMany({ where: { tenantId, workItemId: { in: ids } } });
    await db.workItem.deleteMany({ where: { tenantId, id: { in: ids } } });
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.audit_maintenance', 'on', true)`;
      await tx.auditEvent.deleteMany({
        where: { tenantId, action: "portal.request_created", targetId: { in: ids } },
      });
    });
  }
  await db.$disconnect();
  process.stdout.write(`${MARKER}${JSON.stringify({ cleared: ids.length })}
`);
}

/**
 * ERASE A CONTACT A SPEC CREATED — `portal-invite.spec.ts`'s belt.
 *
 * The spec adds its own contact through the real form and takes its
 * access away and deletes it through the real row menu, which is the
 * coverage. This is what runs when the spec failed BEFORE getting that
 * far, and it is not optional: the Contacts tab is photographed by the
 * visual sweep and walked by `zz-swedish-widths`, both of which sort
 * after it, so a leftover row would change screenshots and column widths
 * in specs that never touched this one.
 *
 * **IT GOES ROUND `deleteContact` ON PURPOSE, unlike most of this file.**
 * The service refuses anyone who can still sign in and anyone who has
 * written in the portal — which is right for a member pressing a button
 * and wrong for a cleanup whose whole job is the case where the spec did
 * not finish. `assertE2ETenant` above it is what keeps that safe: this
 * can only ever reach a tenant the fixture provisioned.
 *
 * Scoped by ADDRESS, not by a clock and not by "contacts of this
 * client": the two seeded contacts and the seeded invitee live there too
 * and every other spec depends on them.
 */
async function removeContact(tenantId: string, email: string): Promise<void> {
  const { getPlatformClient } = await import("../../src/db/client");
  const db = getPlatformClient();
  await assertE2ETenant(db, tenantId);
  const contact = await db.contact.findFirst({
    where: { tenantId, email },
    select: { id: true },
  });
  if (contact) {
    // Sequential, never a `Promise.all` — AGENTS.md's standing trap, and
    // these run outside a transaction anyway so there is nothing to win.
    await db.contactSession.deleteMany({ where: { contactId: contact.id } });
    await db.contactAccount.deleteMany({ where: { contactId: contact.id } });
    // By `value`, not the address: Better Auth keys a reset row by an
    // identifier derived from the token — hashed, since the portal's reset
    // screens — with `value = <contact id>` (the same correction
    // `setContactPortalAccess` now carries). The address arm matches
    // nothing since the hashing — no identifier can equal an address — and
    // stays for the reason the service's copy of it gives.
    await db.contactVerification.deleteMany({
      where: { OR: [{ value: contact.id }, { identifier: email }] },
    });
    await db.contactInvite.deleteMany({ where: { tenantId, contactId: contact.id } });
    // `work_item.assignee_contact_id` is ON DELETE RESTRICT, so a task
    // the contact was handed would block the delete at the database.
    await db.workItem.updateMany({
      where: { tenantId, assigneeContactId: contact.id },
      data: { assigneeContactId: null, contactCompletedAt: null },
    });
    await db.contact.delete({ where: { tenantId_id: { tenantId, id: contact.id } } });
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.audit_maintenance', 'on', true)`;
      await tx.auditEvent.deleteMany({ where: { tenantId, targetId: contact.id } });
    });
  }
  await db.$disconnect();
  process.stdout.write(`${MARKER}${JSON.stringify({ removed: contact !== null })}\n`);
}

/**
 * Age the vault member's second factor past the vault window, so the
 * spec can drive THE DOOR (C52 (a)) — the step-up form inside the Vault
 * tab — without waiting ten minutes. Every session of that member in the
 * fixture tenant gets a factor stamped twenty minutes ago; nothing else
 * is touched. Guarded to a fixture tenant like every command here.
 */
async function ageVaultFactor(tenantId: string, email: string): Promise<void> {
  const { getPlatformClient } = await import("../../src/db/client");
  const db = getPlatformClient();
  await assertE2ETenant(db, tenantId);
  if (!email.endsWith(EMAIL_DOMAIN)) throw new Error("age-vault-factor: not a fixture address");
  const member = await db.member.findFirst({ where: { tenantId, user: { email } }, select: { userId: true } });
  if (!member) throw new Error("age-vault-factor: no such member in the fixture tenant");
  const { count } = await db.session.updateMany({
    where: { userId: member.userId },
    data: { mfaVerifiedAt: new Date(Date.now() - 20 * 60_000) },
  });
  await db.$disconnect();
  process.stdout.write(`${MARKER}${JSON.stringify({ aged: count })}\n`);
}

/**
 * THE LOGINS A CONTACT HANDED OVER (3V slice 96, C64) — the DB half of
 * `portal-send-login.spec.ts`: what the portal never shows (visibility, the
 * member author, the audit actor), read for the fixture contact only.
 */
async function portalSubmissions(tenantId: string, contactEmail: string): Promise<void> {
  const { getPlatformClient } = await import("../../src/db/client");
  const db = getPlatformClient();
  await assertE2ETenant(db, tenantId);
  const contact = await db.contact.findFirst({ where: { tenantId, email: contactEmail }, select: { id: true } });
  const rows = contact
    ? await db.credentialItem.findMany({
        where: { tenantId, submittedByContactId: contact.id },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          name: true,
          submittedName: true,
          submittedByContactId: true,
          type: true,
          visibility: true,
          clientId: true,
          projectId: true,
          url: true,
          createdByMemberId: true,
        },
      })
    : [];
  const events = await db.auditEvent.findMany({
    where: { tenantId, action: "credential.submitted", targetId: { in: rows.map((r) => r.id) } },
    select: { targetId: true, actorType: true, actorId: true },
  });
  const byTarget = new Map(events.map((e) => [e.targetId, e]));
  await db.$disconnect();
  process.stdout.write(
    `${MARKER}${JSON.stringify(
      rows.map((r) => ({
        ...r,
        auditActorType: byTarget.get(r.id)?.actorType ?? null,
        auditActorId: byTarget.get(r.id)?.actorId ?? null,
      })),
    )}\n`,
  );
}

/**
 * Hand the fixture back after `portal-send-login.spec.ts` (3V slice 96):
 * the logins the fixture contact handed over (their secrets and versions go
 * with them, FK cascade), their audit rows, and the agency's
 * `credential.submitted` notifications and mails — scoped by SUBMITTER,
 * never a clock (`clearPortalRequests`' reasoning). Runs from `afterAll`:
 * the vault tab, the inbox and the walks sort after the spec.
 */
async function clearPortalSubmissions(tenantId: string, contactEmail: string): Promise<void> {
  const { getPlatformClient } = await import("../../src/db/client");
  const db = getPlatformClient();
  await assertE2ETenant(db, tenantId);
  const contact = await db.contact.findFirst({ where: { tenantId, email: contactEmail }, select: { id: true } });
  const rows = contact
    ? await db.credentialItem.findMany({ where: { tenantId, submittedByContactId: contact.id }, select: { id: true } })
    : [];
  const ids = rows.map((r) => r.id);
  await db.emailOutbox.deleteMany({ where: { tenantId, kind: "credential.submitted" } });
  await db.notification.deleteMany({ where: { tenantId, kind: "credential.submitted" } });
  if (ids.length > 0) {
    await db.credentialItem.deleteMany({ where: { tenantId, id: { in: ids } } });
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.audit_maintenance', 'on', true)`;
      await tx.auditEvent.deleteMany({ where: { tenantId, action: "credential.submitted", targetId: { in: ids } } });
    });
  }
  await db.$disconnect();
  process.stdout.write(`${MARKER}${JSON.stringify({ cleared: ids.length })}\n`);
}

/**
 * Hand the fixture back after `portal-login-ask.spec.ts` (3V slice 98): the
 * asks made of the fixture contact (whatever their ending), their audit
 * rows, the contact's ask mails, and the agency's `credential.ask_declined`
 * notifications and mails — scoped by the CONTACT asked, never a clock. The
 * logins sent in answer are `clearPortalSubmissions`'. Runs from
 * `afterAll`: the vault tabs, the portal home and the walks sort after the
 * spec. The platform connection may delete (`credential_ask` grants the
 * runtime no DELETE); a throwaway `e2e-` tenant only.
 */
async function clearLoginAsks(tenantId: string, contactEmail: string): Promise<void> {
  const { getPlatformClient } = await import("../../src/db/client");
  const db = getPlatformClient();
  await assertE2ETenant(db, tenantId);
  const contact = await db.contact.findFirst({ where: { tenantId, email: contactEmail }, select: { id: true } });
  const asks = contact
    ? await db.credentialAsk.findMany({ where: { tenantId, contactId: contact.id }, select: { id: true } })
    : [];
  const ids = asks.map((a) => a.id);
  // Scoped by the contact and their asks (the code review's nit): the ask
  // mails TO them, and the declines' notifications ON their asks with the
  // mails those notifications carried.
  if (contact) {
    await db.emailOutbox.deleteMany({
      where: { tenantId, kind: "portal.login_asked", receiverType: "CONTACT", receiverId: contact.id },
    });
  }
  const declines = ids.length
    ? await db.notification.findMany({
        where: { tenantId, kind: "credential.ask_declined", entityType: "CredentialAsk", entityId: { in: ids } },
        select: { id: true },
      })
    : [];
  if (declines.length > 0) {
    const noticeIds = declines.map((n) => n.id);
    await db.emailOutbox.deleteMany({
      where: { tenantId, kind: "credential.ask_declined", notificationIds: { hasSome: noticeIds } },
    });
    await db.notification.deleteMany({ where: { tenantId, id: { in: noticeIds } } });
  }
  if (ids.length > 0) {
    await db.credentialAsk.deleteMany({ where: { tenantId, id: { in: ids } } });
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.audit_maintenance', 'on', true)`;
      await tx.auditEvent.deleteMany({
        where: {
          tenantId,
          action: { in: ["credential.asked", "credential.ask_cancelled", "credential.ask_declined"] },
          targetId: { in: ids },
        },
      });
    });
  }
  await db.$disconnect();
  process.stdout.write(`${MARKER}${JSON.stringify({ cleared: ids.length })}\n`);
}

/**
 * THE FIXTURE CONTACT'S WEEKLY-SUMMARY LINK (Phase 5 slice 101): their summary
 * set back ON (their own setting removed — no row is the default) and the
 * link that stops it printed, minted with the server's own key from the same
 * environment. `client-summary.spec.ts` opens it signed in as nobody, then as
 * the person. The link can only ever stop or start this one throwaway
 * contact's summary.
 */
async function clientSummaryLink(tenantId: string, contactEmail: string): Promise<void> {
  const { getPlatformClient } = await import("../../src/db/client");
  const { clientSummaryToken } = await import("../../src/notify/client-summary-token");
  const db = getPlatformClient();
  await assertE2ETenant(db, tenantId);
  const contact = await db.contact.findFirstOrThrow({ where: { tenantId, email: contactEmail }, select: { id: true } });
  await db.notificationPreference.deleteMany({ where: { tenantId, receiverType: "CONTACT", receiverId: contact.id } });
  await db.$disconnect();
  process.stdout.write(`${MARKER}${JSON.stringify({ token: clientSummaryToken(tenantId, contact.id) })}\n`);
}

/**
 * Mark a login "Change soon" (slice 94) by its name, as removing a member
 * who saw it would — the fixture's members stay, so `vault.spec.ts` sets
 * the mark straight on the row, then clears it through the UI by changing
 * the secret. Live logins of the fixture tenant only.
 */
async function flagLogin(tenantId: string, name: string): Promise<void> {
  const { getPlatformClient } = await import("../../src/db/client");
  // An absent name would be DROPPED from the where clause and mark every
  // login in the tenant (the undefined-where trap).
  if (typeof name !== "string" || name.length === 0) throw new Error("flag-login: a login name is required");
  const db = getPlatformClient();
  await assertE2ETenant(db, tenantId);
  const { count } = await db.credentialItem.updateMany({
    where: { tenantId, name, deletedAt: null },
    data: { needsRotation: true },
  });
  await db.$disconnect();
  process.stdout.write(`${MARKER}${JSON.stringify({ flagged: count })}\n`);
}

/** The DB half of the visibility assertions. */
async function visibility(documentId: string): Promise<void> {
  const { getPlatformClient } = await import("../../src/db/client");
  const db = getPlatformClient();
  const doc = await db.document.findUniqueOrThrow({
    where: { id: documentId },
    select: { visibility: true },
  });
  await db.$disconnect();
  process.stdout.write(`${MARKER}${JSON.stringify({ visibility: doc.visibility })}\n`);
}

const [command, argument] = process.argv.slice(2);

const main = async (): Promise<void> => {
  if (command === "provision") return provision(argument!);
  if (command === "teardown") return teardown(argument!);
  if (command === "visibility") return visibility(argument!);
  if (command === "set-visibility") return setVisibility(argument!, process.argv[4]!);
  if (command === "client-visible-comment") return clientVisibleComment(argument!, process.argv[4]!);
  if (command === "item-visibility") return itemVisibility(argument!, process.argv[4]!);
  if (command === "contact-comment") return contactComment(argument!, process.argv[4]!, process.argv[5]!);
  if (command === "milestone") return milestone(argument!);
  if (command === "big-project") return bigProject(argument!, process.argv[4]);
  if (command === "drop-project") return dropProject(argument!);
  if (command === "portal-requests") return portalRequests(argument!);
  if (command === "clear-portal-requests") return clearPortalRequests(argument!, process.argv[4]!);
  if (command === "notifications") return notifications(argument!);
  if (command === "reset-notifications") return resetNotifications(argument!);
  if (command === "reset-signoffs") return resetSignoffs(argument!);
  if (command === "reset-sealed-asks") return resetSealedAsks(argument!);
  if (command === "reset-portal-sections") return resetPortalSections(argument!);
  if (command === "reset-update-schedule") return resetUpdateSchedule(argument!, process.argv[4]!);
  if (command === "forget-notice") return forgetNotice(argument!, process.argv[4]!);
  if (command === "remove-contact") return removeContact(argument!, process.argv[4]!);
  if (command === "age-vault-factor") return ageVaultFactor(argument!, process.argv[4]!);
  if (command === "flag-login") return flagLogin(argument!, process.argv[4]!);
  if (command === "portal-submissions") return portalSubmissions(argument!, process.argv[4]!);
  if (command === "clear-portal-submissions") return clearPortalSubmissions(argument!, process.argv[4]!);
  if (command === "clear-login-asks") return clearLoginAsks(argument!, process.argv[4]!);
  if (command === "client-summary-link") return clientSummaryLink(argument!, process.argv[4]!);
  if (command === "remove-users") return removeUsers(process.argv.slice(3));
  if (command === "sweep") return sweep(argument);
  if (command === "sweep-dbtests") return sweepDbtests(argument);
  throw new Error(`unknown command "${command ?? ""}"`);
};

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});

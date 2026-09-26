import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
/* eslint-disable no-restricted-imports -- dbtest setup/cleanup uses the raw layer */
import { getPlatformClient } from "@/db/client";
import { withTenant } from "@/db";
import {
  authorizePortal,
  resolvePortalModuleGates,
  withPortalRead,
  type PortalPrincipal,
} from "@/portal";

import { listPortalTasks } from "./portal";

/**
 * "NO INTERNAL FACT TO A CONTACT" — the fixture suite the pins require in
 * the same commit as each portal feature (work-management plan §3.2,
 * PLAN.md Phase 3 tests), against the real schema, the real `app_runtime`
 * role and the real contact principal.
 *
 * ITS CENTRAL ASSERTION IS NOT A FIELD LIST. Every internal fact in this
 * fixture is planted as a SENTINEL STRING that appears nowhere else —
 * the state's name, the internal milestone's name, the label, the
 * client's internal notes, the project's repo and hosting pointers, the
 * titles of the rows a contact must not see — and the test serialises
 * the whole projection and asserts that not one of them appears in it.
 * That is deliberately stronger than "the shape has no `stateId` key":
 * a leak through a field this test has never heard of, through a nested
 * relation, through a future column, still fails. The forbidden-columns
 * grep and the structural allow-list check
 * (`src/authz/portal-projections.test.ts`) are the static half; this is
 * the half that reads what actually came out of Postgres.
 *
 * WHAT ONLY A DATABASE CAN SAY, and is therefore here rather than in a
 * unit test: that an INTERNAL child of a shared parent is absent because
 * `portal_gate` refused it; that flipping `portalEnabled` off empties
 * the list; that another client's and another tenant's shared work is
 * not merely filtered out in TypeScript but unreachable.
 *
 * Tenant slugs are spelled out literally at the `slug:` key and the
 * prefix `pwork-` is registered in `DBTEST_PREFIXES` (e2e/fixtures/seed-cli.ts)
 * so `sweep-dbtests` can collect this suite's orphans. `e2e-` is the
 * BROWSER harness's prefix and is swept by age — a dbtest using it would
 * have its fixtures deleted mid-run by a concurrent e2e run.
 */

const run = randomUUID().slice(0, 8);

/** Strings that exist nowhere but on an INTERNAL-only column. */
const S = {
  stateName: `SENTINELSTATE-${run}`,
  internalPhase: `SENTINELPHASE-${run}`,
  label: `SENTINELLABEL-${run}`,
  clientNote: `SENTINELNOTE-${run}`,
  repo: `SENTINELREPO-${run}`,
  hosting: `SENTINELHOST-${run}`,
  internalTask: `SENTINELINTERNALTASK-${run}`,
  hiddenProject: `SENTINELHIDDENPROJECT-${run}`,
  archivedProject: `SENTINELARCHIVEDPROJECT-${run}`,
  otherClientTask: `SENTINELOTHERCLIENT-${run}`,
  otherTenantTask: `SENTINELOTHERTENANT-${run}`,
  deletedTask: `SENTINELDELETED-${run}`,
  archivedTask: `SENTINELARCHIVED-${run}`,
  cancelledTask: `SENTINELCANCELLED-${run}`,
  /** A cancelled REQUEST that nobody explained. Shown, it would read as
   *  "Declined" with a blank under it — so it must stay hidden. */
  cancelledRequestNoReason: `SENTINELNOREASON-${run}`,
  /** The same with the agency having ACCEPTED it first (C31). Shown, it
   *  would read as "Cancelled" with a blank under it — the new category
   *  inherits the fail-safe, not an exception to it. */
  cancelledAcceptedNoReason: `SENTINELACCEPTEDNOREASON-${run}`,
  /** An INTERNAL request that was declined — its title AND its reason
   *  must both stay off the client's screen. */
  internalDeclined: `SENTINELINTERNALDECLINED-${run}`,
  /** The reason on that row: a member's words about a row the contact
   *  cannot reach at all. */
  triageOfInternal: `SENTINELINTERNALREASON-${run}`,
} as const;

/** Titles a contact IS meant to read. */
const SHOWN = {
  planned: `Shared planned ${run}`,
  started: `Shared in progress ${run}`,
  done: `Shared done ${run}`,
  triaged: `Shared request ${run}`,
  dated: `Shared dated ${run}`,
  sharedPhase: `Design ${run}`,
  /** A request the agency answered NO to (slice 6b). */
  declined: `Declined request ${run}`,
  /** …and what it was told. Client-readable ON PURPOSE — the one string
   *  in this file that a member writes and a contact reads. */
  declinedReason: `We already do this under your retainer ${run}`,
  /** A declined request the agency has since ARCHIVED — the answer
   *  outlives the tidying (founder decision, 2026-09-22). */
  archivedDeclined: `Archived declined request ${run}`,
  archivedDeclinedReason: `Not before the launch ${run}`,
  /** A request the agency ACCEPTED and later stopped (founder decision
   *  C31, 2026-09-25): the client watched it as Planned, so it reads
   *  "Cancelled", never "Declined". */
  cancelled: `Cancelled request ${run}`,
  cancelledReply: `The budget moved to the spring campaign ${run}`,
  /** An accepted request still in live work — `acceptedAt` decides
   *  nothing about a live row, only about a cancelled one. */
  acceptedPlanned: `Accepted planned request ${run}`,
} as const;

/**
 * WHEN THE ACCEPTED ROWS WERE ACCEPTED — a date chosen to appear nowhere
 * else, so the serialised projection can be checked for it the way it
 * is checked for the sentinel strings. The projection SELECTS the column
 * (it decides "Cancelled" against "Declined") and must not RETURN it:
 * §11 shows a client no such date, and the key list below has no room
 * for one. A `Date` sentinel rather than a string because JSON carries
 * it as its ISO form, and that is what the sweep greps for.
 */
const ACCEPTED_SENTINEL = new Date("2001-02-03T04:05:06Z");
const ACCEPTED_SENTINEL_TEXT = "2001-02-03";

const T = randomUUID();
const T2 = randomUUID();
const acme = randomUUID();
const beta = randomUUID();
const gamma = randomUUID();
const pOn = randomUUID();
const pOff = randomUUID();
const pArchived = randomUUID(); // portalEnabled TRUE, project archived
const pBeta = randomUUID();
const pGamma = randomUUID();

/** Stands in for a Member id — no FK on `Contact.invitedById`, by design. */
const memberId = randomUUID();

const ids = {
  primary: randomUUID(),
  collaborator: randomUUID(),
  suspended: randomUUID(),
  betaContact: randomUUID(),
  gammaContact: randomUUID(),
  sharedPhase: randomUUID(),
  internalPhase: randomUUID(),
  label: randomUUID(),
};

const states: Record<string, string> = {};
const invitedAt = new Date("2026-09-01T09:00:00Z");
let gates: Awaited<ReturnType<typeof resolvePortalModuleGates>>;

const principal = (contactId: string, over: Partial<PortalPrincipal> = {}): PortalPrincipal => ({
  contactId,
  tenantId: T,
  clientId: acme,
  gates,
  ...over,
});

/** A raw work-item row. `portalEnabled` is NEVER written here: it is
 *  trigger-derived from the project (`stamp_portal_enabled`, BEFORE
 *  INSERT), which is the rule AGENTS.md states and which this fixture
 *  therefore also exercises. */
let nextNumber = 1;
async function item(input: {
  tenantId: string;
  clientId: string;
  projectId: string;
  title: string;
  category: "BACKLOG" | "TODO" | "IN_PROGRESS" | "DONE" | "CANCELLED" | "TRIAGE";
  visibility: "INTERNAL" | "CLIENT_VISIBLE";
  /** Defaults to TASK. `REQUEST` is what makes a CANCELLED row visible. */
  kind?: "TASK" | "BUG" | "REQUEST";
  /** A triage outcome, for the rows that carry one. */
  triageStatus?: "DECLINED" | "DUPLICATE";
  triageReason?: string;
  /** The agency took this request on, at this moment (C31). */
  acceptedAt?: Date;
  milestoneId?: string;
  targetDate?: Date;
  completedAt?: Date;
  deletedAt?: Date;
  archivedAt?: Date;
}): Promise<string> {
  const db = getPlatformClient();
  const id = randomUUID();
  await db.workItem.create({
    data: {
      id,
      tenantId: input.tenantId,
      clientId: input.clientId,
      projectId: input.projectId,
      number: nextNumber++,
      title: input.title,
      stateId: states[`${input.projectId}:${input.category}`]!,
      stateCategory: input.category,
      kind: input.kind ?? "TASK",
      // `work_item_triage_has_status`: a TRIAGE row must carry one.
      triageStatus: input.triageStatus ?? (input.category === "TRIAGE" ? "PENDING" : null),
      // `work_item_triage_reason_iff_outcome` (20260922120000) binds
      // these two together in BOTH directions, so a fixture that sets
      // one without the other fails at the INSERT — which is the
      // constraint doing its job on this file too.
      triageReason: input.triageReason ?? null,
      duplicateOfId: null,
      acceptedAt: input.acceptedAt ?? null,
      rootId: id,
      // A valid fractional key that sorts before every generated one —
      // the shape `tree-guards.dbtest.ts` settled on.
      rank: `Zz${randomUUID().replace(/-/g, "")}1`,
      visibility: input.visibility,
      milestoneId: input.milestoneId ?? null,
      targetDate: input.targetDate ?? null,
      completedAt: input.completedAt ?? null,
      deletedAt: input.deletedAt ?? null,
      archivedAt: input.archivedAt ?? null,
    },
  });
  return id;
}

beforeAll(async () => {
  const db = getPlatformClient();
  await db.tenant.create({
    data: { id: T, name: `pwork-a-${run}`, slug: `pwork-a-${run}`, entitlements: {} },
  });
  await db.tenant.create({
    data: { id: T2, name: `pwork-b-${run}`, slug: `pwork-b-${run}`, entitlements: {} },
  });
  await db.client.createMany({
    data: [
      { id: acme, tenantId: T, name: "Acme", internalNotes: S.clientNote },
      { id: beta, tenantId: T, name: "Beta" },
      { id: gamma, tenantId: T2, name: "Gamma" },
    ],
  });
  await db.project.createMany({
    data: [
      {
        id: pOn,
        tenantId: T,
        clientId: acme,
        key: "PWON",
        name: `Acme website ${run}`,
        portalEnabled: true,
        repoUrl: S.repo,
        hostingNotes: S.hosting,
      },
      { id: pOff, tenantId: T, clientId: acme, key: "PWOFF", name: S.hiddenProject },
      // PORTAL ON *AND* ARCHIVED — the combination `project`'s own
      // `portal_gate` does not separate (it binds client + portal_enabled
      // and nothing else) and `archiveProject` leaves `portalEnabled`
      // true. Without the projection's own filter this project would go
      // on publishing to the client for ever.
      {
        id: pArchived,
        tenantId: T,
        clientId: acme,
        key: "PWARCH",
        name: "Archived but still switched on",
        portalEnabled: true,
        status: "ARCHIVED",
        archivedAt: new Date("2026-01-01T00:00:00Z"),
      },
      { id: pBeta, tenantId: T, clientId: beta, key: "PWBETA", name: "Beta site", portalEnabled: true },
      { id: pGamma, tenantId: T2, clientId: gamma, key: "PWGAM", name: "Gamma site", portalEnabled: true },
    ],
  });

  // One state per (project, category). EVERY state carries a sentinel
  // name, including the ones the shared rows sit in: a state NAME is on
  // the never-shown list whatever the row's visibility is.
  const categories = ["BACKLOG", "TODO", "IN_PROGRESS", "DONE", "CANCELLED", "TRIAGE"] as const;
  let rank = 0;
  for (const [tenantId, projectId] of [
    [T, pOn],
    [T, pOff],
    [T, pArchived],
    [T, pBeta],
    [T2, pGamma],
  ] as const) {
    for (const category of categories) {
      const id = randomUUID();
      states[`${projectId}:${category}`] = id;
      await db.workflowState.create({
        data: {
          id,
          tenantId,
          projectId,
          // Unique per (tenant, project, name), so the sentinel carries
          // the category — the sweep below matches on its PREFIX.
          name: `${S.stateName}-${category}`,
          category,
          rank: `a${(rank++).toString().padStart(4, "0")}`,
          isDefault: category === "BACKLOG",
        },
      });
    }
  }

  await db.milestone.createMany({
    data: [
      {
        id: ids.sharedPhase,
        tenantId: T,
        clientId: acme,
        projectId: pOn,
        name: SHOWN.sharedPhase,
        rank: "a0",
        visibility: "CLIENT_VISIBLE",
      },
      {
        id: ids.internalPhase,
        tenantId: T,
        clientId: acme,
        projectId: pOn,
        name: S.internalPhase,
        rank: "a1",
        visibility: "INTERNAL",
      },
    ],
  });
  await db.label.create({ data: { id: ids.label, tenantId: T, projectId: pOn, name: S.label } });

  await db.contact.createMany({
    data: [
      { id: ids.primary, tenantId: T, clientId: acme, name: "Primary", email: `pw-primary-${run}@test.invalid`, portalProfile: "CONTACT_PRIMARY", portalStatus: "ACTIVE", invitedAt },
      // Invited BY a member, which is the hazard the forbidden-columns
      // list names: the id is a `Member.id` sitting on a row every
      // contact of this client may read. Measured below.
      { id: ids.collaborator, tenantId: T, clientId: acme, name: "Collab", email: `pw-collab-${run}@test.invalid`, portalProfile: "CONTACT_COLLABORATOR", portalStatus: "ACTIVE", invitedAt, invitedById: memberId },
      { id: ids.suspended, tenantId: T, clientId: acme, name: "Suspended", email: `pw-susp-${run}@test.invalid`, portalProfile: "CONTACT_PRIMARY", portalStatus: "SUSPENDED", invitedAt },
      { id: ids.betaContact, tenantId: T, clientId: beta, name: "Beta", email: `pw-beta-${run}@test.invalid`, portalProfile: "CONTACT_PRIMARY", portalStatus: "ACTIVE", invitedAt },
      { id: ids.gammaContact, tenantId: T2, clientId: gamma, name: "Gamma", email: `pw-gamma-${run}@test.invalid`, portalProfile: "CONTACT_PRIMARY", portalStatus: "ACTIVE", invitedAt },
    ],
  });

  // ── what a contact SHOULD see ────────────────────────────────────
  const shared = await item({ tenantId: T, clientId: acme, projectId: pOn, title: SHOWN.planned, category: "TODO", visibility: "CLIENT_VISIBLE", milestoneId: ids.sharedPhase });
  // …wearing a label, so "a shared row's own INTERNAL children never
  // travel with it" is measured rather than assumed. `Label` is class A:
  // a contact cannot read the join row at all, and the projection never
  // asks — both halves matter, and only one of them is this file's.
  await getPlatformClient().workItemLabel.create({
    data: { tenantId: T, workItemId: shared, labelId: ids.label },
  });
  await item({ tenantId: T, clientId: acme, projectId: pOn, title: SHOWN.started, category: "IN_PROGRESS", visibility: "CLIENT_VISIBLE" });
  await item({ tenantId: T, clientId: acme, projectId: pOn, title: SHOWN.done, category: "DONE", visibility: "CLIENT_VISIBLE", completedAt: new Date("2026-09-10T10:00:00Z") });
  await item({ tenantId: T, clientId: acme, projectId: pOn, title: SHOWN.triaged, category: "TRIAGE", visibility: "CLIENT_VISIBLE" });
  await item({ tenantId: T, clientId: acme, projectId: pOn, title: SHOWN.dated, category: "TODO", visibility: "CLIENT_VISIBLE", targetDate: new Date("2026-09-25T00:00:00Z") });

  // ── what a contact must NOT see ──────────────────────────────────
  await item({ tenantId: T, clientId: acme, projectId: pOn, title: S.internalTask, category: "TODO", visibility: "INTERNAL" });
  // A CLIENT_VISIBLE row carrying an INTERNAL milestone: the ROW is
  // shared, the PHASE is not, and the name must not ride along.
  await item({ tenantId: T, clientId: acme, projectId: pOn, title: `Shared, internal phase ${run}`, category: "TODO", visibility: "CLIENT_VISIBLE", milestoneId: ids.internalPhase });
  await item({ tenantId: T, clientId: acme, projectId: pOff, title: S.hiddenProject, category: "TODO", visibility: "CLIENT_VISIBLE" });
  await item({ tenantId: T, clientId: acme, projectId: pArchived, title: S.archivedProject, category: "TODO", visibility: "CLIENT_VISIBLE" });
  await item({ tenantId: T, clientId: beta, projectId: pBeta, title: S.otherClientTask, category: "TODO", visibility: "CLIENT_VISIBLE" });
  await item({ tenantId: T2, clientId: gamma, projectId: pGamma, title: S.otherTenantTask, category: "TODO", visibility: "CLIENT_VISIBLE" });
  await item({ tenantId: T, clientId: acme, projectId: pOn, title: S.deletedTask, category: "TODO", visibility: "CLIENT_VISIBLE", deletedAt: new Date() });
  await item({ tenantId: T, clientId: acme, projectId: pOn, title: S.archivedTask, category: "TODO", visibility: "CLIENT_VISIBLE", archivedAt: new Date() });
  await item({ tenantId: T, clientId: acme, projectId: pOn, title: S.cancelledTask, category: "CANCELLED", visibility: "CLIENT_VISIBLE" });
  // THE PAIR THAT PINS SLICE 6b's ONE EXCEPTION. Both rows are
  // CLIENT_VISIBLE and both sit in the same CANCELLED state; the ONLY
  // difference is `kind`. The row above must stay invisible and the one
  // below must come back as DECLINED with the agency's words on it —
  // which is `listPortalTasks`' `where` and `portalCategory` agreeing,
  // the pair whose precondition neither can state alone.
  await item({
    tenantId: T,
    clientId: acme,
    projectId: pOn,
    title: SHOWN.declined,
    category: "CANCELLED",
    visibility: "CLIENT_VISIBLE",
    kind: "REQUEST",
    triageStatus: "DECLINED",
    triageReason: SHOWN.declinedReason,
  });
  // AN ANSWERED REQUEST THAT WAS THEN ARCHIVED. Archiving is how an
  // agency tidies its own board and it must not also delete the
  // explanation the client was given — the same silent-vanish this
  // category exists to end, arriving by a different door.
  await item({
    tenantId: T,
    clientId: acme,
    projectId: pOn,
    title: SHOWN.archivedDeclined,
    category: "CANCELLED",
    visibility: "CLIENT_VISIBLE",
    kind: "REQUEST",
    triageStatus: "DECLINED",
    triageReason: SHOWN.archivedDeclinedReason,
    archivedAt: new Date(),
  });
  // …and the THIRD row of the set: a cancelled REQUEST with NO reason.
  // `transitionState` now refuses to create one through any service, so
  // this is planted raw — which is exactly what it is standing in for:
  // a row from before slice 6b, or one a future import writes. The
  // projection must NOT publish it, because "Declined" with a blank
  // under it is the failure this whole slice exists to end. Found by
  // both fresh reviews of the first cut, which published it.
  await item({
    tenantId: T,
    clientId: acme,
    projectId: pOn,
    title: S.cancelledRequestNoReason,
    category: "CANCELLED",
    visibility: "CLIENT_VISIBLE",
    kind: "REQUEST",
  });
  // THE ROW C31 IS ABOUT: a request the agency ACCEPTED — `acceptedAt`
  // set, which is the one thing that separates it from the declined row
  // above — and later stopped with a reply. It reads "Cancelled", not
  // "Declined": the client watched it as Planned, and the portal must
  // not tell them the agency never agreed to it.
  await item({
    tenantId: T,
    clientId: acme,
    projectId: pOn,
    title: SHOWN.cancelled,
    category: "CANCELLED",
    visibility: "CLIENT_VISIBLE",
    kind: "REQUEST",
    triageStatus: "DECLINED",
    triageReason: SHOWN.cancelledReply,
    acceptedAt: ACCEPTED_SENTINEL,
  });
  // …its control: an accepted request still in LIVE work. The stamp
  // says nothing about a live row — it is Planned like any other — and
  // the stamp's value must not ride out with it.
  await item({
    tenantId: T,
    clientId: acme,
    projectId: pOn,
    title: SHOWN.acceptedPlanned,
    category: "TODO",
    visibility: "CLIENT_VISIBLE",
    kind: "REQUEST",
    acceptedAt: ACCEPTED_SENTINEL,
  });
  // …and its fail-safe: accepted, cancelled, and NO reason. The new
  // category is built over the same reason term as the old one, so
  // this row stays invisible exactly as `cancelledRequestNoReason` does
  // — "Cancelled" with a blank under it is no better than "Declined"
  // with one.
  await item({
    tenantId: T,
    clientId: acme,
    projectId: pOn,
    title: S.cancelledAcceptedNoReason,
    category: "CANCELLED",
    visibility: "CLIENT_VISIBLE",
    kind: "REQUEST",
    acceptedAt: ACCEPTED_SENTINEL,
  });
  // …and the same outcome on an INTERNAL row, whose reason must never
  // travel: a member can decline a request they had already made
  // internal, and `portal_gate` — not the projection — is what keeps it
  // off the client's screen.
  await item({
    tenantId: T,
    clientId: acme,
    projectId: pOn,
    title: S.internalDeclined,
    category: "CANCELLED",
    visibility: "INTERNAL",
    kind: "REQUEST",
    triageStatus: "DECLINED",
    triageReason: S.triageOfInternal,
  });

  gates = await resolvePortalModuleGates(T);
});

afterAll(async () => {
  const db = getPlatformClient();
  for (const tenantId of [T, T2]) {
    await db.$executeRaw`DELETE FROM search_index WHERE tenant_id = ${tenantId}`;
    await db.workItemLabel.deleteMany({ where: { tenantId } });
    await db.workItem.deleteMany({ where: { tenantId } });
    await db.label.deleteMany({ where: { tenantId } });
    await db.milestone.deleteMany({ where: { tenantId } });
    await db.workflowState.deleteMany({ where: { tenantId } });
    await db.contact.deleteMany({ where: { tenantId } });
    await db.project.deleteMany({ where: { tenantId } });
    await db.client.deleteMany({ where: { tenantId } });
    await db.tenantPreference.deleteMany({ where: { tenantId } });
    await db.tenant.delete({ where: { id: tenantId } });
  }
});

const titles = (list: Awaited<ReturnType<typeof listPortalTasks>>) =>
  list.projects.flatMap((p) => p.tasks.map((t) => t.title)).sort();

describe("the client-visible task list", () => {
  it("returns exactly the shared, live tasks of portal-enabled projects — plus the client's own declined request", async () => {
    const list = await listPortalTasks(principal(ids.primary));
    expect(titles(list)).toEqual(
      [
        SHOWN.planned,
        SHOWN.started,
        SHOWN.done,
        SHOWN.triaged,
        SHOWN.dated,
        SHOWN.declined,
        SHOWN.archivedDeclined,
        SHOWN.cancelled,
        SHOWN.acceptedPlanned,
        `Shared, internal phase ${run}`,
      ].sort(),
    );
    expect(list.shown).toBe(10);
    expect(list.truncated).toBe(false);
    // One project, because the other three are off, another client's, or
    // another tenant's.
    expect(list.projects).toHaveLength(1);
    expect(list.projects[0]!.projectName).toBe(`Acme website ${run}`);
  });

  it("speaks the portal's six categories and never the tenant's", async () => {
    const list = await listPortalTasks(principal(ids.primary));
    const byTitle = new Map(list.projects.flatMap((p) => p.tasks).map((t) => [t.title, t]));
    expect(byTitle.get(SHOWN.planned)?.category).toBe("PLANNED");
    expect(byTitle.get(SHOWN.started)?.category).toBe("IN_PROGRESS");
    expect(byTitle.get(SHOWN.done)?.category).toBe("DONE");
    // TRIAGE is "Requested", not "Planned": it is the client's own
    // submission and nobody has agreed to it yet (portal.ts).
    expect(byTitle.get(SHOWN.triaged)?.category).toBe("REQUESTED");
    expect(byTitle.get(SHOWN.declined)?.category).toBe("DECLINED");
    // …and agreed work that was stopped is "Cancelled" (C31): the same
    // CANCELLED state, the same reply, told apart by `acceptedAt` alone.
    expect(byTitle.get(SHOWN.cancelled)?.category).toBe("CANCELLED");
    // An accepted request still in live work is Planned like any other:
    // the stamp decides nothing until the row is cancelled.
    expect(byTitle.get(SHOWN.acceptedPlanned)?.category).toBe("PLANNED");
  });

  /**
   * THE PAIR THE FOUNDER DECIDED ON 2026-09-22, and the reason this
   * fixture exists at all: before slice 6b the one row on a client's
   * list that they had submitted THEMSELVES vanished silently the moment
   * the agency said no.
   *
   * Both rows below are CLIENT_VISIBLE, in the same project, in the same
   * CANCELLED state. The only difference between them is `kind` — which
   * `listPortalTasks` filters on and never selects (it is on the portal
   * plane's never-selected list), so this is the only place the pairing
   * can be observed at all.
   */
  it("a cancelled REQUEST comes back as DECLINED with its reason — CANCELLED if it had been accepted — and a cancelled TASK stays invisible", async () => {
    const list = await listPortalTasks(principal(ids.primary));
    const byTitle = new Map(list.projects.flatMap((p) => p.tasks).map((t) => [t.title, t]));

    const declined = byTitle.get(SHOWN.declined);
    expect(declined?.category).toBe("DECLINED");
    expect(declined?.reply).toBe(SHOWN.declinedReason);

    // THE ROW C31 ADDED. Same state, same kind, same column carrying the
    // reply; `acceptedAt` is the only difference between this row and
    // the one above, and it is the difference between telling the
    // client "we stopped what we agreed to" and "we never agreed".
    const cancelled = byTitle.get(SHOWN.cancelled);
    expect(cancelled?.category).toBe("CANCELLED");
    expect(cancelled?.reply).toBe(SHOWN.cancelledReply);

    // The ordinary cancelled task: still nothing. Measured from both
    // ends, as the archived-project test does — the row exists and is
    // absent from the answer, so this is the projection's doing and not
    // an empty fixture.
    expect(titles(list)).not.toContain(S.cancelledTask);
    const db = getPlatformClient();
    expect(await db.workItem.count({ where: { tenantId: T, title: S.cancelledTask } })).toBe(1);
  });

  it("a cancelled REQUEST with NO reason stays invisible — the projection will not publish an answer it cannot show", async () => {
    // The fail-safe, and the case the first cut of this slice got
    // wrong: it keyed only on `kind`, so this row came back as
    // "Declined" with `declinedReason: null` and the page rendered the
    // chip with nothing under it. Both fresh reviews found it.
    //
    // The write path now refuses to MAKE such a row, so the fixture is
    // planted raw and stands in for what the write path cannot cover:
    // rows that predate this slice, and whatever writes one next.
    const list = await listPortalTasks(principal(ids.primary));
    expect(titles(list)).not.toContain(S.cancelledRequestNoReason);
    // …and the ACCEPTED twin (C31): the new category is built over the
    // same reason term, so "Cancelled" with a blank under it cannot ship
    // any more than "Declined" with one could.
    expect(titles(list)).not.toContain(S.cancelledAcceptedNoReason);
    const db = getPlatformClient();
    expect(
      await db.workItem.count({ where: { tenantId: T, title: S.cancelledRequestNoReason } }),
    ).toBe(1);
    expect(
      await db.workItem.count({ where: { tenantId: T, title: S.cancelledAcceptedNoReason } }),
    ).toBe(1);
  });

  it("an ARCHIVED request keeps its answer, while archived LIVE work still disappears", async () => {
    // The pair, in one test, because the rule is a distinction and not a
    // blanket: `archivedAt` is a term of the LIVE branch of the `where`
    // only. Archiving a task in progress hides it, as it always has;
    // archiving an answered request does not take the answer with it.
    const list = await listPortalTasks(principal(ids.primary));
    const byTitle = new Map(list.projects.flatMap((p) => p.tasks).map((t) => [t.title, t]));
    const kept = byTitle.get(SHOWN.archivedDeclined);
    expect(kept?.category).toBe("DECLINED");
    expect(kept?.reply).toBe(SHOWN.archivedDeclinedReason);
    // The control: an archived TODO task is still invisible.
    expect(titles(list)).not.toContain(S.archivedTask);
  });

  it("`reply` is null on every task that is not an answered request", async () => {
    // The column can only be set on a DECLINED/DUPLICATE row
    // (`work_item_triage_reason_iff_outcome`), but the projection ALSO
    // gates it on the category rather than on the column being present —
    // so if a later writer ever put a reason on a live task, this is the
    // assertion that fails first. Two answered categories since C31. A
    // gate keyed on `acceptedAt` instead of on the category is caught
    // by the DECLINED row (stamp null, reason set — its reply would come
    // back null), not by the accepted-but-live one: the CHECK keeps a
    // reason off a live row, so that one passes either way.
    const list = await listPortalTasks(principal(ids.primary));
    for (const task of list.projects.flatMap((p) => p.tasks)) {
      if (task.category === "DECLINED" || task.category === "CANCELLED") {
        expect(task.reply).not.toBeNull();
      } else {
        expect(task.reply).toBeNull();
      }
    }
  });

  it("shows a CLIENT_VISIBLE phase and never an INTERNAL one", async () => {
    const list = await listPortalTasks(principal(ids.primary));
    const byTitle = new Map(list.projects.flatMap((p) => p.tasks).map((t) => [t.title, t]));
    expect(byTitle.get(SHOWN.planned)?.phase).toBe(SHOWN.sharedPhase);
    // The ROW is shared; its milestone is not. RLS returns no milestone
    // row under this principal, so the name cannot be resolved — and the
    // projection renders that as "no phase", not as a blank name.
    expect(byTitle.get(`Shared, internal phase ${run}`)?.phase).toBeNull();
  });

  it("orders by the agreed day, soonest first, undated last — never by rank", async () => {
    const list = await listPortalTasks(principal(ids.primary));
    const tasks = list.projects[0]!.tasks;
    expect(tasks[0]!.title).toBe(SHOWN.dated);
    expect(tasks.slice(1).every((t) => t.targetDate === null)).toBe(true);
    // The DECLINED row is ordered by the same two keys as every other —
    // it is undated, so it lands among the undated. What puts it at the
    // FOOT of the card is the page's category grouping
    // (`PORTAL_TASK_CATEGORIES` ends with DECLINED), not this order.
  });

  it("gives a COLLABORATOR the same list — the capability is in both profiles", async () => {
    const collab = await listPortalTasks(principal(ids.collaborator));
    const primary = await listPortalTasks(principal(ids.primary));
    expect(titles(collab)).toEqual(titles(primary));
  });
});

describe("no INTERNAL fact reaches a contact", () => {
  it("no sentinel appears anywhere in the serialised projection", async () => {
    const serialised = JSON.stringify(await listPortalTasks(principal(ids.primary)));
    const leaked = Object.entries(S)
      .filter(([, value]) => serialised.includes(value))
      .map(([key]) => key);
    expect(leaked).toEqual([]);
    // The date the accepted rows were accepted (C31): SELECTED, so the
    // projection can choose the word, and never returned — a client is
    // owed "Cancelled", not the day the agency took the work on. Two of
    // the rows in the answer carry it; neither may show it.
    expect(serialised).not.toContain(ACCEPTED_SENTINEL_TEXT);
  });

  it("the projection carries no key that is not on the contract", async () => {
    // The sentinel sweep catches a leaked VALUE; this catches a leaked
    // SHAPE — an id, a tenant, a flag that says something about how the
    // tenant works. Together they are what "allow-list" means at runtime.
    const list = await listPortalTasks(principal(ids.primary));
    expect(Object.keys(list).sort()).toEqual(["projects", "shown", "truncated"]);
    for (const project of list.projects) {
      // `projectKey` since the Timeline slice: the card's link to the
      // one-screen project page. The key is the prefix of every task
      // number the client already reads.
      expect(Object.keys(project).sort()).toEqual(["projectId", "projectKey", "projectName", "tasks"]);
      for (const task of project.tasks) {
        expect(Object.keys(task).sort()).toEqual([
          // Slice 6c added the two at the top and neither is an id: the
          // contact assignee is COMPARED in the projection and consumed
          // there, so "is this one yours" leaves as a boolean, and the
          // claim leaves as the stamp the client themselves wrote. A
          // future `assigneeContactId` appearing on this list would be
          // the projection publishing which of a client's own people
          // owns what, which is their organisation and not ours.
          "assignedToYou",
          "category",
          "completedAt",
          "id",
          "markedDoneAt",
          "phase",
          // `declinedReason` until C31, when a second answered category
          // made the old name a lie on half the rows it is set on. No
          // `acceptedAt` here, and there must never be: the projection
          // reads it and consumes it (the sentinel sweep above proves
          // the value stays behind).
          "reply",
          "targetDate",
          "title",
        ]);
      }
    }
  });

  it("an ARCHIVED project stops publishing, even with its portal switch still on", async () => {
    // The policy does NOT do this and cannot be relied on to: `project`'s
    // `portal_gate` is `client_id = app.client_id AND portal_enabled`
    // with no archive term, and `archiveProject` leaves `portalEnabled`
    // true. Measured from both ends — the row is reachable to the tenant
    // and absent from the client's list.
    const list = await listPortalTasks(principal(ids.primary));
    expect(titles(list)).not.toContain(S.archivedProject);
    const db = getPlatformClient();
    expect(
      await db.workItem.count({ where: { tenantId: T, title: S.archivedProject } }),
    ).toBe(1);
    expect(
      (await db.project.findFirstOrThrow({
        where: { tenantId: T, id: pArchived },
        select: { portalEnabled: true },
      })).portalEnabled,
    ).toBe(true);
  });

  it("turning the project's portal switch off empties the list", async () => {
    const db = getPlatformClient();
    await db.project.update({ where: { tenantId_id: { tenantId: T, id: pOn } }, data: { portalEnabled: false } });
    try {
      const list = await listPortalTasks(principal(ids.primary));
      expect(list.projects).toEqual([]);
      expect(list.shown).toBe(0);
    } finally {
      await db.project.update({ where: { tenantId_id: { tenantId: T, id: pOn } }, data: { portalEnabled: true } });
    }
  });

  it("another client's contact sees its own client's work and nothing of Acme's", async () => {
    const list = await listPortalTasks(
      principal(ids.betaContact, { clientId: beta }),
    );
    expect(titles(list)).toEqual([S.otherClientTask]);
  });

  it("another tenant's contact reaches nothing here at all", async () => {
    const list = await listPortalTasks(
      principal(ids.gammaContact, { tenantId: T2, clientId: gamma, gates: await resolvePortalModuleGates(T2) }),
    );
    expect(titles(list)).toEqual([S.otherTenantTask]);
  });

  it("a suspended contact is refused before any row is read", async () => {
    await expect(listPortalTasks(principal(ids.suspended))).rejects.toBeInstanceOf(AuthzError);
  });

  it("a principal claiming another client's scope reads nothing of it", async () => {
    // The session and the row disagree: `authorizePortal` step 1 reads
    // the contact row under the claimed GUCs and refuses when they do
    // not match. NOT_FOUND, never FORBIDDEN — existence must not leak.
    const refusal = await listPortalTasks(principal(ids.primary, { clientId: beta })).catch(
      (e: unknown) => e,
    );
    expect(refusal).toBeInstanceOf(AuthzError);
    expect((refusal as AuthzError).reason).toBe("NOT_FOUND");
  });
});

describe("why Contact.invitedById is on the forbidden-columns list", () => {
  it("a contact really can read its client's OTHER contact rows, member id and all", async () => {
    // MEASURED, because the reason this column is forbidden is a claim
    // about a POLICY and not about a projection: `portal_gate` on
    // `contact` is structural — client match only, no visibility term
    // (migration 20260816180000) — so RLS hands a contact the whole row
    // of every colleague at its own client, and the only thing standing
    // between a `Member.id` and a client's browser is the allow-list in
    // a `portal.ts`. If this test ever starts returning zero rows, the
    // policy changed and the entry can be revisited; until then it is
    // load-bearing.
    const rows = await withPortalRead(principal(ids.primary), (tx) =>
      tx.contact.findMany({ select: { id: true, invitedById: true } }),
    );
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.find((r) => r.id === ids.collaborator)?.invitedById).toBe(memberId);
    // …and never a contact of another client, which is the half that
    // makes the row-level grant safe at all.
    expect(rows.some((r) => r.id === ids.betaContact)).toBe(false);
  });
});

describe("the projection cannot be run under the wrong principal", () => {
  it("refuses a system transaction — a projection built as system has lost the RLS net", async () => {
    // The mistake this guards is a plausible one, not a hypothetical:
    // brokered WRITES legitimately run as `system`, so that shape is
    // always nearby. `withPortalRead` stamps the handle it hands out and
    // `authorizePortal` refuses any other.
    await expect(
      withTenant(T, { type: "system" }, (tx) =>
        authorizePortal(tx, principal(ids.primary), "portal.work_item.view"),
      ),
    ).rejects.toBeInstanceOf(AuthzError);
  });

  it("reads under the contact principal, not merely inside the right tenant", async () => {
    // The control for the above: the INTERNAL task IS in this tenant and
    // IS in this client, so a read that merely scoped the tenant would
    // return it. Only the contact principal's `portal_gate` does not.
    const list = await listPortalTasks(principal(ids.primary));
    expect(titles(list)).not.toContain(S.internalTask);
    const db = getPlatformClient();
    expect(
      await db.workItem.count({ where: { tenantId: T, clientId: acme, title: S.internalTask } }),
    ).toBe(1);
  });
});

/**
 * NARROWING TO ONE PROJECT — the member plane's Portal tab reads through
 * this same function with `{ projectId }` (Phase 3 slice 4), so the
 * option's gates are part of this projection's contract rather than the
 * caller's problem.
 */
describe("listPortalTasks({ projectId })", () => {
  /**
   * A SECOND portal-enabled, unarchived project of the SAME client, and
   * it exists because without it this block measured nothing (code
   * review, 2026-09-21). The fixture above gives acme exactly one live
   * portal project, so "returns that project and nothing else of the
   * client's" was true by construction: a `{ projectId }` that did
   * nothing at all passed every assertion here.
   *
   * It is built in THIS describe's own `beforeAll` rather than in the
   * file's, so the four tests above — which assert exact title sets, a
   * single project group, and that flipping `pOn` off empties the whole
   * list — keep measuring what they were written to measure. The file's
   * `afterAll` deletes by tenant, so it needs no teardown of its own.
   */
  const pOn2 = randomUUID();
  const secondTitle = `Shared in the other project ${run}`;

  beforeAll(async () => {
    const db = getPlatformClient();
    await db.project.create({
      data: { id: pOn2, tenantId: T, clientId: acme, key: "PWON2", name: `Acme intranet ${run}`, portalEnabled: true },
    });
    let rank = 900;
    for (const category of ["BACKLOG", "TODO", "IN_PROGRESS", "DONE", "CANCELLED", "TRIAGE"] as const) {
      const id = randomUUID();
      states[`${pOn2}:${category}`] = id;
      await db.workflowState.create({
        data: {
          id,
          tenantId: T,
          projectId: pOn2,
          name: `${S.stateName}-${category}`,
          category,
          rank: `a${(rank++).toString().padStart(4, "0")}`,
          isDefault: category === "BACKLOG",
        },
      });
    }
    await item({ tenantId: T, clientId: acme, projectId: pOn2, title: secondTitle, category: "TODO", visibility: "CLIENT_VISIBLE" });
  });

  it("returns that project's shared work and nothing else of the client's", async () => {
    // The control: unnarrowed, this contact really does reach BOTH
    // projects. Without this line the assertion below is satisfied by a
    // client who only ever had one.
    const all = await listPortalTasks(principal(ids.primary));
    expect(all.projects.map((p) => p.projectId).sort()).toEqual([pOn, pOn2].sort());
    expect(titles(all)).toContain(secondTitle);

    const list = await listPortalTasks(principal(ids.primary), { projectId: pOn });
    expect(list.projects.map((p) => p.projectId)).toEqual([pOn]);
    expect(titles(list)).not.toContain(secondTitle);
    expect(list.shown).toBe(all.shown - 1);
  });

  it("refuses a project whose portal switch is OFF — the ref runs through portal_gate", async () => {
    // The unnarrowed call filters this project's rows out; the narrowed
    // one is REFUSED, because naming a resource makes steps 3–4 of
    // `authorizePortal` run against `project`'s own policy. That is the
    // point of passing the ref at all.
    await expect(
      listPortalTasks(principal(ids.primary), { projectId: pOff }),
    ).rejects.toBeInstanceOf(AuthzError);
  });

  it("refuses another client's project, as absent as one that does not exist", async () => {
    await expect(
      listPortalTasks(principal(ids.primary), { projectId: pBeta }),
    ).rejects.toBeInstanceOf(AuthzError);
    await expect(
      listPortalTasks(principal(ids.primary), { projectId: randomUUID() }),
    ).rejects.toBeInstanceOf(AuthzError);
  });

  it("ADMITS an archived project and then publishes nothing from it", async () => {
    // The two halves are deliberately different layers and this is where
    // that shows: `project.portal_gate` has no archive term, so the ref
    // passes; the projection's own `project: { archivedAt: null }` is
    // what empties the answer. A reviewer reading only the policy would
    // conclude the opposite.
    const list = await listPortalTasks(principal(ids.primary), { projectId: pArchived });
    expect(list.projects).toEqual([]);
    expect(list.shown).toBe(0);
  });
});

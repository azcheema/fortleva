import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { withTenant } from "@/db";
import { DomainError } from "@/lib/domain-error";
import { portalGateDecision } from "@/auth/portal-gate";
import { setupTenant } from "@/members/dbtest-fixture";
import { synthesiseContactPrincipal } from "@/portal";

import { changeItemVisibility, createItem, deleteItem, setItemArchived } from "./items";
import { listPortalTasks } from "./portal";
import { createRequest } from "./requests";
import { changeState, ensureProjectStates } from "./states";
import { listTriage, triageGlance, type TriageGlance } from "./triage-lane";
import { triageItem } from "./triage";
import { TRIAGE_REASON_MAX, TRIAGE_SNOOZE_MAX_DAYS } from "./triage-limits";

/**
 * THE TRIAGE LANE against the real database, the real `app_runtime`
 * role and the real §6.14 constraints (Phase 3 slice 6b).
 *
 * WHAT ONLY A DATABASE CAN SAY, and is therefore here rather than in a
 * unit test: that `work_item_triage_reason_iff_outcome` refuses a
 * reasonless decline no matter who writes it; that
 * `work_item_triage_has_status` and the state-sync trigger agree with
 * what the service thinks it wrote; that the audit row and the activity
 * row land in the SAME transaction as the state change, so a rolled-back
 * verb leaves no trail of a thing that did not happen; and that a
 * member without `work_item:triage` is refused by the permission
 * resolver rather than by an `if` in a page.
 *
 * ITS CENTRAL CLAIM IS THE FOUNDER'S 2026-09-22 DECISION: a client's own
 * request never disappears without a reason. Three separate mechanisms
 * hold it and each has its own case below — the service's parser, the
 * state machine's refusal, and the CHECK constraint.
 *
 * The tenant slug is spelled out literally at the `slug:` key by
 * `setupTenant("triage")` and the prefix `triage-` is registered in
 * `DBTEST_PREFIXES` (e2e/fixtures/seed-cli.ts) so `sweep-dbtests` can
 * collect this suite's orphans. `e2e-` is the BROWSER harness's prefix
 * and is swept by age — a dbtest using it would have its fixtures
 * deleted mid-run by a concurrent e2e run.
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
let clientId: string;
let projectId: string;
/**
 * A SECOND PROJECT NOBODY IS ASSIGNED TO, and it exists for one test.
 *
 * The employee is given a `MemberProject` on the first project so this
 * suite can separate the two triage permissions (see the `beforeAll`) —
 * which then left no seat holding `work_item:triage` WITHOUT scope, and
 * the scope half of `listTriage`'s gate untestable. A project outside
 * every assignment restores it: the same employee, the same permission,
 * a project it cannot reach.
 */
let unassignedProjectId: string;
const contactId = randomUUID();

beforeAll(async () => {
  f = await setupTenant("triage");
  clientId = randomUUID();
  projectId = randomUUID();
  await f.platform.client.create({ data: { id: clientId, tenantId: f.tenantId, name: "Acme" } });
  await f.platform.project.create({
    data: {
      id: projectId,
      tenantId: f.tenantId,
      clientId,
      key: "TRI",
      name: "Acme site",
      // The intake path re-reads this and refuses a switched-off project.
      portalEnabled: true,
    },
  });
  await f.platform.contact.create({
    data: {
      id: contactId,
      tenantId: f.tenantId,
      clientId,
      name: "Client Carol",
      email: `carol-${randomUUID().slice(0, 8)}@test.invalid`,
    },
  });
  await withTenant(f.tenantId, { type: "system" }, (tx) =>
    ensureProjectStates(tx, f.tenantId, projectId),
  );
  // **THE EMPLOYEE IS GIVEN SCOPE ON PURPOSE**, and without it this
  // suite could not tell the two permissions apart. `setupTenant` writes
  // no `MemberProject`, so an employee is refused by `assertInScope`
  // before any permission is consulted — which is exactly how the first
  // cut of this file's headline test came to prove nothing. With scope,
  // the employee holds `work_item:triage` (C M E) and NOT
  // `work_item:triage_decline` (C M), so it can Accept and Snooze and is
  // refused FORBIDDEN on Decline: the founder's 2026-09-22 split, as a
  // fixture rather than as a sentence.
  await f.platform.memberProject.create({
    data: { tenantId: f.tenantId, memberId: f.seats.employee.memberId, projectId },
  });

  unassignedProjectId = randomUUID();
  await f.platform.project.create({
    data: {
      id: unassignedProjectId,
      tenantId: f.tenantId,
      clientId,
      key: "TRIX",
      name: "Unassigned project",
    },
  });
}, 60_000);

afterAll(async () => {
  // A failed beforeAll leaves `f` unassigned, and Prisma DROPS an
  // undefined where-filter — every delete below would be unscoped
  // (the trap this repo has a memory of, which once wiped a shared dev
  // database).
  if (!f?.tenantId) return;
  const db = f.platform;
  await db.memberProject.deleteMany({ where: { tenantId: f.tenantId } });
  await db.workItemActivity.deleteMany({ where: { tenantId: f.tenantId } });
  // `duplicate_of_id` is ON DELETE RESTRICT, so the rows that POINT at
  // another must go first. Clearing the column is cheaper and safer
  // than ordering the deletes by hand.
  await db.workItem.updateMany({
    where: { tenantId: f.tenantId, duplicateOfId: { not: null } },
    data: { triageStatus: null, triageReason: null, duplicateOfId: null },
  });
  await db.workItem.deleteMany({ where: { tenantId: f.tenantId } });
  await db.workflowState.deleteMany({ where: { tenantId: f.tenantId } });
  await db.contact.deleteMany({ where: { tenantId: f.tenantId } });
  await db.project.deleteMany({ where: { tenantId: f.tenantId } });
  await db.client.deleteMany({ where: { tenantId: f.tenantId } });
  await db.tenantCounter.deleteMany({ where: { tenantId: f.tenantId } });
  await f.cleanup();
}, 60_000);

const ownerCtx = () => ({ tenantId: f.tenantId, actor: f.seats.owner.actor });
/**
 * **THE SEAT THAT ISOLATES THE PERMISSION, and picking the wrong one
 * made this suite's headline test vacuous** (code review, 2026-09-22).
 *
 * `work_item:triage` is `CME` — owner, manager, EMPLOYEE — so an
 * employee HOLDS it. The first cut of this file used that seat and saw
 * a refusal, but it came from `assertInScope`: `setupTenant` writes no
 * `MemberProject`, and `client:view_all` is `CMA`, so the employee has
 * an empty scope and `loadItemInScope` denies NOT_FOUND before the
 * verb's own gate is ever reached. Deleting the `requireAccess` line
 * from `triage.ts` left the test green.
 *
 * ADMIN is the seat that separates them: `CMA` gives it
 * `client:view_all` (so scope passes) and excludes it from `CME` (so
 * the permission denies). The two refusals are told apart by `reason`
 * — FORBIDDEN here, NOT_FOUND there — which is what the assertions
 * below check rather than merely that something threw.
 */
const adminCtx = () => ({ tenantId: f.tenantId, actor: f.seats.admin.actor });
const employeeCtx = () => ({ tenantId: f.tenantId, actor: f.seats.employee.actor });

/** A fresh PENDING request in the project's TRIAGE state, through the
 *  real intake path — so every row these tests answer is shaped exactly
 *  as a contact's submission is. */
async function newRequest(title: string, body: string | null = null): Promise<string> {
  const created = await withTenant(f.tenantId, { type: "system" }, (tx) =>
    createRequest(tx, f.tenantId, {
      projectId,
      title,
      body,
      reportedByContactId: contactId,
    }),
  );
  return created.id;
}

/** The two lifecycle stamps C29's delete guard is about. */
const lifecycle = (id: string) =>
  f.platform.workItem.findUniqueOrThrow({
    where: { id },
    select: { deletedAt: true, archivedAt: true },
  });

const readItem = (id: string) =>
  f.platform.workItem.findFirstOrThrow({
    where: { tenantId: f.tenantId, id },
    select: {
      stateCategory: true,
      triageStatus: true,
      triageReason: true,
      snoozedUntil: true,
      duplicateOfId: true,
      completedAt: true,
      visibility: true,
    },
  });

describe("the four verbs", () => {
  it("ACCEPT moves the request to the project's default state and clears its triage status", async () => {
    const id = await newRequest("Please add a contact form");
    const out = await triageItem(ownerCtx(), id, { verb: "ACCEPT" });

    expect(out.verb).toBe("ACCEPT");
    expect(out.triageStatus).toBeNull();
    expect(out.state?.changed).toBe(true);
    // The seeded default is "To do" (`DEFAULT_STATE_SHAPE`), resolved
    // from the PROJECT and never chosen by the caller.
    expect(out.state?.stateSeedKey).toBe("TODO");

    const row = await readItem(id);
    expect(row.stateCategory).toBe("TODO");
    // `triageStatus` is the only one of the four that a PENDING request
    // actually carries, so it is the only one this case measures — the
    // reason and the duplicate are unreachable while pending (the CHECK
    // forbids them), and `snoozedUntil` is covered by the snooze cases
    // below. Said plainly because the first version of this test
    // asserted all four and claimed to prove a clear that three of them
    // could not have observed.
    expect(row.triageStatus).toBeNull();
    expect(row.triageReason).toBeNull();
    expect(row.snoozedUntil).toBeNull();
    // The client can still see it — accepting does not change who reads
    // it, only what it says. This is the row born CLIENT_VISIBLE at
    // intake and it stays that way.
    expect(row.visibility).toBe("CLIENT_VISIBLE");
  });

  it("DECLINE cancels the request and keeps the agency's reason on the row", async () => {
    const id = await newRequest("Please rebuild the site in Flash");
    const reason = "Flash has not run in a browser since 2020.";
    const out = await triageItem(ownerCtx(), id, { verb: "DECLINE", reason });

    expect(out.triageStatus).toBe("DECLINED");
    expect(out.state?.stateSeedKey).toBe("CANCELLED");

    const row = await readItem(id);
    expect(row.stateCategory).toBe("CANCELLED");
    expect(row.triageStatus).toBe("DECLINED");
    expect(row.triageReason).toBe(reason);
    // NOT a completion. `transitionState` clears `completedAt` for every
    // category but DONE, and a declined request that carried one would
    // read on the client's screen as "finished".
    expect(row.completedAt).toBeNull();
  });

  it("DUPLICATE cancels it, names the row it duplicates, and still carries a reason", async () => {
    const original = await createItem(ownerCtx(), { projectId, title: "Contact form" });
    const id = await newRequest("Add a form to the contact page");
    const out = await triageItem(ownerCtx(), id, {
      verb: "DUPLICATE",
      reason: "Already tracked — we will let you know when it ships.",
      duplicateOfId: original.id,
    });

    expect(out.triageStatus).toBe("DUPLICATE");
    const row = await readItem(id);
    expect(row.stateCategory).toBe("CANCELLED");
    expect(row.duplicateOfId).toBe(original.id);
    expect(row.triageReason).not.toBeNull();
  });

  it("SNOOZE leaves the row exactly where it is and only sets the two columns", async () => {
    const id = await newRequest("Refresh the photography");
    const until = new Date(Date.now() + 7 * 86_400_000);
    const out = await triageItem(ownerCtx(), id, { verb: "SNOOZE", until });

    // NO transition: the client's list must keep saying "Requested",
    // because it still is.
    expect(out.state).toBeNull();
    const row = await readItem(id);
    expect(row.stateCategory).toBe("TRIAGE");
    expect(row.triageStatus).toBe("SNOOZED");
    expect(row.snoozedUntil?.toISOString()).toBe(until.toISOString());
    expect(row.triageReason).toBeNull();
  });

  it("a snoozed request can still be answered — snooze is not a state", async () => {
    const id = await newRequest("Maybe a newsletter");
    await triageItem(ownerCtx(), id, { verb: "SNOOZE", until: new Date(Date.now() + 86_400_000) });
    await triageItem(ownerCtx(), id, { verb: "DECLINE", reason: "Not this year." });
    const row = await readItem(id);
    expect(row.triageStatus).toBe("DECLINED");
    // The wake-up time goes with the verb that ended it: a cancelled row
    // carrying a future `snoozedUntil` would come back to a lane it can
    // never re-enter.
    expect(row.snoozedUntil).toBeNull();
  });
});

/**
 * WHAT A TOAST MAY PROMISE (C29b). Four doors send a reply now and every
 * one of them says either "your client can read your reply" or "saved,
 * but your client cannot read it while…" — from `clientSees`. One case
 * per term, each flipped on its own, so deleting any term fails exactly
 * one — AND EVERY CASE ASKS THE CLIENT'S OWN PORTAL LIST TOO:
 * `listPortalTasks` under the contact's principal, the projection the
 * reply is actually read through, must agree with the outcome. That binds
 * `clientSees` to what a client sees rather than to a copy of the rule,
 * so a later change to either drifts into a red test instead of a false
 * toast (review) — for every term the LIST enforces. The one it does not,
 * a confirmed address, belongs to the portal's session gate
 * (`portalGateDecision`), and its case agrees with that gate instead.
 */
describe("the outcome says whether the client can read the reply", () => {
  // THE AUDIENCE, for this block only: Carol becomes a contact who could
  // sign in (ACTIVE, invited, address confirmed). The fixture's default
  // NO_ACCESS is what every other block of this file assumes, so it is
  // put back.
  beforeAll(async () => {
    await f.platform.contact.update({
      where: { id: contactId },
      data: { portalStatus: "ACTIVE", invitedAt: new Date(), emailVerified: true },
    });
  });
  afterAll(async () => {
    await f.platform.contact.update({
      where: { id: contactId },
      data: { portalStatus: "NO_ACCESS", invitedAt: null, emailVerified: false },
    });
  });

  /** Whether the client's own portal list carries the row — a refusal (nobody to read it, the module off) is "no". */
  async function portalShows(id: string): Promise<boolean> {
    const principal = await synthesiseContactPrincipal(f.tenantId, { id: contactId, tenantId: f.tenantId, clientId });
    try {
      const list = await listPortalTasks(principal);
      return list.projects.some((p) => p.tasks.some((t) => t.id === id));
    } catch (e) {
      if (e instanceof AuthzError) return false;
      throw e;
    }
  }

  /** Decline the request, and require the outcome AND the client's list to say `expected`. */
  async function declineAndCompare(id: string, expected: boolean): Promise<void> {
    const out = await triageItem(ownerCtx(), id, { verb: "DECLINE", reason: "Not this time." });
    expect(out.clientSees).toBe(expected);
    expect(await portalShows(id), "the client's own portal list agrees with the toast").toBe(expected);
  }

  it("TRUE for a shared request in a live project, with its portal on and somebody to read it", async () => {
    await declineAndCompare(await newRequest("Shared and live"), true);
    // The lane verbs carry it too — the client still sees the request.
    const snoozed = await newRequest("Shared, snoozed");
    try {
      const out = await triageItem(ownerCtx(), snoozed, {
        verb: "SNOOZE",
        until: new Date(Date.now() + 86_400_000),
      });
      expect(out.clientSees).toBe(true);
      expect(await portalShows(snoozed)).toBe(true);
    } finally {
      await triageItem(ownerCtx(), snoozed, { verb: "DECLINE", reason: "Cleanup." });
    }
  });

  it("FALSE once a member has made the request private — through the real service", async () => {
    const id = await newRequest("Made private since");
    await changeItemVisibility(ownerCtx(), id, "INTERNAL");
    await declineAndCompare(id, false);
  });

  it("FALSE while the project's portal is switched off", async () => {
    const id = await newRequest("Portal about to go off");
    // Through the fan-out trigger, exactly as the Portal tab's switch
    // writes it: the ROW's `portalEnabled` is what `portal_gate` reads.
    await f.platform.project.update({ where: { id: projectId }, data: { portalEnabled: false } });
    try {
      expect((await f.platform.workItem.findUniqueOrThrow({ where: { id } })).portalEnabled).toBe(false);
      await declineAndCompare(id, false);
    } finally {
      await f.platform.project.update({ where: { id: projectId }, data: { portalEnabled: true } });
    }
  });

  it("FALSE in an archived project — the portal hides the whole project", async () => {
    const id = await newRequest("Project about to be archived");
    // Put back EXACTLY as found: the fixture's project is PLANNED (the
    // column default), not ACTIVE.
    const before = await f.platform.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { status: true, archivedAt: true },
    });
    await f.platform.project.update({
      where: { id: projectId },
      data: { status: "ARCHIVED", archivedAt: new Date() },
    });
    try {
      await declineAndCompare(id, false);
    } finally {
      await f.platform.project.update({ where: { id: projectId }, data: before });
    }
  });

  it("FALSE when nobody at the client can sign in — the one contact's access paused", async () => {
    // The Portal tab's NO_AUDIENCE: the row, the switch and the project
    // are all fine, and there is simply no one to read the reply. The
    // first cut of `clientSees` said TRUE here.
    const id = await newRequest("Nobody left to read it");
    await f.platform.contact.update({ where: { id: contactId }, data: { portalStatus: "SUSPENDED" } });
    try {
      await declineAndCompare(id, false);
    } finally {
      await f.platform.contact.update({ where: { id: contactId }, data: { portalStatus: "ACTIVE" } });
    }
  });

  it("FALSE when the only contact never confirmed their address — the portal's SESSION gate refuses them", async () => {
    // The one term the list check above cannot see: `listPortalTasks`
    // and `synthesiseContactPrincipal` do not look at `emailVerified` —
    // the session gate does (`portalGateDecision`, which refuses an
    // unverified contact's session outright). So the agreement here is
    // with THAT gate, over the very row `clientSees` read (fix review:
    // this term was pinned by nothing).
    const id = await newRequest("Nobody verified to read it");
    await f.platform.contact.update({ where: { id: contactId }, data: { emailVerified: false } });
    try {
      const out = await triageItem(ownerCtx(), id, { verb: "DECLINE", reason: "Not this time." });
      expect(out.clientSees).toBe(false);
      const carol = await f.platform.contact.findUniqueOrThrow({
        where: { id: contactId },
        select: { portalStatus: true, emailVerified: true },
      });
      expect(
        portalGateDecision({
          hasSession: true,
          tenantId: f.tenantId,
          clientId,
          portalStatus: carol.portalStatus,
          emailVerified: carol.emailVerified,
        }),
        "the session gate refuses the same contact",
      ).toBe("unverified");
    } finally {
      await f.platform.contact.update({ where: { id: contactId }, data: { emailVerified: true } });
    }
  });

  it("FALSE while the workspace's portal module is switched off", async () => {
    // The Portal tab's MODULE_OFF, and the one term read after the commit
    // (`triageItem`): gate 3, a tenant preference, the switch an owner
    // actually has.
    const id = await newRequest("Module about to go off");
    await f.platform.tenantPreference.create({
      data: { tenantId: f.tenantId, key: "module.portal.enabled", value: false },
    });
    try {
      await declineAndCompare(id, false);
    } finally {
      await f.platform.tenantPreference.deleteMany({
        where: { tenantId: f.tenantId, key: "module.portal.enabled" },
      });
    }
  });
});

describe("a client's request never disappears without a reason", () => {
  it("DECLINE refuses an empty reason, and a reason of whitespace", async () => {
    const id = await newRequest("Something");
    for (const reason of ["", "   ", "\n\t "]) {
      const e = await triageItem(ownerCtx(), id, { verb: "DECLINE", reason }).catch(
        (err: unknown) => err,
      );
      expect(e).toBeInstanceOf(DomainError);
      expect((e as DomainError).code).toBe("INVALID_INPUT");
    }
    // Nothing was written by any of the three attempts.
    expect((await readItem(id)).stateCategory).toBe("TRIAGE");
  });

  it("DECLINE refuses a reason past the column's own cap", async () => {
    const id = await newRequest("Something long");
    const e = await triageItem(ownerCtx(), id, {
      verb: "DECLINE",
      reason: "x".repeat(TRIAGE_REASON_MAX + 1),
    }).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(DomainError);
    // …and one exactly AT the cap goes through, so the boundary is the
    // one the column states and not one off it.
    await triageItem(ownerCtx(), id, { verb: "DECLINE", reason: "x".repeat(TRIAGE_REASON_MAX) });
    expect((await readItem(id)).triageReason).toHaveLength(TRIAGE_REASON_MAX);
  });

  it("an ORDINARY move from triage into a cancelled state is refused, and points at the verb", async () => {
    // THE SECOND MECHANISM. The parser above only sees callers that go
    // through `triageItem`; this is the one that stops a board drag, the
    // state picker, the palette and the bulk bar — every one of which
    // reaches `transitionState` and none of which has a reason to offer.
    const id = await newRequest("Please delete the blog");
    const cancelled = await f.platform.workflowState.findFirstOrThrow({
      where: { tenantId: f.tenantId, projectId, category: "CANCELLED" },
      select: { id: true },
    });
    const e = await changeState(ownerCtx(), id, cancelled.id).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(DomainError);
    expect((e as DomainError).code).toBe("INVALID_INPUT");
    expect((await readItem(id)).stateCategory).toBe("TRIAGE");
  });

  it("…while every OTHER ordinary move out of triage is allowed, and clears the triage columns", async () => {
    // Dragging a request into "To do" IS accepting it. What used to be
    // missing is the clear: the row sat in To do still marked PENDING,
    // where the lane's own query would find it for ever.
    const id = await newRequest("Please add a blog");
    await triageItem(ownerCtx(), id, { verb: "SNOOZE", until: new Date(Date.now() + 86_400_000) });
    const todo = await f.platform.workflowState.findFirstOrThrow({
      where: { tenantId: f.tenantId, projectId, seedKey: "TODO" },
      select: { id: true },
    });
    await changeState(ownerCtx(), id, todo.id);
    const row = await readItem(id);
    expect(row.stateCategory).toBe("TODO");
    expect(row.triageStatus).toBeNull();
    expect(row.snoozedUntil).toBeNull();
  });

  it("the DATABASE refuses a reasonless decline even when no service is involved", async () => {
    // THE THIRD MECHANISM, and the only one a future import, a fixture
    // or a hand-written UPDATE cannot walk past.
    // `work_item_triage_reason_iff_outcome` (20260922120000).
    const id = await newRequest("Raw write");
    await expect(
      f.platform.workItem.update({
        where: { tenantId_id: { tenantId: f.tenantId, id } },
        data: { triageStatus: "DECLINED", triageReason: null },
        select: { id: true },
      }),
    ).rejects.toThrow(/work_item_triage_reason_iff_outcome/);
    // …and the converse half: a reason with no outcome to explain it.
    await expect(
      f.platform.workItem.update({
        where: { tenantId_id: { tenantId: f.tenantId, id } },
        data: { triageReason: "because" },
        select: { id: true },
      }),
    ).rejects.toThrow(/work_item_triage_reason_iff_outcome/);
  });

  it("the DATABASE refuses a DUPLICATE that names nothing", async () => {
    const id = await newRequest("Raw duplicate");
    await expect(
      f.platform.workItem.update({
        where: { tenantId_id: { tenantId: f.tenantId, id } },
        data: { triageStatus: "DUPLICATE", triageReason: "dup", duplicateOfId: null },
        select: { id: true },
      }),
    ).rejects.toThrow(/work_item_triage_duplicate_has_target/);
  });
});

/**
 * THE HOLE BOTH INDEPENDENT REVIEWS FOUND IN THE FIRST CUT, as
 * fixtures. The guard used to key on the category the row was LEAVING,
 * so it caught only the one-step route; these are the ordinary
 * two-step ones, and the second is the worse of the two.
 */
describe("a request cannot be ended by the back door", () => {
  it("an ACCEPTED request cannot then be cancelled by an ordinary move", async () => {
    // The ordinary agency workflow: take the work on, drop it weeks
    // later. Before the fix this produced a CANCELLED request with no
    // reason, and the portal announced "Declined" with a blank under
    // it — in the agency's name, to the client who asked.
    const id = await newRequest("Accepted then dropped");
    await triageItem(ownerCtx(), id, { verb: "ACCEPT" });
    const cancelled = await f.platform.workflowState.findFirstOrThrow({
      where: { tenantId: f.tenantId, projectId, category: "CANCELLED" },
      select: { id: true },
    });
    const e = await changeState(ownerCtx(), id, cancelled.id).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(DomainError);
    expect((e as DomainError).code).toBe("INVALID_INPUT");
    expect((await readItem(id)).stateCategory).toBe("TODO");

    // …and the verb CAN end it, from a live state. That is the other
    // half of the fix: if DECLINE only worked in the lane, the refusal
    // above would have made an accepted request uncancellable.
    await triageItem(ownerCtx(), id, { verb: "DECLINE", reason: "Client changed direction." });
    const row = await readItem(id);
    expect(row.stateCategory).toBe("CANCELLED");
    expect(row.triageReason).toBe("Client changed direction.");
  });

  it("REOPENING a declined request drops the old reason, so a later cancel cannot republish it", async () => {
    // The stale-reason path. Decline with words, think better of it,
    // drag it back to live work: before the fix the row kept
    // `DECLINED` and the old text on a TODO row, and the next ordinary
    // cancel republished those words as the answer to a decision
    // nobody had made.
    const id = await newRequest("Declined then reopened");
    await triageItem(ownerCtx(), id, { verb: "DECLINE", reason: "No budget this quarter." });
    const todo = await f.platform.workflowState.findFirstOrThrow({
      where: { tenantId: f.tenantId, projectId, seedKey: "TODO" },
      select: { id: true },
    });
    await changeState(ownerCtx(), id, todo.id);

    const reopened = await readItem(id);
    expect(reopened.stateCategory).toBe("TODO");
    expect(reopened.triageStatus).toBeNull();
    expect(reopened.triageReason).toBeNull();
    expect(reopened.duplicateOfId).toBeNull();
  });

  it("a member with work_item:edit alone cannot reach the end state either", async () => {
    // The authorization half, and the reason the guard keys on `kind`
    // rather than on the state being left: with the old guard, an
    // edit-only member could accept a request and then cancel it,
    // reaching the same end state as a decline without ever holding
    // `work_item:triage`. That made the permission a speed bump.
    // (Driven through the OWNER here — the employee seat has no scope
    // in this fixture — because what is being measured is that the
    // STATE MACHINE refuses the route, for everyone.)
    const id = await newRequest("Edit-only route");
    await triageItem(ownerCtx(), id, { verb: "ACCEPT" });
    const cancelled = await f.platform.workflowState.findFirstOrThrow({
      where: { tenantId: f.tenantId, projectId, category: "CANCELLED" },
      select: { id: true },
    });
    await expect(changeState(ownerCtx(), id, cancelled.id)).rejects.toBeInstanceOf(DomainError);
  });

  it("an ordinary TASK is still cancelled the ordinary way", async () => {
    // The control: the refusal is about REQUESTS, not about cancelling.
    const ordinary = await createItem(ownerCtx(), { projectId, title: "Ordinary cancellable" });
    const cancelled = await f.platform.workflowState.findFirstOrThrow({
      where: { tenantId: f.tenantId, projectId, category: "CANCELLED" },
      select: { id: true },
    });
    const out = await changeState(ownerCtx(), ordinary.id, cancelled.id);
    expect(out.changed).toBe(true);
    expect((await readItem(ordinary.id)).stateCategory).toBe("CANCELLED");
  });

  it("AN ANSWERED REQUEST CANNOT BE DELETED — the last silent-vanish (C29)", async () => {
    // **THE DOOR THE OTHER GUARDS LEFT OPEN.** `transitionState` refuses
    // to cancel a REQUEST without a reason, and `listPortalTasks`
    // publishes a cancelled one only when it carries `triageReason`. A
    // soft delete walked round both: the projection filters
    // `deletedAt: null` at the top level, so deleting an
    // answered request erased the row AND the agency's own reply from
    // the client's list, with nothing said. Found by C29's recon.
    const answered = await newRequest("Answered, then deleted");
    await triageItem(ownerCtx(), answered, { verb: "DECLINE", reason: "Out of scope for now." });
    const e = await deleteItem(ownerCtx(), answered).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(DomainError);
    expect((e as DomainError).code).toBe("REQUEST_ANSWER_IS_THE_CLIENTS");
    expect((await lifecycle(answered)).deletedAt).toBeNull();

    // ARCHIVING IS STILL ALLOWED, and that is the point of refusing only
    // the delete: the CANCELLED branch of the projection carries no
    // `archivedAt` term, so an archived answer stays readable to the
    // client while leaving the agency's own lists.
    await setItemArchived(ownerCtx(), answered, true);
    expect((await lifecycle(answered)).archivedAt).not.toBeNull();
  });

  it("an UNANSWERED request is still deletable — the guard is on the reply, not the kind", async () => {
    // A member who files a request by mistake, or clears spam out of the
    // lane, is hiding nothing from anybody: the client has never been
    // told anything about it. What the guard protects is the agency's
    // own words once they are in front of somebody.
    const untouched = await newRequest("Filed by mistake");
    await deleteItem(ownerCtx(), untouched);
    expect((await lifecycle(untouched)).deletedAt).not.toBeNull();
  });

});

describe("what the verb refuses", () => {
  it("a member without work_item:triage is refused BY THE PERMISSION — and nothing is written", async () => {
    // FORBIDDEN, not NOT_FOUND, and the distinction is the whole test:
    // the admin reaches the row (client:view_all) and is stopped by the
    // gate. Assert the reason, or a scope denial passes for a
    // permission denial and the gate has no test at all — which is
    // exactly what happened in the first cut (see `adminCtx`).
    const id = await newRequest("Admin may not decline this");
    const refusal = await triageItem(adminCtx(), id, {
      verb: "DECLINE",
      reason: "no",
    }).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(AuthzError);
    expect((refusal as AuthzError).reason).toBe("FORBIDDEN");
    expect((await readItem(id)).stateCategory).toBe("TRIAGE");
  });

  it("AN EMPLOYEE MAY ACCEPT AND SNOOZE BUT NOT DECLINE — the founder's split", async () => {
    // The whole point of `work_item:triage_decline` (C M), and the
    // reason the employee has scope in this fixture: both verbs reach
    // the same row, through the same service, under the same member.
    // Only the second permission separates them.
    const snoozable = await newRequest("Employee may park this");
    await triageItem(employeeCtx(), snoozable, {
      verb: "SNOOZE",
      until: new Date(Date.now() + 86_400_000),
    });
    expect((await readItem(snoozable)).triageStatus).toBe("SNOOZED");

    const acceptable = await newRequest("Employee may take this on");
    await triageItem(employeeCtx(), acceptable, { verb: "ACCEPT" });
    expect((await readItem(acceptable)).stateCategory).toBe("TODO");

    // …and may NOT end one. FORBIDDEN, not NOT_FOUND: the employee
    // reaches the row (it has scope now) and is stopped by the second
    // permission, which is the distinction this test exists to draw.
    const declinable = await newRequest("Employee may not end this");
    for (const input of [
      { verb: "DECLINE", reason: "no" } as const,
      { verb: "DUPLICATE", reason: "dup", duplicateOfId: acceptable } as const,
    ]) {
      const refusal = await triageItem(employeeCtx(), declinable, input).catch((e: unknown) => e);
      expect(refusal).toBeInstanceOf(AuthzError);
      expect((refusal as AuthzError).reason).toBe("FORBIDDEN");
    }
    expect((await readItem(declinable)).stateCategory).toBe("TRIAGE");

    await triageItem(ownerCtx(), snoozable, { verb: "DECLINE", reason: "Cleanup." });
    await triageItem(ownerCtx(), declinable, { verb: "DECLINE", reason: "Cleanup." });
  });

  it("ACCEPT and SNOOZE are LANE verbs — they refuse anything not in triage", async () => {
    const ordinary = await createItem(ownerCtx(), { projectId, title: "Ordinary task" });
    for (const input of [
      { verb: "ACCEPT" } as const,
      { verb: "SNOOZE", until: new Date(Date.now() + 86_400_000) } as const,
    ]) {
      const e = await triageItem(ownerCtx(), ordinary.id, input).catch((err: unknown) => err);
      expect(e).toBeInstanceOf(DomainError);
      expect((e as DomainError).code).toBe("INVALID_INPUT");
    }
  });

  it("DECLINE refuses a row that is not a REQUEST at all", async () => {
    const ordinary = await createItem(ownerCtx(), { projectId, title: "Not a request" });
    const e = await triageItem(ownerCtx(), ordinary.id, {
      verb: "DECLINE",
      reason: "no",
    }).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(DomainError);
    expect((e as DomainError).code).toBe("INVALID_INPUT");
  });

  it("an already-answered request cannot be answered twice", async () => {
    const id = await newRequest("Answered once");
    await triageItem(ownerCtx(), id, { verb: "DECLINE", reason: "No, sorry." });
    const e = await triageItem(ownerCtx(), id, { verb: "ACCEPT" }).catch((err: unknown) => err);
    expect(e).toBeInstanceOf(DomainError);
    expect((await readItem(id)).triageStatus).toBe("DECLINED");
  });

  it("DUPLICATE refuses the item itself, a row in another project, and one that does not exist", async () => {
    const other = randomUUID();
    await f.platform.project.create({
      data: { id: other, tenantId: f.tenantId, clientId, key: "TRIB", name: "Other project" },
    });
    await withTenant(f.tenantId, { type: "system" }, (tx) =>
      ensureProjectStates(tx, f.tenantId, other),
    );
    const elsewhere = await createItem(ownerCtx(), { projectId: other, title: "Elsewhere" });
    const id = await newRequest("Dup checks");

    const attempt = (duplicateOfId: string) =>
      triageItem(ownerCtx(), id, { verb: "DUPLICATE", reason: "dup", duplicateOfId }).catch(
        (e: unknown) => e,
      );

    expect(await attempt(id)).toBeInstanceOf(DomainError);
    // A row the member cannot name and a row that does not exist answer
    // IDENTICALLY, or the picker becomes an existence oracle (AUTHZ §4).
    expect(await attempt(elsewhere.id)).toBeInstanceOf(AuthzError);
    expect(await attempt(randomUUID())).toBeInstanceOf(AuthzError);
    expect((await readItem(id)).stateCategory).toBe("TRIAGE");

    await f.platform.workItem.deleteMany({ where: { tenantId: f.tenantId, projectId: other } });
    await f.platform.workflowState.deleteMany({ where: { tenantId: f.tenantId, projectId: other } });
    await f.platform.project.delete({ where: { tenantId_id: { tenantId: f.tenantId, id: other } } });
  });

  it("SNOOZE refuses a moment that is not in the future, and one past the cap", async () => {
    const id = await newRequest("Snooze bounds");
    for (const until of [
      new Date(Date.now() - 1000),
      new Date(Date.now() + (TRIAGE_SNOOZE_MAX_DAYS + 1) * 86_400_000),
    ]) {
      const e = await triageItem(ownerCtx(), id, { verb: "SNOOZE", until }).catch(
        (err: unknown) => err,
      );
      expect(e).toBeInstanceOf(DomainError);
    }
    expect((await readItem(id)).triageStatus).toBe("PENDING");
  });
});

/**
 * THE LANE'S READ, AND ITS TWO GATES.
 *
 * **BOTH FRESH REVIEWS OF THIS SLICE FOUND THE SAME GAP:** `listTriage`
 * shipped with no test of either gate, so deleting its `requireAccess`
 * or its `assertInScope` left typecheck, ESLint, the unit suite and
 * `test:db` green — and those two lines are the only thing between any
 * member of the tenant and every client's typed paragraph, in every
 * project. That is the identical failure the FIRST commit of this slice
 * was corrected for one day earlier, in a different file, which is why
 * it is written out here rather than quietly fixed.
 *
 * The seat matters as much as the assertion (see `adminCtx` above):
 * ADMIN separates the permission from the scope, EMPLOYEE separates the
 * scope from the permission, and asserting the `reason` is what stops
 * one standing in for the other.
 */
describe("the lane's read", () => {
  it("returns the project's pending requests, oldest first, with the client's words and name", async () => {
    const first = await newRequest("Oldest waiting", "We would like a newsletter signup.");
    const second = await newRequest("Newer waiting");

    const lane = await listTriage(ownerCtx(), projectId);
    const ids = lane.entries.map((e) => e.id);
    expect(ids.indexOf(first)).toBeLessThan(ids.indexOf(second));

    const entry = lane.entries.find((e) => e.id === first)!;
    expect(entry.title).toBe("Oldest waiting");
    // The client's paragraph, which is the whole point of the lane —
    // and the reason this read cannot live in `triage.ts` (that file is
    // in the portal tripwire's structural tier, which forbids selecting
    // `descriptionText`).
    expect(entry.body).toBe("We would like a newsletter signup.");
    expect(entry.reportedBy).toBe("Client Carol");
    expect(lane.truncated).toBe(false);

    await triageItem(ownerCtx(), first, { verb: "DECLINE", reason: "Not now." });
    await triageItem(ownerCtx(), second, { verb: "DECLINE", reason: "Not now." });
  });

  it("hides a request snoozed to the future and COUNTS it instead", async () => {
    const id = await newRequest("Parked");
    await triageItem(ownerCtx(), id, { verb: "SNOOZE", until: new Date(Date.now() + 5 * 86_400_000) });

    const lane = await listTriage(ownerCtx(), projectId);
    expect(lane.entries.map((e) => e.id)).not.toContain(id);
    // A lane that silently hid rows would be a lane that lost them.
    expect(lane.snoozedCount).toBeGreaterThanOrEqual(1);

    await triageItem(ownerCtx(), id, { verb: "DECLINE", reason: "Not now." });
  });

  it("shows a snoozed request again once its moment has passed", async () => {
    const id = await newRequest("Due again");
    await triageItem(ownerCtx(), id, { verb: "SNOOZE", until: new Date(Date.now() + 86_400_000) });
    // Reach past the service's "must be in the future" rule, which is
    // about what a MEMBER may choose and not about what the lane reads.
    await f.platform.workItem.update({
      where: { tenantId_id: { tenantId: f.tenantId, id } },
      data: { snoozedUntil: new Date(Date.now() - 60_000) },
      select: { id: true },
    });

    const lane = await listTriage(ownerCtx(), projectId);
    const entry = lane.entries.find((e) => e.id === id);
    expect(entry, "a snoozed request comes back when it is due").toBeDefined();
    // …and says so, so the member can tell it from one that just arrived.
    expect(entry!.snoozedUntil).not.toBeNull();

    await triageItem(ownerCtx(), id, { verb: "DECLINE", reason: "Not now." });
  });

  it("lists nothing that is not a REQUEST, even in a TRIAGE state", async () => {
    // Nothing in the product can put an ordinary task in triage, so this
    // is planted raw — which is the point: the lane's copy says
    // "requests your client has sent", and two of its four verbs would
    // half-work on a row that is not one.
    const ordinary = await createItem(ownerCtx(), { projectId, title: "Not a request" });
    const triage = await f.platform.workflowState.findFirstOrThrow({
      where: { tenantId: f.tenantId, projectId, category: "TRIAGE" },
      select: { id: true },
    });
    await f.platform.workItem.update({
      where: { tenantId_id: { tenantId: f.tenantId, id: ordinary.id } },
      data: { stateId: triage.id, stateCategory: "TRIAGE", triageStatus: "PENDING" },
      select: { id: true },
    });

    const lane = await listTriage(ownerCtx(), projectId);
    expect(lane.entries.map((e) => e.id)).not.toContain(ordinary.id);
  });

  it("an employee WITH scope reads the lane — the positive half of the gate", async () => {
    // Without this the refusals below could both be passing for a third
    // reason (a broken read, a bad fixture) and nobody would know.
    const lane = await listTriage(employeeCtx(), projectId);
    expect(Array.isArray(lane.entries)).toBe(true);
    // …and it is told it may not END one, which is what the surface
    // uses to hide the two verbs rather than offer a refusal.
    expect(lane.canDecline).toBe(false);
  });

  it("an owner is told it MAY end a request", async () => {
    expect((await listTriage(ownerCtx(), projectId)).canDecline).toBe(true);
  });

  it("REFUSES a member without work_item:triage — FORBIDDEN, by the permission", async () => {
    // The admin reaches the row (`client:view_all`) and is stopped by
    // the gate. Asserting the REASON is what makes this a test of the
    // permission rather than of the scope — see `adminCtx`.
    const refusal = await listTriage(adminCtx(), projectId).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(AuthzError);
    expect((refusal as AuthzError).reason).toBe("FORBIDDEN");
  });

  it("REFUSES a member with the permission but no scope — NOT_FOUND, by the scope", async () => {
    // The control, on the project the employee is NOT assigned to. Same
    // member, same `work_item:triage`, and it reads the first project
    // happily (the test above) — so what is measured here is
    // `assertInScope` and nothing else. Existence must not leak, so the
    // answer is the one a project that does not exist gets.
    const refusal = await listTriage(employeeCtx(), unassignedProjectId).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(AuthzError);
    expect((refusal as AuthzError).reason).toBe("NOT_FOUND");
  });
});

describe("the trail", () => {
  it("re-snoozing to the SAME moment writes nothing — no second event, no second history row", async () => {
    const id = await newRequest("Double submit");
    const until = new Date(Date.now() + 3 * 86_400_000);
    await triageItem(ownerCtx(), id, { verb: "SNOOZE", until });
    const audits = (await f.audits("work_item.triaged")).length;
    const rows = await f.platform.workItemActivity.count({
      where: { tenantId: f.tenantId, workItemId: id },
    });

    const again = await triageItem(ownerCtx(), id, { verb: "SNOOZE", until: new Date(until) });
    expect(again.snoozedUntil?.toISOString()).toBe(until.toISOString());
    expect((await f.audits("work_item.triaged")).length).toBe(audits);
    expect(
      await f.platform.workItemActivity.count({
        where: { tenantId: f.tenantId, workItemId: id },
      }),
    ).toBe(rows);
  });

  it("every verb writes one work_item.triaged event naming the verb, and no free text", async () => {
    const before = (await f.audits("work_item.triaged")).length;
    const id = await newRequest("Trail");
    const secret = "COMMERCIALLY SENSITIVE REASON";
    await triageItem(ownerCtx(), id, { verb: "DECLINE", reason: secret });

    const events = await f.audits("work_item.triaged");
    expect(events).toHaveLength(before + 1);
    const event = events.at(-1)!;
    expect(event.targetId).toBe(id);
    const metadata = event.metadata as Record<string, unknown>;
    expect(metadata.verb).toBe("DECLINE");
    expect(metadata.projectId).toBe(projectId);
    // IDS AND ENUMS ONLY (SECURITY.md §7): an audit row outlives the row
    // it describes, and a decline reason is prose about a named client.
    expect(JSON.stringify(event.metadata)).not.toContain(secret);
  });

  it("the state change keeps its OWN event — two rows, one transaction", async () => {
    const before = (await f.audits("work_item.state_changed")).length;
    const id = await newRequest("Two events");
    await triageItem(ownerCtx(), id, { verb: "ACCEPT" });
    expect((await f.audits("work_item.state_changed")).length).toBe(before + 1);
  });

  it("the reply the client was given is kept in the task's own history", async () => {
    // Founder decision, 2026-09-22. The audit row deliberately carries
    // no free text, so without this row NOTHING anywhere held the words
    // — and they are replaceable, because reopening a decline clears the
    // column and it can be declined again with different text.
    const id = await newRequest("Kept reply");
    const words = "We cannot do this before the launch, but we can look at it in Q3.";
    await triageItem(ownerCtx(), id, { verb: "DECLINE", reason: words });

    const rows = await f.platform.workItemActivity.findMany({
      where: { tenantId: f.tenantId, workItemId: id, field: "triageReason" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.newValue).toBe(words);
    // INTERNAL: `triageReason` is not on the portal-safe field list, so
    // this is the AGENCY's record of what it said. The client reads the
    // live answer through the projection, never through history.
    expect(rows[0]!.visibility).toBe("INTERNAL");

    // ACCEPT and SNOOZE carry no words, so they write no such row.
    const accepted = await newRequest("No reply to keep");
    await triageItem(ownerCtx(), accepted, { verb: "ACCEPT" });
    expect(
      await f.platform.workItemActivity.count({
        where: { tenantId: f.tenantId, workItemId: accepted, field: "triageReason" },
      }),
    ).toBe(0);
  });

  it("SNOOZE writes an INTERNAL history row — a client must not read 'they put this off'", async () => {
    const id = await newRequest("Internal history");
    await triageItem(ownerCtx(), id, { verb: "SNOOZE", until: new Date(Date.now() + 86_400_000) });
    const rows = await f.platform.workItemActivity.findMany({
      where: { tenantId: f.tenantId, workItemId: id, field: "triageStatus" },
    });
    expect(rows).toHaveLength(1);
    // `triageStatus` is not on `writeActivity`'s portal-safe field list,
    // and `work_item_activity_portal_safe_fields` (20260912120000) makes
    // that a constraint rather than a Set in TypeScript.
    expect(rows[0]!.visibility).toBe("INTERNAL");
    expect(rows[0]!.newValue).toBe("SNOOZED");
  });

  it("a REFUSED verb leaves no trail at all", async () => {
    const beforeAudit = (await f.audits("work_item.triaged")).length;
    const id = await newRequest("No trail");
    const beforeActivity = await f.platform.workItemActivity.count({
      where: { tenantId: f.tenantId, workItemId: id },
    });
    await expect(
      triageItem(adminCtx(), id, { verb: "DECLINE", reason: "no" }),
    ).rejects.toBeInstanceOf(AuthzError);
    expect((await f.audits("work_item.triaged")).length).toBe(beforeAudit);
    expect(
      await f.platform.workItemActivity.count({
        where: { tenantId: f.tenantId, workItemId: id },
      }),
    ).toBe(beforeActivity);
  });
});

/**
 * `/home`'S TRIAGE COUNT — the card rule 8 has owed since 2W.
 *
 * Every assertion here is RELATIVE, never an absolute total, and that
 * is deliberate: this suite has no `beforeEach` wipe, so the describes
 * above leave whatever they leave in triage. A test asserting "the
 * total is 3" would pass today and fail the day somebody adds a case
 * ten describes earlier — the classic fixture-order flake. What is
 * measured instead is the property that actually matters: **the card's
 * number equals the lane's rows, for the same member at the same
 * moment.**
 */
describe("the /home count", () => {
  beforeAll(async () => {
    // Only the portal switch is load-bearing: the intake path calls
    // `ensureProjectStates` itself. Harmless to the one existing test
    // that uses this project — that one is refused by `assertInScope`
    // before any of it is read.
    await f.platform.project.update({
      where: { id: unassignedProjectId },
      data: { portalEnabled: true },
    });
  }, 60_000);

  const countFor = (glance: TriageGlance | null, key: string) =>
    glance?.projects.find((p) => p.projectKey === key)?.count ?? 0;

  it("says exactly what the lane it links to will show", async () => {
    await newRequest("Glance agreement A");
    await newRequest("Glance agreement B");

    // ONE moment, two reads: the card and the lane, as a member sees
    // them. A card saying 3 over a lane showing 2 is the surface that
    // exists to tell the truth about a queue telling a lie about it.
    const [glance, lane] = await Promise.all([
      triageGlance(ownerCtx()),
      listTriage(ownerCtx(), projectId),
    ]);
    expect(countFor(glance, "TRI")).toBe(lane.entries.length);
    expect(lane.entries.length).toBeGreaterThan(0);
  });

  it("excludes a request snoozed into the future — in neither, by the shared predicate", async () => {
    const before = countFor(await triageGlance(ownerCtx()), "TRI");
    const id = await newRequest("Parked for a fortnight");
    expect(countFor(await triageGlance(ownerCtx()), "TRI")).toBe(before + 1);

    await triageItem(ownerCtx(), id, {
      verb: "SNOOZE",
      until: new Date(Date.now() + 14 * 86_400_000),
    });

    const [glance, lane] = await Promise.all([
      triageGlance(ownerCtx()),
      listTriage(ownerCtx(), projectId),
    ]);
    // Back where it started on the card, and gone from the lane's rows —
    // the two cannot disagree, because they are one expression.
    expect(countFor(glance, "TRI")).toBe(before);
    expect(countFor(glance, "TRI")).toBe(lane.entries.length);
    expect(lane.entries.some((e) => e.id === id)).toBe(false);
    // And it is not LOST: the lane still says it is parked.
    expect(lane.snoozedCount).toBeGreaterThan(0);
  });

  it("never puts a project the member's scope cannot reach on their home page", async () => {
    // A request in the project the employee has no `MemberProject` for.
    await withTenant(f.tenantId, { type: "system" }, (tx) =>
      createRequest(tx, f.tenantId, {
        projectId: unassignedProjectId,
        title: "Out of reach",
        body: null,
        reportedByContactId: contactId,
      }),
    );

    const [mine, theirs] = await Promise.all([
      triageGlance(employeeCtx()),
      triageGlance(ownerCtx()),
    ]);
    // THE NAME IS THE POINT, not only the number: scope is composed into
    // the query, so a project this member cannot open never reaches the
    // page to be counted OR named. Asserted as a difference between two
    // seats rather than as a total, so nothing an earlier describe left
    // behind can decide it.
    expect(countFor(theirs, "TRIX")).toBeGreaterThan(0);
    expect(countFor(mine, "TRIX")).toBe(0);
    expect(mine?.projects.some((p) => p.projectName === "Unassigned project")).toBe(false);
    // The employee still sees its OWN project, so the zero above is
    // about scope and not about a read that answered nothing.
    expect(countFor(mine, "TRI")).toBeGreaterThan(0);
  });

  it("keeps counting an ARCHIVED project's requests — archiving is not an answer", async () => {
    // **THE CASE BOTH FRESH REVIEWS FOUND, and nothing covered it.** The
    // first cut of `triageGlance` filtered `project: { archivedAt: null }`,
    // copying `listMyWork`. Follow that through: `archiveProject` leaves
    // child rows untouched, `portal.ts` already hides an archived
    // project's tasks from the CLIENT, and the filter would have hidden
    // them from the AGENCY too — a client's own request invisible to
    // everyone but whoever typed the archived project's triage URL. The
    // founder decided the mirror of this in 6b: an ANSWERED request
    // outlives the archive. An unanswered one owes the same.
    const id = await newRequest("Archived but still owed");
    const before = countFor(await triageGlance(ownerCtx()), "TRI");
    expect(before).toBeGreaterThan(0);

    // Put back EXACTLY as found (the fixture's project is PLANNED, the
    // column default — this used to restore ACTIVE).
    const found = await f.platform.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { status: true, archivedAt: true },
    });
    await f.platform.project.update({
      where: { id: projectId },
      data: { status: "ARCHIVED", archivedAt: new Date() },
    });
    try {
      // Still counted, and still exactly what the lane will show.
      const [glance, lane] = await Promise.all([
        triageGlance(ownerCtx()),
        listTriage(ownerCtx(), projectId),
      ]);
      expect(countFor(glance, "TRI")).toBe(before);
      expect(countFor(glance, "TRI")).toBe(lane.entries.length);
      expect(lane.entries.some((e) => e.id === id)).toBe(true);
    } finally {
      await f.platform.project.update({ where: { id: projectId }, data: found });
    }
  });

  it("answers NULL for a member who may not triage — the permission, alone", async () => {
    // ADMIN is the seat that isolates it, the reason this file's own
    // header gives: `client:view_all` is C M A so scope passes, and
    // `work_item:triage` is C M E so the permission does not. Delete the
    // `requireAccess` line from `triageGlance` and this test is the one
    // that fails.
    expect(await triageGlance(adminCtx())).toBeNull();
    // The positive twin, same tenant, same moment: a seat that holds it
    // gets a card. Without this, a read that answered null for EVERY
    // caller would pass the assertion above.
    expect(await triageGlance(employeeCtx())).not.toBeNull();
  });

  it("is a refusal, never a throw — /home must not 500 for a member with no triage rights", async () => {
    // `listTriage` denies; this one cannot, because it runs on every
    // member's landing page. The distinction is the whole reason there
    // are two functions rather than a flag.
    await expect(triageGlance(adminCtx())).resolves.toBeNull();
    const refusal = await listTriage(adminCtx(), projectId).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(AuthzError);
    expect((refusal as AuthzError).reason).toBe("FORBIDDEN");
  });
});

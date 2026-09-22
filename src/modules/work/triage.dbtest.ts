import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { withTenant } from "@/db";
import { DomainError } from "@/lib/domain-error";
import { setupTenant } from "@/members/dbtest-fixture";

import { createItem } from "./items";
import { createRequest } from "./requests";
import { changeState, ensureProjectStates } from "./states";
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
}, 60_000);

afterAll(async () => {
  // A failed beforeAll leaves `f` unassigned, and Prisma DROPS an
  // undefined where-filter — every delete below would be unscoped
  // (the trap this repo has a memory of, which once wiped a shared dev
  // database).
  if (!f?.tenantId) return;
  const db = f.platform;
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

  it("a member WITH the permission but no scope is refused NOT_FOUND — the other refusal", async () => {
    // The control for the test above. The employee HOLDS
    // `work_item:triage` and has an empty scope, so it gets past
    // `requireAccess` and is stopped by `assertInScope` — existence
    // must not leak, so the answer is the one a nonexistent row gets.
    const id = await newRequest("Employee cannot reach this");
    const refusal = await triageItem(employeeCtx(), id, {
      verb: "DECLINE",
      reason: "no",
    }).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(AuthzError);
    expect((refusal as AuthzError).reason).toBe("NOT_FOUND");
    expect((await readItem(id)).stateCategory).toBe("TRIAGE");
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

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { withTenant } from "@/db";
import { DomainError } from "@/lib/domain-error";
import { setupTenant } from "@/members/dbtest-fixture";
import { createItem } from "@/modules/work";

import {
  acknowledgeNotice,
  clockIn,
  clockOut,
  createEntry,
  createRateCard,
  deleteEntry,
  getCurrentShift,
  getCurrentTimer,
  getNoticeStatus,
  listBillRateCards,
  listCostRateCards,
  listMyEntries,
  listTeamEntries,
  listTeamShiftTotals,
  listWorkTypes,
  resetTimeDefaultsMemo,
  revealCostRates,
  settleMember,
  startBreak,
  startTimer,
  stopBreak,
  stopTimer,
  undoStart,
  updateEntry,
} from "./index";

/**
 * 2T core behaviour against the real database and the real app_runtime
 * role (PLAN.md Phase 2T "non-negotiable tests" + the 2026-08-20 D1–D6
 * additions): the staff-notice gate and lazy seeds, timer concurrency
 * and the auto-stop-previous + undo pattern, rate resolution incl. the
 * SERVICE tier, snapshot stability, the EXCLUDE no-overlap, card
 * immutability, COST encryption + ✦ reveal, deny-default scoping,
 * zero portal rows, manual/duration entries, the lock trigger + bypass
 * GUC, summary == SUM and the derived summary visibility, shifts +
 * breaks with the bounds triggers and closed-rows-only team totals,
 * and the deterministic lazy settle.
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
let acme: string;
let beta: string;
let acmeProject: string;
let betaProject: string;
let taskId: string;
let development: string; // Acme agreement, client-level
let maintenance: string; // Acme agreement, client-level
let betaOps: string; // Beta agreement
const contact = { id: randomUUID() };

const ownerCtx = () => ({ tenantId: f.tenantId, actor: f.seats.owner.actor });
const managerCtx = () => ({ tenantId: f.tenantId, actor: f.seats.manager.actor });
const employeeCtx = () => ({ tenantId: f.tenantId, actor: f.seats.employee.actor });

const domainCode = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "resolved";
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    throw e;
  }
};
const authzReason = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "resolved";
  } catch (e) {
    if (e instanceof AuthzError) return e.reason;
    throw e;
  }
};

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);

beforeAll(async () => {
  resetTimeDefaultsMemo();
  f = await setupTenant("time");
  acme = randomUUID();
  beta = randomUUID();
  acmeProject = randomUUID();
  betaProject = randomUUID();
  development = randomUUID();
  maintenance = randomUUID();
  betaOps = randomUUID();
  await f.platform.client.createMany({
    data: [
      { id: acme, tenantId: f.tenantId, name: "Acme" },
      { id: beta, tenantId: f.tenantId, name: "Beta" },
    ],
  });
  await f.platform.project.createMany({
    data: [
      { id: acmeProject, tenantId: f.tenantId, clientId: acme, key: "ACME", name: "Acme site", billingCurrency: "SEK" },
      { id: betaProject, tenantId: f.tenantId, clientId: beta, key: "BETA", name: "Beta site", billingCurrency: "SEK" },
    ],
  });
  await f.platform.service.createMany({
    data: [
      { id: development, tenantId: f.tenantId, clientId: acme, name: "Development", kind: "ONE_TIME" },
      { id: maintenance, tenantId: f.tenantId, clientId: acme, name: "Maintenance", kind: "RECURRING", billingInterval: "MONTHLY" },
      { id: betaOps, tenantId: f.tenantId, clientId: beta, name: "Beta ops", kind: "RECURRING", billingInterval: "MONTHLY" },
    ],
  });
  await f.platform.contact.create({
    data: {
      id: contact.id,
      tenantId: f.tenantId,
      clientId: acme,
      name: "Client Carol",
      email: `carol-${randomUUID().slice(0, 8)}@test.invalid`,
      portalStatus: "ACTIVE",
    },
  });
  const item = await createItem(ownerCtx(), { projectId: acmeProject, title: "Build the thing" });
  taskId = item.id;
}, 60_000);

afterAll(async () => {
  const db = f.platform;
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.time_maintenance', 'on', true)`;
    await tx.$executeRaw`SELECT set_config('app.time_lock_bypass', 'on', true)`;
    await tx.timeEntry.deleteMany({ where: { tenantId: f.tenantId } });
    await tx.shiftBreak.deleteMany({ where: { tenantId: f.tenantId } });
    await tx.shift.deleteMany({ where: { tenantId: f.tenantId } });
    await tx.rateCard.deleteMany({ where: { tenantId: f.tenantId } });
    await tx.projectTimeSummary.deleteMany({ where: { tenantId: f.tenantId } });
    await tx.staffNoticeAcknowledgment.deleteMany({ where: { tenantId: f.tenantId } });
    await tx.staffNotice.deleteMany({ where: { tenantId: f.tenantId } });
    await tx.workType.deleteMany({ where: { tenantId: f.tenantId } });
  });
  await db.notification.deleteMany({ where: { tenantId: f.tenantId } });
  await db.workItemActivity.deleteMany({ where: { tenantId: f.tenantId } });
  await db.workItem.deleteMany({ where: { tenantId: f.tenantId } });
  await db.workflowState.deleteMany({ where: { tenantId: f.tenantId } });
  await db.contact.deleteMany({ where: { tenantId: f.tenantId } });
  await db.service.deleteMany({ where: { tenantId: f.tenantId } });
  await db.project.deleteMany({ where: { tenantId: f.tenantId } });
  await db.client.deleteMany({ where: { tenantId: f.tenantId } });
  await db.tenantCounter.deleteMany({ where: { tenantId: f.tenantId } });
  await db.tenantPreference.deleteMany({ where: { tenantId: f.tenantId } });
  // The COST card minted this tenant's DEK (crypto v2) - the shared fixture does not know about it.
  await db.tenantKey.deleteMany({ where: { tenantId: f.tenantId } });
  resetTimeDefaultsMemo();
  await f.cleanup();
}, 60_000);

describe("staff notice gate + lazy defaults", () => {
  it("refuses the first timer until the seeded notice is acknowledged; seeds are localized", async () => {
    expect(await domainCode(startTimer(ownerCtx(), { workItemId: taskId }))).toBe("NOTICE_UNACKNOWLEDGED");
    const status = await getNoticeStatus(ownerCtx());
    expect(status.required).toBe(true);
    expect(status.acknowledged).toBe(false);
    expect(status.notice?.version).toBe(1);
    expect(status.notice?.locale).toBe("sv"); // tenant default locale
    expect(status.notice?.purposes).toEqual(["billing", "planning", "profitability", "working_time"]);
    const en = await getNoticeStatus(ownerCtx(), "en");
    expect(en.notice?.locale).toBe("en");

    const types = await listWorkTypes(ownerCtx());
    expect(types.map((t) => t.name)).toEqual([
      "Kundutveckling",
      "Intern produktutveckling",
      "Konsultation",
      "Möte",
      "Lärande",
      "Marknadsföring",
    ]);
    expect(types.find((t) => t.name === "Lärande")?.defaultBillable).toBe(false);

    const published = await f.audits("staff_notice.published");
    expect(published).toHaveLength(1);
    expect(published[0]?.actorType).toBe("SYSTEM");
  });

  it("acknowledgment is per version, idempotent and audited", async () => {
    const status = await getNoticeStatus(ownerCtx());
    await acknowledgeNotice(ownerCtx(), status.notice!.id);
    await acknowledgeNotice(ownerCtx(), status.notice!.id); // no-op
    expect((await getNoticeStatus(ownerCtx())).acknowledged).toBe(true);
    expect(await f.audits("staff_notice.acknowledged")).toHaveLength(1);
    // The other seats acknowledge too (they time things below).
    for (const ctx of [managerCtx(), employeeCtx()]) {
      const s = await getNoticeStatus(ctx);
      await acknowledgeNotice(ctx, s.notice!.id);
    }
  });
});

describe("timer", () => {
  it("starts on a task (project + client derived), starting another auto-stops it and returns both", async () => {
    const a = await startTimer(ownerCtx(), { workItemId: taskId });
    expect(a.stopped).toBeNull();
    expect(a.started.projectId).toBe(acmeProject);
    expect(a.started.clientId).toBe(acme);
    expect(a.started.billable).toBe(true);
    expect(a.started.stoppedAt).toBeNull();
    expect(a.started.startedAt.getMilliseconds()).toBe(0);

    const b = await startTimer(ownerCtx(), { description: "Standup" }); // ad-hoc
    expect(b.stopped?.id).toBe(a.started.id);
    expect(b.stopped?.stoppedAt).not.toBeNull();
    expect(b.stopped?.durationSeconds).toBeGreaterThanOrEqual(0);
    expect(b.started.projectId).toBeNull();
    expect(b.started.clientId).toBeNull();
    expect(b.started.billable).toBe(false);

    const running = await f.platform.timeEntry.count({
      where: { tenantId: f.tenantId, memberId: f.seats.owner.memberId, stoppedAt: null, deletedAt: null },
    });
    expect(running).toBe(1);
    const current = await getCurrentTimer(ownerCtx());
    expect(current.running?.id).toBe(b.started.id);
    expect(current.noticeRequired).toBe(false);
    expect(current.nudge).toBe(false);
  });

  it("8 concurrent starts leave exactly one running row (advisory lock + partial unique)", async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => startTimer(ownerCtx(), { description: `Burst ${i}` })),
    );
    const running = await f.platform.timeEntry.count({
      where: { tenantId: f.tenantId, memberId: f.seats.owner.memberId, stoppedAt: null, deletedAt: null },
    });
    expect(running).toBe(1);
  });

  it("stop with confirm-dialog edits; a second stop is TIMER_NOT_RUNNING; undo resumes the auto-stopped one", async () => {
    const stopped = await stopTimer(ownerCtx(), { description: "Burst, edited" });
    expect(stopped.stoppedAt).not.toBeNull();
    expect(stopped.description).toBe("Burst, edited");
    expect(await domainCode(stopTimer(ownerCtx()))).toBe("TIMER_NOT_RUNNING");

    const a = await startTimer(ownerCtx(), { workItemId: taskId });
    const b = await startTimer(ownerCtx(), { description: "Oops" });
    await undoStart(ownerCtx(), { startedId: b.started.id, resumeId: a.started.id });
    const rows = await f.platform.timeEntry.findMany({
      where: { tenantId: f.tenantId, id: { in: [a.started.id, b.started.id] } },
      select: { id: true, stoppedAt: true },
    });
    expect(rows.map((r) => r.id)).toEqual([a.started.id]);
    expect(rows[0]?.stoppedAt).toBeNull();
    await stopTimer(ownerCtx());
  });

  it("the duration CHECK refuses an inconsistent row even from the platform role", async () => {
    const entry = await f.platform.timeEntry.findFirst({
      where: { tenantId: f.tenantId, memberId: f.seats.owner.memberId, stoppedAt: { not: null } },
      select: { id: true },
    });
    await expect(
      f.platform.timeEntry.update({ where: { id: entry!.id }, data: { durationSeconds: 999_999 } }),
    ).rejects.toThrow(/time_entry_duration_exact/);
  });
});

describe("rates — tiers, SERVICE, snapshot stability, EXCLUDE, immutability, COST ✦", () => {
  let projectCard: string;

  it("resolves SERVICE > PROJECT > TENANT at write and snapshots the amount on the entry", async () => {
    await createRateCard(ownerCtx(), { kind: "BILL", scope: "TENANT", amount: "800", currency: "SEK", effectiveFrom: "2026-01-01" });
    projectCard = (
      await createRateCard(ownerCtx(), {
        kind: "BILL",
        scope: "PROJECT",
        projectId: acmeProject,
        amount: "1200",
        currency: "SEK",
        effectiveFrom: "2026-01-01",
      })
    ).id;
    await createRateCard(ownerCtx(), {
      kind: "BILL",
      scope: "SERVICE",
      serviceId: maintenance,
      amount: "950",
      currency: "SEK",
      effectiveFrom: "2026-01-01",
    });

    const onProject = await createEntry(ownerCtx(), {
      projectId: acmeProject,
      description: "Design review",
      startedAt: new Date("2026-08-03T08:00:00Z"),
      stoppedAt: new Date("2026-08-03T10:00:00Z"),
    });
    const rows = await f.platform.timeEntry.findMany({
      where: { id: onProject.id },
      select: { billRate: true, rateSource: true, billRateCardId: true, currency: true },
    });
    expect(Number(rows[0]?.billRate)).toBe(1200);
    expect(rows[0]?.rateSource).toBe("PROJECT");
    expect(rows[0]?.billRateCardId).toBe(projectCard);
    expect(rows[0]?.currency).toBe("SEK");

    const onAgreement = await createEntry(ownerCtx(), {
      projectId: acmeProject,
      serviceId: maintenance,
      description: "Patch",
      startedAt: new Date("2026-08-03T11:00:00Z"),
      stoppedAt: new Date("2026-08-03T12:00:00Z"),
    });
    const ag = await f.platform.timeEntry.findFirst({ where: { id: onAgreement.id }, select: { billRate: true, rateSource: true } });
    expect(Number(ag?.billRate)).toBe(950);
    expect(ag?.rateSource).toBe("SERVICE");

    // Beta's agreement on an Acme project is refused before the trigger even sees it.
    expect(
      await domainCode(
        createEntry(ownerCtx(), {
          projectId: acmeProject,
          serviceId: betaOps,
          description: "Wrong client",
          startedAt: new Date("2026-08-03T13:00:00Z"),
          stoppedAt: new Date("2026-08-03T14:00:00Z"),
        }),
      ),
    ).toBe("SERVICE_CLIENT_MISMATCH");

    // Project.defaultServiceId seeds the agreement when the member picks none.
    await f.platform.project.update({ where: { id: acmeProject }, data: { defaultServiceId: maintenance } });
    const seeded = await createEntry(ownerCtx(), {
      projectId: acmeProject,
      description: "Default agreement",
      startedAt: new Date("2026-08-04T08:00:00Z"),
      stoppedAt: new Date("2026-08-04T09:00:00Z"),
    });
    expect(seeded.serviceId).toBe(maintenance);
    await f.platform.project.update({ where: { id: acmeProject }, data: { defaultServiceId: null } });

    // Non-billable ⇒ no bill rate, but the entry still exists for the hours.
    const nb = await createEntry(ownerCtx(), {
      projectId: acmeProject,
      description: "Internal sync",
      billable: false,
      startedAt: new Date("2026-08-04T10:00:00Z"),
      stoppedAt: new Date("2026-08-04T11:00:00Z"),
    });
    const nbRow = await f.platform.timeEntry.findFirst({ where: { id: nb.id }, select: { billRate: true, rateSource: true } });
    expect(nbRow?.billRate).toBeNull();
    expect(nbRow?.rateSource).toBe("NONE");
  });

  it("a second open card on the same dimension is RATE_OVERLAP; closeOpen replaces it and old snapshots stay", async () => {
    expect(
      await domainCode(
        createRateCard(ownerCtx(), {
          kind: "BILL",
          scope: "PROJECT",
          projectId: acmeProject,
          amount: "1300",
          currency: "SEK",
          effectiveFrom: "2026-06-01",
        }),
      ),
    ).toBe("RATE_OVERLAP");
    const replaced = await createRateCard(ownerCtx(), {
      kind: "BILL",
      scope: "PROJECT",
      projectId: acmeProject,
      amount: "1300",
      currency: "SEK",
      effectiveFrom: "2026-08-15",
      closeOpen: true,
    });
    const cards = await listBillRateCards(ownerCtx(), { projectId: acmeProject });
    expect(cards.find((c) => c.id === projectCard)?.effectiveTo).toBe("2026-08-15");
    expect(cards.find((c) => c.id === replaced.id)?.effectiveTo).toBeNull();

    // Earlier entries keep the 1200 snapshot; an entry after the switch gets 1300.
    const old = await f.platform.timeEntry.findFirst({
      where: { tenantId: f.tenantId, billRateCardId: projectCard },
      select: { billRate: true },
    });
    expect(Number(old?.billRate)).toBe(1200);
    const sept = await createEntry(ownerCtx(), {
      projectId: acmeProject,
      description: "After the rate change",
      startedAt: new Date("2026-08-16T08:00:00Z"),
      stoppedAt: new Date("2026-08-16T09:00:00Z"),
    });
    const septRow = await f.platform.timeEntry.findFirst({ where: { id: sept.id }, select: { billRate: true, billRateCardId: true } });
    expect(Number(septRow?.billRate)).toBe(1300);
    expect(septRow?.billRateCardId).toBe(replaced.id);
    await deleteEntry(ownerCtx(), sept.id);
  });

  it("rate cards are immutable at the database (only effective_to, NULL → date)", async () => {
    await expect(
      f.platform.rateCard.update({ where: { id: projectCard }, data: { amount: "1" } }),
    ).rejects.toThrow(/RATE_CARD_IMMUTABLE/);
    await expect(
      f.platform.rateCard.update({ where: { id: projectCard }, data: { effectiveTo: new Date("2026-10-01T00:00:00Z") } }),
    ).rejects.toThrow(/RATE_CARD_IMMUTABLE/);
  });

  it("COST cards: salary-grade — encrypted v2, omitted from reads, revealed only with ✦ + fresh factor, audited", async () => {
    const card = await createRateCard(ownerCtx(), {
      kind: "COST",
      scope: "MEMBER",
      memberId: f.seats.owner.memberId,
      amount: "600",
      currency: "SEK",
      effectiveFrom: "2026-01-01",
    });
    expect(card.amount).toBeNull();
    const raw = await f.platform.rateCard.findFirst({
      where: { id: card.id },
      omit: { amountCiphertext: false },
    });
    expect(raw?.amount).toBeNull();
    expect(raw?.amountCiphertext?.startsWith("v2.")).toBe(true);
    // The global omit hides the ciphertext from an ordinary read.
    const plain = await f.platform.rateCard.findFirst({ where: { id: card.id } });
    expect(plain && "amountCiphertext" in plain).toBe(false);

    expect((await listCostRateCards(ownerCtx())).map((c) => c.amount)).toEqual([null]);
    expect(await revealCostRates(ownerCtx(), [card.id])).toEqual({ [card.id]: "600" });
    expect(await authzReason(revealCostRates(employeeCtx(), [card.id]))).toBe("FORBIDDEN");
    const stale = { tenantId: f.tenantId, actor: { memberId: f.seats.owner.memberId, mfa: { enrolled: true, verifiedAt: hoursAgo(2) } } };
    expect(await authzReason(revealCostRates(stale, [card.id]))).toBe("MFA_REQUIRED");
    const revealed = await f.audits("rate_card.cost_revealed");
    expect(revealed).toHaveLength(1);
    expect(JSON.stringify(revealed[0]?.metadata)).not.toContain("600");
    const created = await f.audits("rate_card.created");
    expect(created.some((a) => JSON.stringify(a.metadata).includes("600"))).toBe(false);

    // A new entry for the owner carries the COST card id, never the amount.
    const e = await createEntry(ownerCtx(), {
      projectId: acmeProject,
      description: "With cost",
      startedAt: new Date("2026-08-05T08:00:00Z"),
      stoppedAt: new Date("2026-08-05T09:00:00Z"),
    });
    const row = await f.platform.timeEntry.findFirst({ where: { id: e.id }, select: { costRateCardId: true } });
    expect(row?.costRateCardId).toBe(card.id);
    // COST per agreement is refused by the app and the CHECK alike.
    expect(
      await domainCode(
        createRateCard(ownerCtx(), { kind: "COST", scope: "SERVICE", serviceId: maintenance, amount: "1", currency: "SEK", effectiveFrom: "2026-01-01" }),
      ),
    ).toBe("INVALID_INPUT");
  });
});

describe("scoping + zero portal rows", () => {
  it("an unassigned employee cannot time a project (NOT_FOUND) but can time an ad-hoc task", async () => {
    expect(await authzReason(startTimer(employeeCtx(), { workItemId: taskId }))).toBe("NOT_FOUND");
    expect(await authzReason(startTimer(employeeCtx(), { projectId: acmeProject, description: "x" }))).toBe("NOT_FOUND");
    const adhoc = await startTimer(employeeCtx(), { description: "Inbox zero" });
    expect(adhoc.started.projectId).toBeNull();
    await stopTimer(employeeCtx());
  });

  it("team lists need time:view_team and respect scope; ad-hoc rows are visible to any holder", async () => {
    expect(await authzReason(listTeamEntries(employeeCtx(), { from: "2026-01-01", to: "2026-12-31" }))).toBe("FORBIDDEN");
    // The manager template carries client:view_all (AUTHZ.md CMA): every project row is in
    // scope, ad-hoc rows too, and bill rates show (manager holds rate:view_bill).
    const rows = await listTeamEntries(managerCtx(), { from: "2026-01-01", to: "2026-12-31" });
    expect(rows.some((r) => r.projectId === null)).toBe(true);
    expect(rows.some((r) => r.projectId === acmeProject)).toBe(true);
    expect(rows.some((r) => r.billRate !== null)).toBe(true);
    const scoped = await listTeamEntries(managerCtx(), { from: "2026-01-01", to: "2026-12-31", projectId: acmeProject });
    expect(scoped.every((r) => r.projectId === acmeProject)).toBe(true);
    // The employee's own list carries no rates (no rate:view_bill).
    const mine = await listMyEntries(employeeCtx(), { from: "2026-01-01", to: "2026-12-31" });
    expect(mine.every((r) => r.billRate === null)).toBe(true);
  });

  it("a contact principal reads ZERO rows of every class-A time table", async () => {
    await withTenant(f.tenantId, { type: "contact", id: contact.id, clientId: acme }, async (tx) => {
      expect(await tx.timeEntry.count()).toBe(0);
      expect(await tx.shift.count()).toBe(0);
      expect(await tx.shiftBreak.count()).toBe(0);
      expect(await tx.rateCard.count()).toBe(0);
      expect(await tx.workType.count()).toBe(0);
      expect(await tx.staffNotice.count()).toBe(0);
      expect(await tx.projectBudget.count()).toBe(0);
    });
  });
});

describe("entries — duration, midnight, edit, lock trigger, summary == SUM, derived visibility", () => {
  it("a DURATION entry anchors at the local day start; a midnight-spanning entry keeps its start date", async () => {
    const d = await createEntry(ownerCtx(), { projectId: acmeProject, description: "Docs", durationText: "1h 30m", localDate: "2026-08-19" });
    expect(d.durationSeconds).toBe(5400);
    expect(d.startedAt.toISOString()).toBe("2026-08-18T22:00:00.000Z"); // Europe/Stockholm 00:00 CEST
    expect(d.localDate.toISOString().slice(0, 10)).toBe("2026-08-19");
    expect(d.timezone).toBe("Europe/Stockholm");

    const m = await createEntry(ownerCtx(), {
      projectId: acmeProject,
      description: "Late night",
      startedAt: new Date("2026-08-10T21:30:00Z"), // 23:30 local
      stoppedAt: new Date("2026-08-10T22:30:00Z"), // 00:30 local next day
    });
    expect(m.localDate.toISOString().slice(0, 10)).toBe("2026-08-10");
    expect(await domainCode(createEntry(ownerCtx(), { projectId: acmeProject, description: "bad", durationText: "25h" }))).toBe("INVALID_DURATION");
    expect(await domainCode(createEntry(ownerCtx(), { description: "   ", durationText: "1h" }))).toBe("DESCRIPTION_REQUIRED");
  });

  it("own edits are audited; others' need time:edit_any; locked entries refuse edits at the database unless the bypass GUC is on", async () => {
    const e = await createEntry(ownerCtx(), { projectId: acmeProject, description: "Editable", durationText: "1h", localDate: "2026-08-19" });
    const edited = await updateEntry(ownerCtx(), e.id, { durationText: "2h" });
    expect(edited.durationSeconds).toBe(7200);
    expect((await f.audits("time_entry.updated")).length).toBeGreaterThan(0);
    expect(await authzReason(updateEntry(employeeCtx(), e.id, { durationText: "3h" }))).toBe("FORBIDDEN");

    await f.platform.timeEntry.update({ where: { id: e.id }, data: { lockedReason: "INVOICED", lockedAt: new Date() } });
    expect(await domainCode(updateEntry(ownerCtx(), e.id, { durationText: "3h" }))).toBe("ENTRY_LOCKED");
    expect(await domainCode(deleteEntry(ownerCtx(), e.id))).toBe("ENTRY_LOCKED");
    await expect(
      f.platform.timeEntry.update({ where: { id: e.id }, data: { description: "tamper" } }),
    ).rejects.toThrow(/ENTRY_LOCKED/);
    await f.platform.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.time_lock_bypass', 'on', true)`;
      await tx.timeEntry.update({ where: { id: e.id }, data: { lockedReason: null, lockedAt: null } });
    });
    await deleteEntry(ownerCtx(), e.id);
    expect((await listMyEntries(ownerCtx(), { from: "2026-08-19", to: "2026-08-19" })).map((r) => r.id)).not.toContain(e.id);
  });

  it("project_time_summary == SUM(time_entry) per (project, month); visibility derives from hoursSharingMode and is readable by the contact only then", async () => {
    const month = new Date("2026-08-01T00:00:00Z");
    const sums = await f.platform.timeEntry.groupBy({
      by: ["billable"],
      where: {
        tenantId: f.tenantId,
        projectId: acmeProject,
        deletedAt: null,
        stoppedAt: { not: null },
        localDate: { gte: month, lt: new Date("2026-09-01T00:00:00Z") },
      },
      _sum: { durationSeconds: true },
    });
    const billable = sums.find((s) => s.billable)?._sum.durationSeconds ?? 0;
    const nonBillable = sums.find((s) => !s.billable)?._sum.durationSeconds ?? 0;
    const summary = await f.platform.projectTimeSummary.findFirst({
      where: { tenantId: f.tenantId, projectId: acmeProject, periodMonth: month },
    });
    expect(summary?.billableSeconds).toBe(billable);
    expect(summary?.nonBillableSeconds).toBe(nonBillable);
    expect(summary?.visibility).toBe("INTERNAL"); // hoursSharingMode NONE
    expect(summary?.billableAmount).toBeNull();

    await f.platform.project.update({ where: { id: acmeProject }, data: { portalEnabled: true, hoursSharingMode: "HOURS" } });
    const after = await f.platform.projectTimeSummary.findFirst({ where: { id: summary!.id } });
    expect(after?.visibility).toBe("CLIENT_VISIBLE");
    expect(after?.portalEnabled).toBe(true);
    await withTenant(f.tenantId, { type: "contact", id: contact.id, clientId: acme }, async (tx) => {
      const rows = await tx.projectTimeSummary.findMany();
      expect(rows.map((r) => r.id)).toEqual([summary!.id]);
      expect(Object.keys(rows[0]!)).not.toContain("memberId");
      expect(await tx.timeEntry.count()).toBe(0);
    });
    await f.platform.project.update({ where: { id: acmeProject }, data: { hoursSharingMode: "NONE" } });
    await withTenant(f.tenantId, { type: "contact", id: contact.id, clientId: acme }, async (tx) => {
      expect(await tx.projectTimeSummary.count()).toBe(0);
    });
  });
});

describe("shifts + breaks", () => {
  it("clock in once; concurrent clock-ins leave one open shift; a break stops the timer; a timer closes the break", async () => {
    const shift = await clockIn(ownerCtx());
    expect(shift.stoppedAt).toBeNull();
    expect(await domainCode(clockIn(ownerCtx()))).toBe("SHIFT_ALREADY_OPEN");
    await Promise.all(Array.from({ length: 5 }, () => clockIn(employeeCtx()).catch(() => null)));
    expect(
      await f.platform.shift.count({ where: { tenantId: f.tenantId, memberId: f.seats.employee.memberId, stoppedAt: null } }),
    ).toBe(1);

    await startTimer(ownerCtx(), { workItemId: taskId });
    const onBreak = await startBreak(ownerCtx());
    expect(onBreak.stoppedTimer).not.toBeNull();
    expect(onBreak.shift.breaks).toHaveLength(1);
    expect(await domainCode(startBreak(ownerCtx()))).toBe("BREAK_ALREADY_OPEN");
    expect((await getCurrentTimer(ownerCtx())).running).toBeNull();

    await startTimer(ownerCtx(), { description: "Back to work" });
    const current = await getCurrentShift(ownerCtx());
    expect(current.onBreak).toBe(false);
    expect(current.shift?.breaks[0]?.stoppedAt).not.toBeNull();
    expect(await domainCode(stopBreak(ownerCtx()))).toBe("BREAK_NOT_OPEN");
  });

  it("clock out closes breaks, stops the timer, and workedSeconds = span − Σ breaks; bounds + shrink guards hold", async () => {
    const { shift, stoppedTimer } = await clockOut(ownerCtx());
    expect(stoppedTimer).not.toBeNull();
    expect(shift.stoppedAt).not.toBeNull();
    const span = Math.floor((shift.stoppedAt!.getTime() - shift.startedAt.getTime()) / 1000);
    const breaks = shift.breaks.reduce((s, b) => s + (b.durationSeconds ?? 0), 0);
    expect(shift.workedSeconds).toBe(span - breaks);
    expect(await domainCode(clockOut(ownerCtx()))).toBe("SHIFT_NOT_OPEN");

    await expect(
      f.platform.shiftBreak.create({
        data: {
          tenantId: f.tenantId,
          shiftId: shift.id,
          memberId: f.seats.owner.memberId,
          startedAt: new Date(shift.startedAt.getTime() - 60_000),
          stoppedAt: shift.startedAt,
          durationSeconds: 60,
        },
      }),
    ).rejects.toThrow(/BREAK_OUT_OF_BOUNDS/);
    await expect(
      f.platform.shift.update({
        where: { id: shift.id },
        data: { startedAt: new Date(shift.breaks[0]!.startedAt.getTime() + 1000) },
      }),
    ).rejects.toThrow(/SHIFT_SHRINK/);

    // Team totals: closed rows only — the employee's OPEN shift never appears.
    const totals = await listTeamShiftTotals(managerCtx(), { from: "2020-01-01", to: "2030-12-31" });
    expect(totals.some((t) => t.memberId === f.seats.owner.memberId)).toBe(true);
    expect(totals.some((t) => t.memberId === f.seats.employee.memberId)).toBe(false);
    await clockOut(employeeCtx());
  });
});

describe("lazy settle (deterministic, idempotent, audits SYSTEM)", () => {
  it("auto-stops a 13 h timer at exactly started + 12 h and flags it; a second pass does nothing", async () => {
    const { started } = await startTimer(ownerCtx(), { workItemId: taskId });
    const startedAt = hoursAgo(13);
    startedAt.setMilliseconds(0);
    await f.platform.timeEntry.update({ where: { id: started.id }, data: { startedAt, localDate: new Date(startedAt.toISOString().slice(0, 10)) } });
    const first = await settleMember(f.tenantId, f.seats.owner.memberId);
    expect(first.autoStoppedEntries).toBe(1);
    const row = await f.platform.timeEntry.findFirst({ where: { id: started.id } });
    expect(row?.stoppedAt?.getTime()).toBe(startedAt.getTime() + 12 * 3600_000);
    expect(row?.durationSeconds).toBe(12 * 3600);
    expect(row?.needsReview).toBe(true);
    expect(row?.reviewReason).toBe("AUTO_STOPPED");
    expect((await settleMember(f.tenantId, f.seats.owner.memberId)).autoStoppedEntries).toBe(0);
    const audits = await f.audits("timer.auto_stopped");
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actorType).toBe("SYSTEM");
  });

  it("auto-stops a 15 h shift at started + 14 h, dropping a break that began after the bound", async () => {
    const shift = await clockIn(ownerCtx());
    const startedAt = hoursAgo(15);
    startedAt.setMilliseconds(0);
    await f.platform.shift.update({ where: { id: shift.id }, data: { startedAt, localDate: new Date(startedAt.toISOString().slice(0, 10)) } });
    await f.platform.shiftBreak.create({
      data: { tenantId: f.tenantId, shiftId: shift.id, memberId: f.seats.owner.memberId, startedAt: new Date() },
    }); // began "now" — after the 14 h bound (inserted directly: the service would settle first)
    const r = await settleMember(f.tenantId, f.seats.owner.memberId);
    expect(r.autoStoppedShifts).toBe(1);
    const closed = await f.platform.shift.findFirst({ where: { id: shift.id }, include: { breaks: true } });
    expect(closed?.stoppedAt?.getTime()).toBe(startedAt.getTime() + 14 * 3600_000);
    expect(closed?.breaks).toHaveLength(0);
    expect(closed?.workedSeconds).toBe(14 * 3600);
    expect(closed?.reviewReason).toBe("AUTO_STOPPED");
    expect((await f.audits("shift.auto_stopped"))[0]?.actorType).toBe("SYSTEM");
  });
});

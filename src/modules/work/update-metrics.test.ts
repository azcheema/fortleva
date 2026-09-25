import { describe, expect, it } from "vitest";

import {
  PORTAL_SNAPSHOT_KEYS,
  foreignPortalSnapshotKeys,
  metricsWindowFor,
  type PortalSnapshot,
} from "./update-snapshot";

/**
 * THE FORBIDDEN-KEYS WALK OVER `portalSnapshot` (SECURITY.md §T9 —
 * "forbidden-columns grep covers portalSnapshot"). Two halves:
 *
 *  · the allow-list itself is pinned, and every name on the portal
 *    projection's never-list is asserted ABSENT from it — so a key like
 *    `cost` or `assigneeMemberId` cannot be added to the shape without
 *    this test naming it;
 *  · a snapshot shaped the way `computePortalSnapshot` writes one walks
 *    clean, and one carrying a member key or a margin does not.
 *
 * The database half — a REAL snapshot, serialised and searched for the
 * fixture's sentinel strings — is `updates.dbtest.ts`.
 */
describe("the portal snapshot's allow-list", () => {
  it("is pinned", () => {
    expect([...PORTAL_SNAPSHOT_KEYS]).toEqual([
      "version",
      "computedAt",
      "window",
      "from",
      "to",
      "tasks",
      "done",
      "total",
      "doneInPeriod",
      "milestones",
      "hitInPeriod",
      "versions",
      "shippedInPeriod",
      "title",
      "requests",
      "open",
      "acceptedInPeriod",
      "hours",
      "mode",
      "inPeriod",
      "toDate",
      "seconds",
      "billableSeconds",
      "amount",
      "budgetSeconds",
      "budgetAmount",
      "currency",
    ]);
  });

  it("shares no name with the projection's forbidden columns", () => {
    // The names `portal-projections.test.ts` pins (not imported: importing
    // a test module would register its suites here a second time), plus
    // the keys the internal twin is made of.
    const allowed = new Set<string>(PORTAL_SNAPSHOT_KEYS);
    for (const col of [
      "internalNotes",
      "repoUrl",
      "hostingNotes",
      "leadMemberId",
      "billRate",
      "cost",
      "assigneeMemberId",
      "assigneeContactName",
      "stateId",
      "stateName",
      "priority",
      "estimateMinutes",
      "remainingMinutes",
      "labelId",
      "labels",
      "actorMemberId",
      "authorMemberId",
      "createdByMemberId",
      "invitedById",
      "changesSinceLast",
      "publishedByMemberId",
      "internalSnapshot",
      "byMember",
      "memberId",
      "member",
      "margin",
      "costRateCardId",
      "name",
      "email",
    ]) {
      expect(allowed.has(col), col).toBe(false);
    }
  });

  it("walks a snapshot of the written shape clean, and names any other key", () => {
    const snapshot: PortalSnapshot = {
      version: 1,
      computedAt: "2026-09-25T10:00:00.000Z",
      window: { from: "2026-09-11T00:00:00.000Z", to: "2026-09-25T00:00:00.000Z" },
      tasks: { done: 3, total: 8, doneInPeriod: 2 },
      milestones: { done: 1, total: 2, hitInPeriod: ["Design review"] },
      versions: { shippedInPeriod: [{ version: "1.2.0", title: null }] },
      requests: { open: 1, acceptedInPeriod: 0 },
      hours: {
        mode: "BILLABLE_AMOUNT",
        inPeriod: { seconds: 7200, billableSeconds: 3600, amount: "950.00" },
        toDate: { seconds: 36_000, billableSeconds: 30_000, amount: "7916.67" },
        budgetSeconds: 144_000,
        budgetAmount: "40000.00",
        currency: "SEK",
      },
    };
    expect(foreignPortalSnapshotKeys(snapshot)).toEqual([]);
    expect(
      foreignPortalSnapshotKeys({ ...snapshot, byMember: [{ memberId: "m1", seconds: 1 }], cost: { margin: "1" } }).sort(),
    ).toEqual(["byMember", "cost", "margin", "memberId"]);
  });
});

describe("metricsWindowFor", () => {
  const zone = "Europe/Stockholm";
  const now = new Date("2026-09-25T12:00:00.000Z");
  const created = new Date("2026-08-01T08:00:00.000Z");

  it("uses the author's dates as whole local days, the end day inclusive", () => {
    const w = metricsWindowFor(
      { periodStart: "2026-09-11", periodEnd: "2026-09-24", previous: null, projectCreatedAt: created },
      zone,
      now,
    );
    // CEST: local midnight is 22:00 UTC the evening before.
    expect(w.from.toISOString()).toBe("2026-09-10T22:00:00.000Z");
    expect(w.to.toISOString()).toBe("2026-09-24T22:00:00.000Z");
  });

  it("without dates, runs from the previous post — the day after its period, else its publishing — to now", () => {
    const afterPeriod = metricsWindowFor(
      {
        periodStart: null,
        periodEnd: null,
        previous: { periodEnd: "2026-09-10", publishedAt: new Date("2026-09-11T09:00:00.000Z") },
        projectCreatedAt: created,
      },
      zone,
      now,
    );
    expect(afterPeriod.from.toISOString()).toBe("2026-09-10T22:00:00.000Z");
    expect(afterPeriod.to).toBe(now);
    const afterPublish = metricsWindowFor(
      {
        periodStart: null,
        periodEnd: null,
        previous: { periodEnd: null, publishedAt: new Date("2026-09-11T09:00:00.000Z") },
        projectCreatedAt: created,
      },
      zone,
      now,
    );
    expect(afterPublish.from.toISOString()).toBe("2026-09-11T09:00:00.000Z");
  });

  it("the first post of a project counts from the project's creation, and a window never runs backwards", () => {
    const first = metricsWindowFor({ periodStart: null, periodEnd: null, previous: null, projectCreatedAt: created }, zone, now);
    expect(first.from).toBe(created);
    const backwards = metricsWindowFor(
      { periodStart: "2026-09-20", periodEnd: null, previous: null, projectCreatedAt: created },
      zone,
      new Date("2026-09-01T00:00:00.000Z"),
    );
    expect(backwards.to.getTime()).toBe(backwards.from.getTime());
  });
});

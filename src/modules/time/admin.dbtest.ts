import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthzError } from "@/authz/errors";
import { DomainError } from "@/lib/domain-error";
import { setupTenant } from "@/members/dbtest-fixture";

import {
  acknowledgeNotice,
  createWorkType,
  getCurrentNoticeTexts,
  getNoticeStatus,
  listNoticeAcknowledgments,
  listWorkTypes,
  publishNotice,
  resetTimeDefaultsMemo,
  setWorkTypeArchived,
  updateWorkType,
} from "./index";

/**
 * The /settings/time services against the real database and the real
 * app_runtime role (SECURITY.md §9.7.5; DATA_MODEL.md §6.15 D5): the
 * current notice is readable in every locale by settings:view and by
 * nobody below it; publishing a version resets acknowledgment for
 * everyone and the gate follows; work types are created, renamed,
 * archived and restored by work_type:manage only, with names unique
 * among live rows and every mutation audited.
 */

let f: Awaited<ReturnType<typeof setupTenant>>;

const ownerCtx = () => ({ tenantId: f.tenantId, actor: f.seats.owner.actor });
const employeeCtx = () => ({ tenantId: f.tenantId, actor: f.seats.employee.actor });

const authzReason = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "resolved";
  } catch (e) {
    if (e instanceof AuthzError) return e.reason;
    throw e;
  }
};
const domainCode = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "resolved";
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    throw e;
  }
};

beforeAll(async () => {
  resetTimeDefaultsMemo();
  f = await setupTenant("tadmin");
}, 90_000);

afterAll(async () => {
  const db = f.platform;
  await db.staffNoticeAcknowledgment.deleteMany({ where: { tenantId: f.tenantId } });
  await db.staffNotice.deleteMany({ where: { tenantId: f.tenantId } });
  await db.workType.deleteMany({ where: { tenantId: f.tenantId } });
  await f.cleanup();
});

describe("staff notice — current texts, publish, acknowledgment status", () => {
  it("settings:view reads the current version in every locale; the employee cannot", async () => {
    const texts = await getCurrentNoticeTexts(ownerCtx());
    expect(texts.version).toBe(1);
    expect(texts.texts.map((x) => x.locale)).toEqual(["en", "sv"]);
    expect(texts.purposes).toEqual(["billing", "planning", "profitability", "working_time"]);
    expect(texts.publishedAt).not.toBeNull();
    expect(await authzReason(getCurrentNoticeTexts(employeeCtx()))).toBe("FORBIDDEN");
    expect(await authzReason(listNoticeAcknowledgments(employeeCtx()))).toBe("FORBIDDEN");
  });

  it("publishing version 2 resets everyone's standing; the status follows; the employee cannot publish", async () => {
    // Version 1 acknowledged by the owner first.
    const v1 = await getNoticeStatus(ownerCtx());
    await acknowledgeNotice(ownerCtx(), v1.notice!.id);
    let acks = await listNoticeAcknowledgments(ownerCtx());
    expect(acks.version).toBe(1);
    expect(acks.members.find((m) => m.memberId === f.seats.owner.memberId)?.acknowledgedAt).not.toBeNull();

    expect(
      await authzReason(
        publishNotice(employeeCtx(), { texts: [{ locale: "sv", title: "x", body: "y" }] }),
      ),
    ).toBe("FORBIDDEN");
    expect(await domainCode(publishNotice(ownerCtx(), { texts: [] }))).toBe("INVALID_INPUT");
    expect(await domainCode(publishNotice(ownerCtx(), { texts: [{ locale: "sv", title: " ", body: "y" }] }))).toBe(
      "INVALID_INPUT",
    );

    const { version } = await publishNotice(ownerCtx(), {
      texts: [
        { locale: "sv", title: "Version två", body: "## Vad\n\nNy text." },
        { locale: "en", title: "Version two", body: "## What\n\nNew text." },
      ],
    });
    expect(version).toBe(2);
    const texts = await getCurrentNoticeTexts(ownerCtx());
    expect(texts.version).toBe(2);
    expect(texts.texts.map((x) => [x.locale, x.title])).toEqual([
      ["en", "Version two"],
      ["sv", "Version två"],
    ]);
    // Purposes and tags carry over when the publisher does not restate them.
    expect(texts.purposes).toEqual(["billing", "planning", "profitability", "working_time"]);

    acks = await listNoticeAcknowledgments(ownerCtx());
    expect(acks.version).toBe(2);
    expect(acks.members.every((m) => m.acknowledgedAt === null)).toBe(true);
    expect((await getNoticeStatus(ownerCtx())).acknowledged).toBe(false);
    expect((await getNoticeStatus(ownerCtx())).notice?.version).toBe(2);

    const v2 = await getNoticeStatus(ownerCtx());
    await acknowledgeNotice(ownerCtx(), v2.notice!.id);
    acks = await listNoticeAcknowledgments(ownerCtx());
    expect(acks.members.filter((m) => m.acknowledgedAt !== null).map((m) => m.memberId)).toEqual([f.seats.owner.memberId]);
    expect((await getNoticeStatus(employeeCtx())).acknowledged).toBe(false);

    const published = await f.audits("staff_notice.published");
    expect(published.map((a) => (a.metadata as { version: number }).version).sort()).toEqual([1, 2]);
  });
});

describe("work types — manage, unique live names, archive/restore, audit", () => {
  it("creates, renames, flips default-billable, archives and restores; names unique among live rows", async () => {
    const before = await listWorkTypes(ownerCtx());
    expect(before.length).toBeGreaterThanOrEqual(6); // the localized seeds

    const row = await createWorkType(ownerCtx(), { name: "  Code review ", defaultBillable: false });
    expect(row.name).toBe("Code review");
    expect(row.defaultBillable).toBe(false);
    expect(row.sortOrder).toBe(before.length);
    // The live-name unique is a hand-written partial index: Prisma reports
    // it without a target; mapDbError must still translate it.
    expect(await domainCode(createWorkType(ownerCtx(), { name: "Code review" }))).toBe("WORK_TYPE_TAKEN");
    expect(await domainCode(createWorkType(ownerCtx(), { name: "   " }))).toBe("NAME_REQUIRED");

    const renamed = await updateWorkType(ownerCtx(), row.id, { name: "Peer review", defaultBillable: null });
    expect(renamed.name).toBe("Peer review");
    expect(renamed.defaultBillable).toBeNull();
    expect(await domainCode(updateWorkType(ownerCtx(), row.id, { name: before[0]!.name }))).toBe("WORK_TYPE_TAKEN");

    await setWorkTypeArchived(ownerCtx(), row.id, true);
    expect((await listWorkTypes(ownerCtx())).some((w) => w.id === row.id)).toBe(false);
    const withArchived = await listWorkTypes(ownerCtx(), { includeArchived: true });
    expect(withArchived.find((w) => w.id === row.id)?.archivedAt).not.toBeNull();
    // The name is free again while archived — and archiving twice is a no-op.
    const again = await createWorkType(ownerCtx(), { name: "Peer review" });
    await setWorkTypeArchived(ownerCtx(), row.id, true);
    await setWorkTypeArchived(ownerCtx(), again.id, true);
    await setWorkTypeArchived(ownerCtx(), row.id, false);
    expect((await listWorkTypes(ownerCtx())).find((w) => w.id === row.id)?.archivedAt).toBeNull();

    expect(await authzReason(createWorkType(employeeCtx(), { name: "Nope" }))).toBe("FORBIDDEN");
    expect(await authzReason(updateWorkType(employeeCtx(), row.id, { name: "Nope" }))).toBe("FORBIDDEN");
    expect(await authzReason(setWorkTypeArchived(employeeCtx(), row.id, true))).toBe("FORBIDDEN");
    // time:track suffices to read the picker list.
    expect((await listWorkTypes(employeeCtx())).some((w) => w.id === row.id)).toBe(true);

    expect((await f.audits("work_type.created")).length).toBe(2);
    expect((await f.audits("work_type.archived")).length).toBe(2);
    const updated = await f.audits("work_type.updated");
    expect(updated.length).toBe(2); // the rename+flip, then the restore
    expect(updated.some((a) => (a.metadata as { restored?: boolean }).restored === true)).toBe(true);
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withTenant, type TenantDb } from "@/db";
import { actorFor, setupTenant } from "@/members/dbtest-fixture";
import { listInbox } from "@/notify/inbox";
import { renderEmail } from "@/notify/templates";

import { readUpdateSchedule, sendUpdateReminders } from "./update-reminders";

/**
 * PROGRESS-UPDATE REMINDERS against the real database and app_runtime
 * (Phase 5 slice 102; founder decision C70): the trigger that is the only
 * writer of `project.update_schedule_since`; the schedule's state as the
 * project page reads it; and the job's per-tenant body — who hears (C70 (a),
 * (f): the lead if they can publish, else the project's people who can),
 * which post counts (C70 (g): with the portal on, only one the client can
 * see), the three reminders on their own days and hours, a new round on the
 * next due day (C70 (e)), exactly once, nothing for a paused project or one
 * whose update is in, nothing recorded while nobody can hear it, the sweep,
 * the inbox and the mail.
 *
 * It calls the per-tenant `sendUpdateReminders` ONLY — never the job's
 * cross-tenant `runUpdateReminders`, which would remind every tenant on the
 * shared dev database (AGENTS.md: never write outside a throwaway tenant).
 *
 * THE CLOCK IS PASSED IN, and the posts are PLANTED (inserted as published
 * rows with a chosen `published_at` — no guard refuses an insert, and the
 * cleanup deletes them under `app.work_maintenance`), because the stamp's
 * `since` is the database's real `now()`: every planted post lies in June
 * 2031, far after it. Each project's last post is Friday 6 June 2031, so its
 * update is due Friday 13 June. The tenant's zone is Europe/Stockholm (the
 * default; UTC+2 in June): runs at 10:00 UTC are 12:00 there.
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
let acme: string;
/** project key → id */
const P: Record<string, string> = {};
/** Members this file creates beyond the fixture's seats. */
const extras: { userId: string; memberId: string | null }[] = [];
let suspendedLead: string;
let strayManager: string;

/** A run at hh:mm UTC on a June 2031 day. */
const at = (day: number, hhmm = "10:00") => new Date(`2031-06-${String(day).padStart(2, "0")}T${hhmm}:00.000Z`);
const sys = <T,>(fn: (tx: TenantDb) => Promise<T>) => withTenant(f.tenantId, { type: "system" }, fn);

async function extraMember(roleId: string, label: string): Promise<string> {
  const userId = randomUUID();
  await f.platform.user.create({ data: { id: userId, name: label, email: `${label}-updrem-${userId.slice(0, 8)}@test.invalid` } });
  const entry: { userId: string; memberId: string | null } = { userId, memberId: null };
  extras.push(entry);
  const member = await f.platform.member.create({ data: { tenantId: f.tenantId, userId }, select: { id: true } });
  entry.memberId = member.id;
  await f.platform.memberRole.create({ data: { tenantId: f.tenantId, memberId: member.id, roleId } });
  return member.id;
}

let seq = 0;
/** A PUBLISHED post planted at `publishedAt`. */
async function plantPost(projectKey: string, publishedAt: Date, visibility: "INTERNAL" | "CLIENT_VISIBLE" = "INTERNAL") {
  seq += 1;
  await f.platform.projectUpdate.create({
    data: {
      tenantId: f.tenantId,
      clientId: acme,
      projectId: P[projectKey]!,
      seq,
      health: "ON_TRACK",
      body: { sections: [], metrics: {} },
      bodyText: "planted",
      portalSnapshot: {},
      status: "PUBLISHED",
      visibility,
      authorMemberId: f.seats.manager.memberId,
      publishedAt,
      publishedByMemberId: f.seats.manager.memberId,
    },
  });
}

const notes = (projectKey: string) =>
  f.platform.notification.findMany({
    where: { tenantId: f.tenantId, kind: "project_update.due", projectId: P[projectKey]! },
    select: { receiverId: true, params: true, entityType: true, entityId: true, dedupeKey: true },
    orderBy: { id: "asc" },
  });
const receiversOf = async (projectKey: string) => [...new Set((await notes(projectKey)).map((n) => n.receiverId))].sort();
const stepsOf = async (projectKey: string) => (await notes(projectKey)).map((n) => (n.params as Record<string, string>)["step"]);
const sentRows = (projectKey: string) =>
  f.platform.projectUpdateReminderSent.findMany({
    where: { tenantId: f.tenantId, projectId: P[projectKey]! },
    select: { dueOn: true, step: true },
    orderBy: [{ dueOn: "asc" }, { step: "asc" }],
  });
const rowsOf = async (projectKey: string) =>
  (await sentRows(projectKey)).map((r) => `${r.dueOn.toISOString().slice(0, 10)}#${r.step}`);

beforeAll(async () => {
  f = await setupTenant("updrem");
  acme = randomUUID();
  await f.platform.client.create({ data: { id: acme, tenantId: f.tenantId, name: "Acme" } });
  suspendedLead = await extraMember(f.roleId("manager"), "suspended");
  // A custom role that may publish updates but holds no `client:view_all`:
  // its scope is its own assignments only (a manager's is the whole tenant).
  const publisher = await f.platform.role.create({ data: { tenantId: f.tenantId, name: "Publisher" }, select: { id: true } });
  const codes = await f.platform.permission.findMany({
    where: { code: { in: ["project_update:view", "project_update:publish", "project:view"] } },
    select: { id: true },
  });
  expect(codes).toHaveLength(3);
  await f.platform.rolePermission.createMany({
    data: codes.map((c) => ({ tenantId: f.tenantId, roleId: publisher.id, permissionId: c.id, source: "TENANT_GRANT" as const })),
  });
  strayManager = await extraMember(publisher.id, "stray");

  const manager = f.seats.manager.memberId;
  const employee = f.seats.employee.memberId;
  const project = async (key: string, data: Record<string, unknown> = {}) => {
    P[key] = randomUUID();
    await f.platform.project.create({
      data: {
        id: P[key]!,
        tenantId: f.tenantId,
        clientId: acme,
        key,
        name: `Project ${key}`,
        status: "ACTIVE",
        updateCadence: "WEEKLY",
        ...data,
      } as Parameters<typeof f.platform.project.create>[0]["data"],
    });
  };
  // UPA: the lead is a manager on the project — the lead alone hears.
  await project("UPA", { leadMemberId: manager });
  // UPB: the lead is an employee (can draft, not publish) — the project's
  // people who can publish hear instead: the manager, not the employee.
  await project("UPB", { leadMemberId: employee });
  // UPC: no lead and nobody on it — nobody can hear; nothing is recorded.
  await project("UPC");
  // UPD: the lead could publish but is SUSPENDED — the owner on it hears.
  await project("UPD", { leadMemberId: suspendedLead });
  // UPE: the lead may publish but is not on the project, and their role
  // reaches only their own assignments (out of scope) — the owner on it hears.
  await project("UPE", { leadMemberId: strayManager });
  // UPF: the client portal is ON — the internal post of 6 June does not
  // count (C70 (g)); the last one the client could see was 30 May, so it
  // was due 6 June and is late.
  await project("UPF", { leadMemberId: manager, portalEnabled: true });
  // UPG: its update is in (12 June) — nothing is owed that week.
  await project("UPG", { leadMemberId: manager });
  // UPH: PAUSED — no schedule at all.
  await project("UPH", { leadMemberId: manager, status: "PAUSED" });

  for (const [memberId, keys] of [
    [manager, ["UPA", "UPB", "UPF", "UPG", "UPH"]],
    [employee, ["UPB"]],
    [suspendedLead, ["UPD"]],
    [f.seats.owner.memberId, ["UPD", "UPE"]],
  ] as const) {
    for (const k of keys) await f.platform.memberProject.create({ data: { tenantId: f.tenantId, memberId, projectId: P[k]! } });
  }
  await f.platform.member.update({ where: { id: suspendedLead }, data: { status: "SUSPENDED", suspendedAt: new Date() } });

  for (const k of ["UPA", "UPB", "UPC", "UPD", "UPE", "UPF", "UPG", "UPH"]) await plantPost(k, at(6));
  await plantPost("UPF", new Date("2031-05-30T10:00:00.000Z"), "CLIENT_VISIBLE");
  await plantPost("UPG", at(12), "INTERNAL");
}, 240_000);

afterAll(async () => {
  if (!f) return;
  const where = { where: { tenantId: f.tenantId } };
  await f.platform.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.work_maintenance', 'on', true)`;
    await tx.projectUpdate.deleteMany(where);
  });
  await f.platform.emailOutbox.deleteMany(where);
  await f.platform.notification.deleteMany(where);
  await f.platform.projectUpdateReminderSent.deleteMany(where);
  await f.platform.memberProject.deleteMany(where);
  await f.platform.$executeRaw`DELETE FROM search_index WHERE tenant_id = ${f.tenantId}`;
  await f.platform.project.deleteMany(where);
  await f.platform.client.deleteMany(where);
  for (const e of extras) {
    if (e.memberId) {
      await f.platform.memberRole.deleteMany({ where: { tenantId: f.tenantId, memberId: e.memberId } });
      await f.platform.member.deleteMany({ where: { tenantId: f.tenantId, id: e.memberId } });
    }
    await f.platform.user.deleteMany({ where: { id: e.userId } });
  }
  // The fixture deletes the tenant's audit rows (under its maintenance GUC).
  await f.cleanup();
}, 120_000);

describe("the stamp is the only writer of `update_schedule_since`", () => {
  const sinceOf = async (id: string) =>
    (await f.platform.project.findUniqueOrThrow({ where: { id }, select: { updateScheduleSince: true } })).updateScheduleSince;
  const tick = () => new Promise((r) => setTimeout(r, 20));

  it("stamps a cadence at birth, clears it for NONE, defaults the day to Friday", async () => {
    const row = await f.platform.project.findUniqueOrThrow({
      where: { id: P["UPA"]! },
      select: { updateWeekday: true, updateScheduleSince: true },
    });
    expect(row.updateWeekday).toBe(5);
    expect(row.updateScheduleSince).not.toBeNull();
    const id = randomUUID();
    await f.platform.project.create({ data: { id, tenantId: f.tenantId, clientId: acme, key: "UPZ", name: "No cadence" } });
    expect(await sinceOf(id)).toBeNull();
    await f.platform.project.update({ where: { id }, data: { updateCadence: "MONTHLY" } });
    const set = await sinceOf(id);
    expect(set).not.toBeNull();
    // A direct write is put back.
    await f.platform.project.update({ where: { id }, data: { updateScheduleSince: new Date("2020-01-01T00:00:00Z") } });
    expect((await sinceOf(id))?.getTime()).toBe(set!.getTime());
    // An unrelated edit keeps it.
    await f.platform.project.update({ where: { id }, data: { name: "Renamed" } });
    expect((await sinceOf(id))?.getTime()).toBe(set!.getTime());
    await tick();
    // A new day restarts it; so does becoming ACTIVE again, and the portal switching ON.
    await f.platform.project.update({ where: { id }, data: { updateWeekday: 2 } });
    const afterDay = await sinceOf(id);
    expect(afterDay!.getTime()).toBeGreaterThan(set!.getTime());
    await f.platform.project.update({ where: { id }, data: { status: "PAUSED" } });
    expect((await sinceOf(id))?.getTime()).toBe(afterDay!.getTime());
    await tick();
    await f.platform.project.update({ where: { id }, data: { status: "ACTIVE" } });
    const afterActive = await sinceOf(id);
    expect(afterActive!.getTime()).toBeGreaterThan(afterDay!.getTime());
    await tick();
    await f.platform.project.update({ where: { id }, data: { portalEnabled: true } });
    const afterPortal = await sinceOf(id);
    expect(afterPortal!.getTime()).toBeGreaterThan(afterActive!.getTime());
    await f.platform.project.update({ where: { id }, data: { portalEnabled: false } });
    expect((await sinceOf(id))?.getTime()).toBe(afterPortal!.getTime());
    // NONE clears it.
    await f.platform.project.update({ where: { id }, data: { updateCadence: "NONE" } });
    expect(await sinceOf(id)).toBeNull();
    await f.platform.project.delete({ where: { id } });
  });

  it("refuses a weekend day", async () => {
    await expect(f.platform.project.update({ where: { id: P["UPA"]! }, data: { updateWeekday: 6 } })).rejects.toThrow();
  });
});

describe("where a project's schedule stands", () => {
  const stand = (key: string, now: Date) =>
    sys(async (tx) => {
      const p = await tx.project.findUniqueOrThrow({
        where: { id: P[key]! },
        select: {
          id: true,
          status: true,
          archivedAt: true,
          portalEnabled: true,
          updateCadence: true,
          updateWeekday: true,
          updateScheduleSince: true,
        },
      });
      return readUpdateSchedule(tx, f.tenantId, p, now);
    });

  it("is scheduled before the day, due on it, late after it", async () => {
    expect(await stand("UPA", at(12))).toEqual({ dueOn: "2031-06-13", state: "scheduled" });
    expect(await stand("UPA", at(13))).toEqual({ dueOn: "2031-06-13", state: "due" });
    expect(await stand("UPA", at(16))).toEqual({ dueOn: "2031-06-13", state: "late" });
  });

  it("counts only a post the client can see while the portal is on (C70 (g))", async () => {
    expect(await stand("UPF", at(13))).toEqual({ dueOn: "2031-06-06", state: "late" });
  });

  it("moves on once the update is in, and has no schedule for a paused project", async () => {
    expect(await stand("UPG", at(13))).toEqual({ dueOn: "2031-06-20", state: "scheduled" });
    expect(await stand("UPH", at(13))).toBeNull();
  });
});

describe("the reminders", () => {
  it("sends nothing before the update is due, nor outside 09:00–17:00 on its day", async () => {
    expect(await sendUpdateReminders(f.tenantId, at(12))).toEqual({ sent: 0, unheard: 0 });
    expect(await sendUpdateReminders(f.tenantId, at(13, "06:30"))).toEqual({ sent: 0, unheard: 0 }); // 08:30 in Stockholm
    expect(await sendUpdateReminders(f.tenantId, at(13, "15:30"))).toEqual({ sent: 0, unheard: 0 }); // 17:30
    expect(await f.platform.projectUpdateReminderSent.count({ where: { tenantId: f.tenantId } })).toBe(0);
  });

  it("on the due day: the lead who can publish, else the project's people who can — once, and never to someone who cannot", async () => {
    // A row old enough to sweep, planted first.
    await f.platform.projectUpdateReminderSent.create({
      data: { tenantId: f.tenantId, projectId: P["UPA"]!, dueOn: new Date("2031-03-07T00:00:00Z"), step: 0 },
    });
    const run = await sendUpdateReminders(f.tenantId, at(13));
    // UPA, UPB, UPD, UPE, UPF heard; UPC had nobody; UPG is in; UPH is paused.
    expect(run).toEqual({ sent: 5, unheard: 1 });
    expect(await receiversOf("UPA")).toEqual([f.seats.manager.memberId]);
    expect(await receiversOf("UPB")).toEqual([f.seats.manager.memberId]); // never the employee lead
    expect(await receiversOf("UPD")).toEqual([f.seats.owner.memberId]); // never the suspended lead
    expect(await receiversOf("UPE")).toEqual([f.seats.owner.memberId]); // never the out-of-scope lead
    expect(await receiversOf("UPF")).toEqual([f.seats.manager.memberId]);
    expect(await notes("UPC")).toEqual([]);
    expect(await rowsOf("UPC")).toEqual([]); // nothing recorded while nobody can hear
    expect(await notes("UPG")).toEqual([]);
    expect(await notes("UPH")).toEqual([]);
    // The swept row is gone; the day's is there.
    expect(await rowsOf("UPA")).toEqual(["2031-06-13#0"]);
    // IDS ONLY: the key and the step, never a name.
    const [n] = await notes("UPA");
    expect(n!.params).toEqual({ projectKey: "UPA", step: "0", late: "0" });
    expect(n!.entityType).toBe("Project");
    expect(JSON.stringify(n!.params)).not.toContain("Project UPA");
    // Again at the same moment: nothing new.
    expect(await sendUpdateReminders(f.tenantId, at(13, "11:00"))).toEqual({ sent: 0, unheard: 1 });
    expect(await stepsOf("UPA")).toEqual(["0"]);
  });

  it("mails the receiver a link to the Updates tab, naming nothing; and audits each reminder as SYSTEM", async () => {
    const mail = await f.platform.emailOutbox.findMany({
      where: { tenantId: f.tenantId, kind: "project_update.due", receiverId: f.seats.manager.memberId },
      select: { params: true, toEmail: true },
    });
    expect(mail.length).toBeGreaterThan(0);
    const params = mail.find((m) => (m.params as Record<string, string>)["projectKey"] === "UPA")!.params as Record<string, unknown>;
    const due = renderEmail("project_update.due", "en", params);
    expect(due.subject).toBe("A project update is due today");
    expect(due.text).toContain("/projects/UPA/updates");
    expect(due.text).not.toContain("Project UPA");
    expect(renderEmail("project_update.due", "sv", { ...params, step: "1", late: "1" }).subject).toBe("En projektuppdatering är försenad");
    // UPF was due on the 6th: its first reminder of the round of the 13th is LATE, step 0 or not.
    const upf = await notes("UPF");
    expect(upf[0]!.params).toEqual({ projectKey: "UPF", step: "0", late: "1" });
    const audits = await f.platform.auditEvent.findMany({
      where: { tenantId: f.tenantId, action: "project_update.reminder_sent", targetId: P["UPA"]! },
      select: { metadata: true, actorType: true },
      orderBy: { createdAt: "asc" },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.actorType).toBe("SYSTEM");
    expect(audits[0]!.metadata).toMatchObject({ dueOn: "2031-06-13", round: "2031-06-13", step: 0, receivers: 1 });
  });

  it("the inbox names the project for its reader and links to its Updates tab", async () => {
    const page = await listInbox({ tenantId: f.tenantId, actor: actorFor(f.seats.manager.memberId) }, { filter: "all" });
    const row = page.rows.find((r) => r.kind === "project_update.due" && r.subject?.title === "Project UPA");
    expect(row?.subject?.href).toBe("/projects/UPA/updates");
  });

  it("reminds again on the next two working days — never at the weekend, never a fourth day", async () => {
    expect((await sendUpdateReminders(f.tenantId, at(14))).sent).toBe(0); // Saturday
    expect((await sendUpdateReminders(f.tenantId, at(15))).sent).toBe(0); // Sunday
    // Two runs at once on Monday: each reminder still goes once.
    const both = await Promise.all([sendUpdateReminders(f.tenantId, at(16)), sendUpdateReminders(f.tenantId, at(16))]);
    expect(both[0].sent + both[1].sent).toBe(5);
    expect((await sendUpdateReminders(f.tenantId, at(17))).sent).toBe(5); // Tuesday
    expect((await sendUpdateReminders(f.tenantId, at(18))).sent).toBe(0); // Wednesday: the round is over
    expect(await stepsOf("UPA")).toEqual(["0", "1", "2"]);
    expect(await rowsOf("UPA")).toEqual(["2031-06-13#0", "2031-06-13#1", "2031-06-13#2"]);
  });

  it("starts a new round on the next due day while the update is still missing (C70 (e)) — and stops once it is in", async () => {
    // The update arrives for UPA on Thursday the 19th.
    await plantPost("UPA", at(19));
    const run = await sendUpdateReminders(f.tenantId, at(20));
    // UPB, UPD, UPE, UPF are still missing (new round), UPG is due its own first
    // (its 12 June post made it due the 20th) — UPA is not.
    expect(run.sent).toBe(5);
    expect(await stepsOf("UPA")).toEqual(["0", "1", "2"]);
    expect(await rowsOf("UPB")).toEqual(["2031-06-13#0", "2031-06-13#1", "2031-06-13#2", "2031-06-20#0"]);
    const audit = await f.platform.auditEvent.findFirst({
      where: { tenantId: f.tenantId, action: "project_update.reminder_sent", targetId: P["UPB"]! },
      orderBy: { createdAt: "desc" },
      select: { metadata: true },
    });
    // Still late since the 13th; this is the round of the 20th — and its mail says late.
    expect(audit?.metadata).toMatchObject({ dueOn: "2031-06-13", round: "2031-06-20", step: 0 });
    expect((await notes("UPB")).at(-1)!.params).toEqual({ projectKey: "UPB", step: "0", late: "1" });
  });

  it("reminds nobody in a workspace that is not sending — suspended, offboarding or closed", async () => {
    const before = await f.platform.tenant.findUniqueOrThrow({ where: { id: f.tenantId }, select: { status: true } });
    await f.platform.tenant.update({ where: { id: f.tenantId }, data: { status: "SUSPENDED" } });
    try {
      // Monday the 23rd: the round of the 20th's second reminder is owed — and not sent.
      expect(await sendUpdateReminders(f.tenantId, at(23))).toEqual({ sent: 0, unheard: 0 });
    } finally {
      await f.platform.tenant.update({ where: { id: f.tenantId }, data: { status: before.status } });
    }
    // Back to sending: UPB, UPD, UPE, UPF and UPG's round of the 20th, step 1.
    expect((await sendUpdateReminders(f.tenantId, at(23))).sent).toBe(5);
  });

  it("re-checks at the send: a post published, or the receiver suspended, since the plan sends nothing", async () => {
    const owner = f.seats.owner.memberId;
    const seen: string[] = [];
    try {
      const run = await sendUpdateReminders(f.tenantId, at(24), {
        beforeSend: async (projectId) => {
          seen.push(projectId);
          // UPB's update arrives between the plan and its send…
          if (projectId === P["UPB"]) await plantPost("UPB", at(24, "07:30"));
          // …and the only receiver of UPD and UPE, the owner, is suspended.
          if (projectId === P["UPD"] || projectId === P["UPE"]) {
            await f.platform.member.update({ where: { id: owner }, data: { status: "SUSPENDED", suspendedAt: new Date() } });
          }
        },
      });
      // UPF and UPG get Tuesday's reminder. UPB is in; the owner — the only
      // receiver of UPD and UPE — was suspended before the first of their
      // sends (the plan saw them ACTIVE, the send does not).
      const step2 = async (k: string) => (await rowsOf(k)).includes("2031-06-20#2");
      expect(await step2("UPF")).toBe(true);
      expect(await step2("UPG")).toBe(true);
      expect(await step2("UPB")).toBe(false);
      expect(await step2("UPD")).toBe(false);
      expect(await step2("UPE")).toBe(false);
      expect(run.sent).toBe(2);
      // …and the three refused were refused AT the send: each was planned
      // and reached the seam (the fix-pass review's low).
      expect(seen).toEqual(expect.arrayContaining([P["UPB"], P["UPD"], P["UPE"], P["UPF"], P["UPG"]]));
    } finally {
      await f.platform.member.update({ where: { id: owner }, data: { status: "ACTIVE", suspendedAt: null } });
    }
  });

  // The contact plane's zero rows are the isolation suite's: it walks every
  // class-A model in `RLS_CLASSES.A`, this table included.
});

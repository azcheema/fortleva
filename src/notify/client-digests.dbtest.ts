import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { deleteContact } from "@/clients/service";
import { enqueueClientDigests } from "@/jobs/client-digests";
import { drainOutbox } from "@/jobs/outbox";
import { setTransport, type MailMessage, type MailTransport } from "@/mailer";
import { setupTenant } from "@/members/dbtest-fixture";
import { synthesiseContactPrincipal } from "@/portal";
import { countClientSummary } from "@/portal/weekly-summary";

import { CONTACT_DIGEST_MAIL } from "./client-digest";
import { readClientSummaryLink, setClientSummary } from "./client-summary";
import { clientSummaryToken } from "./client-summary-token";
import { digestPeriod } from "./digest";

/**
 * THE CLIENTS' WEEKLY SUMMARY EMAIL against the real database (Phase 5 slice
 * 101; founder decision C69) — what each person's summary counts, who gets
 * one, what the outbox sends, and the link that stops it. Every job and drain
 * here is held to THIS tenant (`enqueueClientDigests(tenantId, …)`,
 * `drainOutbox(…, { tenantId })`): neither may claim, count or "send" another
 * tenant's mail on the shared database.
 *
 * PLAN Phase 5's non-negotiables, by name: a summary built under the contact
 * principal cannot contain INTERNAL rows; a client-visible fact never reaches
 * another client's people; suppression honoured; unsubscribe idempotent.
 *
 * THE CLOCK. A summary is due on Monday 08:00 in the workspace's zone (the
 * default, Europe/Stockholm), and the portal's "your agency replied" reads
 * the REAL clock's last 14 days — so the job runs at the most recent real
 * Monday morning that has passed (`NOW`), and every fact is planted a day
 * before it. The outbox measures "too late" on the real clock, so the send
 * tests plant their own queued rows, due an hour ago, as the team's do.
 */

const run = randomUUID().slice(0, 8);
const ZONE = "Europe/Stockholm";

/** The most recent Monday 08:00 (Stockholm) at least an hour gone, and 08:30 that day. */
const MONDAY = (() => {
  const real = new Date();
  const period = digestPeriod(real, ZONE, "WEEKLY", 8, 1)!;
  return period.at.getTime() <= real.getTime() - 3_600_000 ? period.at : period.previousAt;
})();
const NOW = new Date(MONDAY.getTime() + 30 * 60_000);
/** When every fact in the window was planted: the Sunday before. */
const T = new Date(MONDAY.getTime() - 86_400_000);
/** A summary's window, as the job would set it for a first summary. */
const SINCE = new Date(MONDAY.getTime() - 7 * 86_400_000 - 60_000);
const UNTIL = new Date(NOW.getTime() - 60_000);

let f: Awaited<ReturnType<typeof setupTenant>>;
let restoreTransport: MailTransport | null = null;
const sent: (MailMessage & { from: string })[] = [];

const ids = {
  acme: randomUUID(),
  beta: randomUUID(),
  gone: randomUUID(),
  /** A client with nothing shared at all. */
  quiet: randomUUID(),
  /** A client with one old sign-off waiting, and nothing new. */
  waits: randomUUID(),
  pOn: randomUUID(),
  pOff: randomUUID(),
  pBeta: randomUUID(),
  pGone: randomUUID(),
  pWaits: randomUUID(),
  /** Acme, main contact. */
  anna: randomUUID(),
  /** Acme, a helper (collaborator): may not sign. */
  carl: randomUUID(),
  /** Acme, main contact, paused. */
  sue: randomUUID(),
  /** Acme, main contact, nothing waiting on her and — the shared news aside — the one we stop. */
  dora: randomUUID(),
  /** Beta's main contact. */
  bo: randomUUID(),
  /** A main contact of a client the agency has archived. */
  gus: randomUUID(),
  /** Acme, never given access: deletable. */
  nell: randomUUID(),
  /** The quiet client's main contact: nothing new, nothing waiting — no mail. */
  quinn: randomUUID(),
  /** The waiting client's main contact: nothing new, one thing waiting — a mail (C69 (c)). */
  will: randomUUID(),
};
const NAMES = { acme: `Acme ${run}`, beta: `Beta ${run}`, project: `Site ${run}`, task: `Shared task ${run}` };
const states: Record<string, string> = {};
let nextNumber = 1;
let seq = 1;

async function statesFor(projectId: string) {
  let rank = 0;
  for (const category of ["BACKLOG", "TODO", "IN_PROGRESS", "DONE", "CANCELLED", "TRIAGE"] as const) {
    const id = randomUUID();
    states[`${projectId}:${category}`] = id;
    await f.platform.workflowState.create({
      data: {
        id,
        tenantId: f.tenantId,
        projectId,
        name: `${category}-${run}`,
        category,
        rank: `a${(rank++).toString().padStart(4, "0")}`,
        isDefault: category === "BACKLOG",
      },
    });
  }
}

async function task(input: {
  clientId: string;
  projectId: string;
  visibility: "INTERNAL" | "CLIENT_VISIBLE";
  assigneeContactId?: string;
}): Promise<string> {
  const id = randomUUID();
  await f.platform.workItem.create({
    data: {
      id,
      tenantId: f.tenantId,
      clientId: input.clientId,
      projectId: input.projectId,
      number: nextNumber++,
      title: `${NAMES.task} ${nextNumber}`,
      stateId: states[`${input.projectId}:TODO`]!,
      stateCategory: "TODO",
      rootId: id,
      rank: `Zz${randomUUID().replace(/-/g, "")}1`,
      visibility: input.visibility,
      ...(input.assigneeContactId ? { assigneeContactId: input.assigneeContactId } : {}),
    },
  });
  return id;
}

async function agencyComment(input: {
  clientId: string;
  projectId: string;
  taskId: string;
  visibility: "INTERNAL" | "CLIENT_VISIBLE";
}) {
  await f.platform.comment.create({
    data: {
      tenantId: f.tenantId,
      clientId: input.clientId,
      projectId: input.projectId,
      subjectType: "WORK_ITEM",
      subjectId: input.taskId,
      authorMemberId: f.seats.owner.memberId,
      body: { type: "doc", content: [] },
      bodyText: "reply",
      visibility: input.visibility,
      createdAt: T,
    },
  });
}

async function update(input: {
  clientId: string;
  projectId: string;
  visibility: "INTERNAL" | "CLIENT_VISIBLE";
  publishedAt: Date;
}) {
  await f.platform.projectUpdate.create({
    data: {
      tenantId: f.tenantId,
      clientId: input.clientId,
      projectId: input.projectId,
      seq: seq++,
      health: "ON_TRACK",
      body: { sections: [] },
      bodyText: "update",
      portalSnapshot: { version: 1 },
      status: "PUBLISHED",
      visibility: input.visibility,
      authorMemberId: f.seats.owner.memberId,
      publishedAt: input.publishedAt,
      publishedByMemberId: f.seats.owner.memberId,
    },
  });
}

async function file(input: { clientId: string; projectId: string; visibility: "INTERNAL" | "CLIENT_VISIBLE" }) {
  const objectId = randomUUID();
  await f.platform.fileObject.create({
    data: {
      id: objectId,
      tenantId: f.tenantId,
      r2Key: `${f.tenantId}/${objectId}`,
      sha256: objectId.replace(/-/g, "").padEnd(64, "0"),
      sizeBytes: BigInt(5),
      contentType: "text/plain",
      status: "COMMITTED",
      committedAt: T,
    },
  });
  await f.platform.document.create({
    data: {
      tenantId: f.tenantId,
      clientId: input.clientId,
      projectId: input.projectId,
      name: `File ${randomUUID().slice(0, 6)}`,
      visibility: input.visibility,
      versions: { create: { versionNumber: 1, fileObjectId: objectId, createdAt: T } },
    },
  });
}

async function pendingSignOff(clientId: string, projectId: string) {
  await f.platform.projectVersion.create({
    data: {
      tenantId: f.tenantId,
      clientId,
      projectId,
      version: `v.${randomUUID().slice(0, 6)}`,
      status: "SHIPPED",
      shippedAt: T,
      approvalStatus: "PENDING",
      approvalRequestedAt: T,
    },
  });
}

const principalOf = (contactId: string, clientId: string) =>
  synthesiseContactPrincipal(f.tenantId, { id: contactId, tenantId: f.tenantId, clientId });

const summaries = () =>
  f.platform.emailOutbox.findMany({
    where: { tenantId: f.tenantId, kind: CONTACT_DIGEST_MAIL },
    orderBy: { createdAt: "asc" },
  });

const emailOf = (who: keyof typeof ids) => `csum-${who}-${run}@test.invalid`;

beforeAll(async () => {
  f = await setupTenant("csum");
  restoreTransport = setTransport(async (msg) => {
    sent.push(msg);
  });
  const db = f.platform;
  const up = run.slice(0, 2).toUpperCase();
  await db.client.createMany({
    data: [
      { id: ids.acme, tenantId: f.tenantId, name: NAMES.acme },
      { id: ids.beta, tenantId: f.tenantId, name: NAMES.beta },
      { id: ids.gone, tenantId: f.tenantId, name: `Gone ${run}`, status: "ARCHIVED", archivedAt: T },
      { id: ids.quiet, tenantId: f.tenantId, name: `Quiet ${run}` },
      { id: ids.waits, tenantId: f.tenantId, name: `Waits ${run}` },
    ],
  });
  await db.project.createMany({
    data: [
      { id: ids.pOn, tenantId: f.tenantId, clientId: ids.acme, key: `CSA${up}`, name: NAMES.project, portalEnabled: true },
      { id: ids.pOff, tenantId: f.tenantId, clientId: ids.acme, key: `CSB${up}`, name: `Off ${run}`, portalEnabled: false },
      { id: ids.pBeta, tenantId: f.tenantId, clientId: ids.beta, key: `CSC${up}`, name: `Beta site ${run}`, portalEnabled: true },
      { id: ids.pGone, tenantId: f.tenantId, clientId: ids.gone, key: `CSD${up}`, name: `Gone site ${run}`, portalEnabled: true },
      { id: ids.pWaits, tenantId: f.tenantId, clientId: ids.waits, key: `CSE${up}`, name: `Waits site ${run}`, portalEnabled: true },
    ],
  });
  for (const p of [ids.pOn, ids.pOff, ids.pBeta, ids.pGone]) await statesFor(p);
  const invitedAt = new Date("2026-09-01T09:00:00Z");
  const person = (
    who: keyof typeof ids,
    clientId: string,
    extra: { portalProfile?: "CONTACT_PRIMARY" | "CONTACT_COLLABORATOR"; portalStatus?: "ACTIVE" | "SUSPENDED" | "NO_ACCESS" } = {},
  ) => ({
    id: ids[who],
    tenantId: f.tenantId,
    clientId,
    name: who,
    email: emailOf(who),
    portalProfile: extra.portalProfile ?? "CONTACT_PRIMARY",
    portalStatus: extra.portalStatus ?? "ACTIVE",
    invitedAt: extra.portalStatus === "NO_ACCESS" ? null : invitedAt,
    emailVerified: true,
  });
  await db.contact.createMany({
    data: [
      person("anna", ids.acme),
      person("carl", ids.acme, { portalProfile: "CONTACT_COLLABORATOR" }),
      person("sue", ids.acme, { portalStatus: "SUSPENDED" }),
      person("dora", ids.acme),
      person("bo", ids.beta),
      person("gus", ids.gone),
      person("nell", ids.acme, { portalStatus: "NO_ACCESS" }),
      person("quinn", ids.quiet),
      person("will", ids.waits),
    ],
  });

  // ── What Acme's people may see, all within the week ──────────────────
  await update({ clientId: ids.acme, projectId: ids.pOn, visibility: "CLIENT_VISIBLE", publishedAt: T });
  const replied = await task({ clientId: ids.acme, projectId: ids.pOn, visibility: "CLIENT_VISIBLE" });
  await agencyComment({ clientId: ids.acme, projectId: ids.pOn, taskId: replied, visibility: "CLIENT_VISIBLE" });
  await file({ clientId: ids.acme, projectId: ids.pOn, visibility: "CLIENT_VISIBLE" });
  await pendingSignOff(ids.acme, ids.pOn);
  await task({ clientId: ids.acme, projectId: ids.pOn, visibility: "CLIENT_VISIBLE", assigneeContactId: ids.anna });

  // ── Sentinels: none may be counted for anybody at Acme ───────────────
  // INTERNAL, on the very project the client sees.
  await update({ clientId: ids.acme, projectId: ids.pOn, visibility: "INTERNAL", publishedAt: T });
  const internalOnly = await task({ clientId: ids.acme, projectId: ids.pOn, visibility: "CLIENT_VISIBLE" });
  await agencyComment({ clientId: ids.acme, projectId: ids.pOn, taskId: internalOnly, visibility: "INTERNAL" });
  await file({ clientId: ids.acme, projectId: ids.pOn, visibility: "INTERNAL" });
  // Client-visible, on a project whose portal is OFF.
  await update({ clientId: ids.acme, projectId: ids.pOff, visibility: "CLIENT_VISIBLE", publishedAt: T });
  await pendingSignOff(ids.acme, ids.pOff);
  // Client-visible, but older than the window: not new.
  await update({
    clientId: ids.acme,
    projectId: ids.pOn,
    visibility: "CLIENT_VISIBLE",
    publishedAt: new Date(SINCE.getTime() - 86_400_000),
  });
  // ANOTHER client's — Beta's, counted for Bo alone.
  await update({ clientId: ids.beta, projectId: ids.pBeta, visibility: "CLIENT_VISIBLE", publishedAt: T });
  // The archived client's — something waiting, which must still send nothing.
  await pendingSignOff(ids.gone, ids.pGone);
  // The waiting client's ONE fact: a sign-off asked weeks ago, still open.
  await f.platform.projectVersion.create({
    data: {
      tenantId: f.tenantId,
      clientId: ids.waits,
      projectId: ids.pWaits,
      version: `v.old-${run}`,
      status: "SHIPPED",
      shippedAt: new Date(SINCE.getTime() - 14 * 86_400_000),
      approvalStatus: "PENDING",
      approvalRequestedAt: new Date(SINCE.getTime() - 14 * 86_400_000),
    },
  });
}, 180_000);

afterAll(async () => {
  if (restoreTransport) setTransport(restoreTransport);
  if (!f) return;
  const db = f.platform;
  await db.emailSuppression.deleteMany({ where: { email: { in: Object.keys(ids).map((k) => emailOf(k as keyof typeof ids)) } } });
  await db.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
  await db.notificationPreference.deleteMany({ where: { tenantId: f.tenantId } });
  await db.tenantPreference.deleteMany({ where: { tenantId: f.tenantId } });
  await db.comment.deleteMany({ where: { tenantId: f.tenantId } });
  // A published update is immutable outside the maintenance switch
  // (`UPDATE_IMMUTABLE`) — the updates suite's own cleanup.
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.work_maintenance', 'on', true)`;
    await tx.projectUpdate.deleteMany({ where: { tenantId: f.tenantId } });
  });
  await db.projectVersion.deleteMany({ where: { tenantId: f.tenantId } });
  await db.fileVersion.deleteMany({ where: { tenantId: f.tenantId } });
  await db.document.deleteMany({ where: { tenantId: f.tenantId } });
  await db.fileObject.deleteMany({ where: { tenantId: f.tenantId } });
  await db.workItem.deleteMany({ where: { tenantId: f.tenantId } });
  await db.workflowState.deleteMany({ where: { tenantId: f.tenantId } });
  await db.contact.deleteMany({ where: { tenantId: f.tenantId } });
  await db.project.deleteMany({ where: { tenantId: f.tenantId } });
  await db.client.deleteMany({ where: { tenantId: f.tenantId } });
  await f.cleanup();
}, 120_000);

beforeEach(async () => {
  sent.length = 0;
  const db = f.platform;
  await db.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
  await db.notificationPreference.deleteMany({ where: { tenantId: f.tenantId } });
  await db.tenantPreference.deleteMany({ where: { tenantId: f.tenantId } });
  await db.emailSuppression.deleteMany({ where: { email: { in: Object.keys(ids).map((k) => emailOf(k as keyof typeof ids)) } } });
  await db.contact.updateMany({ where: { id: { in: [ids.anna, ids.carl, ids.dora, ids.bo] } }, data: { portalStatus: "ACTIVE" } });
  await db.tenant.update({ where: { id: f.tenantId }, data: { status: "ACTIVE" } });
});

describe("what a person's summary counts — the portal's own projections, as that person", () => {
  it("counts only what this main contact's portal shows: nothing INTERNAL, nothing on a project whose portal is off, nothing older, nothing of another client", async () => {
    const counts = await countClientSummary(await principalOf(ids.anna, ids.acme), SINCE, UNTIL);
    expect(counts).toEqual({ updates: 1, replies: 1, files: 1, signoffs: 1, tasks: 1, logins: 0 });
  });

  it("a helper who may not sign is told of no sign-offs, and of no task given to somebody else", async () => {
    const counts = await countClientSummary(await principalOf(ids.carl, ids.acme), SINCE, UNTIL);
    expect(counts?.signoffs).toBe(0);
    expect(counts?.tasks).toBe(0);
    expect(counts?.updates).toBe(1);
  });

  it("another client's person counts their own client's news only", async () => {
    const counts = await countClientSummary(await principalOf(ids.bo, ids.beta), SINCE, UNTIL);
    expect(counts).toEqual({ updates: 1, replies: 0, files: 0, signoffs: 0, tasks: 0, logins: 0 });
  });

  it("a person with nothing shared counts zeros; one with only an old sign-off counts it as waiting", async () => {
    expect(await countClientSummary(await principalOf(ids.quinn, ids.quiet), SINCE, UNTIL)).toEqual({
      updates: 0,
      replies: 0,
      files: 0,
      signoffs: 0,
      tasks: 0,
      logins: 0,
    });
    expect(await countClientSummary(await principalOf(ids.will, ids.waits), SINCE, UNTIL)).toEqual({
      updates: 0,
      replies: 0,
      files: 0,
      signoffs: 1,
      tasks: 0,
      logins: 0,
    });
  });

  it("refused EVERYWHERE — the portal switched off for the workspace — is no answer at all, never zeros", async () => {
    await f.platform.tenantPreference.create({ data: { tenantId: f.tenantId, key: "module.portal.enabled", value: false } });
    expect(await countClientSummary(await principalOf(ids.anna, ids.acme), SINCE, UNTIL)).toBeNull();
  });

  it("new is [since, until): a fact at `until` is the NEXT summary's, one at `since` is this one's", async () => {
    const principal = await principalOf(ids.anna, ids.acme);
    expect((await countClientSummary(principal, T, UNTIL))?.updates).toBe(1);
    expect((await countClientSummary(principal, SINCE, T))?.updates).toBe(0);
    // Waiting is now, whatever the window.
    expect((await countClientSummary(principal, SINCE, T))?.signoffs).toBe(1);
  });
});

describe("the job's enqueue", () => {
  it("one row per person with something to say — waiting alone is enough; never the paused, an archived client's, or a person with nothing", async () => {
    expect(await enqueueClientDigests(f.tenantId, NOW)).toBe(5);
    const rows = await summaries();
    // Will has nothing new and one old sign-off waiting (C69 (c)); Quinn has
    // nothing at all; Sue is paused, Gus's client archived, Nell never invited.
    expect(rows.map((r) => r.receiverId).sort()).toEqual([ids.anna, ids.carl, ids.dora, ids.bo, ids.will].sort());
    const anna = rows.find((r) => r.receiverId === ids.anna)!;
    const week = digestPeriod(NOW, ZONE, "WEEKLY", 8, 1)!.periodKey;
    expect(anna.idempotencyKey).toBe(`digest:contact:${ids.anna}:${week}`);
    expect(anna.receiverType).toBe("CONTACT");
    expect(anna.toEmail).toBe(emailOf("anna"));
    // Times only — never a number, never a name.
    expect(anna.params).toEqual({
      dueAt: MONDAY.toISOString(),
      since: new Date(digestPeriod(NOW, ZONE, "WEEKLY", 8, 1)!.previousAt.getTime() - 60_000).toISOString(),
      until: UNTIL.toISOString(),
    });
    expect(anna.notificationIds).toEqual([]);
    expect(anna.createdAt.toISOString()).toBe(UNTIL.toISOString());
  });

  it("once a week: a second run in the catch-up hours makes nothing more", async () => {
    expect(await enqueueClientDigests(f.tenantId, NOW)).toBe(5);
    expect(await enqueueClientDigests(f.tenantId, new Date(NOW.getTime() + 60 * 60_000))).toBe(0);
    expect(await summaries()).toHaveLength(5);
  });

  it("only on Monday morning in the workspace's zone: not before 08:00, not after the three catch-up hours", async () => {
    expect(await enqueueClientDigests(f.tenantId, new Date(MONDAY.getTime() - 60_000))).toBe(0);
    expect(await enqueueClientDigests(f.tenantId, new Date(MONDAY.getTime() + 3 * 3_600_000))).toBe(0);
    expect(await summaries()).toHaveLength(0);
  });

  it("nobody, while the workspace's switch is off (C69 (d))", async () => {
    await f.platform.tenantPreference.create({ data: { tenantId: f.tenantId, key: "mail.clientSummary", value: false } });
    expect(await enqueueClientDigests(f.tenantId, NOW)).toBe(0);
  });

  it("not a person who stopped their own, nor a suppressed address", async () => {
    await setClientSummary(clientSummaryToken(f.tenantId, ids.dora), false, "page");
    await f.platform.emailSuppression.create({ data: { email: emailOf("bo"), reason: "HARD_BOUNCE", source: "manual" } });
    expect(await enqueueClientDigests(f.tenantId, NOW)).toBe(3);
    expect((await summaries()).map((r) => r.receiverId).sort()).toEqual([ids.anna, ids.carl, ids.will].sort());
  });

  it("nobody, in a workspace that is no longer sending", async () => {
    await f.platform.tenant.update({ where: { id: f.tenantId }, data: { status: "SUSPENDED" } });
    expect(await enqueueClientDigests(f.tenantId, NOW)).toBe(0);
  });
});

describe("the outbox's send", () => {
  /** A summary as the job would have queued it, due an hour ago on the real clock. */
  async function queued(who: "anna" | "bo" | "carl", opts: { dueHoursAgo?: number; toEmail?: string } = {}) {
    const now = Date.now();
    const at = new Date(now - 60_000);
    await f.platform.emailOutbox.create({
      data: {
        tenantId: f.tenantId,
        idempotencyKey: `digest:contact:${ids[who]}:test-${randomUUID().slice(0, 6)}`,
        receiverType: "CONTACT",
        receiverId: ids[who],
        toEmail: opts.toEmail ?? emailOf(who),
        kind: CONTACT_DIGEST_MAIL,
        locale: "en",
        params: {
          dueAt: new Date(now - (opts.dueHoursAgo ?? 1) * 3_600_000).toISOString(),
          since: SINCE.toISOString(),
          until: at.toISOString(),
        },
        notificationIds: [],
        sendAfter: at,
        createdAt: at,
      },
    });
  }

  it("counts again as the person, names nobody, carries the one-click address and the agency's reply address", async () => {
    await queued("anna");
    const out = await drainOutbox(50, { tenantId: f.tenantId });
    expect(out.sent).toBe(1);
    const mail = sent[0]!;
    expect(mail.to).toBe(emailOf("anna"));
    expect(mail.subject).toBe("Your weekly summary from your agency");
    expect(mail.text).toContain("- 1 new update from your agency");
    expect(mail.text).toContain("- Your agency replied on 1 task");
    expect(mail.text).toContain("- 1 file was shared with you or updated");
    expect(mail.text).toContain("- 1 thing is waiting for your sign-off");
    expect(mail.text).toContain("- 1 task is waiting for you");
    for (const name of [NAMES.acme, NAMES.beta, NAMES.project, NAMES.task, "anna"]) expect(mail.text).not.toContain(name);
    const token = clientSummaryToken(f.tenantId, ids.anna);
    expect(mail.text).toContain(`/portal/unsubscribe/${token}`);
    expect(mail.listUnsubscribe).toMatch(new RegExp(`/api/client-summary/unsubscribe/${token}$`));
    const ownerEmail = (await f.platform.user.findUniqueOrThrow({ where: { id: f.seats.owner.userId } })).email;
    expect(mail.replyTo).toBe(ownerEmail.toLowerCase());
    expect((await summaries())[0]!.status).toBe("SENT");
  });

  it("a project switched off between the job and the send is counted as the portal now shows it", async () => {
    await queued("bo");
    await f.platform.project.update({ where: { id: ids.pBeta }, data: { portalEnabled: false } });
    try {
      const out = await drainOutbox(50, { tenantId: f.tenantId });
      expect(out.skipped).toBe(1);
      expect(sent).toHaveLength(0);
      const [row] = await summaries();
      // Nothing left to say — not dropped: it still chains.
      expect(row!.status).toBe("SKIPPED");
      expect(row!.lastError).toBeNull();
    } finally {
      await f.platform.project.update({ where: { id: ids.pBeta }, data: { portalEnabled: true } });
    }
  });

  it("is dropped, tagged, when the person stopped it, was paused, changed address or their workspace switched it off since", async () => {
    await queued("anna");
    await setClientSummary(clientSummaryToken(f.tenantId, ids.anna), false, "one_click");
    await queued("carl");
    await f.platform.contact.update({ where: { id: ids.carl }, data: { portalStatus: "SUSPENDED" } });
    await queued("bo", { toEmail: `old-${emailOf("bo")}` });
    const out = await drainOutbox(50, { tenantId: f.tenantId });
    expect(out.skipped).toBe(3);
    expect(sent).toHaveLength(0);
    expect((await summaries()).map((r) => [r.status, r.lastError])).toEqual([
      ["SKIPPED", "digest:unwanted"],
      ["SKIPPED", "digest:unwanted"],
      ["SKIPPED", "digest:unwanted"],
    ]);

    await f.platform.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
    await f.platform.tenantPreference.create({ data: { tenantId: f.tenantId, key: "mail.clientSummary", value: false } });
    await queued("bo");
    expect((await drainOutbox(50, { tenantId: f.tenantId })).skipped).toBe(1);
    expect((await summaries())[0]!.lastError).toBe("digest:unwanted");
  });

  it("is dropped as no longer wanted when the person's whole portal is refused by send time", async () => {
    await queued("anna");
    await f.platform.tenantPreference.create({ data: { tenantId: f.tenantId, key: "module.portal.enabled", value: false } });
    expect((await drainOutbox(50, { tenantId: f.tenantId })).skipped).toBe(1);
    expect(sent).toHaveLength(0);
    expect((await summaries())[0]!.lastError).toBe("digest:unwanted");
  });

  it("is dropped as too late four hours after its time, and never sent to a suppressed address", async () => {
    await queued("anna", { dueHoursAgo: 4.5 });
    await queued("bo");
    await f.platform.emailSuppression.create({ data: { email: emailOf("bo"), reason: "COMPLAINT", source: "manual" } });
    const out = await drainOutbox(50, { tenantId: f.tenantId });
    expect(out).toMatchObject({ sent: 0, skipped: 1, suppressed: 1 });
    expect(sent).toHaveLength(0);
  });
});

describe("the link that stops it", () => {
  const token = () => clientSummaryToken(f.tenantId, ids.dora);

  it("stops once and records once — a second stop, even at the same moment, changes nothing (idempotent)", async () => {
    const before = (await f.audits("contact.summary_stopped")).length;
    const results = await Promise.all([
      setClientSummary(token(), false, "one_click"),
      setClientSummary(token(), false, "page"),
    ]);
    expect(results).toEqual(["done", "done"]);
    expect(await setClientSummary(token(), false, "one_click")).toBe("done");
    const stopped = await f.audits("contact.summary_stopped");
    expect(stopped.length - before).toBe(1);
    expect(stopped.at(-1)!.targetId).toBe(ids.dora);
    expect(await readClientSummaryLink(token())).toEqual({ on: false });
  });

  it("starts again only for the person themselves, signed in — never for whoever holds the link", async () => {
    await setClientSummary(token(), false, "page");
    expect(await setClientSummary(token(), true, "page")).toBe("signIn");
    expect(await setClientSummary(token(), true, "page", ids.anna)).toBe("signIn");
    expect(await readClientSummaryLink(token())).toEqual({ on: false });
    const before = (await f.audits("contact.summary_started")).length;
    expect(await setClientSummary(token(), true, "page", ids.dora)).toBe("done");
    expect(await readClientSummaryLink(token())).toEqual({ on: true });
    expect((await f.audits("contact.summary_started")).length - before).toBe(1);
  });

  it("refuses a forged or foreign link, and reads nothing for it", async () => {
    const forged = `${token().slice(0, -1)}${token().endsWith("A") ? "B" : "A"}`;
    expect(await setClientSummary(forged, false, "page")).toBe("dead");
    expect(await readClientSummaryLink(forged)).toBeNull();
    // A well-signed link to a person who is not in that workspace.
    const stranger = clientSummaryToken(f.tenantId, randomUUID());
    expect(await setClientSummary(stranger, false, "page")).toBe("dead");
    expect(await readClientSummaryLink(stranger)).toBeNull();
  });

  it("goes with the person: deleting a contact removes their stopped summary too", async () => {
    await setClientSummary(clientSummaryToken(f.tenantId, ids.nell), false, "page");
    expect(await f.platform.notificationPreference.count({ where: { receiverId: ids.nell } })).toBe(1);
    await deleteContact({ tenantId: f.tenantId, actor: f.seats.owner.actor }, ids.nell);
    expect(await f.platform.notificationPreference.count({ where: { receiverId: ids.nell } })).toBe(0);
  });
});

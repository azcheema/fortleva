import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assertInScope, type MemberActor } from "@/authz/authorize";
import { AuthzError } from "@/authz/errors";
import { withTenant } from "@/db";
import { hasAccess } from "@/entitlements/resolver";
import { setupTenant } from "@/members/dbtest-fixture";
import {
  assignItem,
  changeItemVisibility,
  createComment,
  createItem,
  getItemDetail,
  listMentionable,
  setCommentVisibility,
  updateComment,
} from "./index";
import { mentionableMembers } from "./mentions";

/**
 * @MENTIONS (slice 125, founder decision C101) against the real database
 * and the real `app_runtime` role: who may be mentioned (the batched rule
 * pinned EQUAL to the canonical per-member answer), what a mention writes
 * and who it tells, the refusals — someone who cannot open the task, a
 * client-visible body, a raise — and the database's own belts
 * (`comment_visible_no_mention`, `mention_member_only`).
 */

let f: Awaited<ReturnType<typeof setupTenant>>;
let clientId: string;
let otherClientId: string;
let projectId: string;
/** Employees by how they reach the task's project (or don't). */
const extra = {
  viaClient: "",
  viaProject: "",
  nowhere: "",
  suspended: "",
  revoked: "",
};
const extraUsers: string[] = [];

const doc = (...content: unknown[]) => ({ type: "doc", content: [{ type: "paragraph", content }] });
const text = (value: string) => ({ type: "text", text: value });
const mention = (id: string) => ({ type: "mention", attrs: { id } });

beforeAll(async () => {
  f = await setupTenant("mention");
  const db = f.platform;
  clientId = randomUUID();
  otherClientId = randomUUID();
  projectId = randomUUID();
  await db.client.create({ data: { id: clientId, tenantId: f.tenantId, name: "Acme" } });
  await db.client.create({ data: { id: otherClientId, tenantId: f.tenantId, name: "Other" } });
  await db.project.create({
    data: { id: projectId, tenantId: f.tenantId, clientId, key: "ACME", name: "Acme site", portalEnabled: true },
  });
  const otherProject = randomUUID();
  await db.project.create({
    data: { id: otherProject, tenantId: f.tenantId, clientId: otherClientId, key: "OTH", name: "Other site" },
  });

  // The seated employee reaches the client (the comments' authors need scope).
  await db.memberClient.create({ data: { tenantId: f.tenantId, memberId: f.seats.employee.memberId, clientId } });

  const employeeRole = f.roleId("employee");
  const person = async (label: string, opts: { status?: "ACTIVE" | "SUSPENDED"; roleId?: string } = {}) => {
    const userId = randomUUID();
    const email = `${label}-mention-${userId.slice(0, 8)}@test.invalid`;
    await db.user.create({ data: { id: userId, name: `Teammate ${label}`, email } });
    extraUsers.push(userId);
    const member = await db.member.create({ data: { tenantId: f.tenantId, userId, status: opts.status ?? "ACTIVE" } });
    await db.memberRole.create({ data: { tenantId: f.tenantId, memberId: member.id, roleId: opts.roleId ?? employeeRole } });
    return member.id;
  };

  extra.viaClient = await person("client");
  await db.memberClient.create({ data: { tenantId: f.tenantId, memberId: extra.viaClient, clientId } });
  extra.viaProject = await person("project");
  await db.memberProject.create({ data: { tenantId: f.tenantId, memberId: extra.viaProject, projectId } });
  extra.nowhere = await person("nowhere");
  await db.memberProject.create({ data: { tenantId: f.tenantId, memberId: extra.nowhere, projectId: otherProject } });
  extra.suspended = await person("suspended", { status: "SUSPENDED" });
  await db.memberClient.create({ data: { tenantId: f.tenantId, memberId: extra.suspended, clientId } });

  // A custom role with every employee code BUT `work_item:view`, whose row
  // for it is a TENANT_REVOKE tombstone — the filter the batched read must
  // honour as `effectivePermissions` does.
  const role = await db.role.create({ data: { tenantId: f.tenantId, name: "No task view" } });
  const held = await db.rolePermission.findMany({
    where: { tenantId: f.tenantId, roleId: employeeRole, source: { not: "TENANT_REVOKE" } },
    select: { permissionId: true, permission: { select: { code: true } } },
  });
  await db.rolePermission.createMany({
    data: held.map((r) => ({
      tenantId: f.tenantId,
      roleId: role.id,
      permissionId: r.permissionId,
      source: r.permission.code === "work_item:view" ? ("TENANT_REVOKE" as const) : ("TENANT_GRANT" as const),
    })),
  });
  extra.revoked = await person("revoked", { roleId: role.id });
  await db.memberClient.create({ data: { tenantId: f.tenantId, memberId: extra.revoked, clientId } });
}, 120_000);

afterAll(async () => {
  if (!f?.tenantId) return;
  const db = f.platform;
  await db.notification.deleteMany({ where: { tenantId: f.tenantId } });
  await db.emailOutbox.deleteMany({ where: { tenantId: f.tenantId } });
  await db.notificationPreference.deleteMany({ where: { tenantId: f.tenantId } });
  await db.comment.deleteMany({ where: { tenantId: f.tenantId } }); // its mentions cascade
  await db.workItemActivity.deleteMany({ where: { tenantId: f.tenantId } });
  await db.workItem.deleteMany({ where: { tenantId: f.tenantId } });
  await db.workflowState.deleteMany({ where: { tenantId: f.tenantId } });
  await db.memberClient.deleteMany({ where: { tenantId: f.tenantId } });
  await db.memberProject.deleteMany({ where: { tenantId: f.tenantId } });
  await db.project.deleteMany({ where: { tenantId: f.tenantId } });
  await db.client.deleteMany({ where: { tenantId: f.tenantId } });
  await db.tenantCounter.deleteMany({ where: { tenantId: f.tenantId } });
  await f.cleanup();
  await f.platform.user.deleteMany({ where: { id: { in: extraUsers } } });
}, 120_000);

const ownerCtx = () => ({ tenantId: f.tenantId, actor: f.seats.owner.actor });
const employeeCtx = () => ({ tenantId: f.tenantId, actor: f.seats.employee.actor });

const mentionRows = (commentId: string) =>
  f.platform.mention.findMany({
    where: { tenantId: f.tenantId, commentId },
    select: { mentionedMemberId: true, mentionedContactId: true },
    orderBy: { mentionedMemberId: "asc" },
  });

const noticesOf = (kind: string, itemId: string) =>
  f.platform.notification.findMany({
    where: { tenantId: f.tenantId, kind, entityId: itemId },
    select: { receiverId: true, reason: true, dedupeKey: true },
    orderBy: { receiverId: "asc" },
  });

/**
 * What a refused raw write SAYS — the message and Prisma's `meta`, where the
 * pg adapter may carry the constraint's name instead (db-error-map.ts).
 */
const refusal = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "resolved";
  } catch (e) {
    let meta = "";
    try {
      meta = JSON.stringify((e as { meta?: unknown }).meta ?? "");
    } catch {
      meta = "";
    }
    return `${e instanceof Error ? e.message : String(e)} ${meta}`;
  }
};

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "resolved";
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
};

describe("who may be mentioned", () => {
  it("the batched rule equals hasAccess(work_item:view) + assertInScope asked as each member", async () => {
    const everyone = [
      f.seats.owner.memberId,
      f.seats.admin.memberId,
      f.seats.manager.memberId,
      f.seats.employee.memberId,
      ...Object.values(extra),
    ];
    const SYSTEM = { type: "system" } as const;
    const canonical = new Set<string>();
    for (const memberId of everyone) {
      const actor: MemberActor = { memberId };
      const ok = await withTenant(f.tenantId, SYSTEM, async (tx) => {
        if (!(await hasAccess(tx, f.tenantId, actor, "work_item:view"))) return false;
        try {
          await assertInScope(tx, actor, { projectId });
          return true;
        } catch (e) {
          if (e instanceof AuthzError) return false;
          throw e;
        }
      });
      if (ok) canonical.add(memberId);
    }
    const batched = await withTenant(f.tenantId, SYSTEM, (tx) => mentionableMembers(tx, f.tenantId, { projectId, clientId }));
    expect(new Set(batched.map((m) => m.id))).toEqual(canonical);
    // …and the canonical answer is the one the design names, so the two
    // cannot agree on something wrong.
    expect(canonical).toEqual(
      new Set([
        f.seats.owner.memberId,
        f.seats.admin.memberId,
        f.seats.manager.memberId,
        f.seats.employee.memberId,
        extra.viaClient,
        extra.viaProject,
      ]),
    );
    // Names ride along, for the composer's list.
    expect(batched.find((m) => m.id === extra.viaProject)?.name).toBe("Teammate project");
  });

  it("the composer's list leaves the author out", async () => {
    const { id } = await createItem(ownerCtx(), { projectId, title: "Listing" });
    const listed = (await listMentionable(employeeCtx(), id)).map((m) => m.id);
    expect(listed).not.toContain(f.seats.employee.memberId);
    expect(listed).toContain(f.seats.owner.memberId);
    expect(listed).toContain(extra.viaProject);
    expect(listed).not.toContain(extra.nowhere);
  });
});

describe("mentioning someone in a note", () => {
  it("writes one row per person and tells each — reason MENTIONED, mailed by level — never the author", async () => {
    const { id } = await createItem(ownerCtx(), { projectId, title: "Hand-over" });
    // The project teammate keeps mail to "Nothing": told in the inbox, not mailed.
    await f.platform.notificationPreference.create({
      data: { tenantId: f.tenantId, receiverId: extra.viaProject, emailLevel: "NONE" },
    });
    const c = await createComment(ownerCtx(), id, {
      doc: doc(text("Can you two "), mention(extra.viaClient), text(" "), mention(extra.viaProject), mention(f.seats.owner.memberId)),
      visibility: "INTERNAL",
    });
    expect((await mentionRows(c.id)).map((r) => r.mentionedMemberId).sort()).toEqual(
      [extra.viaClient, extra.viaProject, f.seats.owner.memberId].sort(),
    );
    expect((await mentionRows(c.id)).every((r) => r.mentionedContactId === null)).toBe(true);

    const told = await noticesOf("comment.mentioned", id);
    expect(told).toEqual(
      [extra.viaClient, extra.viaProject]
        .sort()
        .map((receiverId) => ({ receiverId, reason: "MENTIONED", dedupeKey: `mentioned:${id}` })),
    );
    const mails = await f.platform.emailOutbox.findMany({
      where: { tenantId: f.tenantId, kind: "comment.mentioned" },
      select: { receiverId: true },
    });
    expect(mails.map((m) => m.receiverId)).toContain(extra.viaClient);
    expect(mails.map((m) => m.receiverId)).not.toContain(extra.viaProject);
    // No audit for one's own comment — routine, its history row is the record.
    expect(await f.platform.auditEvent.count({ where: { tenantId: f.tenantId, targetId: c.id } })).toBe(0);
  });

  it("the mentioned assignee gets the mention, not the coalesced comment notice as well", async () => {
    const { id } = await createItem(ownerCtx(), { projectId, title: "Assigned" });
    await assignItem(ownerCtx(), id, extra.viaClient);
    await createComment(ownerCtx(), id, { doc: doc(mention(extra.viaClient), text(" please")), visibility: "INTERNAL" });
    expect((await noticesOf("comment.mentioned", id)).map((n) => n.receiverId)).toEqual([extra.viaClient]);
    expect(await noticesOf("work_item.commented", id)).toEqual([]);
    // A later comment that does not mention them is the ordinary notice.
    await createComment(ownerCtx(), id, { doc: doc(text("Any news?")), visibility: "INTERNAL" });
    expect((await noticesOf("work_item.commented", id)).map((n) => n.receiverId)).toEqual([extra.viaClient]);
  });

  it("someone who cannot open the task — out of scope, suspended, without task access — refuses the post and writes nothing", async () => {
    const { id } = await createItem(ownerCtx(), { projectId, title: "Refusals" });
    for (const who of [extra.nowhere, extra.suspended, extra.revoked, randomUUID()]) {
      expect(
        await code(createComment(ownerCtx(), id, { doc: doc(text("hi "), mention(who)), visibility: "INTERNAL" })),
        who,
      ).toBe("MENTION_NOT_ALLOWED");
    }
    expect(await f.platform.comment.count({ where: { tenantId: f.tenantId, subjectId: id } })).toBe(0);
    expect(await noticesOf("comment.mentioned", id)).toEqual([]);
  });

  it("a reply the client can see may mention no one", async () => {
    const { id } = await createItem(ownerCtx(), { projectId, title: "Shared" });
    await changeItemVisibility(ownerCtx(), id, "CLIENT_VISIBLE");
    expect(
      await code(createComment(ownerCtx(), id, { doc: doc(text("cc "), mention(extra.viaClient)), visibility: "CLIENT_VISIBLE" })),
    ).toBe("COMMENT_MENTION_VISIBLE");
    expect(await f.platform.comment.count({ where: { tenantId: f.tenantId, subjectId: id } })).toBe(0);
  });
});

describe("editing and raising", () => {
  it("an edit tells only the people it ADDS and drops the rows of the people it removes", async () => {
    const { id } = await createItem(ownerCtx(), { projectId, title: "Edited" });
    const c = await createComment(ownerCtx(), id, { doc: doc(text("for "), mention(extra.viaClient)), visibility: "INTERNAL" });
    await f.platform.notification.updateMany({ where: { tenantId: f.tenantId, entityId: id }, data: { readAt: new Date() } });
    await updateComment(ownerCtx(), c.id, { doc: doc(text("for "), mention(extra.viaProject)) });
    expect((await mentionRows(c.id)).map((r) => r.mentionedMemberId)).toEqual([extra.viaProject]);
    const told = await noticesOf("comment.mentioned", id);
    expect(told.filter((n) => n.receiverId === extra.viaClient)).toHaveLength(1); // the first, read — nothing new
    expect(told.filter((n) => n.receiverId === extra.viaProject)).toHaveLength(1);
    // A person mentioned before and unable to open the task since stays in
    // the text: the edit is not refused for them, and adds no one.
    await f.platform.member.update({ where: { id: extra.viaProject }, data: { status: "SUSPENDED" } });
    try {
      await updateComment(ownerCtx(), c.id, { doc: doc(text("still for "), mention(extra.viaProject)) });
      expect((await mentionRows(c.id)).map((r) => r.mentionedMemberId)).toEqual([extra.viaProject]);
      // …but adding someone who cannot open it is refused, and nothing changes.
      expect(
        await code(updateComment(ownerCtx(), c.id, { doc: doc(mention(extra.viaProject), mention(extra.nowhere)) })),
      ).toBe("MENTION_NOT_ALLOWED");
    } finally {
      await f.platform.member.update({ where: { id: extra.viaProject }, data: { status: "ACTIVE" } });
    }
  });

  it("a note that mentions someone cannot be shown to the client, nor a client-visible comment edited to mention", async () => {
    const { id } = await createItem(ownerCtx(), { projectId, title: "Raise" });
    await changeItemVisibility(ownerCtx(), id, "CLIENT_VISIBLE");
    const note = await createComment(ownerCtx(), id, { doc: doc(mention(extra.viaClient), text(" see")), visibility: "INTERNAL" });
    expect(await code(setCommentVisibility(ownerCtx(), note.id, "CLIENT_VISIBLE"))).toBe("COMMENT_HAS_MENTION");
    const reply = await createComment(ownerCtx(), id, { doc: doc(text("Hi!")), visibility: "CLIENT_VISIBLE" });
    expect(await code(updateComment(ownerCtx(), reply.id, { doc: doc(text("Hi "), mention(extra.viaClient)) }))).toBe(
      "COMMENT_MENTION_VISIBLE",
    );
    // Once the mention is gone the raise goes through.
    await updateComment(ownerCtx(), note.id, { doc: doc(text("see the brief")) });
    expect((await setCommentVisibility(ownerCtx(), note.id, "CLIENT_VISIBLE")).visibility).toBe("CLIENT_VISIBLE");
  });

  it("the panel's read names the people and marks the note", async () => {
    const { id, number } = await createItem(ownerCtx(), { projectId, title: "Read" });
    await createComment(ownerCtx(), id, { doc: doc(mention(extra.viaClient), text(" ok?")), visibility: "INTERNAL" });
    const { comments } = await getItemDetail(ownerCtx(), projectId, number);
    expect(comments.mentionNames).toEqual({ [extra.viaClient]: "Teammate client" });
    expect(comments.rows[0]).toMatchObject({ hasMention: true });
  });
});

describe("the database's belts", () => {
  it("refuses a client-visible body holding a mention, whoever writes it (comment_visible_no_mention)", async () => {
    const { id } = await createItem(ownerCtx(), { projectId, title: "Belt" });
    await changeItemVisibility(ownerCtx(), id, "CLIENT_VISIBLE");
    const principal = { type: "member", id: f.seats.owner.memberId } as const;
    const body = doc(text("x "), mention(extra.viaClient)) as object;
    expect(
      await refusal(
        withTenant(f.tenantId, principal, (tx) =>
          tx.comment.create({
            data: {
              tenantId: f.tenantId,
              subjectType: "WORK_ITEM",
              subjectId: id,
              authorMemberId: f.seats.owner.memberId,
              body,
              bodyText: "x",
              visibility: "CLIENT_VISIBLE",
            },
            select: { id: true },
          }),
        ),
      ),
    ).toMatch(/comment_visible_no_mention/);
    // …and a raise of an internal one written straight to the table.
    const note = await withTenant(f.tenantId, principal, (tx) =>
      tx.comment.create({
        data: {
          tenantId: f.tenantId,
          subjectType: "WORK_ITEM",
          subjectId: id,
          authorMemberId: f.seats.owner.memberId,
          body,
          bodyText: "x",
          visibility: "INTERNAL",
        },
        select: { id: true },
      }),
    );
    expect(
      await refusal(
        withTenant(f.tenantId, principal, (tx) =>
          tx.comment.update({ where: { id: note.id }, data: { visibility: "CLIENT_VISIBLE" }, select: { id: true } }),
        ),
      ),
    ).toMatch(/comment_visible_no_mention/);
  });

  it("a mention row names exactly one member and no contact (mention_member_only), once (mention_member_once)", async () => {
    const { id } = await createItem(ownerCtx(), { projectId, title: "Rows" });
    const c = await createComment(ownerCtx(), id, { doc: doc(text("plain")), visibility: "INTERNAL" });
    const principal = { type: "member", id: f.seats.owner.memberId } as const;
    expect(
      await refusal(
        withTenant(f.tenantId, principal, (tx) =>
          tx.mention.create({ data: { tenantId: f.tenantId, commentId: c.id, mentionedContactId: randomUUID() } }),
        ),
      ),
    ).toMatch(/mention_member_only/);
    await withTenant(f.tenantId, principal, (tx) =>
      tx.mention.create({ data: { tenantId: f.tenantId, commentId: c.id, mentionedMemberId: extra.viaClient } }),
    );
    expect(
      await refusal(
        withTenant(f.tenantId, principal, (tx) =>
          tx.mention.create({ data: { tenantId: f.tenantId, commentId: c.id, mentionedMemberId: extra.viaClient } }),
        ),
      ),
    ).toMatch(/mention_member_once|Unique constraint/);
  });
});

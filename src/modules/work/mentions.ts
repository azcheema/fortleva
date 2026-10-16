import { effectivePermissionsOf } from "@/authz/authorize";
import { withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { fail } from "@/lib/domain-error";

import { notifyItemMembers } from "./notify";
import { loadItemInScope } from "./rows";
import { principalOf, type WorkCtx } from "./states";

/**
 * @MENTIONS (slice 125, founder decision C101): a member types @name in a
 * comment and that teammate is told. The settled rules:
 *
 * · ONLY TEAMMATES (C101 (a)) — a member id is the one thing a mention
 *   node stores (`extensions.ts`); a client's people are never offered and
 *   a `mention` row never names a contact.
 * · ONLY IN AN INTERNAL NOTE (C101 (b)) — the comment writers refuse a
 *   client-visible body with a mention (COMMENT_MENTION_VISIBLE) and a
 *   raise of one (COMMENT_HAS_MENTION); the database refuses it whoever
 *   writes (the CHECK `comment_visible_no_mention`, 20261029090000).
 * · ONLY PEOPLE WHO CAN OPEN THE TASK (design §3.2) — ACTIVE, holding
 *   `work_item:view`, and reaching the task's project: `client:view_all`,
 *   or assigned to the project, or to its client (`resolveScope`'s rule
 *   for one project). The list the composer shows and the check the writer
 *   makes are the SAME function, below; the writer never trusts the list
 *   the browser had.
 * · Being mentioned is a NOTIFICATION, `comment.mentioned` (reason
 *   MENTIONED): instant, mailed at the "Only mentions" level and louder,
 *   pushed as the member's phone allows. ONE unread notice per person and
 *   task: a second mention on the same task before the first is read adds
 *   nothing (the coalescing every work notice has — `notifyItemMembers`'
 *   per-task dedupe key).
 * · A mention is part of writing a comment — ROUTINE: the comment's own
 *   history row, no audit event (AGENTS.md's carve-out for one's own
 *   comment). The notification rows record who was told.
 */

/** The code that opens a task, and the one that reaches every project. */
const READ_CODE = "work_item:view";
const ALL_CODE = "client:view_all";

export type Mentionable = { readonly id: string; readonly name: string };

/**
 * THE rule of who may be mentioned on one task — the composer's list and
 * the writer's check. In four statements whatever the team's size: the
 * ACTIVE members (or just `only`), their two codes from ONE permission
 * read (`effectivePermissionsOf` — gate 4 as `requireAccess` reads it), and
 * the project's and the client's assignment rows for those without
 * `client:view_all`.
 *
 * The MODULE gates are not asked per person: the platform's switch, the
 * plan and the workspace's own are workspace-wide, and every caller has
 * just passed them for this module as itself. `mentions.dbtest.ts` pins
 * the answer equal to `hasAccess` + `assertInScope` asked as each member.
 *
 * Sequential reads (the one-connection rule, AGENTS.md). Ordered as the
 * assignee picker is — by the day each joined, then id.
 */
export async function mentionableMembers(
  tx: TenantDb,
  tenantId: string,
  item: { readonly projectId: string; readonly clientId: string },
  only?: readonly string[],
): Promise<Mentionable[]> {
  if (only && only.length === 0) return [];
  const members = await tx.member.findMany({
    where: { tenantId, status: "ACTIVE", ...(only ? { id: { in: [...only] } } : {}) },
    select: { id: true, user: { select: { name: true } } },
    orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
  });
  if (members.length === 0) return [];
  const held = await effectivePermissionsOf(
    tx,
    members.map((m) => m.id),
    [READ_CODE, ALL_CODE],
  );
  const readers = members.filter((m) => held.get(m.id)?.has(READ_CODE));
  const narrow = readers.filter((m) => !held.get(m.id)!.has(ALL_CODE)).map((m) => m.id);
  const reach = new Set<string>();
  if (narrow.length > 0) {
    const byProject = await tx.memberProject.findMany({
      where: { tenantId, projectId: item.projectId, memberId: { in: narrow } },
      select: { memberId: true },
    });
    const byClient = await tx.memberClient.findMany({
      where: { tenantId, clientId: item.clientId, memberId: { in: narrow } },
      select: { memberId: true },
    });
    for (const row of [...byProject, ...byClient]) reach.add(row.memberId);
  }
  return readers
    .filter((m) => held.get(m.id)!.has(ALL_CODE) || reach.has(m.id))
    .map((m) => ({ id: m.id, name: m.user.name }));
}

/**
 * The people a body mentions, each checked against the rule — every one of
 * them may be mentioned, or the write is refused with MENTION_NOT_ALLOWED
 * and nothing is written (the composer keeps the words). Naming no one is
 * deliberate: the author picked from a list, so the likeliest cause is a
 * colleague suspended or moved off the project since, and the author can
 * see their own chips.
 */
export async function assertMentionable(
  tx: TenantDb,
  tenantId: string,
  item: { readonly projectId: string; readonly clientId: string },
  memberIds: readonly string[],
): Promise<void> {
  if (memberIds.length === 0) return;
  const allowed = await mentionableMembers(tx, tenantId, item, memberIds);
  if (allowed.length !== new Set(memberIds).size) fail("MENTION_NOT_ALLOWED");
}

/**
 * Bring a comment's `mention` rows in line with its body and tell the
 * people ADDED — never the removed, never the author (`emit` drops the
 * actor). Called by the comment writers inside their transaction, after
 * the comment row is written and the people checked.
 */
export async function recordMentions(
  tx: TenantDb,
  ctx: WorkCtx,
  commentId: string,
  item: { readonly id: string; readonly number: number; readonly clientId: string; readonly projectId: string },
  change: { readonly add: readonly string[]; readonly remove: readonly string[] },
): Promise<void> {
  if (change.remove.length > 0) {
    await tx.mention.deleteMany({
      where: { tenantId: ctx.tenantId, commentId, mentionedMemberId: { in: [...change.remove] } },
    });
  }
  if (change.add.length === 0) return;
  await tx.mention.createMany({
    data: change.add.map((memberId) => ({ tenantId: ctx.tenantId, commentId, mentionedMemberId: memberId })),
    skipDuplicates: true,
  });
  await notifyItemMembers(
    tx,
    ctx,
    item,
    "comment.mentioned",
    new Map(change.add.map((memberId) => [memberId, "MENTIONED" as const])),
    "mentioned",
  );
}

/** The members a comment's rows say it mentions — what an edit diffs against. */
export async function mentionedBy(tx: TenantDb, tenantId: string, commentId: string): Promise<Set<string>> {
  const rows = await tx.mention.findMany({
    where: { tenantId, commentId, mentionedMemberId: { not: null } },
    select: { mentionedMemberId: true },
  });
  return new Set(rows.map((r) => r.mentionedMemberId!));
}

/**
 * The composer's list (`listMentionableAction`): the teammates who may be
 * mentioned on this task, the author left out. Asked by a member who can
 * comment (`comment:create`) on a task in their scope — the same gates as
 * the post it prepares — AND who may see the member list (`member:view`):
 * the list names teammates and, by who is on it, their reach, which the
 * assignee picker and /members already show only behind their own codes
 * (the security review's LOW — parity for a custom role).
 */
export async function listMentionable(ctx: WorkCtx, itemId: string): Promise<Mentionable[]> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "comment:create");
    await requireAccess(tx, ctx.tenantId, ctx.actor, "member:view");
    const item = await loadItemInScope(tx, ctx, itemId, { lock: false });
    const people = await mentionableMembers(tx, ctx.tenantId, item);
    return people.filter((p) => p.id !== ctx.actor.memberId);
  });
}

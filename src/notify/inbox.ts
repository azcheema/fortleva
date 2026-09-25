import { scopeWhere } from "@/authz/authorize";
import type { MemberActor } from "@/authz/authorize";
import { withTenant, type TenantDb } from "@/db";
import { accessibleCodes } from "@/entitlements/resolver";
import { fail } from "@/lib/domain-error";
import { idCursor } from "@/lib/id-cursor";
import { BUDGET_ALERT_ENTITY, PROJECT_MONEY_CODES } from "@/modules/time/money-codes";

import { isNotificationKind, type NotificationKind } from "./catalog";

/**
 * The member inbox (`/inbox`, UI.md §3.1 "Inbox — core; unread badge";
 * DATA_MODEL.md §6.18). Reads and per-row state for the notifications
 * `notify.emit` fanned out to THIS member.
 *
 * THE THREE PARTS OF THE STANDARD MUTATION RECIPE THAT ARE MISSING HERE
 * ARE MISSING ON PURPOSE, and each is replaced by something stronger or
 * by nothing at all:
 *
 *   • No `requireAccess`. Notifications are CORE infrastructure and are
 *     "never entitlement-gated — channels toggled by preference"
 *     (DATA_MODEL.md §6.18, PLAN.md §3 2W). A member whose tenant has
 *     the time module off still receives and reads the notifications
 *     the system already decided to send them; a gate here would
 *     silently swallow rows. There is no `notification:*` permission
 *     code, and adding one would be a new namespace entry for a surface
 *     whose only possible subject is yourself.
 *
 *   • No `assertInScope` on the notification row. The RESTRICTIVE
 *     `principal_scope` / `principal_scope_update` policies (migration
 *     20260820170000) bind SELECT *and* UPDATE to
 *     `receiver_id = app.principal_id` under the member principal. That
 *     is the same check one layer lower, where no future caller can
 *     forget it — the `principalScoped` RLS subclass exists for exactly
 *     this. Every write below is an `updateMany`, so an id belonging to
 *     another member is not refused, it simply does not match: the
 *     answer to "mark someone else's notification read" is a count of
 *     zero, which is also the answer for an id that never existed. No
 *     existence oracle, by construction.
 *
 *   • No audit event. `src/audit/catalog.ts` holds exactly one
 *     notification action — `notification.preference_changed` — and no
 *     read/archive/snooze action, which is the deliberate reading:
 *     inbox state is per-receiver bookkeeping about the receiver's own
 *     attention, visible to nobody else and describing no tenant fact.
 *     It is the `moveItem` rank-only carve-out (AGENTS.md, 2026-08-21)
 *     with an even weaker claim to a row. Do not read this as licence
 *     to skip audit where a *second person* could see the change.
 *
 * SUBJECT RESOLUTION IS SCOPE-FILTERED, NOT SCOPE-CHECKED (the property
 * `modules/work/bulk.ts` documents). `params` carries ids only —
 * rendering happens here, from live rows, under the RECEIVER's
 * principal — and a receiver's scope can shrink after the notification
 * was sent (a MemberClient row removed, a project assignment revoked).
 * So the entity loads compose `scopeWhere` INTO the query: an item the
 * member may no longer see falls out exactly like a deleted one, and
 * the row still renders — they were told something happened, and
 * hiding it would leave a silent gap in their own inbox — but with the
 * kind's generic label and NO title and NO link. Member scope is
 * application-level and never an RLS term, so a bare tenant-scoped read
 * here would hand a member the title of work they were removed from.
 */

export type InboxCtx = { readonly tenantId: string; readonly actor: MemberActor };

/** The four buckets the page offers. `all` means "not archived". */
export type InboxFilter = "unread" | "all" | "snoozed" | "archived";

export const INBOX_FILTERS = ["unread", "all", "snoozed", "archived"] as const;

export const isInboxFilter = (v: string | undefined): v is InboxFilter =>
  v !== undefined && (INBOX_FILTERS as readonly string[]).includes(v);

/** One page of rows; `nextCursor` drives "load more". */
export const INBOX_PAGE_SIZE = 50;
/** Ceiling on a single mark/archive/snooze call (the page, twice over). */
export const MAX_INBOX_IDS = 100;
/** A snooze may not park a row past this — 90 days, in ms. */
const MAX_SNOOZE_MS = 90 * 24 * 60 * 60 * 1000;

/** What the UI needs to draw one row. `subject` is null when the
 * receiver may no longer see the thing the notification is about. */
export type InboxRow = {
  readonly id: string;
  /** A catalogued kind, or null for a row written by a newer deploy. */
  readonly kind: NotificationKind | null;
  readonly createdAt: Date;
  readonly readAt: Date | null;
  readonly archivedAt: Date | null;
  readonly snoozedTill: Date | null;
  readonly subject: InboxSubject | null;
};

/**
 * What a row is about. `href` is null when the member may read the NAME
 * but the page it would open would refuse them — a budget alert for a
 * member without the Money page's codes, or with Time switched off (C34):
 * the row names the project and links nowhere.
 */
export type InboxSubject = { readonly title: string; readonly href: string | null };

export type InboxPage = {
  readonly rows: readonly InboxRow[];
  readonly nextCursor: string | null;
};

/**
 * THE PAGE WALKS ON `id`, NOT ON `createdAt`, and that is a correctness
 * requirement rather than a shortcut.
 *
 * `created_at` is `timestamptz(6)` defaulted to `now()` — transaction
 * start, to the MICROsecond. Prisma hands it back as a JS `Date`, which
 * holds milliseconds, so a cursor built from one is already rounded
 * down: page 2 asking for `created_at < '12:00:00.123000'` skips every
 * row actually stamped `.123456`, and the `created_at = cursor`
 * tie-break can never match a real value either. Rows emitted in ONE
 * transaction share that stamp exactly (`checkBudgetAlerts` crossing
 * two thresholds does it), so a batch straddling the page boundary
 * would vanish — silently, from the surface whose whole job is to lose
 * nothing.
 *
 * A UUIDv7 id round-trips as a string, is unique, and carries the same
 * creation millisecond, so it IS the total order the keyset needs.
 * `notify.emit` writes v7 ids (`newId()`) for exactly this reason; the
 * column is TEXT and the database sorts byte-wise (`C.UTF-8`, asserted
 * by `isolation.dbtest.ts`), which for lowercase canonical hex is the
 * same order.
 */
// Canonical UUID only (`idCursor`, the parser the item panel's Activity
// section shares): anything else is a stale or hand-made link and is
// answered with the first page rather than an error.
const decodeCursor = idCursor;

/**
 * Does this param actually put the reader past the first page?
 *
 * The page needs the same answer the QUERY gets, and "a `cursor` param
 * exists" is not it: `?cursor=` and `?cursor=garbage` are both rejected
 * above and answered with the first page, so treating them as paged
 * would tell a member who is genuinely caught up that there is
 * "nothing further back" — the same lie the past-the-end state exists
 * to remove, pointed the other way. One function, both callers.
 */
export const isInboxCursor = (raw: string | null | undefined): boolean =>
  decodeCursor(raw) !== null;

/** Rows that belong in front of the member right now: unread, not
 * archived, and not parked by a snooze that has yet to expire. */
const liveUnread = (now: Date) => ({
  readAt: null,
  archivedAt: null,
  OR: [{ snoozedTill: null }, { snoozedTill: { lte: now } }],
});

const filterWhere = (filter: InboxFilter, now: Date) => {
  switch (filter) {
    case "unread":
      return liveUnread(now);
    case "snoozed":
      return { archivedAt: null, snoozedTill: { gt: now } };
    case "archived":
      return { archivedAt: { not: null } };
    case "all":
      return { archivedAt: null };
  }
};

const receiverWhere = (ctx: InboxCtx) => ({
  tenantId: ctx.tenantId,
  receiverType: "MEMBER" as const,
  receiverId: ctx.actor.memberId,
});

/**
 * The unread badge (UI.md §3.1). Counted under the member principal, so
 * `principal_scope` has already restricted it to this member's rows;
 * the receiver terms stay for the index, not for safety.
 *
 * The `In` variant exists so the member-plane layout — which already
 * opens a transaction to resolve nav permissions — can fold this into
 * it. The badge is on EVERY authed page, and a second serial round trip
 * per render is a cost nothing here needs to pay.
 */
export const countUnreadIn = (tx: TenantDb, ctx: InboxCtx): Promise<number> =>
  tx.notification.count({ where: { ...receiverWhere(ctx), ...liveUnread(new Date()) } });

export async function countUnread(ctx: InboxCtx): Promise<number> {
  return withTenant(ctx.tenantId, { type: "member", id: ctx.actor.memberId }, (tx) =>
    countUnreadIn(tx, ctx),
  );
}

/** The columns a row is drawn from — the page and the glance read the same ones. */
const ROW_SELECT = {
  id: true,
  kind: true,
  createdAt: true,
  readAt: true,
  archivedAt: true,
  snoozedTill: true,
  entityType: true,
  entityId: true,
  projectId: true,
} as const;

export async function listInbox(
  ctx: InboxCtx,
  opts: { filter: InboxFilter; cursor?: string | null } = { filter: "unread" },
): Promise<InboxPage> {
  return withTenant(ctx.tenantId, { type: "member", id: ctx.actor.memberId }, async (tx) => {
    const now = new Date();
    const cursor = decodeCursor(opts.cursor);
    // Keyset, not offset: an offset page shifts under the member the
    // moment they mark something read.
    //
    // COMPOSED WITH `AND`, NEVER BY SPREADING. The unread filter carries
    // a top-level `OR`, so `{...filter, ...after}` would let one clause
    // overwrite the other — it did, and the snooze term silently
    // vanished on page 2. An `AND` array cannot collide.
    const after = cursor ? [{ id: { lt: cursor } }] : [];
    const found = await tx.notification.findMany({
      where: { ...receiverWhere(ctx), AND: [filterWhere(opts.filter, now), ...after] },
      orderBy: { id: "desc" },
      take: INBOX_PAGE_SIZE + 1,
      select: ROW_SELECT,
    });
    const hasMore = found.length > INBOX_PAGE_SIZE;
    const page = hasMore ? found.slice(0, INBOX_PAGE_SIZE) : found;
    const rows = await toInboxRows(tx, ctx, page);
    const last = page.at(-1);
    return { rows, nextCursor: hasMore && last ? last.id : null };
  });
}

/** How many unread rows `/home`'s inbox card shows (UI.md rule 8, "inbox top-5"). */
export const INBOX_GLANCE_SIZE = 5;

export type InboxGlance = {
  /** The badge's number — every live unread row, not only the ones shown. */
  readonly unread: number;
  /** The newest live unread rows, at most `INBOX_GLANCE_SIZE`. */
  readonly rows: readonly InboxRow[];
};

/**
 * `/home`'s inbox card: the unread count and the newest few unread rows,
 * in one transaction, through the SAME bucket predicate and the SAME
 * scope-filtered subject resolution the Unread tab uses — so the card can
 * never name a task the inbox itself would not.
 */
export async function inboxGlance(ctx: InboxCtx, limit: number = INBOX_GLANCE_SIZE): Promise<InboxGlance> {
  return withTenant(ctx.tenantId, { type: "member", id: ctx.actor.memberId }, async (tx) => {
    const where = { ...receiverWhere(ctx), AND: [liveUnread(new Date())] };
    // In sequence, never a `Promise.all` on this transaction's one
    // connection (AGENTS.md's trap): a lost race would hand `undefined` to
    // `toInboxRows` and take `/home` down with it. The connection runs one
    // statement at a time either way.
    const unread = await tx.notification.count({ where });
    const found = await tx.notification.findMany({
      where,
      orderBy: { id: "desc" },
      take: limit,
      select: ROW_SELECT,
    });
    return { unread, rows: await toInboxRows(tx, ctx, found) };
  });
}

type RowSource = SubjectSource & {
  kind: string;
  createdAt: Date;
  readAt: Date | null;
  archivedAt: Date | null;
  snoozedTill: Date | null;
};

async function toInboxRows(tx: TenantDb, ctx: InboxCtx, page: readonly RowSource[]): Promise<InboxRow[]> {
  const subjects = await resolveSubjects(tx, ctx, page);
  return page.map((n) => ({
    id: n.id,
    kind: isNotificationKind(n.kind) ? n.kind : null,
    createdAt: n.createdAt,
    readAt: n.readAt,
    archivedAt: n.archivedAt,
    snoozedTill: n.snoozedTill,
    subject: subjects.get(n.id) ?? null,
  }));
}

type SubjectSource = {
  id: string;
  entityType: string;
  entityId: string;
  projectId: string | null;
};

/**
 * Two scope-filtered batch loads — projects, then work items — and
 * nothing per row. A subject the loads did not return stays null, which
 * is what an unresolvable, a deleted, an out-of-scope and a
 * not-permitted entity all look like from here: the same answer for
 * all four, deliberately.
 *
 * THE LIST ITSELF IS UNGATED; THE SUBJECT IS NOT. Reaching your own
 * inbox needs no permission — notifications are core (§6.18) and the
 * only possible subject is yourself. But a subject line is a work
 * item's TITLE and a project's NAME, and `work_item:view` /
 * `project:view` are the codes that say who may read those. A member
 * can be assigned a task by someone who holds `work_item:edit` without
 * holding any work permission themselves, so without this the inbox
 * would be the one surface in the product that renders tenant content
 * with no permission code behind it. They still get the row and the
 * kind — they are told something happened — with no title and no link.
 *
 * ON ALL FOUR GATES, not the permission alone (founder decision C33,
 * 2026-09-25): with the Work module switched off a task's subject is null
 * too, because the backlog its link opens would refuse, and search already
 * hides tasks in that state.
 */
async function resolveSubjects(
  tx: TenantDb,
  ctx: InboxCtx,
  rows: readonly SubjectSource[],
): Promise<Map<string, InboxSubject>> {
  const out = new Map<string, InboxSubject>();
  if (rows.length === 0) return out;

  // ONE call for every code the page needs, awaited in turn — never checks
  // as legs of a `Promise.all` on this transaction's one connection
  // (AGENTS.md's trap; `authz-batches.test.ts`). It runs whenever `/home`'s
  // glance or an `/inbox` page has rows to name, and asks only what those
  // rows need: `project:view` (core, so no module gate); `work_item:view`
  // when a row is a task (Work's gates); the Money page's own codes when a
  // row is a budget alert (Time's gates — founder decision C34: its link is
  // offered only to a member that page would not refuse).
  const namesTasks = rows.some((r) => r.entityType === "WorkItem");
  const linksMoney = rows.some((r) => r.entityType === BUDGET_ALERT_ENTITY);
  const may = await accessibleCodes(tx, ctx.tenantId, ctx.actor, [
    "project:view",
    ...(namesTasks ? ["work_item:view"] : []),
    ...(linksMoney ? PROJECT_MONEY_CODES : []),
  ]);
  const mayViewProjects = may.has("project:view");
  const mayViewItems = may.has("work_item:view");
  const mayOpenMoney = PROJECT_MONEY_CODES.every((code) => may.has(code));

  // A task row's project is wanted only for a task's link, which needs
  // `work_item:view` too — with Work off it can name nothing.
  const projectIds = mayViewProjects
    ? [
        ...new Set(
          rows
            .filter((r) => r.entityType !== "WorkItem" || mayViewItems)
            .map((r) => r.projectId)
            .filter((v): v is string => v !== null),
        ),
      ]
    : [];
  // Each scope is resolved only when there is something to look up — with
  // Work off, or a page of nothing but budget alerts, the item side has
  // no ids at all and its three or four reads would buy nothing.
  const projects = projectIds.length
    ? await tx.project.findMany({
        where: {
          ...(await scopeWhere(tx, ctx.actor, { clientField: "clientId", projectField: "id" })),
          tenantId: ctx.tenantId,
          id: { in: projectIds },
        },
        select: { id: true, key: true, name: true },
      })
    : [];
  const byProject = new Map(projects.map((p) => [p.id, p]));

  const itemIds = mayViewItems
    ? [...new Set(rows.filter((r) => r.entityType === "WorkItem").map((r) => r.entityId))]
    : [];
  const items = itemIds.length
    ? await tx.workItem.findMany({
        where: {
          ...(await scopeWhere(tx, ctx.actor, { clientField: "clientId", projectField: "projectId" })),
          tenantId: ctx.tenantId,
          id: { in: itemIds },
          deletedAt: null,
        },
        select: { id: true, number: true, title: true, projectId: true },
      })
    : [];
  const byItem = new Map(items.map((i) => [i.id, i]));

  for (const r of rows) {
    if (r.entityType === "WorkItem") {
      const item = byItem.get(r.entityId);
      // The project load gates the LINK: without a key there is no
      // address to send them to, so the row stays label-only.
      const project = item ? byProject.get(item.projectId) : undefined;
      if (item && project) {
        out.set(r.id, {
          title: item.title,
          href: `/projects/${project.key}/backlog?item=${project.key}-${item.number}`,
        });
      }
      continue;
    }
    // Everything else names its project — the only surface a non-item
    // notification can point at in 2W/2T. The NAME needs only
    // `project:view` and scope. The LINK is a budget alert's, to the Money
    // page, and needs that page's own codes too, or it would lead to a
    // refusal (C34). A row naming any other entity — a newer deploy's
    // included — is named and links nowhere rather than borrowing that
    // link.
    const project = r.projectId ? byProject.get(r.projectId) : undefined;
    if (project) {
      out.set(r.id, {
        title: project.name,
        href: r.entityType === BUDGET_ALERT_ENTITY && mayOpenMoney ? `/projects/${project.key}/money` : null,
      });
    }
  }
  return out;
}

/**
 * Shared shape of the per-row verbs: validate, then one `updateMany`
 * whose WHERE the RLS policy has already narrowed to this member. The
 * count is what the caller reports, and it never distinguishes "not
 * yours" from "not there".
 */
async function updateOwn(
  ctx: InboxCtx,
  ids: readonly string[],
  data: Record<string, unknown>,
  extraWhere: Record<string, unknown> = {},
): Promise<number> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) fail("INVALID_INPUT", "no notifications selected");
  if (unique.length > MAX_INBOX_IDS) fail("INVALID_INPUT", "too many notifications selected");
  return withTenant(ctx.tenantId, { type: "member", id: ctx.actor.memberId }, async (tx) => {
    const { count } = await tx.notification.updateMany({
      where: { ...receiverWhere(ctx), id: { in: unique }, ...extraWhere },
      data,
    });
    return count;
  });
}

export const markRead = (ctx: InboxCtx, ids: readonly string[]): Promise<number> =>
  updateOwn(ctx, ids, { readAt: new Date() }, { readAt: null });

export const markUnread = (ctx: InboxCtx, ids: readonly string[]): Promise<number> =>
  updateOwn(ctx, ids, { readAt: null }, { readAt: { not: null } });

/** Archiving also marks read: a row you have filed is one you have
 * seen, and leaving it in the unread count would make the badge lie. */
export const archive = (ctx: InboxCtx, ids: readonly string[]): Promise<number> => {
  const now = new Date();
  return updateOwn(ctx, ids, { archivedAt: now, readAt: now }, { archivedAt: null });
};

export const unarchive = (ctx: InboxCtx, ids: readonly string[]): Promise<number> =>
  updateOwn(ctx, ids, { archivedAt: null }, { archivedAt: { not: null } });

/**
 * Park a row until an absolute instant. The instant is computed by the
 * CLIENT and validated here rather than derived from a preset on the
 * server: "tomorrow morning" is a question about the member's own wall
 * clock, and `Member.timezone` is an optional field that is routinely
 * empty — a server-side preset would quietly snooze to the wrong
 * morning. The bounds keep a hostile or broken client from parking a
 * row past any horizon a person would ever look at.
 */
export async function snooze(ctx: InboxCtx, ids: readonly string[], till: Date): Promise<number> {
  const ms = till.getTime();
  if (!Number.isFinite(ms)) fail("INVALID_INPUT", "snooze needs a date");
  const now = Date.now();
  if (ms <= now) fail("INVALID_INPUT", "snooze must be in the future");
  if (ms > now + MAX_SNOOZE_MS) fail("INVALID_INPUT", "snooze is too far ahead");
  // A snooze un-reads the row: the point is to be told again later.
  return updateOwn(ctx, ids, { snoozedTill: till, readAt: null }, { archivedAt: null });
}

export const unsnooze = (ctx: InboxCtx, ids: readonly string[]): Promise<number> =>
  updateOwn(ctx, ids, { snoozedTill: null }, { snoozedTill: { not: null } });

/** "Mark all as read" — every row the Unread tab would show, including
 * the ones below the page the member is looking at. */
export async function markAllRead(ctx: InboxCtx): Promise<number> {
  return withTenant(ctx.tenantId, { type: "member", id: ctx.actor.memberId }, async (tx) => {
    const { count } = await tx.notification.updateMany({
      where: { ...receiverWhere(ctx), ...liveUnread(new Date()) },
      data: { readAt: new Date() },
    });
    return count;
  });
}

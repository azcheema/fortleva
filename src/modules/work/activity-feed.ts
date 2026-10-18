import { isAuthorized, scopeWhere } from "@/authz/authorize";
import { AuthzError } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { accessibleCodes, requireAccess } from "@/entitlements/resolver";
import { ACTIVITY_MAX_SKIP, ACTIVITY_PAGE_CAP, activityWindow, mergeNewestFirst, type ActivityParams } from "@/lib/activity-plan";
import { localDateString, startOfLocalDay } from "@/lib/duration";
import { addDays } from "@/lib/week";

import { principalOf, type WorkCtx } from "./states";

/**
 * WHAT HAPPENED, ACROSS PROJECTS — the Activity page's one read (slice 133;
 * founder decision C110 — docs/research/2026-10-18-slice-133-activity-design.md
 * §3.1, §4).
 *
 * WHO: `work_item:view` on all four gates and `project:view` (the Tasks
 * page's pair) — either refused → null, the page's forbidden state. Then
 * `document:view` and `project_update:view`, on all four gates, in one
 * `accessibleCodes` call: without the first no file events and no comments on
 * files; without the second no update events and no comments on updates.
 *
 * WHAT: work and client events (C110 (b)) — a task added or sent as a
 * request, a task finished, a client's person commenting, a file added or a
 * new version of one, a client deciding on a file, an update published, a
 * milestone reached, a version shipped, a client deciding on a version.
 * NOTHING per person beyond naming who did each (C110 (a)): no filter, no
 * count, no time.
 *
 * WHERE: every table's own `clientId`/`projectId` under `scopeWhere`,
 * composed with `AND` — never spread (the inbox's page-2 bug). The filters
 * are found among the projects in scope (not archived) and those projects'
 * clients, or are no filter at all — never an error.
 *
 * WHEN: one window of days in the READER's zone (`activityWindow`), at most
 * `ACTIVITY_PAGE_CAP` events, merged newest first. A page CUT at the cap goes
 * on inside its last day (`until` + `skip`: that day's events already
 * drawn). EARLIER otherwise: the newest event in the year before the window
 * names the next window's last day — empty weeks are skipped; an empty year
 * jumps a year back; past the workspace's creation the history has ended.
 *
 * Sequential reads on the one transaction (AGENTS.md's `Promise.all` trap).
 * Member plane only: no portal projection reads this. No audit: a read.
 */

export type FeedActor =
  | { readonly kind: "member"; readonly id: string; readonly name: string | null }
  | { readonly kind: "contact"; readonly id: string; readonly name: string | null; readonly clientName: string | null }
  | { readonly kind: "system" };

/** Where an event happened: its project (null for a client's or the workspace's own file) and its client (null for the workspace's). */
export type FeedPlace = {
  readonly projectKey: string | null;
  readonly projectName: string | null;
  readonly clientId: string | null;
  readonly clientName: string | null;
};

export type FeedTask = { readonly number: number; readonly title: string };

export type FeedSubject =
  | { readonly type: "task"; readonly task: FeedTask }
  | { readonly type: "file"; readonly name: string }
  | { readonly type: "update"; readonly updateId: string; readonly seq: number | null }
  | { readonly type: "version"; readonly version: string };

type EventBody =
  | { readonly kind: "task_added"; readonly task: FeedTask; readonly request: boolean }
  | { readonly kind: "task_done"; readonly task: FeedTask }
  | { readonly kind: "client_comment"; readonly on: FeedSubject; readonly excerpt: string }
  | { readonly kind: "file_added"; readonly file: string; readonly version: number }
  | { readonly kind: "file_decided"; readonly file: string; readonly approved: boolean }
  | { readonly kind: "update_published"; readonly updateId: string; readonly seq: number | null; readonly title: string | null; readonly shared: boolean }
  | { readonly kind: "milestone_done"; readonly milestone: string }
  | { readonly kind: "version_shipped"; readonly version: string }
  | { readonly kind: "version_decided"; readonly version: string; readonly approved: boolean };

export type FeedEvent = EventBody & {
  /** Unique across kinds: the kind and the row's id. */
  readonly id: string;
  readonly at: Date;
  readonly actor: FeedActor;
  readonly place: FeedPlace;
};

export type ActivityFeedRead = {
  readonly events: readonly FeedEvent[];
  readonly window: { readonly from: string; readonly to: string };
  /**
   * The next page back: its last day and the events of that day already
   * drawn (a page cut at the cap goes on inside its last day) — or null: the
   * history has ended.
   */
  readonly earlier: { readonly until: string; readonly skip: number } | null;
  /** The projects the filter offers — every one in scope and not archived, by name. */
  readonly projects: readonly { readonly key: string; readonly name: string }[];
  /** Those projects' clients, by name. */
  readonly clients: readonly { readonly id: string; readonly name: string }[];
  /** The filters as applied — a key or an id outside the lists above is no filter. `until` is null on today's window. */
  readonly applied: ActivityParams;
};

/** A comment's excerpt, as the page draws it. */
const EXCERPT_CHARS = 140;

/**
 * Documents that are no "file added": a data export is no work event, and a
 * REPORT is behind `report:view` and the reports module everywhere else (the
 * Files list leaves it out, search too) — named here, it reached a member
 * without either (both reviews' MEDIUM). Not on this page at all.
 */
const NOT_FILE_EVENTS = ["EXPORT", "REPORT"] as const;

/**
 * How many reads the task kind makes at most to replace the births it drops
 * — the case is a TEMPLATE, which writes up to `TEMPLATE_MAX_TASKS` (1 000)
 * births in one statement (an import writes them 100 at a time). A bound, not
 * a promise: past it a page may leave out some events of that stretch. Keep
 * `BIRTH_ROUNDS × (ACTIVITY_PAGE_CAP + 1)` (1 204) above the largest such
 * block — then the day the "earlier" probe names (it skips the birth rule)
 * always draws the births' `created` twins, never an empty page.
 */
const BIRTH_ROUNDS = 4;

/**
 * A Done row this close to its task's first `created` row is the task's
 * birth, not a finish: written by the same work (the same statement for an
 * import or a template; a few statements apart for `createItem` straight into
 * a Done column, which over a slow database link can be a second or two). A
 * person who makes a task and finishes it within five seconds gets its
 * "added" line only — the task is still there; that is the price.
 */
const BIRTH_WINDOW_MS = 5_000;

/** An event before naming: who and where as ids; subjects of comments as ids. */
type Raw = {
  readonly id: string;
  readonly at: Date;
  readonly actorMemberId: string | null;
  readonly actorContactId: string | null;
  readonly projectId: string | null;
  readonly clientId: string | null;
  readonly body: EventBody | { readonly kind: "comment_pending"; readonly subjectType: string; readonly subjectId: string; readonly excerpt: string };
};

type Range = { readonly gte?: Date; readonly lt: Date };
/**
 * One kind's events over a range, newest first, at most `take`. A PROBE (the
 * "earlier" check) asks only for the newest event's time, so the task kind
 * skips its birth rule there: a birth's `created` twin is within seconds of it,
 * the same day — and an import's batch of births read four rows at a time
 * would exhaust the rounds and hide the whole day (the re-check's MEDIUM).
 */
type Kind = (range: Range, take: number, probe?: boolean) => Promise<Raw[]>;

const excerptOf = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS - 1).trimEnd()}…` : flat;
};

export async function readActivityFeed(
  ctx: WorkCtx,
  opts: { readonly params: ActivityParams; readonly timeZone: string; readonly today: string },
): Promise<ActivityFeedRead | null> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    try {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "work_item:view");
    } catch (e) {
      if (e instanceof AuthzError) return null;
      throw e;
    }
    if (!(await isAuthorized(tx, ctx.actor, "project:view"))) return null;
    const codes = await accessibleCodes(tx, ctx.tenantId, ctx.actor, ["document:view", "project_update:view"]);
    const files = codes.has("document:view");
    const updates = codes.has("project_update:view");

    // ── the filters, found in scope ──
    const projectScope = await scopeWhere(tx, ctx.actor, { clientField: "clientId", projectField: "id" });
    const projects = await tx.project.findMany({
      where: { AND: [projectScope, { tenantId: ctx.tenantId, archivedAt: null }] },
      select: { id: true, key: true, name: true, clientId: true },
      orderBy: [{ name: "asc" }, { key: "asc" }],
    });
    const clientIds = [...new Set(projects.map((p) => p.clientId))];
    const clients = clientIds.length
      ? await tx.client.findMany({
          where: { tenantId: ctx.tenantId, id: { in: clientIds } },
          select: { id: true, name: true },
          orderBy: [{ name: "asc" }, { id: "asc" }],
        })
      : [];
    const project = opts.params.project === null ? null : (projects.find((p) => p.key === opts.params.project) ?? null);
    const client = opts.params.client === null ? null : (clients.find((c) => c.id === opts.params.client) ?? null);
    const filter = { ...(project ? { projectId: project.id } : {}), ...(client ? { clientId: client.id } : {}) };

    const scope = await scopeWhere(tx, ctx.actor, { clientField: "clientId", projectField: "projectId" });
    const kinds = eventKinds(tx, ctx.tenantId, scope, filter, { files, updates });

    // ── the window ──
    const window = activityWindow(opts.params.until, opts.today);
    const skip = opts.params.until !== null && window.to === opts.params.until ? opts.params.skip : 0;
    const from = startOfLocalDay(window.from, opts.timeZone);
    const to = startOfLocalDay(addDays(window.to, 1), opts.timeZone);
    const lists: Raw[][] = [];
    for (const kind of kinds) lists.push(await kind({ gte: from, lt: to }, ACTIVITY_PAGE_CAP + skip + 1));
    // The page before drew `skip` of this window's newest events (all on its
    // last day): those go, and the next `ACTIVITY_PAGE_CAP` are this page's.
    const merged = mergeNewestFirst(lists, ACTIVITY_PAGE_CAP + skip);
    const page = merged.events.slice(skip);

    let earlier: { readonly until: string; readonly skip: number } | null;
    const lastDrawn = page[page.length - 1];
    if (merged.truncated && lastDrawn) {
      // Cut at the cap: the next page goes on INSIDE the last drawn day, past
      // the events of it drawn so far — nothing is out of reach (L1).
      const day = localDateString(lastDrawn.at, opts.timeZone);
      const drawnThatDay = page.filter((e) => localDateString(e.at, opts.timeZone) === day).length;
      const next = (day === window.to ? skip : 0) + drawnThatDay;
      // Past the ceiling (an import of thousands at once): the day before.
      earlier = next <= ACTIVITY_MAX_SKIP ? { until: day, skip: next } : { until: addDays(day, -1), skip: 0 };
    } else {
      earlier = await earlierThan(tx, ctx.tenantId, kinds, from, opts.timeZone);
    }

    const events = await nameEvents(tx, ctx.tenantId, page);
    return {
      events,
      window,
      earlier,
      projects: projects.map((p) => ({ key: p.key, name: p.name })),
      clients,
      applied: {
        project: project?.key ?? null,
        client: client?.id ?? null,
        // Today's window is "no until" — unless it goes on inside today (a cut
        // page), which keeps its place (and Back to today) in the links.
        until: window.to === opts.today && skip === 0 ? null : window.to,
        skip,
      },
    };
  });
}

/** How far back one "earlier" probe looks (the reviews' LOW: unbounded, it walked the whole history on every load). */
const PROBE_DAYS = 365;

/**
 * The next window back: the day of the newest event before `from` within a
 * year — or, when that year is empty but the workspace is older, the day a
 * year back (the next page probes the year before it). Null when the year
 * reaches back past the workspace's own creation: the history has ended.
 */
async function earlierThan(
  tx: TenantDb,
  tenantId: string,
  kinds: readonly Kind[],
  from: Date,
  timeZone: string,
): Promise<{ readonly until: string; readonly skip: number } | null> {
  const floor = new Date(from.getTime() - PROBE_DAYS * 86_400_000);
  let newest: Date | null = null;
  for (const kind of kinds) {
    const [one] = await kind({ gte: floor, lt: from }, 1, true);
    if (one && (newest === null || one.at > newest)) newest = one.at;
  }
  if (newest) return { until: localDateString(newest, timeZone), skip: 0 };
  const tenant = await tx.tenant.findFirst({ where: { id: tenantId }, select: { createdAt: true } });
  if (!tenant || tenant.createdAt >= floor) return null;
  return { until: localDateString(new Date(floor.getTime() - 1), timeZone), skip: 0 };
}

type Scope = Awaited<ReturnType<typeof scopeWhere>>;
type Filter = { readonly projectId?: string; readonly clientId?: string };
const NEWEST = [{ createdAt: "desc" as const }, { id: "desc" as const }];

/** One query per kind of event (design §3.1), each over a time range, newest first. */
function eventKinds(tx: TenantDb, tenantId: string, scope: Scope, filter: Filter, can: { files: boolean; updates: boolean }): Kind[] {
  const kinds: Kind[] = [];

  // A task added, and a task finished (into Done from outside it — a move
  // WITHIN Done writes a row too). A task in the bin takes its events with it.
  // A BIRTH into Done — an import's, a template's, a task made straight in a
  // Done column — writes its state row with the task's own `created` row (an
  // import and a template in the very same statement, `createItem` a few
  // statements after — `BIRTH_WINDOW_MS`): that is "added", never "finished" (the code
  // review's L2). The task row's own `createdAt` is no measure — an import
  // makes its rows seconds before it writes their history. Dropped here, and
  // read on (by offset, in the same order) until `take` real rows are in
  // hand, so the merge's cap stays exact.
  kinds.push(async (range, take, probe) => {
    const out: Raw[] = [];
    const seen = new Set<string>();
    let offset = 0;
    for (let round = 0; round < BIRTH_ROUNDS && out.length < take; round++) {
      const rows = await tx.workItemActivity.findMany({
        where: {
          AND: [
            scope,
            filter,
            {
              tenantId,
              createdAt: range,
              workItem: { deletedAt: null },
              OR: [{ field: "created" }, { field: "stateCategory", newValue: "DONE", NOT: { oldValue: "DONE" } }],
            },
          ],
        },
        select: {
          id: true,
          createdAt: true,
          field: true,
          actorMemberId: true,
          actorContactId: true,
          projectId: true,
          clientId: true,
          workItemId: true,
          workItem: { select: { number: true, title: true } },
        },
        orderBy: NEWEST,
        skip: offset,
        take,
      });
      offset += rows.length;
      // Each finished task's FIRST `created` row — its birth.
      const doneIds = probe ? [] : [...new Set(rows.filter((r) => r.field !== "created").map((r) => r.workItemId))];
      const born = new Map<string, number>();
      if (doneIds.length > 0) {
        const births = await tx.workItemActivity.groupBy({
          by: ["workItemId"],
          where: { tenantId, workItemId: { in: doneIds }, field: "created" },
          _min: { createdAt: true },
        });
        for (const b of births) if (b._min.createdAt) born.set(b.workItemId, b._min.createdAt.getTime());
      }
      for (const r of rows) {
        // An event committed between two rounds shifts the offset: a row may come twice.
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        const birth = born.get(r.workItemId);
        if (!probe && r.field !== "created" && birth !== undefined && Math.abs(r.createdAt.getTime() - birth) <= BIRTH_WINDOW_MS) continue;
        const task = { number: r.workItem.number, title: r.workItem.title };
        out.push({
          id: `${r.field === "created" ? "task_added" : "task_done"}:${r.id}`,
          at: r.createdAt,
          actorMemberId: r.actorMemberId,
          actorContactId: r.actorContactId,
          projectId: r.projectId,
          clientId: r.clientId,
          body: r.field === "created" ? { kind: "task_added", task, request: r.actorContactId !== null } : { kind: "task_done", task },
        });
      }
      if (rows.length < take) break;
    }
    return out.slice(0, take);
  });

  // A client's person commenting — on what this reader may open.
  const subjects: ("WORK_ITEM" | "PROJECT_VERSION" | "DOCUMENT" | "FILE_VERSION" | "PROJECT_UPDATE")[] = [
    "WORK_ITEM",
    "PROJECT_VERSION",
    ...(can.files ? (["DOCUMENT", "FILE_VERSION"] as const) : []),
    ...(can.updates ? (["PROJECT_UPDATE"] as const) : []),
  ];
  kinds.push(async (range, take) => {
    const rows = await tx.comment.findMany({
      where: { AND: [scope, filter, { tenantId, createdAt: range, deletedAt: null, authorContactId: { not: null }, subjectType: { in: subjects } }] },
      select: { id: true, createdAt: true, authorContactId: true, subjectType: true, subjectId: true, bodyText: true, projectId: true, clientId: true },
      orderBy: NEWEST,
      take,
    });
    return rows.map((r) => ({
      id: `client_comment:${r.id}`,
      at: r.createdAt,
      actorMemberId: null,
      actorContactId: r.authorContactId,
      projectId: r.projectId,
      clientId: r.clientId,
      body: { kind: "comment_pending", subjectType: r.subjectType, subjectId: r.subjectId, excerpt: excerptOf(r.bodyText) },
    }));
  });

  if (can.files) {
    // A file added (a data export is no work event), and each later version of one.
    kinds.push(async (range, take) => {
      const rows = await tx.document.findMany({
        where: { AND: [scope, filter, { tenantId, createdAt: range, deletedAt: null, kind: { notIn: [...NOT_FILE_EVENTS] } }] },
        select: { id: true, createdAt: true, name: true, createdByMemberId: true, createdByContactId: true, projectId: true, clientId: true },
        orderBy: NEWEST,
        take,
      });
      return rows.map((r) => ({
        id: `file_added:${r.id}`,
        at: r.createdAt,
        actorMemberId: r.createdByMemberId,
        actorContactId: r.createdByContactId,
        projectId: r.projectId,
        clientId: r.clientId,
        body: { kind: "file_added", file: r.name, version: 1 },
      }));
    });
    kinds.push(async (range, take) => {
      const rows = await tx.fileVersion.findMany({
        where: {
          tenantId,
          createdAt: range,
          versionNumber: { gt: 1 },
          document: { AND: [scope, filter, { deletedAt: null, kind: { notIn: [...NOT_FILE_EVENTS] } }] },
        },
        select: {
          id: true,
          createdAt: true,
          versionNumber: true,
          uploadedByMemberId: true,
          uploadedByContactId: true,
          document: { select: { name: true, projectId: true, clientId: true } },
        },
        orderBy: NEWEST,
        take,
      });
      return rows.map((r) => ({
        id: `file_version:${r.id}`,
        at: r.createdAt,
        actorMemberId: r.uploadedByMemberId,
        actorContactId: r.uploadedByContactId,
        projectId: r.document.projectId,
        clientId: r.document.clientId,
        body: { kind: "file_added", file: r.document.name, version: r.versionNumber },
      }));
    });
    // A client's person approving a file, or sending it back.
    kinds.push(async (range, take) => {
      const rows = await tx.document.findMany({
        where: {
          AND: [
            scope,
            filter,
            { tenantId, deletedAt: null, approvalDecidedAt: range, approvalStatus: { in: ["APPROVED", "CHANGES_REQUESTED"] }, approvalByContactId: { not: null } },
          ],
        },
        select: { id: true, approvalDecidedAt: true, approvalStatus: true, approvalByContactId: true, name: true, projectId: true, clientId: true },
        orderBy: [{ approvalDecidedAt: "desc" }, { id: "desc" }],
        take,
      });
      return rows.map((r) => ({
        id: `file_decided:${r.id}`,
        at: r.approvalDecidedAt!,
        actorMemberId: null,
        actorContactId: r.approvalByContactId,
        projectId: r.projectId,
        clientId: r.clientId,
        body: { kind: "file_decided", file: r.name, approved: r.approvalStatus === "APPROVED" },
      }));
    });
  }

  if (can.updates) {
    // An update published — and still published, or archived since.
    kinds.push(async (range, take) => {
      const rows = await tx.projectUpdate.findMany({
        where: { AND: [scope, filter, { tenantId, publishedAt: range, status: { in: ["PUBLISHED", "ARCHIVED"] } }] },
        select: { id: true, publishedAt: true, publishedByMemberId: true, seq: true, title: true, visibility: true, projectId: true, clientId: true },
        orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
        take,
      });
      return rows.map((r) => ({
        id: `update_published:${r.id}`,
        at: r.publishedAt!,
        actorMemberId: r.publishedByMemberId,
        actorContactId: null,
        projectId: r.projectId,
        clientId: r.clientId,
        body: { kind: "update_published", updateId: r.id, seq: r.seq, title: r.title, shared: r.visibility === "CLIENT_VISIBLE" },
      }));
    });
  }

  // A milestone reached and a version shipped carry no one's name (neither
  // row records who); a client's decision on a version names the person.
  kinds.push(async (range, take) => {
    const rows = await tx.milestone.findMany({
      where: { AND: [scope, filter, { tenantId, status: "DONE", completedAt: range }] },
      select: { id: true, completedAt: true, name: true, projectId: true, clientId: true },
      orderBy: [{ completedAt: "desc" }, { id: "desc" }],
      take,
    });
    return rows.map((r) => ({
      id: `milestone_done:${r.id}`,
      at: r.completedAt!,
      actorMemberId: null,
      actorContactId: null,
      projectId: r.projectId,
      clientId: r.clientId,
      body: { kind: "milestone_done", milestone: r.name },
    }));
  });
  kinds.push(async (range, take) => {
    const rows = await tx.projectVersion.findMany({
      where: { AND: [scope, filter, { tenantId, status: "SHIPPED", shippedAt: range }] },
      select: { id: true, shippedAt: true, version: true, projectId: true, clientId: true },
      orderBy: [{ shippedAt: "desc" }, { id: "desc" }],
      take,
    });
    return rows.map((r) => ({
      id: `version_shipped:${r.id}`,
      at: r.shippedAt!,
      actorMemberId: null,
      actorContactId: null,
      projectId: r.projectId,
      clientId: r.clientId,
      body: { kind: "version_shipped", version: r.version },
    }));
  });
  kinds.push(async (range, take) => {
    const rows = await tx.projectVersion.findMany({
      where: {
        AND: [
          scope,
          filter,
          { tenantId, approvalDecidedAt: range, approvalStatus: { in: ["APPROVED", "CHANGES_REQUESTED"] }, approvalByContactId: { not: null } },
        ],
      },
      select: { id: true, approvalDecidedAt: true, approvalStatus: true, approvalByContactId: true, version: true, projectId: true, clientId: true },
      orderBy: [{ approvalDecidedAt: "desc" }, { id: "desc" }],
      take,
    });
    return rows.map((r) => ({
      id: `version_decided:${r.id}`,
      at: r.approvalDecidedAt!,
      actorMemberId: null,
      actorContactId: r.approvalByContactId,
      projectId: r.projectId,
      clientId: r.clientId,
      body: { kind: "version_decided", version: r.version, approved: r.approvalStatus === "APPROVED" },
    }));
  });

  return kinds;
}

/**
 * The drawn events, named: places, people, and what each client comment was
 * on. A comment whose subject is gone since (a task in the bin, a file
 * deleted) is left out — there is nothing to open. In sequence, a handful of
 * batched reads.
 */
async function nameEvents(tx: TenantDb, tenantId: string, raws: readonly Raw[]): Promise<FeedEvent[]> {
  const ids = (pick: (r: Raw) => string | null) => [...new Set(raws.map(pick).filter((x): x is string => x !== null))];

  const projectRows = await tx.project.findMany({ where: { tenantId, id: { in: ids((r) => r.projectId) } }, select: { id: true, key: true, name: true } });
  const projectsById = new Map(projectRows.map((p) => [p.id, p]));

  const memberRows = await tx.member.findMany({
    where: { tenantId, id: { in: ids((r) => r.actorMemberId) } },
    select: { id: true, user: { select: { name: true } } },
  });
  const memberNames = new Map(memberRows.map((m) => [m.id, m.user.name]));

  const contactRows = await tx.contact.findMany({
    where: { tenantId, id: { in: ids((r) => r.actorContactId) } },
    select: { id: true, name: true, clientId: true },
  });
  const contactsById = new Map(contactRows.map((c) => [c.id, c]));

  const clientRows = await tx.client.findMany({
    where: { tenantId, id: { in: ids((r) => r.clientId) } },
    select: { id: true, name: true },
  });
  const clientNames = new Map(clientRows.map((c) => [c.id, c.name]));

  // What the client comments were on, by kind of subject.
  const pending = raws.flatMap((r) => (r.body.kind === "comment_pending" ? [r.body] : []));
  const subjectIds = (type: string) => [...new Set(pending.filter((p) => p.subjectType === type).map((p) => p.subjectId))];
  const tasks = new Map(
    (
      await tx.workItem.findMany({
        where: { tenantId, id: { in: subjectIds("WORK_ITEM") }, deletedAt: null },
        select: { id: true, number: true, title: true },
      })
    ).map((w) => [w.id, { number: w.number, title: w.title }]),
  );
  const documents = new Map(
    (
      await tx.document.findMany({
        where: { tenantId, id: { in: subjectIds("DOCUMENT") }, deletedAt: null, kind: { notIn: [...NOT_FILE_EVENTS] } },
        select: { id: true, name: true },
      })
    ).map((d) => [d.id, d.name]),
  );
  const versionsOfFiles = new Map(
    (
      await tx.fileVersion.findMany({
        where: { tenantId, id: { in: subjectIds("FILE_VERSION") }, document: { deletedAt: null, kind: { notIn: [...NOT_FILE_EVENTS] } } },
        select: { id: true, document: { select: { name: true } } },
      })
    ).map((v) => [v.id, v.document.name]),
  );
  const updateRows = new Map(
    (
      await tx.projectUpdate.findMany({
        where: { tenantId, id: { in: subjectIds("PROJECT_UPDATE") }, status: { in: ["PUBLISHED", "ARCHIVED"] } },
        select: { id: true, seq: true },
      })
    ).map((u) => [u.id, u.seq]),
  );
  const versionRows = new Map(
    (
      await tx.projectVersion.findMany({
        where: { tenantId, id: { in: subjectIds("PROJECT_VERSION") } },
        select: { id: true, version: true },
      })
    ).map((v) => [v.id, v.version]),
  );
  const subjectOf = (type: string, id: string): FeedSubject | null => {
    if (type === "WORK_ITEM") {
      const task = tasks.get(id);
      return task ? { type: "task", task } : null;
    }
    if (type === "DOCUMENT" || type === "FILE_VERSION") {
      const name = type === "DOCUMENT" ? documents.get(id) : versionsOfFiles.get(id);
      return name !== undefined ? { type: "file", name } : null;
    }
    if (type === "PROJECT_UPDATE") return updateRows.has(id) ? { type: "update", updateId: id, seq: updateRows.get(id) ?? null } : null;
    if (type === "PROJECT_VERSION") {
      const version = versionRows.get(id);
      return version !== undefined ? { type: "version", version } : null;
    }
    return null;
  };

  const out: FeedEvent[] = [];
  for (const r of raws) {
    let body: EventBody;
    if (r.body.kind === "comment_pending") {
      const on = subjectOf(r.body.subjectType, r.body.subjectId);
      if (!on) continue;
      body = { kind: "client_comment", on, excerpt: r.body.excerpt };
    } else {
      body = r.body;
    }
    const projectRow = r.projectId ? projectsById.get(r.projectId) : undefined;
    // A client's person is named only within the event's OWN client (the
    // panel's `resolveActorNames` rule, the code review's L3): an id
    // attributed wrongly never names another client's person.
    const found = r.actorContactId ? contactsById.get(r.actorContactId) : undefined;
    const contact = found && found.clientId === r.clientId ? found : undefined;
    const actor: FeedActor = r.actorMemberId
      ? { kind: "member", id: r.actorMemberId, name: memberNames.get(r.actorMemberId) ?? null }
      : r.actorContactId
        ? { kind: "contact", id: r.actorContactId, name: contact?.name ?? null, clientName: contact ? (clientNames.get(contact.clientId) ?? null) : null }
        : { kind: "system" };
    out.push({
      ...body,
      id: r.id,
      at: r.at,
      actor,
      place: {
        projectKey: projectRow?.key ?? null,
        projectName: projectRow?.name ?? null,
        clientId: r.clientId,
        clientName: r.clientId ? (clientNames.get(r.clientId) ?? null) : null,
      },
    });
  }
  return out;
}

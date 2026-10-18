import { record } from "@/audit/record";
import { assertInScope } from "@/authz/authorize";
import { deny } from "@/authz/errors";
import { nextCounter, withTenant, type TenantDb } from "@/db";
import { accessibleCodes, requireAccess } from "@/entitlements/resolver";
import type { ProjectHealth } from "@/generated/prisma/enums";
import { fail } from "@/lib/domain-error";
import { todayIn } from "@/lib/due-date";
import { dateColumn, isoDateOf, localDateString, localHourInstant } from "@/lib/duration";
import { addDays } from "@/lib/week";
import { MAX_TITLE_LENGTH } from "@/lib/work-view/model";
import { revealCostRates } from "@/modules/time/rates";
import { loadProjectEntries, type EntryRow } from "@/modules/time/rollup";
import { isTimezone } from "@/preferences/config";
import { readPreferences } from "@/preferences/service";

import { guarded } from "./db-errors";
import { principalOf, type WorkCtx } from "./states";
import {
  UPDATE_EDIT_NOTE_MAX,
  UPDATE_RETRACT_WINDOW_MS,
  UPDATE_SCHEDULE_MAX_DAYS,
  UPDATE_TITLE_MAX,
  normalizeUpdateBody,
  readUpdateBody,
  type UpdateBody,
} from "./update-body";
import type { UpdateLayout } from "./update-layout";
import {
  changeIdsOf,
  computeInternalSnapshot,
  computePortalSnapshot,
  metricsWindowFor,
  readChanges,
  redactHoursFor,
  type ChangesSinceLast,
  type HoursAccess,
  type InternalSnapshot,
  type PortalSnapshot,
} from "./update-metrics";
import { resolveUpdateLayout } from "./update-templates";

/**
 * PROGRESS UPDATES — the portal centrepiece (DATA_MODEL.md §6.16, PLAN
 * Phase 3). Draft → publish → (archive | annotate | hide) with one
 * fifteen-minute exception, every verb `requireAccess → assertInScope →
 * mutate → record` in one transaction, and the rule that makes the
 * whole feature safe to put in front of a client stated once:
 *
 *   PUBLISH IS THE ONLY MOMENT NUMBERS ARE COMPUTED, and it computes
 *   them into TWO rows — the portal-safe aggregates onto the class-B
 *   post, everything per-member or cost-shaped onto its class-A twin
 *   (`update-metrics.ts` is where the split lives; `portal_deny` is
 *   what makes it hold).
 *
 * WHO MAY DO WHAT (AUTHZ.md §3.1): `project_update:view` (everyone in
 * scope) reads posts and drafts; `project_update:create` (C M E)
 * drafts and edits drafts — any draft of the project, because a draft
 * is the team's, not the author's; `project_update:publish` (C M)
 * publishes, archives, retracts and annotates, because each of those
 * changes what a CLIENT reads and the catalog reserves that for a
 * delivery lead; `project_update:change_visibility` (C M A) flips the
 * audience of a published post. The internal snapshot is not one
 * thing: each of its parts is gated on READ by the code that gates its
 * live source, so a member who cannot open the Money page cannot read
 * last month's margin off a status post either.
 *
 * NOTHING HERE WRITES A `WorkItemActivity` ROW OR NOTIFIES. An update is
 * not a task, and the notification kinds for it (a client digest is
 * Phase 5) do not exist yet — recorded in PLAN §0 rather than faked.
 */

export type UpdateStatus = "DRAFT" | "PUBLISHED" | "ARCHIVED";
export type UpdateVisibility = "INTERNAL" | "CLIENT_VISIBLE";
export type { ProjectHealth };

export type UpdateDraftInput = {
  readonly health: ProjectHealth;
  readonly title: string | null;
  /** ISO dates, or null. */
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  /** Whatever the composer sent — normalised here, refused here. */
  readonly body: unknown;
};

export type UpdateListEntry = {
  readonly id: string;
  readonly seq: number | null;
  readonly health: ProjectHealth;
  readonly title: string | null;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly status: UpdateStatus;
  readonly visibility: UpdateVisibility;
  readonly publishedAt: Date | null;
  readonly authorName: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** The first line or so of the post, for a list row. */
  readonly excerpt: string | null;
  /**
   * A DRAFT scheduled to publish (slice 135, C112): the hour, the audience
   * chosen, and who scheduled it — null for every other post.
   */
  readonly scheduled: UpdateSchedule | null;
};

export type UpdateSchedule = {
  readonly at: Date;
  readonly visibility: UpdateVisibility;
  readonly byName: string | null;
};

export type UpdateCaps = {
  readonly create: boolean;
  readonly publish: boolean;
  readonly changeVisibility: boolean;
};

export type UpdateList = {
  readonly updates: readonly UpdateListEntry[];
  /** The newest PUBLISHED post, whatever its visibility — the one the tab pins. */
  readonly latest: UpdateListEntry | null;
  readonly caps: UpdateCaps;
};

/** The staff-only twin, each part already gated for THIS reader. */
export type InternalView = {
  readonly byMember: InternalSnapshot["byMember"];
  readonly cost: InternalSnapshot["cost"];
  readonly budget: InternalSnapshot["budget"];
  readonly computedAt: Date;
};

export type UpdateDetail = UpdateListEntry & {
  readonly projectId: string;
  readonly body: UpdateBody;
  readonly bodyText: string | null;
  readonly metrics: PortalSnapshot | null;
  readonly internal: InternalView | null;
  readonly editNote: string | null;
  readonly publishedByName: string | null;
  /** Whether "Retract" is still open — the fifteen-minute clock, read at the same instant as the row. */
  readonly retractUntil: Date | null;
  readonly caps: UpdateCaps;
};

export type UpdatePublished = {
  readonly id: string;
  readonly seq: number;
  readonly visibility: UpdateVisibility;
  /** The project's switch at the moment of publishing — what the toast says. */
  readonly portalEnabled: boolean;
};

const listSelect = {
  id: true,
  seq: true,
  health: true,
  title: true,
  periodStart: true,
  periodEnd: true,
  status: true,
  visibility: true,
  publishedAt: true,
  authorMemberId: true,
  bodyText: true,
  createdAt: true,
  updatedAt: true,
  scheduledFor: true,
  scheduledVisibility: true,
  scheduledByMemberId: true,
} as const;

type ListRow = {
  id: string;
  seq: number | null;
  health: ProjectHealth;
  title: string | null;
  periodStart: Date | null;
  periodEnd: Date | null;
  status: UpdateStatus;
  visibility: UpdateVisibility;
  publishedAt: Date | null;
  authorMemberId: string;
  bodyText: string | null;
  createdAt: Date;
  updatedAt: Date;
  scheduledFor: Date | null;
  scheduledVisibility: UpdateVisibility | null;
  scheduledByMemberId: string | null;
};

/** Every member id a list row names — its author, and who scheduled it. */
const namedIds = (r: ListRow): string[] =>
  r.scheduledByMemberId ? [r.authorMemberId, r.scheduledByMemberId] : [r.authorMemberId];

const EXCERPT_CHARS = 200;

const excerptOf = (text: string | null): string | null => {
  if (!text) return null;
  const line = text.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
  if (line.length === 0) return null;
  return line.length > EXCERPT_CHARS ? `${line.slice(0, EXCERPT_CHARS - 1)}…` : line;
};

const toEntry = (r: ListRow, names: ReadonlyMap<string, string>): UpdateListEntry => ({
  id: r.id,
  seq: r.seq,
  health: r.health,
  title: r.title,
  periodStart: r.periodStart ? isoDateOf(r.periodStart) : null,
  periodEnd: r.periodEnd ? isoDateOf(r.periodEnd) : null,
  status: r.status,
  visibility: r.visibility,
  publishedAt: r.publishedAt,
  authorName: names.get(r.authorMemberId) ?? null,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  excerpt: excerptOf(r.bodyText),
  scheduled:
    r.scheduledFor && r.scheduledVisibility
      ? {
          at: r.scheduledFor,
          visibility: r.scheduledVisibility,
          byName: r.scheduledByMemberId ? (names.get(r.scheduledByMemberId) ?? null) : null,
        }
      : null,
});

/** Member display names for attribution columns that carry no FK. */
async function memberNames(tx: TenantDb, tenantId: string, ids: readonly string[]): Promise<Map<string, string>> {
  const distinct = [...new Set(ids)];
  if (distinct.length === 0) return new Map();
  const rows = await tx.member.findMany({
    where: { tenantId, id: { in: distinct } },
    select: { id: true, user: { select: { name: true } } },
  });
  return new Map(rows.map((m) => [m.id, m.user.name]));
}

const CAP_CODES = ["project_update:create", "project_update:publish", "project_update:change_visibility"] as const;
/** The codes that gate the hours block and the internal twin — the figures' LIVE sources. */
const FIGURE_CODES = ["time:view_team", "budget:view", "rate:view_bill", "rate:view_cost"] as const;

/**
 * ONE permission resolution per read for every control and every figure
 * a surface gates — never several `isAuthorized` legs (AGENTS.md;
 * `authz-batches.test.ts`). ALL FOUR GATES (`accessibleCodes`), not the
 * permission alone: the figures' live surfaces — the Time tab, the
 * budget card, the Money page — go through `requireAccess`, so a tenant
 * that switched `time` off must find the frozen figures gone here too,
 * or a post would widen what a member could read live (the fix-pass
 * review). The answer for a ✦ code is `isAuthorized`'s: a stale factor
 * excludes it, so a page render never turns into a step-up.
 */
const heldCodes = (tx: TenantDb, ctx: WorkCtx) =>
  accessibleCodes(tx, ctx.tenantId, ctx.actor, [...CAP_CODES, ...FIGURE_CODES]);

const capsOf = (held: ReadonlySet<string>): UpdateCaps => ({
  create: held.has("project_update:create"),
  publish: held.has("project_update:publish"),
  changeVisibility: held.has("project_update:change_visibility"),
});

const hoursAccessOf = (held: ReadonlySet<string>): HoursAccess => ({
  team: held.has("time:view_team"),
  budget: held.has("budget:view"),
  bill: held.has("rate:view_bill"),
});

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const cleanTitle = (title: string | null): string | null => {
  if (title === null) return null;
  const t = title.trim();
  if (t.length === 0) return null;
  if (t.length > UPDATE_TITLE_MAX || /[\t\r\n]/.test(t)) fail("INVALID_INPUT", "title");
  return t;
};

const cleanDate = (v: string | null, what: string): string | null => {
  if (v === null) return null;
  if (!ISO_DATE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) fail("INVALID_INPUT", what);
  return v;
};

/** The draft's columns from the composer's input — one place, both writers. */
function draftColumns(input: UpdateDraftInput) {
  const periodStart = cleanDate(input.periodStart, "periodStart");
  const periodEnd = cleanDate(input.periodEnd, "periodEnd");
  if (periodStart && periodEnd && periodEnd < periodStart) fail("INVALID_INPUT", "period order");
  const normalized = normalizeUpdateBody(input.body);
  return {
    health: input.health,
    title: cleanTitle(input.title),
    periodStart: periodStart ? dateColumn(periodStart) : null,
    periodEnd: periodEnd ? dateColumn(periodEnd) : null,
    body: normalized.body as object,
    bodyText: normalized.text,
  };
}

export type ProjectRow = {
  id: string;
  key: string;
  clientId: string;
  portalEnabled: boolean;
  hoursSharingMode: "NONE" | "HOURS" | "BILLABLE_AMOUNT";
  billingCurrency: string | null;
  archivedAt: Date | null;
  createdAt: Date;
  portalShowTasks: boolean;
  portalShowMilestones: boolean;
  /** The layout a new update opens with (slice 105); null = the workspace's default. */
  updateTemplateId: string | null;
};

export const projectSelect = {
  id: true,
  key: true,
  clientId: true,
  portalEnabled: true,
  hoursSharingMode: true,
  billingCurrency: true,
  archivedAt: true,
  createdAt: true,
  // The portal's sections (C47) — what a new update's pre-fill may name (slice 102).
  portalShowTasks: true,
  portalShowMilestones: true,
  updateTemplateId: true,
} as const;

async function loadProject(tx: TenantDb, ctx: WorkCtx, projectId: string): Promise<ProjectRow> {
  const project = await tx.project.findFirst({ where: { tenantId: ctx.tenantId, id: projectId }, select: projectSelect });
  if (!project) deny("NOT_FOUND");
  await assertInScope(tx, ctx.actor, { projectId });
  return project!;
}

type UpdateRow = {
  id: string;
  projectId: string;
  clientId: string;
  status: UpdateStatus;
  visibility: UpdateVisibility;
  publishedAt: Date | null;
  seq: number | null;
  updatedAt: Date;
  /** Set while a draft waits to be published by the job — and then it is LOCKED (C112 (a)). */
  scheduledFor: Date | null;
};

/** The update, in scope, with its status — every verb starts here. */
async function loadUpdate(tx: TenantDb, ctx: WorkCtx, id: string): Promise<UpdateRow> {
  const row = await tx.projectUpdate.findFirst({
    where: { tenantId: ctx.tenantId, id },
    select: {
      id: true,
      projectId: true,
      clientId: true,
      status: true,
      visibility: true,
      publishedAt: true,
      seq: true,
      updatedAt: true,
      scheduledFor: true,
    },
  });
  if (!row) deny("NOT_FOUND");
  await assertInScope(tx, ctx.actor, { projectId: row!.projectId });
  return row!;
}

/**
 * The newest PUBLISHED post of a project — what the window rule and the
 * composer's default health read. PUBLISHED, not "not a draft": an
 * archived post was taken back, so the next post's window starts where
 * the last post the client can still see ended, and the header chip
 * (`latestPublishedHealth`) and this agree on which post that is.
 */
async function previousPublished(
  tx: TenantDb,
  tenantId: string,
  projectId: string,
  excludeId?: string,
): Promise<{ periodEnd: string | null; publishedAt: Date; health: ProjectHealth } | null> {
  const prev = await tx.projectUpdate.findFirst({
    where: { tenantId, projectId, status: "PUBLISHED", ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { periodEnd: true, publishedAt: true, health: true },
    orderBy: [{ publishedAt: "desc" }, { seq: "desc" }],
  });
  if (!prev?.publishedAt) return null;
  return { periodEnd: prev.periodEnd ? isoDateOf(prev.periodEnd) : null, publishedAt: prev.publishedAt, health: prev.health };
}

// ── Reads ────────────────────────────────────────────────────────────

/** project_update:view — every post of a project, newest first; drafts included. */
export async function listUpdates(ctx: WorkCtx, projectId: string): Promise<UpdateList> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "project_update:view");
    await loadProject(tx, ctx, projectId);
    const rows = await tx.projectUpdate.findMany({
      where: { tenantId: ctx.tenantId, projectId },
      select: listSelect,
      // Drafts first (they have no publishedAt), then newest published.
      orderBy: [{ publishedAt: { sort: "desc", nulls: "first" } }, { createdAt: "desc" }],
      take: 200,
    });
    const names = await memberNames(tx, ctx.tenantId, rows.flatMap(namedIds));
    const updates = rows.map((r) => toEntry(r, names));
    const latest = updates.find((u) => u.status === "PUBLISHED") ?? null;
    const caps = capsOf(await heldCodes(tx, ctx));
    return { updates, latest, caps };
  });
}

/**
 * project_update:view — one post with its body, its frozen portal
 * metrics and as much of the internal snapshot as THIS reader may see.
 */
export async function getUpdate(ctx: WorkCtx, id: string): Promise<UpdateDetail> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "project_update:view");
    const head = await loadUpdate(tx, ctx, id);
    const row = await tx.projectUpdate.findFirstOrThrow({
      where: { tenantId: ctx.tenantId, id: head.id },
      select: {
        ...listSelect,
        projectId: true,
        body: true,
        portalSnapshot: true,
        editNote: true,
        publishedByMemberId: true,
        internalSnapshot: { select: { byMember: true, cost: true, budget: true, computedAt: true } },
      },
    });
    const names = await memberNames(
      tx,
      ctx.tenantId,
      [...namedIds(row), row.publishedByMemberId].filter((x): x is string => x !== null),
    );
    const held = await heldCodes(tx, ctx);
    const caps = capsOf(held);
    const access = hoursAccessOf(held);

    // BOTH halves are read as THIS member may read them. The class-A twin
    // in parts, and the class-B snapshot's hours block through the same
    // codes (security review, slice 67): the row stays complete for the
    // client it was shared with; a member reads off it only what the
    // Time tab, the budget card and the Money page would show them live.
    let internal: InternalView | null = null;
    if (row.internalSnapshot) {
      const snap = row.internalSnapshot;
      const budget = access.budget ? (snap.budget as InternalSnapshot["budget"]) : null;
      internal = {
        byMember: access.team ? (snap.byMember as InternalSnapshot["byMember"]) : null,
        cost: held.has("rate:view_cost") ? (snap.cost as InternalSnapshot["cost"]) : null,
        budget: budget && !access.bill && budget.kind === "MONEY" ? { ...budget, usedAmount: null } : budget,
        computedAt: snap.computedAt,
      };
    }
    const frozen = (row.portalSnapshot as PortalSnapshot | null) ?? null;

    const now = new Date();
    const retractUntil =
      row.status === "PUBLISHED" && row.publishedAt ? new Date(row.publishedAt.getTime() + UPDATE_RETRACT_WINDOW_MS) : null;
    return {
      ...toEntry(row, names),
      projectId: row.projectId,
      body: readUpdateBody(row.body),
      bodyText: row.bodyText,
      metrics: frozen ? redactHoursFor(frozen, access) : null,
      internal,
      editNote: row.editNote,
      publishedByName: row.publishedByMemberId ? (names.get(row.publishedByMemberId) ?? null) : null,
      retractUntil: retractUntil && retractUntil.getTime() > now.getTime() ? retractUntil : null,
      caps,
    };
  });
}

/** The health of a project's newest published post, or null — the header chip. */
export async function latestPublishedHealth(
  tx: TenantDb,
  tenantId: string,
  projectId: string,
): Promise<{ health: ProjectHealth; publishedAt: Date } | null> {
  const row = await tx.projectUpdate.findFirst({
    where: { tenantId, projectId, status: "PUBLISHED" },
    select: { health: true, publishedAt: true },
    orderBy: [{ publishedAt: "desc" }, { seq: "desc" }],
  });
  return row?.publishedAt ? { health: row.health, publishedAt: row.publishedAt } : null;
}

export type ComposerContext = {
  readonly changes: ChangesSinceLast;
  /** The live numbers for the metrics card — what publish would freeze right now. */
  readonly metrics: PortalSnapshot;
  /** What the previous post chose, for the composer's defaults. */
  readonly previousHealth: ProjectHealth | null;
  readonly project: {
    readonly portalEnabled: boolean;
    readonly hoursSharingMode: ProjectRow["hoursSharingMode"];
    /** The portal's Tasks and Milestones sections (C47) — what the pre-fill may name (slice 102). */
    readonly shows: { readonly tasks: boolean; readonly milestones: boolean };
  };
  /**
   * The project's progress-update LAYOUT (slice 105, C73): the headings the
   * composer lays a draft out under and the numbers a new update starts with
   * ticked — the project's pick, else the workspace's default, else Fortleva
   * standard (`resolveUpdateLayout`).
   */
  readonly layout: UpdateLayout;
  /** The member may publish — and so schedule (slice 135); the dialog offers Later only then. */
  readonly canPublish: boolean;
};

/**
 * project_update:create — what the composer needs before a word is
 * typed: what happened since the last post, the metrics as they stand,
 * and the previous health. `period` narrows the window the way publish
 * will; the composer re-asks when the author changes the dates.
 */
export async function readComposerContext(
  ctx: WorkCtx,
  projectId: string,
  period: { readonly periodStart: string | null; readonly periodEnd: string | null; readonly excludeId?: string },
): Promise<ComposerContext> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "project_update:create");
    const project = await loadProject(tx, ctx, projectId);
    const prefs = await readPreferences(tx, ctx.tenantId);
    const previous = await previousPublished(tx, ctx.tenantId, projectId, period.excludeId);
    const window = metricsWindowFor(
      {
        periodStart: cleanDate(period.periodStart, "periodStart"),
        periodEnd: cleanDate(period.periodEnd, "periodEnd"),
        previous,
        projectCreatedAt: project.createdAt,
      },
      prefs.timezone,
    );
    const changes = await readChanges(tx, ctx.tenantId, project, window);
    const metrics = await computePortalSnapshot(
      tx,
      ctx.tenantId,
      project,
      window,
      { tasks: true, milestones: true, versions: true, requests: true, hours: true },
      prefs.timezone,
    );
    // The preview shows the AUTHOR the numbers as they may see them
    // live (the same rule as `getUpdate`); publish freezes the complete
    // block for the client regardless, which the toggle's copy says.
    const held = await heldCodes(tx, ctx);
    const access = hoursAccessOf(held);
    // In sequence, after the batch above (AGENTS.md's standing trap).
    const { layout } = await resolveUpdateLayout(tx, ctx.tenantId, project.updateTemplateId);
    return {
      canPublish: held.has("project_update:publish"),
      layout,
      changes,
      metrics: redactHoursFor(metrics, access),
      previousHealth: previous?.health ?? null,
      project: {
        portalEnabled: project.portalEnabled,
        hoursSharingMode: project.hoursSharingMode,
        shows: { tasks: project.portalShowTasks, milestones: project.portalShowMilestones },
      },
    };
  });
}

/** How many lines `privateWorkNamed` looks at — a post's worth — and how long: a task title's limit. */
const NAMED_MAX_LINES = 500;
/** A leading task key ("ACME-12 ") — what the panel's Add and "Add all shared" inserted before slice 102. */
const KEY_PREFIX = /^[A-Z][A-Z0-9]{0,7}-\d+\s+/;

/**
 * project_update:create — which PRIVATE work of the project a post names:
 * every INTERNAL task (not deleted) whose title, and every INTERNAL
 * milestone whose name, is one WHOLE LINE of the post (its title included).
 * The composer asks just before the publish dialog opens (slice 102's
 * security and fix-pass reviews): every new update now opens pre-filled,
 * and a draft can sit for days while a pre-filled task is made private —
 * so the check reads the project as it stands NOW, with no window, rather
 * than the composer's possibly stale and window-limited context. A whole
 * line, not a substring: a pre-filled or inserted line is the title
 * verbatim — matched as written AND with a leading task key stripped
 * (drafts written before slice 102 hold "ACME-12 Title" lines; a title that
 * itself starts key-shaped, "ISO-27001 audit", still matches as written —
 * the final check's medium) — and a substring would flag "Login" inside
 * "Login page redesign".
 * Advisory — the dialog warns, the member decides; publish does not refuse.
 */
export async function privateWorkNamed(
  ctx: WorkCtx,
  projectId: string,
  lines: readonly string[],
): Promise<string[]> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "project_update:create");
    const project = await loadProject(tx, ctx, projectId);
    return privateNamesIn(tx, ctx.tenantId, project.id, lines);
  });
}

/**
 * `privateWorkNamed`'s rule inside a transaction the caller has authorised —
 * the dialog's check, and the hourly job's own at the moment a scheduled
 * post goes out (slice 135's security review: a post can wait 90 days,
 * locked, while a task it names turns private).
 */
export async function privateNamesIn(
  tx: TenantDb,
  tenantId: string,
  projectId: string,
  lines: readonly string[],
): Promise<string[]> {
  // Only lines that COULD be a title are counted against the cap — blank
  // lines and long paragraphs first go (the re-check's L2: the job hands in a
  // whole post's lines, the dialog only candidates). A title's length plus
  // room for a leading task key, as the composer's own filter.
  const candidates = lines
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l.length <= MAX_TITLE_LENGTH + 16)
    .slice(0, NAMED_MAX_LINES);
  const wanted = [
    ...new Set(
      candidates
        .flatMap((line) => {
          const unkeyed = line.replace(KEY_PREFIX, "");
          return unkeyed === line ? [line] : [line, unkeyed];
        })
        .filter((l) => l.length > 0 && l.length <= MAX_TITLE_LENGTH),
    ),
  ];
  if (wanted.length === 0) return [];
  const tasks = await tx.workItem.findMany({
    where: { tenantId, projectId, visibility: "INTERNAL", deletedAt: null, title: { in: wanted } },
    select: { title: true },
    take: 50,
  });
  const milestones = await tx.milestone.findMany({
    where: { tenantId, projectId, visibility: "INTERNAL", name: { in: wanted } },
    select: { name: true },
    take: 50,
  });
  return [...new Set([...tasks.map((t) => t.title), ...milestones.map((m) => m.name)])];
}

/**
 * The lines a saved post is made of — its title, its own headings, every
 * line of its sections — as the composer hands the dialog's check (slice
 * 135: the job reads them from the row). Read from the section DOCUMENTS,
 * not `bodyText`: the editor's `getText({ blockSeparator: "\n" })` makes a
 * line of every block AND of every hard break inside one (a pasted soft
 * line is a `hardBreak`), while the stored text folds a hard break into a
 * space (the re-check's L1).
 */
export function linesOfPost(title: string | null, body: UpdateBody): string[] {
  return [
    title ?? "",
    ...body.sections.flatMap((s) => (s.key === "CUSTOM" && s.title ? [s.title] : [])),
    ...body.sections.flatMap((s) => docText(s.body).split("\n")),
  ];
}

/** A ProseMirror JSON node's text as the editor reads it: blocks and hard breaks end lines. */
function docText(node: unknown): string {
  if (typeof node !== "object" || node === null) return "";
  const n = node as { type?: unknown; text?: unknown; content?: unknown };
  if (n.type === "text") return typeof n.text === "string" ? n.text : "";
  if (n.type === "hardBreak") return "\n";
  const kids: unknown[] = Array.isArray(n.content) ? n.content : [];
  // A block of inline content (a paragraph, a heading) joins its pieces as
  // they stand; a block of blocks (a list, a table, the document) puts each
  // on its own line.
  const inline = kids.every((k) => {
    const t = typeof k === "object" && k !== null ? (k as { type?: unknown }).type : null;
    return t === "text" || t === "hardBreak";
  });
  return kids.map(docText).join(inline ? "" : "\n");
}

// ── Drafts ───────────────────────────────────────────────────────────

/**
 * project_update:create — a new draft. Audited once, at creation
 * (`project_update.drafted`): a draft is listed to every member with
 * `project_update:view`, so who started it is a fact the log should
 * hold — and its EDITS are routine, the way a task's field edits are
 * (AGENTS.md's carve-out): a "Save draft" click per audit row would be
 * noise, and nobody outside staff can read a draft.
 */
export async function createUpdateDraft(
  ctx: WorkCtx,
  projectId: string,
  input: UpdateDraftInput,
): Promise<{ id: string; updatedAt: Date }> {
  const columns = draftColumns(input);
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "project_update:create");
      const project = await loadProject(tx, ctx, projectId);
      if (project.archivedAt) fail("ARCHIVED");
      const row = await tx.projectUpdate.create({
        data: {
          tenantId: ctx.tenantId,
          clientId: project.clientId,
          projectId: project.id,
          authorMemberId: ctx.actor.memberId,
          ...columns,
        },
        select: { id: true, updatedAt: true },
      });
      await record(tx, {
        action: "project_update.drafted",
        targetType: "ProjectUpdate",
        targetId: row.id,
        metadata: { projectId: project.id },
      });
      return { id: row.id, updatedAt: row.updatedAt };
    }),
  );
}

/** project_update:create — edit a draft (any draft of the project). Routine: no audit (see `createUpdateDraft`). */
export async function updateUpdateDraft(
  ctx: WorkCtx,
  id: string,
  input: UpdateDraftInput,
): Promise<{ id: string; updatedAt: Date }> {
  const columns = draftColumns(input);
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "project_update:create");
      const row = await loadUpdate(tx, ctx, id);
      if (row.status !== "DRAFT") fail("UPDATE_NOT_DRAFT");
      // Locked while scheduled (C112 (a)); the trigger is the belt for an
      // edit that read the draft before it was scheduled.
      if (row.scheduledFor) fail("UPDATE_SCHEDULED");
      // `updatedAt` from the write itself (RETURNING) — the version token the
      // composer's Publish and Schedule then bind to (AGENTS.md: a CAS token
      // comes from RETURNING, never from what was sent).
      const saved = await tx.projectUpdate.update({ where: { id: row.id }, data: columns, select: { id: true, updatedAt: true } });
      return { id: saved.id, updatedAt: saved.updatedAt };
    }),
  );
}

/** project_update:create — delete a draft. Audited: deletion is never routine. */
export async function discardUpdateDraft(ctx: WorkCtx, id: string): Promise<void> {
  await withTenant(ctx.tenantId, principalOf(ctx), async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "project_update:create");
      const row = await loadUpdate(tx, ctx, id);
      if (row.status !== "DRAFT") fail("UPDATE_NOT_DRAFT");
      // Unschedule first (C112 (a)) — by someone who may publish, as the
      // schedule was. The database cannot hold this one (a delete guard would
      // refuse the project's cascade), so the delete is bound to the row
      // still being unscheduled: a schedule written in between is a zero-row
      // delete, never a scheduled post deleted unseen.
      if (row.scheduledFor) fail("UPDATE_SCHEDULED");
      const gone = await tx.projectUpdate.deleteMany({ where: { tenantId: ctx.tenantId, id: row.id, scheduledFor: null } });
      if (gone.count !== 1) {
        // Scheduled in between — or already deleted by someone else, whose
        // own discard recorded it.
        const still = await tx.projectUpdate.findFirst({ where: { tenantId: ctx.tenantId, id: row.id }, select: { id: true } });
        if (still) fail("UPDATE_SCHEDULED");
        return;
      }
      await record(tx, {
        action: "project_update.draft_discarded",
        targetType: "ProjectUpdate",
        targetId: row.id,
        metadata: { projectId: row.projectId },
      });
    }),
  );
}

// ── Publish and after ────────────────────────────────────────────────

/**
 * project_update:publish — the one moment the numbers are computed.
 *
 * TWO TRANSACTIONS AND A REVEAL BETWEEN THEM, the shape `projectMoney`
 * uses for the same reason: a COST rate is decrypted only by
 * `revealCostRates`, an audited ✦ act in its own transaction, so the
 * publisher's cost figures — when they may see them at all — come from
 * a reveal that happens OUTSIDE the publishing transaction and are
 * handed in. The first transaction decides what this publisher may
 * freeze; the second freezes it, and re-reads the draft's status so
 * that two publishers racing on one post produce one number.
 *
 * `visibility` is the dialog's answer. CLIENT_VISIBLE on a project whose
 * portal is off is allowed and reported (`portalEnabled`): the switch
 * is the Portal tab's, and the post is ready for the day it flips.
 */
export async function publishUpdate(
  ctx: WorkCtx,
  id: string,
  input: {
    readonly visibility: UpdateVisibility;
    /**
     * The version the composer's own save returned (slice 135's security
     * review): a save by somebody else since is UPDATE_CHANGED, never
     * published unseen. Absent — a caller with no save of its own — the
     * version this publish reads is the one it binds to, as before.
     */
    readonly expectedUpdatedAt?: Date;
  },
): Promise<UpdatePublished> {
  // ── 1. What may this publisher freeze? ─────────────────────────────
  const prep = await withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "project_update:publish");
    const head = await loadUpdate(tx, ctx, id);
    if (head.status !== "DRAFT") fail("UPDATE_NOT_DRAFT");
    // A scheduled post is the job's to publish, or Unschedule's to free (C112 (a)).
    if (head.scheduledFor) fail("UPDATE_SCHEDULED");
    if (input.expectedUpdatedAt && head.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) fail("UPDATE_CHANGED");
    const project = await loadProject(tx, ctx, head.projectId);
    if (project.archivedAt) fail("ARCHIVED");
    // ONE resolution on all four gates (the same set the reads use); a ✦
    // code with a stale factor answers false here, so a publisher who
    // has not stepped up simply freezes no cost — never a redirect out
    // of a publish.
    const held = await accessibleCodes(tx, ctx.tenantId, ctx.actor, [...FIGURE_CODES]);
    return preparePublish(tx, ctx.tenantId, head, project, held);
  });

  // ── 2. The audited reveal, outside any transaction of ours ─────────
  let costOf: Record<string, string> | null = null;
  if (prep.seesCost) {
    costOf = {};
    for (let i = 0; i < prep.cardIds.length; i += 50) {
      Object.assign(costOf, await revealCostRates(ctx, prep.cardIds.slice(i, i + 50)));
    }
  }

  // ── 3. Freeze ──────────────────────────────────────────────────────
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "project_update:publish");
      const head = await loadUpdate(tx, ctx, id);
      if (head.status !== "DRAFT") fail("UPDATE_NOT_DRAFT");
      if (head.scheduledFor) fail("UPDATE_SCHEDULED");
      if (head.updatedAt.getTime() !== prep.seenUpdatedAt.getTime()) fail("UPDATE_CHANGED");
      return freezePublish(tx, ctx.tenantId, head.id, prep, costOf, {
        visibility: input.visibility,
        publisherMemberId: ctx.actor.memberId,
        scheduledFor: null,
      });
    }),
  );
}

/** What one publish may freeze — decided before the freeze, by the member's Publish and by the job's. */
export type PublishPrep = {
  readonly project: ProjectRow;
  readonly window: ReturnType<typeof metricsWindowFor>;
  readonly prefs: Awaited<ReturnType<typeof readPreferences>>;
  readonly seesBudget: boolean;
  readonly seesBill: boolean;
  readonly seesCost: boolean;
  readonly entries: EntryRow[] | null;
  readonly cardIds: string[];
  readonly body: UpdateBody;
  readonly seenUpdatedAt: Date;
};

/**
 * The first half of a publish, shared (slice 135): the window, and what the
 * PUBLISHER's figure codes (`held`, on all four gates) let it freeze. The
 * caller has already authorised, scoped and refused a non-draft, an
 * archived project and a scheduled post where it must.
 */
export async function preparePublish(
  tx: TenantDb,
  tenantId: string,
  head: { readonly id: string; readonly updatedAt: Date },
  project: ProjectRow,
  held: ReadonlySet<string>,
): Promise<PublishPrep> {
  const draft = await tx.projectUpdate.findFirstOrThrow({
    where: { tenantId, id: head.id },
    select: { periodStart: true, periodEnd: true, body: true, bodyText: true },
  });
  if (draft.bodyText === null) fail("UPDATE_EMPTY");
  // What this transaction READ is what the freeze must FREEZE: the row's
  // `updatedAt` is carried across and compared there, so a draft saved by
  // somebody else in between is refused rather than published with a
  // window, toggles or a body this transaction never saw (code review,
  // slice 67).
  const seenUpdatedAt = head.updatedAt;
  const prefs = await readPreferences(tx, tenantId);
  const previous = await previousPublished(tx, tenantId, project.id, head.id);
  const window = metricsWindowFor(
    {
      periodStart: draft.periodStart ? isoDateOf(draft.periodStart) : null,
      periodEnd: draft.periodEnd ? isoDateOf(draft.periodEnd) : null,
      previous,
      projectCreatedAt: project.createdAt,
    },
    prefs.timezone,
  );
  const seesTeam = held.has("time:view_team");
  const seesBudget = held.has("budget:view");
  const seesBill = held.has("rate:view_bill");
  const seesCost = seesTeam && prefs.finance.costRatesEnabled && held.has("rate:view_cost");
  const entries: EntryRow[] | null = seesTeam
    ? await loadProjectEntries(tx, tenantId, project.id, {
        from: localDateString(window.from, prefs.timezone),
        to: localDateString(new Date(window.to.getTime() - 1), prefs.timezone),
      })
    : null;
  const cardIds = entries
    ? [...new Set(entries.map((r) => r.costRateCardId).filter((c): c is string => c !== null))]
    : [];
  return {
    project,
    window,
    prefs,
    seesBudget,
    seesBill,
    seesCost,
    entries,
    cardIds,
    body: readUpdateBody(draft.body),
    seenUpdatedAt,
  };
}

/**
 * The second half, shared (slice 135): the numbers frozen at THIS instant,
 * the number taken, the post written by compare-and-set, its twin, its
 * audit row. `scheduledFor` is the schedule the caller read — null for the
 * member's Publish, which so publishes only an UNSCHEDULED draft; the job's
 * own, so a post unscheduled or moved in between is a zero-row write.
 * Publishing clears the schedule in the same statement (the CHECK's rule).
 */
export async function freezePublish(
  tx: TenantDb,
  tenantId: string,
  updateId: string,
  prep: PublishPrep,
  costOf: Record<string, string> | null,
  how: {
    readonly visibility: UpdateVisibility;
    readonly publisherMemberId: string;
    readonly scheduledFor: Date | null;
  },
): Promise<UpdatePublished> {
  const { project, window, prefs } = prep;
  const now = new Date();
  const portal = await computePortalSnapshot(tx, tenantId, project, window, prep.body.metrics.include, prefs.timezone, now);
  const budgetRow = prep.seesBudget
    ? await tx.projectBudget.findFirst({
        where: { tenantId, projectId: project.id, status: "ACTIVE" },
        select: {
          id: true,
          projectId: true,
          kind: true,
          billingModel: true,
          amount: true,
          currency: true,
          period: true,
          periodAnchor: true,
          includeNonBillable: true,
          thresholds: true,
          notifyMemberIds: true,
          status: true,
        },
      })
    : null;
  const internal = await computeInternalSnapshot(
    tx,
    tenantId,
    {
      entries: prep.entries,
      costOf,
      budget: budgetRow,
      withAmounts: prep.seesBill,
      currency: project.billingCurrency,
    },
    localDateString(now, prefs.timezone),
  );
  const changes = await readChanges(tx, tenantId, project, window);
  const seq = await nextCounter(tx, `project_update:${project.id}`);
  // THE WRITE IS THE COMPARE-AND-SET. The check above ran a dozen
  // round trips ago (the snapshots, the budget, the counter), so a
  // save that landed in between would still be published unseen if
  // this were `update` by id. Binding the write to the row's
  // `updatedAt` as this publish READ it — and to the schedule it read —
  // makes a superseded draft a zero-row update, refused as UPDATE_CHANGED
  // — the number is spent (the counter never runs backwards), the row is
  // untouched.
  const written = await tx.projectUpdate.updateMany({
    where: { tenantId, id: updateId, status: "DRAFT", updatedAt: prep.seenUpdatedAt, scheduledFor: how.scheduledFor },
    data: {
      seq,
      status: "PUBLISHED",
      visibility: how.visibility,
      publishedAt: now,
      publishedByMemberId: how.publisherMemberId,
      portalSnapshot: portal as object,
      changesSinceLast: changeIdsOf(changes) as object,
      scheduledFor: null,
      scheduledByMemberId: null,
      scheduledVisibility: null,
    },
  });
  if (written.count !== 1) fail("UPDATE_CHANGED");
  // The class-A twin, by tagged SQL: three of its columns are NULL
  // when the publisher could not see the figure, and a SQL NULL on a
  // jsonb column is not the same value as JSON `null` (Prisma spells
  // the two differently; the read side must never have to ask which).
  const json = (v: unknown): string | null => (v === null ? null : JSON.stringify(v));
  await tx.$executeRaw`
    INSERT INTO project_update_internal_snapshot
      (update_id, tenant_id, by_member, cost, budget, computed_at)
    VALUES (${updateId}, ${tenantId},
            ${json(internal.byMember)}::jsonb, ${json(internal.cost)}::jsonb, ${json(internal.budget)}::jsonb,
            ${now})`;
  await record(tx, {
    action: "project_update.published",
    targetType: "ProjectUpdate",
    targetId: updateId,
    metadata: {
      projectId: project.id,
      seq,
      visibility: how.visibility,
      portalEnabled: project.portalEnabled,
      // The job's publish is written as SYSTEM; the row names who
      // scheduled it (an id, as the post's `published_by_member_id` does).
      ...(how.scheduledFor ? { scheduled: true, scheduledBy: how.publisherMemberId } : {}),
    },
  });
  return { id: updateId, seq, visibility: how.visibility, portalEnabled: project.portalEnabled };
}

/**
 * project_update:publish — schedule a draft to publish at a whole HOUR
 * (slice 135, founder decision C112): the job publishes it with the hourly
 * run after that hour, as THIS member, to the audience chosen now, with the
 * numbers counted then (C112 (b)). The publish code, not create: scheduling
 * decides what a client reads and when, which is the delivery lead's.
 *
 * `date` and `hour` are the member's wall clock in `timeZone` — the action
 * passes the zone the page drew the picker in (`resolveTimeZone`), never one
 * the form sent. The hour must lie after now and at most
 * `UPDATE_SCHEDULE_MAX_DAYS` ahead. Scheduling a scheduled draft MOVES it.
 * From here until it goes out — or is unscheduled — the draft is LOCKED
 * (C112 (a)).
 */
export async function scheduleUpdate(
  ctx: WorkCtx,
  id: string,
  input: {
    readonly visibility: UpdateVisibility;
    readonly date: string;
    readonly hour: number;
    readonly timeZone: string;
    /** The version the composer's own save returned — as `publishUpdate`'s. */
    readonly expectedUpdatedAt?: Date;
  },
): Promise<{ readonly scheduledFor: Date }> {
  if (
    !ISO_DATE.test(input.date) ||
    Number.isNaN(Date.parse(`${input.date}T00:00:00Z`)) ||
    !Number.isInteger(input.hour) ||
    input.hour < 0 ||
    input.hour > 23 ||
    !isTimezone(input.timeZone)
  ) {
    fail("INVALID_INPUT", "schedule");
  }
  const at = localHourInstant(input.date, input.hour, input.timeZone);
  // After now; and at most 90 DAYS ahead on the member's own calendar — the
  // bound the picker draws (`max`), so its last day is good at every hour
  // (the code review's L3).
  if (at.getTime() <= Date.now() || input.date > addDays(todayIn(input.timeZone), UPDATE_SCHEDULE_MAX_DAYS)) {
    fail("UPDATE_SCHEDULE_TIME");
  }
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "project_update:publish");
      const head = await loadUpdate(tx, ctx, id);
      if (head.status !== "DRAFT") fail("UPDATE_NOT_DRAFT");
      if (input.expectedUpdatedAt && head.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) fail("UPDATE_CHANGED");
      const project = await loadProject(tx, ctx, head.projectId);
      if (project.archivedAt) fail("ARCHIVED");
      const draft = await tx.projectUpdate.findFirstOrThrow({
        where: { tenantId: ctx.tenantId, id: head.id },
        select: { bodyText: true, title: true, body: true },
      });
      if (draft.bodyText === null) fail("UPDATE_EMPTY");
      // For the CLIENT, a post naming private work is refused NOW: the job
      // refuses it at go-out (`private_named`) where nobody is there to heed
      // the dialog's warning, so scheduling it would only promise a post that
      // will not be sent (the re-check's M2). Publish now stays advisory —
      // the member is there to decide.
      if (input.visibility === "CLIENT_VISIBLE") {
        const named = await privateNamesIn(tx, ctx.tenantId, project.id, linesOfPost(draft.title, readUpdateBody(draft.body)));
        if (named.length > 0) fail("UPDATE_NAMES_PRIVATE");
      }
      // Bound to the row as read: an edit saved in between is refused, not
      // scheduled unseen (the composer saves, then schedules).
      const written = await tx.projectUpdate.updateMany({
        where: { tenantId: ctx.tenantId, id: head.id, status: "DRAFT", updatedAt: head.updatedAt },
        data: { scheduledFor: at, scheduledByMemberId: ctx.actor.memberId, scheduledVisibility: input.visibility },
      });
      if (written.count !== 1) fail("UPDATE_CHANGED");
      await record(tx, {
        action: "project_update.scheduled",
        targetType: "ProjectUpdate",
        targetId: head.id,
        metadata: {
          projectId: project.id,
          scheduledFor: at.toISOString(),
          visibility: input.visibility,
          ...(head.scheduledFor ? { movedFrom: head.scheduledFor.toISOString() } : {}),
        },
      });
      return { scheduledFor: at };
    }),
  );
}

/**
 * project_update:publish — take a draft off its schedule (C112 (a)): it is a
 * plain draft again, editable. Already unscheduled is a quiet no-op; a post
 * the job published a moment ago is UPDATE_NOT_DRAFT.
 */
export async function unscheduleUpdate(ctx: WorkCtx, id: string): Promise<void> {
  await withTenant(ctx.tenantId, principalOf(ctx), async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "project_update:publish");
      const head = await loadUpdate(tx, ctx, id);
      if (head.status !== "DRAFT") fail("UPDATE_NOT_DRAFT");
      if (!head.scheduledFor) return;
      const before = await tx.projectUpdate.findFirstOrThrow({
        where: { tenantId: ctx.tenantId, id: head.id },
        select: { scheduledByMemberId: true },
      });
      const cleared = await tx.projectUpdate.updateMany({
        where: { tenantId: ctx.tenantId, id: head.id, status: "DRAFT", scheduledFor: head.scheduledFor },
        data: { scheduledFor: null, scheduledByMemberId: null, scheduledVisibility: null },
      });
      if (cleared.count !== 1) {
        // Nothing cleared: the job published it a moment ago (the write
        // waited on its lock and found a published row), or someone moved
        // or cleared it. Never "Unscheduled" over a post that has gone out
        // (both reviews' finding) — the member must know, while Retract is
        // still open.
        const now = await tx.projectUpdate.findFirst({
          where: { tenantId: ctx.tenantId, id: head.id },
          select: { status: true, scheduledFor: true },
        });
        if (!now) return deny("NOT_FOUND");
        if (now.status !== "DRAFT") fail("UPDATE_NOT_DRAFT");
        if (now.scheduledFor) fail("UPDATE_CHANGED");
        return;
      }
      await record(tx, {
        action: "project_update.unscheduled",
        targetType: "ProjectUpdate",
        targetId: head.id,
        metadata: {
          projectId: head.projectId,
          scheduledFor: head.scheduledFor.toISOString(),
          ...(before.scheduledByMemberId ? { scheduledBy: before.scheduledByMemberId } : {}),
        },
      });
    }),
  );
}

/** project_update:publish — archive a published post: hidden from the client, kept for the record. */
export async function archiveUpdate(ctx: WorkCtx, id: string): Promise<void> {
  await withTenant(ctx.tenantId, principalOf(ctx), async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "project_update:publish");
      const row = await loadUpdate(tx, ctx, id);
      if (row.status !== "PUBLISHED") fail("UPDATE_NOT_PUBLISHED");
      await tx.projectUpdate.update({
        where: { id: row.id },
        data: { status: "ARCHIVED", visibility: "INTERNAL" },
        select: { id: true },
      });
      await record(tx, {
        action: "project_update.archived",
        targetType: "ProjectUpdate",
        targetId: row.id,
        metadata: { projectId: row.projectId, seq: row.seq ?? 0, wasVisible: row.visibility === "CLIENT_VISIBLE" },
      });
    }),
  );
}

/** project_update:change_visibility — show a published post to the client, or take it back. */
export async function setUpdateVisibility(ctx: WorkCtx, id: string, visibility: UpdateVisibility): Promise<void> {
  await withTenant(ctx.tenantId, principalOf(ctx), async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "project_update:change_visibility");
      const row = await loadUpdate(tx, ctx, id);
      if (row.status !== "PUBLISHED") fail("UPDATE_NOT_PUBLISHED");
      if (row.visibility === visibility) return;
      await tx.projectUpdate.update({ where: { id: row.id }, data: { visibility }, select: { id: true } });
      await record(tx, {
        action: "project_update.visibility_changed",
        targetType: "ProjectUpdate",
        targetId: row.id,
        metadata: { projectId: row.projectId, seq: row.seq ?? 0, from: row.visibility, to: visibility },
      });
    }),
  );
}

/**
 * project_update:publish — the one text that changes after publish: a
 * note under the post, client-readable when the post is. Null clears it.
 */
export async function annotateUpdate(ctx: WorkCtx, id: string, editNote: string | null): Promise<void> {
  const note = editNote === null ? null : editNote.trim();
  if (note !== null && (note.length === 0 || note.length > UPDATE_EDIT_NOTE_MAX)) fail("INVALID_INPUT", "editNote");
  await withTenant(ctx.tenantId, principalOf(ctx), async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "project_update:publish");
      const row = await loadUpdate(tx, ctx, id);
      if (row.status !== "PUBLISHED") fail("UPDATE_NOT_PUBLISHED");
      await tx.projectUpdate.update({ where: { id: row.id }, data: { editNote: note }, select: { id: true } });
      await record(tx, {
        action: "project_update.annotated",
        targetType: "ProjectUpdate",
        targetId: row.id,
        metadata: { projectId: row.projectId, seq: row.seq ?? 0, cleared: note === null },
      });
    }),
  );
}

/**
 * project_update:publish — back to DRAFT within fifteen minutes of
 * publishing (§6.16's grace window). The number is consumed for good —
 * the counter never runs backwards — and the snapshots are dropped, so
 * a republish freezes fresh numbers under a fresh number. The trigger
 * applies the same clock; a race past it maps to UPDATE_IMMUTABLE.
 */
export async function retractUpdate(ctx: WorkCtx, id: string): Promise<void> {
  await withTenant(ctx.tenantId, principalOf(ctx), async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "project_update:publish");
      const row = await loadUpdate(tx, ctx, id);
      const publishedAt: Date =
        row.status === "PUBLISHED" && row.publishedAt ? row.publishedAt : fail("UPDATE_NOT_PUBLISHED");
      if (Date.now() - publishedAt.getTime() > UPDATE_RETRACT_WINDOW_MS) fail("UPDATE_RETRACT_WINDOW_CLOSED");
      await tx.projectUpdateInternalSnapshot.deleteMany({ where: { tenantId: ctx.tenantId, updateId: row.id } });
      // Raw, because the two JSON columns must become SQL NULL (Prisma's
      // `null` on a Json field means the JSON value `null`), and because
      // the trigger's clock is the database's: `now()` in the same
      // statement it judges. `updated_at` is truncated to MILLISECONDS:
      // Prisma's `@updatedAt` writes at that precision and reads a
      // `Date` at that precision, and `publishUpdate`'s compare-and-set
      // binds its write to the value it read — a microsecond tail from
      // a raw `now()` would make every republish after a retraction a
      // superseded draft (measured: the dbtest's republish failed with
      // UPDATE_CHANGED until this was cut).
      const changed = await tx.$executeRaw`
        UPDATE project_update
           SET status = 'DRAFT', visibility = 'INTERNAL', seq = NULL,
               published_at = NULL, published_by_member_id = NULL,
               portal_snapshot = NULL, changes_since_last = NULL,
               updated_at = date_trunc('milliseconds', now())
         WHERE tenant_id = ${ctx.tenantId} AND id = ${row.id} AND status = 'PUBLISHED'`;
      if (changed !== 1) fail("UPDATE_NOT_PUBLISHED");
      await record(tx, {
        action: "project_update.retracted",
        targetType: "ProjectUpdate",
        targetId: row.id,
        metadata: { projectId: row.projectId, seq: row.seq ?? 0, wasVisible: row.visibility === "CLIENT_VISIBLE" },
      });
    }),
  );
}

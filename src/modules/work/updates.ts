import { record } from "@/audit/record";
import { assertInScope } from "@/authz/authorize";
import { deny } from "@/authz/errors";
import { nextCounter, withTenant, type TenantDb } from "@/db";
import { accessibleCodes, requireAccess } from "@/entitlements/resolver";
import type { ProjectHealth } from "@/generated/prisma/enums";
import { fail } from "@/lib/domain-error";
import { dateColumn, isoDateOf, localDateString } from "@/lib/duration";
import { revealCostRates } from "@/modules/time/rates";
import { loadProjectEntries, type EntryRow } from "@/modules/time/rollup";
import { readPreferences } from "@/preferences/service";

import { guarded } from "./db-errors";
import { principalOf, type WorkCtx } from "./states";
import {
  UPDATE_EDIT_NOTE_MAX,
  UPDATE_RETRACT_WINDOW_MS,
  UPDATE_TITLE_MAX,
  normalizeUpdateBody,
  readUpdateBody,
  type UpdateBody,
} from "./update-body";
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
};

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

type ProjectRow = {
  id: string;
  key: string;
  clientId: string;
  portalEnabled: boolean;
  hoursSharingMode: "NONE" | "HOURS" | "BILLABLE_AMOUNT";
  billingCurrency: string | null;
  archivedAt: Date | null;
  createdAt: Date;
};

const projectSelect = {
  id: true,
  key: true,
  clientId: true,
  portalEnabled: true,
  hoursSharingMode: true,
  billingCurrency: true,
  archivedAt: true,
  createdAt: true,
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
    const names = await memberNames(tx, ctx.tenantId, rows.map((r) => r.authorMemberId));
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
      [row.authorMemberId, row.publishedByMemberId].filter((x): x is string => x !== null),
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
  readonly project: { readonly portalEnabled: boolean; readonly hoursSharingMode: ProjectRow["hoursSharingMode"] };
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
    const access = hoursAccessOf(await heldCodes(tx, ctx));
    return {
      changes,
      metrics: redactHoursFor(metrics, access),
      previousHealth: previous?.health ?? null,
      project: { portalEnabled: project.portalEnabled, hoursSharingMode: project.hoursSharingMode },
    };
  });
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
): Promise<{ id: string }> {
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
        select: { id: true },
      });
      await record(tx, {
        action: "project_update.drafted",
        targetType: "ProjectUpdate",
        targetId: row.id,
        metadata: { projectId: project.id },
      });
      return { id: row.id };
    }),
  );
}

/** project_update:create — edit a draft (any draft of the project). Routine: no audit (see `createUpdateDraft`). */
export async function updateUpdateDraft(ctx: WorkCtx, id: string, input: UpdateDraftInput): Promise<{ id: string }> {
  const columns = draftColumns(input);
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "project_update:create");
      const row = await loadUpdate(tx, ctx, id);
      if (row.status !== "DRAFT") fail("UPDATE_NOT_DRAFT");
      await tx.projectUpdate.update({ where: { id: row.id }, data: columns, select: { id: true } });
      return { id: row.id };
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
      await tx.projectUpdate.delete({ where: { id: row.id }, select: { id: true } });
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
  input: { readonly visibility: UpdateVisibility },
): Promise<UpdatePublished> {
  // ── 1. What may this publisher freeze? ─────────────────────────────
  const prep = await withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "project_update:publish");
    const head = await loadUpdate(tx, ctx, id);
    if (head.status !== "DRAFT") fail("UPDATE_NOT_DRAFT");
    const project = await loadProject(tx, ctx, head.projectId);
    if (project.archivedAt) fail("ARCHIVED");
    const draft = await tx.projectUpdate.findFirstOrThrow({
      where: { tenantId: ctx.tenantId, id: head.id },
      select: { periodStart: true, periodEnd: true, body: true, bodyText: true },
    });
    if (draft.bodyText === null) fail("UPDATE_EMPTY");
    // What this transaction READ is what the third one must FREEZE: the
    // row's `updatedAt` is carried across and compared there, so a draft
    // saved by somebody else in between is refused rather than published
    // with a window, toggles or a body this transaction never saw
    // (code review, slice 67).
    const seenUpdatedAt = head.updatedAt;
    const prefs = await readPreferences(tx, ctx.tenantId);
    const previous = await previousPublished(tx, ctx.tenantId, project.id, head.id);
    const window = metricsWindowFor(
      {
        periodStart: draft.periodStart ? isoDateOf(draft.periodStart) : null,
        periodEnd: draft.periodEnd ? isoDateOf(draft.periodEnd) : null,
        previous,
        projectCreatedAt: project.createdAt,
      },
      prefs.timezone,
    );
    // ONE resolution on all four gates (the same set the reads use); a ✦
    // code with a stale factor answers false here, so a publisher who
    // has not stepped up simply freezes no cost — never a redirect out
    // of a publish.
    const held = await accessibleCodes(tx, ctx.tenantId, ctx.actor, [...FIGURE_CODES]);
    const seesTeam = held.has("time:view_team");
    const seesBudget = held.has("budget:view");
    const seesBill = held.has("rate:view_bill");
    const seesCost = seesTeam && prefs.finance.costRatesEnabled && held.has("rate:view_cost");
    const entries: EntryRow[] | null = seesTeam
      ? await loadProjectEntries(tx, ctx.tenantId, project.id, {
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
      if (head.updatedAt.getTime() !== prep.seenUpdatedAt.getTime()) fail("UPDATE_CHANGED");
      const { project, window, prefs } = prep;
      const now = new Date();
      const portal = await computePortalSnapshot(
        tx,
        ctx.tenantId,
        project,
        window,
        prep.body.metrics.include,
        prefs.timezone,
        now,
      );
      const budgetRow = prep.seesBudget
        ? await tx.projectBudget.findFirst({
            where: { tenantId: ctx.tenantId, projectId: project.id, status: "ACTIVE" },
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
        ctx.tenantId,
        {
          entries: prep.entries,
          costOf,
          budget: budgetRow,
          withAmounts: prep.seesBill,
          currency: project.billingCurrency,
        },
        localDateString(now, prefs.timezone),
      );
      const changes = await readChanges(tx, ctx.tenantId, project, window);
      const seq = await nextCounter(tx, `project_update:${project.id}`);
      // THE WRITE IS THE COMPARE-AND-SET. The check above ran a dozen
      // round trips ago (the snapshots, the budget, the counter), so a
      // save that landed in between would still be published unseen if
      // this were `update` by id. Binding the write to the row's
      // `updatedAt` as this publish READ it makes a superseded draft a
      // zero-row update, refused as UPDATE_CHANGED — the number is spent
      // (the counter never runs backwards), the row is untouched.
      const written = await tx.projectUpdate.updateMany({
        where: { tenantId: ctx.tenantId, id: head.id, status: "DRAFT", updatedAt: prep.seenUpdatedAt },
        data: {
          seq,
          status: "PUBLISHED",
          visibility: input.visibility,
          publishedAt: now,
          publishedByMemberId: ctx.actor.memberId,
          portalSnapshot: portal as object,
          changesSinceLast: changeIdsOf(changes) as object,
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
        VALUES (${head.id}, ${ctx.tenantId},
                ${json(internal.byMember)}::jsonb, ${json(internal.cost)}::jsonb, ${json(internal.budget)}::jsonb,
                ${now})`;
      await record(tx, {
        action: "project_update.published",
        targetType: "ProjectUpdate",
        targetId: head.id,
        metadata: { projectId: project.id, seq, visibility: input.visibility, portalEnabled: project.portalEnabled },
      });
      return { id: head.id, seq, visibility: input.visibility, portalEnabled: project.portalEnabled };
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

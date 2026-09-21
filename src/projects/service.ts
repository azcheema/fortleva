import { record } from "@/audit/record";
import {
  assertInScope,
  effectivePermissions,
  scopeWhere,
  type MemberActor,
} from "@/authz/authorize";
import { deny } from "@/authz/errors";
import { clean } from "@/clients/service";
import { PORTAL_ENABLED_FANOUT_TARGETS, withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import type {
  HoursSharingMode,
  MilestoneStatus,
  ProjectStatus,
  ProjectVersionStatus,
  UpdateCadence,
  Visibility,
} from "@/generated/prisma/enums";
import { fail, isDeadlock, isLockTimeout, isUniqueViolation } from "@/lib/domain-error";
import { newId } from "@/lib/ids";
import { retryOnContention } from "@/lib/retry";

/**
 * Projects (DATA_MODEL.md §6.5, PLAN.md Phase 2). Every list composes
 * scopeWhere({clientId, projectId}); every mutation runs the recipe
 * withTenant → requireAccess → assertInScope → mutate → record.
 * INTERNAL-ONLY fields (repoUrl, hostingNotes, internalNotes,
 * leadMemberId) are returned to members only — the forbidden-columns
 * grep (src/authz/portal-projections.test.ts) keeps them out of every
 * portal projection. Project.portalEnabled is the ONLY portal switch
 * the app writes; children's portal_enabled is trigger-derived.
 */

export type ProjectCtx = {
  readonly tenantId: string;
  /** From requireTenantContext() — never from form params. */
  readonly actor: MemberActor;
};

const principalOf = (ctx: ProjectCtx) =>
  ({ type: "member", id: ctx.actor.memberId }) as const;

export const PROJECT_KEY_RE = /^[A-Z][A-Z0-9]{0,7}$/;

/** Uppercase + trim; throws KEY_INVALID unless it matches the schema CHECK. */
export const normalizeProjectKey = (raw: string): string => {
  const key = raw.trim().toUpperCase();
  if (!PROJECT_KEY_RE.test(key)) fail("KEY_INVALID", raw);
  return key;
};

/** The Project table's own project column is "id" (its children use "projectId"). */
const PROJECT_SCOPE = { clientField: "clientId", projectField: "id" } as const;

// ── Reads ────────────────────────────────────────────────────────────

export type ProjectListRow = {
  id: string;
  key: string;
  name: string;
  status: ProjectStatus;
  clientId: string;
  clientName: string;
  leadMemberId: string | null;
  leadName: string | null;
  milestoneTotal: number;
  milestoneDone: number;
  portalEnabled: boolean;
  updatedAt: Date;
};

export type ProjectGroup = {
  clientId: string;
  clientName: string;
  projects: ProjectListRow[];
};

/** project:view; scoped; grouped by client (UI.md §3.1). */
export async function listProjects(
  ctx: ProjectCtx,
  opts: { includeArchived?: boolean } = {},
): Promise<ProjectGroup[]> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "project:view");
    const scope = await scopeWhere(tx, ctx.actor, PROJECT_SCOPE);
    const rows = await tx.project.findMany({
      where: { ...scope, ...(opts.includeArchived ? {} : { status: { not: "ARCHIVED" } }) },
      orderBy: [{ client: { name: "asc" } }, { name: "asc" }],
      select: {
        id: true,
        key: true,
        name: true,
        status: true,
        clientId: true,
        leadMemberId: true,
        portalEnabled: true,
        updatedAt: true,
        client: { select: { name: true } },
        milestones: { select: { status: true } },
      },
    });
    const leadIds = [...new Set(rows.map((r) => r.leadMemberId).filter((x): x is string => !!x))];
    const leads = leadIds.length
      ? await tx.member.findMany({
          where: { id: { in: leadIds } },
          select: { id: true, user: { select: { name: true } } },
        })
      : [];
    const leadName = new Map(leads.map((m) => [m.id, m.user.name]));
    const groups = new Map<string, ProjectGroup>();
    for (const r of rows) {
      const g = groups.get(r.clientId) ?? {
        clientId: r.clientId,
        clientName: r.client.name,
        projects: [],
      };
      g.projects.push({
        id: r.id,
        key: r.key,
        name: r.name,
        status: r.status,
        clientId: r.clientId,
        clientName: r.client.name,
        leadMemberId: r.leadMemberId,
        leadName: r.leadMemberId ? (leadName.get(r.leadMemberId) ?? null) : null,
        milestoneTotal: r.milestones.filter((m) => m.status !== "CANCELLED").length,
        milestoneDone: r.milestones.filter((m) => m.status === "DONE").length,
        portalEnabled: r.portalEnabled,
        updatedAt: r.updatedAt,
      });
      groups.set(r.clientId, g);
    }
    return [...groups.values()];
  });
}

export type MilestoneRow = {
  id: string;
  name: string;
  description: string | null;
  status: MilestoneStatus;
  dueAt: Date | null;
  completedAt: Date | null;
  visibility: Visibility;
  /** Ordering key — for neighbour arithmetic on the server only; never rendered (UI.md rule 4). */
  rank: string;
};

export type VersionRow = {
  id: string;
  version: string;
  title: string | null;
  releaseNotes: string | null;
  status: ProjectVersionStatus;
  shippedAt: Date | null;
  createdAt: Date;
};

export type ProjectDetail = {
  id: string;
  key: string;
  name: string;
  type: string | null;
  scopeSummary: string | null;
  status: ProjectStatus;
  startDate: Date | null;
  launchDate: Date | null;
  productionUrl: string | null;
  stagingUrl: string | null;
  // INTERNAL-ONLY (member plane only; the portal projection never selects these)
  repoUrl: string | null;
  hostingNotes: string | null;
  internalNotes: string | null;
  leadMemberId: string | null;
  leadName: string | null;
  portalEnabled: boolean;
  hoursSharingMode: HoursSharingMode;
  billingCurrency: string | null;
  defaultBillable: boolean;
  updateCadence: UpdateCadence;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  client: { id: string; name: string };
  milestones: MilestoneRow[];
  versions: VersionRow[];
  assignments: { memberId: string; name: string; email: string; createdAt: Date }[];
  caps: {
    edit: boolean;
    delete: boolean;
    manageVersions: boolean;
    manageAssignments: boolean;
    /** project:manage_portal — the Portal tab and everything on it. */
    managePortal: boolean;
    viewDocuments: boolean;
    uploadDocuments: boolean;
    deleteDocuments: boolean;
    changeDocumentVisibility: boolean;
  };
};

/** project:view; assertInScope({projectId}) ⇒ NOT_FOUND outside scope. */
export async function getProjectByKey(ctx: ProjectCtx, key: string): Promise<ProjectDetail> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "project:view");
    const head = await tx.project.findFirst({
      where: { key: key.toUpperCase() },
      select: { id: true },
    });
    if (!head) deny("NOT_FOUND");
    await assertInScope(tx, ctx.actor, { projectId: head!.id });
    const held = await effectivePermissions(tx, ctx.actor.memberId);
    const p = await tx.project.findFirstOrThrow({
      where: { id: head!.id },
      include: {
        client: { select: { id: true, name: true } },
        milestones: { orderBy: { rank: "asc" } },
        versions: { orderBy: [{ shippedAt: "desc" }, { createdAt: "desc" }] },
        memberProjects: {
          orderBy: { createdAt: "asc" },
          include: { member: { select: { user: { select: { name: true, email: true } } } } },
        },
      },
    });
    const lead = p.leadMemberId
      ? await tx.member.findFirst({
          where: { id: p.leadMemberId },
          select: { user: { select: { name: true } } },
        })
      : null;
    return {
      id: p.id,
      key: p.key,
      name: p.name,
      type: p.type,
      scopeSummary: p.scopeSummary,
      status: p.status,
      startDate: p.startDate,
      launchDate: p.launchDate,
      productionUrl: p.productionUrl,
      stagingUrl: p.stagingUrl,
      repoUrl: p.repoUrl,
      hostingNotes: p.hostingNotes,
      internalNotes: p.internalNotes,
      leadMemberId: p.leadMemberId,
      leadName: lead?.user.name ?? null,
      portalEnabled: p.portalEnabled,
      hoursSharingMode: p.hoursSharingMode,
      billingCurrency: p.billingCurrency,
      defaultBillable: p.defaultBillable,
      updateCadence: p.updateCadence,
      archivedAt: p.archivedAt,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      client: p.client,
      milestones: p.milestones.map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description,
        status: m.status,
        dueAt: m.dueAt,
        completedAt: m.completedAt,
        visibility: m.visibility,
        rank: m.rank,
      })),
      versions: p.versions.map((v) => ({
        id: v.id,
        version: v.version,
        title: v.title,
        releaseNotes: v.releaseNotes,
        status: v.status,
        shippedAt: v.shippedAt,
        createdAt: v.createdAt,
      })),
      assignments: p.memberProjects.map((mp) => ({
        memberId: mp.memberId,
        name: mp.member.user.name,
        email: mp.member.user.email,
        createdAt: mp.createdAt,
      })),
      caps: {
        edit: held.has("project:edit"),
        delete: held.has("project:delete"),
        manageVersions: held.has("project:manage_versions"),
        manageAssignments: held.has("project:manage_assignments"),
        managePortal: held.has("project:manage_portal"),
        viewDocuments: held.has("document:view"),
        uploadDocuments: held.has("document:upload"),
        deleteDocuments: held.has("document:delete"),
        changeDocumentVisibility: held.has("document:change_visibility"),
      },
    };
  });
}

/** Loads a project row and asserts scope — the head of every mutation below. */
async function loadInScope(tx: TenantDb, actor: MemberActor, projectId: string) {
  const p = await tx.project.findFirst({ where: { id: projectId } });
  if (!p) deny("NOT_FOUND");
  await assertInScope(tx, actor, { projectId });
  return p!;
}

// ── Mutations ────────────────────────────────────────────────────────

export type ProjectCreateInput = {
  clientId: string;
  key: string;
  name: string;
  type?: string | null;
  scopeSummary?: string | null;
  status?: ProjectStatus;
};

/**
 * project:create; the client must be DIRECTLY in scope (a project-only
 * member does not spawn siblings). Assignments stay explicit — the
 * creator is not auto-assigned. Key is uppercased and validated here;
 * the DB CHECK + unique are the backstop.
 */
export async function createProject(
  ctx: ProjectCtx,
  input: ProjectCreateInput,
): Promise<{ id: string; key: string }> {
  const name = clean(input.name);
  if (!name) fail("NAME_REQUIRED");
  const key = normalizeProjectKey(input.key);
  const id = newId();
  await withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "project:create");
    await assertInScope(tx, ctx.actor, { clientId: input.clientId });
    const client = await tx.client.findFirst({
      where: { id: input.clientId },
      select: { status: true },
    });
    if (!client) deny("NOT_FOUND");
    if (client!.status === "ARCHIVED") fail("ARCHIVED");
    const taken = await tx.project.findFirst({ where: { key }, select: { id: true } });
    if (taken) fail("KEY_TAKEN", key);
    try {
      await tx.project.create({
        data: {
          id,
          tenantId: ctx.tenantId,
          clientId: input.clientId,
          key,
          name: name!,
          type: clean(input.type),
          scopeSummary: clean(input.scopeSummary),
          status: input.status ?? "PLANNED",
        },
      });
    } catch (e) {
      if (isUniqueViolation(e)) fail("KEY_TAKEN", key);
      throw e;
    }
    await record(tx, {
      action: "project.created",
      targetType: "Project",
      targetId: id,
      metadata: { key, name, clientId: input.clientId },
    });
  });
  return { id, key };
}

export const PROJECT_FIELDS = [
  "name",
  "type",
  "scopeSummary",
  "startDate",
  "launchDate",
  "productionUrl",
  "stagingUrl",
  "repoUrl",
  "hostingNotes",
  "internalNotes",
  "leadMemberId",
  "billingCurrency",
  "defaultBillable",
  "updateCadence",
] as const;
export type ProjectField = (typeof PROJECT_FIELDS)[number];

/** INTERNAL-ONLY project fields — never in a portal projection, never in audit metadata values. */
export const PROJECT_INTERNAL_FIELDS: readonly ProjectField[] = [
  "repoUrl",
  "hostingNotes",
  "internalNotes",
  "leadMemberId",
];

export type ProjectPatch = Partial<{
  name: string;
  type: string | null;
  scopeSummary: string | null;
  startDate: Date | null;
  launchDate: Date | null;
  productionUrl: string | null;
  stagingUrl: string | null;
  repoUrl: string | null;
  hostingNotes: string | null;
  internalNotes: string | null;
  leadMemberId: string | null;
  billingCurrency: string | null;
  defaultBillable: boolean;
  updateCadence: UpdateCadence;
}>;

const sameDate = (a: Date | null, b: Date | null): boolean =>
  (a === null && b === null) || (!!a && !!b && a.getTime() === b.getTime());

/** project:edit — fields incl. the INTERNAL-only ones; only changed names go to the audit row. */
export async function updateProject(
  ctx: ProjectCtx,
  projectId: string,
  patch: ProjectPatch,
): Promise<{ changed: ProjectField[] }> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "project:edit");
    const p = await loadInScope(tx, ctx.actor, projectId);
    if (p.status === "ARCHIVED") fail("ARCHIVED");
    const data: Record<string, unknown> = {};
    const changed: ProjectField[] = [];
    for (const f of PROJECT_FIELDS) {
      if (!(f in patch)) continue;
      let next: unknown;
      switch (f) {
        case "name":
          next = clean(patch.name);
          if (!next) fail("NAME_REQUIRED");
          break;
        case "startDate":
        case "launchDate": {
          const v = patch[f] ?? null;
          if (!sameDate(v, p[f])) {
            data[f] = v;
            changed.push(f);
          }
          continue;
        }
        case "defaultBillable":
          next = patch.defaultBillable === true;
          break;
        case "updateCadence":
          next = patch.updateCadence ?? "NONE";
          break;
        case "billingCurrency":
          next = clean(patch.billingCurrency)?.toUpperCase() ?? null;
          if (next !== null && !/^[A-Z]{3}$/.test(next as string)) fail("INVALID_INPUT", "currency");
          break;
        case "leadMemberId": {
          next = clean(patch.leadMemberId);
          if (next) {
            const m = await tx.member.findFirst({
              where: { id: next as string, status: "ACTIVE" },
              select: { id: true },
            });
            if (!m) fail("INVALID_INPUT", "lead member");
          }
          break;
        }
        default:
          next = clean(patch[f]);
      }
      if (next !== p[f]) {
        data[f] = next;
        changed.push(f);
      }
    }
    if (changed.length === 0) return { changed };
    await tx.project.update({ where: { id: projectId }, data });
    await record(tx, {
      action: "project.updated",
      targetType: "Project",
      targetId: projectId,
      metadata: { fields: changed },
    });
    return { changed };
  });
}

/** project:edit — PLANNED/ACTIVE/PAUSED/COMPLETED/CANCELLED; ARCHIVED goes through archiveProject. */
export async function changeProjectStatus(
  ctx: ProjectCtx,
  projectId: string,
  status: Exclude<ProjectStatus, "ARCHIVED">,
): Promise<{ changed: boolean }> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "project:edit");
    const p = await loadInScope(tx, ctx.actor, projectId);
    if (p.status === "ARCHIVED") fail("ARCHIVED");
    if (p.status === status) return { changed: false };
    await tx.project.update({ where: { id: projectId }, data: { status } });
    await record(tx, {
      action: "project.status_changed",
      targetType: "Project",
      targetId: projectId,
      metadata: { from: p.status, to: status },
    });
    return { changed: true };
  });
}

/** project:delete — archive; children stay, portal switch untouched. */
export async function archiveProject(ctx: ProjectCtx, projectId: string): Promise<void> {
  await withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "project:delete");
    const p = await loadInScope(tx, ctx.actor, projectId);
    if (p.status === "ARCHIVED") return;
    await tx.project.update({
      where: { id: projectId },
      data: { status: "ARCHIVED", archivedAt: new Date() },
    });
    await record(tx, {
      action: "project.archived",
      targetType: "Project",
      targetId: projectId,
      metadata: { from: p.status },
    });
  });
}

/** project:delete — restore to PAUSED (explicit; the team picks the real status). */
export async function unarchiveProject(ctx: ProjectCtx, projectId: string): Promise<void> {
  await withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "project:delete");
    const p = await loadInScope(tx, ctx.actor, projectId);
    if (p.status !== "ARCHIVED") return;
    await tx.project.update({
      where: { id: projectId },
      data: { status: "PAUSED", archivedAt: null },
    });
    await record(tx, {
      action: "project.status_changed",
      targetType: "Project",
      targetId: projectId,
      metadata: { from: "ARCHIVED", to: "PAUSED" },
    });
  });
}

/**
 * The portal switch's two budgets. The transaction budget is SIZED
 * AGAINST the lock bound so the two cannot drift apart silently — but
 * read the next paragraph before treating it as a guarantee.
 *
 * WHAT IT IS NOT: a worst case. `lock_timeout` applies "separately to
 * each lock acquisition attempt" (Postgres's own wording), and an
 * acquisition attempt is per contended ROW, not per statement — so a
 * single leg can wait its full bound many times over, once per row a
 * different transaction is holding, without ever tripping it. The
 * product of legs and bound below is therefore the cost of ONE holder
 * per leg, which is the shape this was built for (a bulk edit, the
 * motivating case, is exactly one holder). Several distinct concurrent
 * holders on one project can exceed it, and `lock_timeout` is
 * structurally incapable of bounding that — only `statement_timeout`
 * (57014) cancels a statement on its total time. WHAT HAPPENS THEN is
 * a P2028, untranslated, which the member meets as a 500 on a control
 * that nonetheless rolled back cleanly: worse than the toast, far
 * better than the unbounded hang this replaced, and deliberately left
 * visible rather than dressed up as contention, because a fan-out that
 * genuinely takes 25 s is a bug someone should see. Reach for
 * `statement_timeout` if that case ever stops being hypothetical.
 *
 * SO THE HEADROOM IS PICKED, NOT DERIVED — 10 s, a round number over a
 * fan-out whose own work is milliseconds now that all ten legs are
 * indexed. Only the LEGS × BOUND part is derived.
 *
 * PORTAL_FANOUT_LEGS IS DERIVED FROM THE REGISTRY, not counted by
 * hand: `PORTAL_ENABLED_FANOUT_TARGETS` is the list
 * `isolation.dbtest.ts` already checks the trigger body against, so a
 * new projectScoped model widens this budget in the same commit that
 * gives it a leg. The `+ 1` is `search_index`, which the trigger
 * updates but the registry cannot name — it is deliberately not a
 * Prisma model (generated tsvector columns are hand-written DDL), so
 * it is the one leg no list in TypeScript knows about.
 */
const PORTAL_FANOUT_LEGS = PORTAL_ENABLED_FANOUT_TARGETS.length + 1;
export const PORTAL_LOCK_WAIT_MS = 1_500;
export const PORTAL_TX_MS = PORTAL_FANOUT_LEGS * PORTAL_LOCK_WAIT_MS + 10_000;

/**
 * THE project-level portal gate (TENANCY.md §7.2). Writes ONLY
 * Project.portalEnabled — the trigger fans out to every projectScoped
 * child. Permission: `project:manage_portal` (C M) since Phase 3 slice
 * 4, 2026-09-21 — it was `project:edit` (C M E) while the code was
 * missing from the catalogue, so this NARROWS the control to a delivery
 * lead. An employee can still edit every other field of the project.
 */
export async function setPortalEnabled(
  ctx: ProjectCtx,
  projectId: string,
  enabled: boolean,
): Promise<{ changed: boolean }> {
  // RETRIED ON CONTENTION — a deadlock OR a bounded lock wait — and the
  // choice of cure over prevention is the whole story of this function.
  //
  // It writes ONE `project` row, and `project_portal_enabled_fanout`
  // turns that into TEN mass UPDATEs — milestone, project_version,
  // service, document, work_item, work_item_activity, comment,
  // search_index, project_time_summary, time_report — each `WHERE
  // project_id = …` in scan order, sharing an order with nobody.
  // `modules/work/rank-lock.ts` has listed it since slice 7 as a KNOWN
  // LOCKER OUTSIDE THE QUEUE, able to deadlock WITH a queued writer.
  //
  // JOINING THAT QUEUE WAS TRIED ON 2026-09-20 AND REJECTED. It covers
  // ONE of the ten legs — milestones queue on a different key
  // (`milestone_rank:`) and the other eight tables have no queue at all
  // — while converting a targeted wait on the rows that actually
  // conflict into a project-wide wait on anything queued. It would also
  // have made `rank-lock.ts`'s own invariant false, since no queued
  // writer has ever locked a document or comment row and this one would
  // lock both.
  //
  // THE OTHER SHAPE, which slice 40 named and left open and slice 43
  // closes. Contention here is not always a cycle. A bulk edit holds
  // `FOR NO KEY UPDATE` on every selected `work_item` row to commit,
  // and the fan-out's own UPDATE wants the same conflicting mode — so
  // it simply BLOCKS. No cycle, no 40P01, nothing for `isDeadlock` to
  // match.
  //
  // AND IT IS WORSE THAN THIS FUNCTION USED TO CLAIM, which is the
  // finding slice 43 did not expect. The comment here, `rank-lock.ts`
  // and PLAN §0 all said an unbounded wait "dies as P2028 at
  // `withTenant`'s 5 s budget". It does not. MEASURED, by removing the
  // bound and shrinking the transaction budget to 3 s with a row lock
  // held against it: the call was still waiting past 30 s. Prisma's
  // interactive-transaction timeout is enforced around the queries it
  // issues, not inside one the DATABASE has parked. Nor did anything
  // else bound it, checked in `pg_settings` on the real datasource
  // rather than assumed: `lock_timeout` 0 and `statement_timeout` 0,
  // both from `source = 'default'` with nothing set on the database or
  // on `app_runtime`, and the one bound that IS configured —
  // `idle_in_transaction_session_timeout`, 5 min — catches a
  // transaction sitting IDLE, never one actively waiting on a lock. So
  // the real pre-slice behaviour of this control was
  // not a 5 s failure: it was a request that hung until whatever sits
  // above it gave up, holding every lock the fan-out had already taken
  // for all of it. A starved portal switch was a blocker for everyone
  // else, for as long as the starving lasted.
  //
  // So it now asks for a bound. `lockTimeoutMs` makes a wait end at a
  // known point in an error `retryOnContention` can tell apart, and
  // when the attempts are spent against ONE holder per leg — the shape
  // this was built for — the member is TOLD (PORTAL_SWITCH_BUSY)
  // rather than shown a 500. Nothing was written, the whole transaction
  // rolled back, so "try again" is the truth and the whole remedy. See
  // PORTAL_LOCK_WAIT_MS for the case that bound cannot cover.
  //
  // WHY NOT SIMPLY WAIT IT OUT with a budget long enough to outlast any
  // bulk edit: this is the emergency "stop showing this client our
  // data" control. A switch that hangs indefinitely and then either
  // works or does not is worse than one that comes back and says which
  // — typically in about three lock waits (~4.5 s), and bounded by
  // attempts × the transaction budget, not by "seconds", which the
  // first draft of this claimed (review). The member can press it
  // again, and while it waits it
  // holds locks that make everything else on the project slower, which
  // is the opposite of what an emergency control should do. The OFF
  // direction gets no longer allowance than ON for the same reason.
  //
  // THE BUDGET IS DERIVED, NOT PICKED — see PORTAL_LOCK_WAIT_MS above
  // for why the two numbers are related rather than chosen separately.
  //
  // AND THE FAN-OUT ITSELF GOT FASTER in the same slice (migration
  // 20260920190000): two of its ten legs — work_item_activity, the
  // fastest-growing table in the product, and service — had NO index
  // the `project_id` predicate could use, so each scanned the tenant's
  // whole history of that table. A leg that scans is a leg that holds
  // its locks longer, so the widest window for this contention was one
  // this function was opening itself.
  //
  // Safe to re-run on either shape because Postgres has already rolled
  // the attempt back — the re-run redoes the permission check, the
  // scope check and the `changed` read from scratch, so the audit row
  // can never describe a transition that did not happen.
  try {
    return await retryOnContention(() => withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "project:manage_portal");
      const p = await loadInScope(tx, ctx.actor, projectId);
      if (p.portalEnabled === enabled) return { changed: false };
      await tx.project.update({ where: { id: projectId }, data: { portalEnabled: enabled } });
      await record(tx, {
        action: enabled ? "project.portal_enabled" : "project.portal_disabled",
        targetType: "Project",
        targetId: projectId,
      });
      return { changed: true };
    }, { timeoutMs: PORTAL_TX_MS, lockTimeoutMs: PORTAL_LOCK_WAIT_MS }));
  } catch (e) {
    // BOTH shapes `retryOnContention` retried, not just the new one
    // (review): a deadlock that survives three attempts means exactly
    // what a spent lock timeout means — nothing was written, try again
    // — and letting it through raw put a 500 on the emergency control.
    // The detail never reaches the member (`messageForError` renders
    // `t(e.code)`); it is the breadcrumb that says WHICH shape spent
    // its attempts, for whoever reads the server log.
    if (isLockTimeout(e)) fail("PORTAL_SWITCH_BUSY", "lock timeout");
    if (isDeadlock(e)) fail("PORTAL_SWITCH_BUSY", "deadlock");
    throw e;
  }
}

/** project:manage_portal (was project:edit until 2026-09-21) — CONTACT_PRIMARY hours widget mode. */
export async function setHoursSharingMode(
  ctx: ProjectCtx,
  projectId: string,
  mode: HoursSharingMode,
): Promise<{ changed: boolean }> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "project:manage_portal");
    const p = await loadInScope(tx, ctx.actor, projectId);
    if (p.hoursSharingMode === mode) return { changed: false };
    await tx.project.update({ where: { id: projectId }, data: { hoursSharingMode: mode } });
    await record(tx, {
      action: "project.hours_sharing_changed",
      targetType: "Project",
      targetId: projectId,
      metadata: { from: p.hoursSharingMode, to: mode },
    });
    return { changed: true };
  });
}

/** project:edit — audited project.key_changed; old keys are NOT redirected in v1. */
export async function changeProjectKey(
  ctx: ProjectCtx,
  projectId: string,
  rawKey: string,
): Promise<{ key: string; changed: boolean }> {
  const key = normalizeProjectKey(rawKey);
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "project:edit");
    const p = await loadInScope(tx, ctx.actor, projectId);
    if (p.key === key) return { key, changed: false };
    const taken = await tx.project.findFirst({ where: { key }, select: { id: true } });
    if (taken) fail("KEY_TAKEN", key);
    try {
      await tx.project.update({ where: { id: projectId }, data: { key } });
    } catch (e) {
      if (isUniqueViolation(e)) fail("KEY_TAKEN", key);
      throw e;
    }
    await record(tx, {
      action: "project.key_changed",
      targetType: "Project",
      targetId: projectId,
      metadata: { from: p.key, to: key },
    });
    return { key, changed: true };
  });
}

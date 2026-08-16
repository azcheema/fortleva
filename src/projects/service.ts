import { record } from "@/audit/record";
import {
  assertInScope,
  effectivePermissions,
  scopeWhere,
  type MemberActor,
} from "@/authz/authorize";
import { deny } from "@/authz/errors";
import { clean } from "@/clients/service";
import { withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import type {
  HoursSharingMode,
  MilestoneStatus,
  ProjectStatus,
  ProjectVersionStatus,
  UpdateCadence,
  Visibility,
} from "@/generated/prisma/enums";
import { fail, isUniqueViolation } from "@/lib/domain-error";
import { newId } from "@/lib/ids";

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
 * THE project-level portal gate (TENANCY.md §7.2). Writes ONLY
 * Project.portalEnabled — the trigger fans out to every projectScoped
 * child. Permission: project:edit for now; the plan introduces
 * project:manage_portal in Phase 3 (catalog stays 63 in Phase 2) — swap
 * the code here when it lands.
 */
export async function setPortalEnabled(
  ctx: ProjectCtx,
  projectId: string,
  enabled: boolean,
): Promise<{ changed: boolean }> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "project:edit");
    const p = await loadInScope(tx, ctx.actor, projectId);
    if (p.portalEnabled === enabled) return { changed: false };
    await tx.project.update({ where: { id: projectId }, data: { portalEnabled: enabled } });
    await record(tx, {
      action: enabled ? "project.portal_enabled" : "project.portal_disabled",
      targetType: "Project",
      targetId: projectId,
    });
    return { changed: true };
  });
}

/** project:edit (project:manage_portal in Phase 3) — CONTACT_PRIMARY hours widget mode. */
export async function setHoursSharingMode(
  ctx: ProjectCtx,
  projectId: string,
  mode: HoursSharingMode,
): Promise<{ changed: boolean }> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "project:edit");
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

import { record } from "@/audit/record";
import { withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { fail } from "@/lib/domain-error";

import { guarded } from "./db-errors";
import { principalOf, type WorkCtx } from "./states";
import type { UpdateMetricsInclude } from "./update-body";
import {
  cleanLayoutName,
  parseLayoutMetrics,
  parseLayoutSections,
  readLayout,
  STANDARD_LAYOUT,
  type LayoutHeading,
  type UpdateLayout,
} from "./update-layout";

/**
 * THE WORKSPACE'S PROGRESS-UPDATE LAYOUTS (Phase 5 slice 105; founder
 * decision C73 (c), (d), (g); DATA_MODEL.md §6.16 `ProjectUpdateTemplate`).
 *
 * A workspace keeps several named layouts; at most one is its default; each
 * project may pick one (`project.update_template_id`, through `updateProject`
 * under `project:edit`), else it uses the default, else Fortleva standard.
 * Owners and admins edit them — `settings:edit`, a workspace act with no
 * scope, as work types are; anyone who may open Settings reads the list
 * (`settings:view`). The project page reads the names under `project:view`
 * itself (`getProjectByKey`), so the people who may pick one can see them.
 *
 * Every mutation is `requireAccess → mutate → audit` in one transaction; the
 * database holds the names (case-insensitive UNIQUE), the one default
 * (partial UNIQUE) and the projects' pick (RESTRICT key) against races, each
 * mapped to a sentence by `guarded` (`db-errors.ts`).
 */

export type UpdateTemplateRow = {
  readonly id: string;
  readonly name: string;
  readonly sections: readonly LayoutHeading[];
  readonly metrics: UpdateMetricsInclude;
  readonly isDefault: boolean;
  /** Projects not archived that picked this layout. */
  readonly projectCount: number;
};

export type UpdateTemplateInput = {
  readonly name: unknown;
  readonly sections: unknown;
  readonly metrics: unknown;
};

const nameOf = (raw: unknown): string => {
  const name = cleanLayoutName(raw);
  if (name === null) fail(typeof raw === "string" && raw.trim() === "" ? "NAME_REQUIRED" : "INVALID_INPUT", "layout name");
  return name!;
};

/**
 * A name the workspace already uses, whatever its case — asked first, so the
 * UNIQUE is only the race's belt. Raw `lower(name) = lower($1)`, the index's
 * own expression: Prisma's insensitive `equals` compiles to an unescaped
 * `ILIKE`, where a `_` or `%` in a name is a wildcard and "Q_A review" would
 * clash with "QxA review" (the code review's L1).
 */
async function assertNameFree(tx: TenantDb, tenantId: string, name: string, exceptId: string | null): Promise<void> {
  const clash = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM project_update_template
    WHERE tenant_id = ${tenantId} AND lower(name) = lower(${name}) AND id IS DISTINCT FROM ${exceptId}
    LIMIT 1`;
  if (clash.length > 0) fail("LAYOUT_NAME_TAKEN");
}

/** settings:view — the Settings page's list, the default first, then by name. */
export async function listUpdateTemplates(ctx: WorkCtx): Promise<UpdateTemplateRow[]> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "settings:view");
    const rows = await tx.projectUpdateTemplate.findMany({
      where: { tenantId: ctx.tenantId },
      select: { id: true, name: true, sections: true, metricsIncluded: true, isDefault: true },
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    });
    const counts = await tx.project.groupBy({
      by: ["updateTemplateId"],
      where: { tenantId: ctx.tenantId, updateTemplateId: { not: null }, status: { not: "ARCHIVED" } },
      _count: { _all: true },
    });
    const countOf = new Map(counts.map((c) => [c.updateTemplateId, c._count._all]));
    return rows.map((r) => {
      const layout = readLayout(r);
      return {
        id: r.id,
        name: r.name,
        sections: layout.sections,
        metrics: layout.metrics,
        isDefault: r.isDefault,
        projectCount: countOf.get(r.id) ?? 0,
      };
    });
  });
}

/** settings:edit — a new layout; not the default until someone makes it so. */
export async function createUpdateTemplate(ctx: WorkCtx, input: UpdateTemplateInput): Promise<{ id: string; name: string }> {
  const name = nameOf(input.name);
  const sections = parseLayoutSections(input.sections);
  const metrics = parseLayoutMetrics(input.metrics);
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "settings:edit");
      await assertNameFree(tx, ctx.tenantId, name, null);
      const row = await tx.projectUpdateTemplate.create({
        data: { tenantId: ctx.tenantId, name, sections, metricsIncluded: metrics },
        select: { id: true, name: true },
      });
      await record(tx, { action: "project_update_template.created", targetType: "ProjectUpdateTemplate", targetId: row.id });
      return row;
    }),
  );
}

/**
 * settings:edit — rename, re-order its headings, change its numbers. Drafts and
 * posts never change with it. Only what CHANGED is written and audited (the
 * dialog sends all three every time; the code review's nit): an edit that
 * changes nothing writes nothing.
 */
export async function updateUpdateTemplate(
  ctx: WorkCtx,
  id: string,
  input: Partial<UpdateTemplateInput>,
): Promise<{ id: string; name: string }> {
  const asked: { name?: string; sections?: LayoutHeading[]; metricsIncluded?: UpdateMetricsInclude } = {};
  if (input.name !== undefined) asked.name = nameOf(input.name);
  if (input.sections !== undefined) asked.sections = parseLayoutSections(input.sections);
  if (input.metrics !== undefined) asked.metricsIncluded = parseLayoutMetrics(input.metrics);
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "settings:edit");
      const existing = await tx.projectUpdateTemplate.findFirst({
        where: { tenantId: ctx.tenantId, id },
        select: { id: true, name: true, sections: true, metricsIncluded: true },
      });
      if (!existing) fail("INVALID_INPUT", "unknown layout");
      const stored = readLayout(existing!);
      const data: typeof asked = {};
      if (asked.name !== undefined && asked.name !== existing!.name) data.name = asked.name;
      if (asked.sections !== undefined && JSON.stringify(asked.sections) !== JSON.stringify(stored.sections)) {
        data.sections = asked.sections;
      }
      if (asked.metricsIncluded !== undefined && JSON.stringify(asked.metricsIncluded) !== JSON.stringify(stored.metrics)) {
        data.metricsIncluded = asked.metricsIncluded;
      }
      if (Object.keys(data).length === 0) return { id, name: existing!.name };
      if (data.name !== undefined) await assertNameFree(tx, ctx.tenantId, data.name, id);
      const row = await tx.projectUpdateTemplate.update({ where: { id }, data, select: { id: true, name: true } });
      await record(tx, {
        action: "project_update_template.updated",
        targetType: "ProjectUpdateTemplate",
        targetId: id,
        metadata: { fields: Object.keys(data).map((k) => (k === "metricsIncluded" ? "metrics" : k)) },
      });
      return row;
    }),
  );
}

/**
 * settings:edit — delete a layout. Its projects go back to the default first,
 * in this transaction (the project's key RESTRICTs the delete otherwise), and
 * ALL of them — archived ones too, which the key sees as well (the migration
 * review's L2). The row is locked first, so a project picking it at the same
 * moment waits and is then refused (`LAYOUT_BUSY`), never left pointing at
 * nothing.
 */
export async function deleteUpdateTemplate(ctx: WorkCtx, id: string): Promise<{ projectsReset: number }> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "settings:edit");
      const locked = await tx.$queryRaw<{ id: string; is_default: boolean }[]>`
        SELECT id, is_default FROM project_update_template WHERE tenant_id = ${ctx.tenantId} AND id = ${id} FOR UPDATE`;
      if (locked.length === 0) fail("INVALID_INPUT", "unknown layout");
      const { count } = await tx.project.updateMany({
        where: { tenantId: ctx.tenantId, updateTemplateId: id },
        data: { updateTemplateId: null },
      });
      await tx.projectUpdateTemplate.delete({ where: { id }, select: { id: true } });
      await record(tx, {
        action: "project_update_template.deleted",
        targetType: "ProjectUpdateTemplate",
        targetId: id,
        metadata: { projectsReset: count, wasDefault: locked[0]!.is_default },
      });
      return { projectsReset: count };
    }),
  );
}

/**
 * settings:edit — which layout is the workspace's default; null = Fortleva
 * standard. Every layout row of the workspace is locked first, so two members
 * making different defaults at once queue rather than collide (the partial
 * UNIQUE is the belt).
 */
export async function setDefaultUpdateTemplate(ctx: WorkCtx, id: string | null): Promise<{ changed: boolean }> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "settings:edit");
      const rows = await tx.$queryRaw<{ id: string; is_default: boolean }[]>`
        SELECT id, is_default FROM project_update_template WHERE tenant_id = ${ctx.tenantId} ORDER BY id FOR UPDATE`;
      if (id !== null && !rows.some((r) => r.id === id)) fail("INVALID_INPUT", "unknown layout");
      const from = rows.find((r) => r.is_default)?.id ?? null;
      if (from === id) return { changed: false };
      if (from !== null) {
        await tx.projectUpdateTemplate.update({ where: { id: from }, data: { isDefault: false }, select: { id: true } });
      }
      if (id !== null) {
        await tx.projectUpdateTemplate.update({ where: { id }, data: { isDefault: true }, select: { id: true } });
      }
      await record(tx, {
        action: "project_update_template.default_changed",
        targetType: "ProjectUpdateTemplate",
        targetId: id ?? from ?? undefined,
        metadata: { from, to: id },
      });
      return { changed: true };
    }),
  );
}

/**
 * The layout a project's NEW update opens with: the one it picked, else the
 * workspace's default, else Fortleva standard. Read inside the caller's gated
 * transaction (`readComposerContext`, `project_update:create`) — a layout is a
 * workspace setting with nothing secret in it.
 */
export async function resolveUpdateLayout(
  tx: TenantDb,
  tenantId: string,
  projectTemplateId: string | null,
): Promise<{ readonly layout: UpdateLayout; readonly name: string | null }> {
  const picked = projectTemplateId
    ? await tx.projectUpdateTemplate.findFirst({
        where: { tenantId, id: projectTemplateId },
        select: { name: true, sections: true, metricsIncluded: true },
      })
    : null;
  const row =
    picked ??
    (await tx.projectUpdateTemplate.findFirst({
      where: { tenantId, isDefault: true },
      select: { name: true, sections: true, metricsIncluded: true },
    }));
  return row ? { layout: readLayout(row), name: row.name } : { layout: STANDARD_LAYOUT, name: null };
}

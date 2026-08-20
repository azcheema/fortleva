import { record } from "@/audit/record";
import { withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { fail } from "@/lib/domain-error";

import { guarded, principalOf, type TimeCtx } from "./ctx";

/**
 * WorkType (D5): a tenant-editable time category — a lookup table, not
 * an enum, and NOT rate-bearing. defaultBillable (nullable) seeds
 * TimeEntry.billable (explicit choice → type → project default).
 * Seeded per tenant in the tenant's default locale; names unique among
 * live rows; archived rows stay on history and leave pickers.
 */

type Seed = { readonly name: string; readonly defaultBillable: boolean | null };

export const WORK_TYPE_SEEDS: Readonly<Record<"en" | "sv", readonly Seed[]>> = {
  en: [
    { name: "Client development", defaultBillable: null },
    { name: "Internal product development", defaultBillable: false },
    { name: "Consultancy", defaultBillable: null },
    { name: "Meeting", defaultBillable: null },
    { name: "Learning", defaultBillable: false },
    { name: "Marketing", defaultBillable: false },
  ],
  sv: [
    { name: "Kundutveckling", defaultBillable: null },
    { name: "Intern produktutveckling", defaultBillable: false },
    { name: "Konsultation", defaultBillable: null },
    { name: "Möte", defaultBillable: null },
    { name: "Lärande", defaultBillable: false },
    { name: "Marknadsföring", defaultBillable: false },
  ],
};

/** Lazy, idempotent seed (first use of the time module in a tenant). */
export async function ensureWorkTypes(tx: TenantDb, tenantId: string): Promise<boolean> {
  const existing = await tx.workType.count({ where: { tenantId } });
  if (existing > 0) return false;
  const tenant = await tx.tenant.findFirst({ where: { id: tenantId }, select: { defaultLocale: true } });
  const seeds = WORK_TYPE_SEEDS[tenant?.defaultLocale === "sv" ? "sv" : "en"];
  const { count } = await tx.workType.createMany({
    data: seeds.map((s, i) => ({
      tenantId,
      name: s.name,
      sortOrder: i,
      defaultBillable: s.defaultBillable,
    })),
    skipDuplicates: true,
  });
  return count > 0;
}

export type WorkTypeRow = {
  id: string;
  name: string;
  sortOrder: number;
  defaultBillable: boolean | null;
  archivedAt: Date | null;
};

const select = { id: true, name: true, sortOrder: true, defaultBillable: true, archivedAt: true } as const;

/** time:track — the picker list (live rows in order; archived on request). */
export async function listWorkTypes(
  ctx: TimeCtx,
  opts?: { includeArchived?: boolean },
): Promise<WorkTypeRow[]> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "time:track");
    return tx.workType.findMany({
      where: { tenantId: ctx.tenantId, ...(opts?.includeArchived ? {} : { archivedAt: null }) },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select,
    });
  });
}

const cleanName = (name: string): string => {
  const n = name.trim();
  if (n === "") fail("NAME_REQUIRED");
  return n;
};

/** work_type:manage */
export async function createWorkType(
  ctx: TimeCtx,
  input: { name: string; defaultBillable?: boolean | null },
): Promise<WorkTypeRow> {
  const name = cleanName(input.name);
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "work_type:manage");
      const last = await tx.workType.findFirst({
        where: { tenantId: ctx.tenantId },
        orderBy: { sortOrder: "desc" },
        select: { sortOrder: true },
      });
      const row = await tx.workType.create({
        data: {
          tenantId: ctx.tenantId,
          name,
          sortOrder: (last?.sortOrder ?? -1) + 1,
          defaultBillable: input.defaultBillable ?? null,
          createdByMemberId: ctx.actor.memberId,
        },
        select,
      });
      await record(tx, { action: "work_type.created", targetType: "WorkType", targetId: row.id });
      return row;
    }),
  );
}

/** work_type:manage — rename / default-billable / order. */
export async function updateWorkType(
  ctx: TimeCtx,
  id: string,
  patch: { name?: string; defaultBillable?: boolean | null; sortOrder?: number },
): Promise<WorkTypeRow> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "work_type:manage");
      const existing = await tx.workType.findFirst({ where: { tenantId: ctx.tenantId, id }, select });
      if (!existing) fail("INVALID_INPUT", "unknown work type");
      const data: { name?: string; defaultBillable?: boolean | null; sortOrder?: number } = {};
      if (patch.name !== undefined) data.name = cleanName(patch.name);
      if (patch.defaultBillable !== undefined) data.defaultBillable = patch.defaultBillable;
      if (patch.sortOrder !== undefined) data.sortOrder = Math.max(0, Math.floor(patch.sortOrder));
      const row = await tx.workType.update({ where: { id }, data, select });
      await record(tx, {
        action: "work_type.updated",
        targetType: "WorkType",
        targetId: id,
        metadata: { fields: Object.keys(data) },
      });
      return row;
    }),
  );
}

/** work_type:manage — archive (leaves pickers, stays on history) or restore. */
export async function setWorkTypeArchived(ctx: TimeCtx, id: string, archived: boolean): Promise<void> {
  await withTenant(ctx.tenantId, principalOf(ctx), async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "work_type:manage");
      const existing = await tx.workType.findFirst({ where: { tenantId: ctx.tenantId, id }, select });
      if (!existing) fail("INVALID_INPUT", "unknown work type");
      if ((existing!.archivedAt !== null) === archived) return;
      await tx.workType.update({ where: { id }, data: { archivedAt: archived ? new Date() : null } });
      await record(tx, {
        action: archived ? "work_type.archived" : "work_type.updated",
        targetType: "WorkType",
        targetId: id,
        metadata: archived ? {} : { fields: ["archivedAt"], restored: true },
      });
    }),
  );
}

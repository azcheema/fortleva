import { assertInScope } from "@/authz/authorize";
import type { TenantDb } from "@/db";
import { fail } from "@/lib/domain-error";
import type { TenantPreferences } from "@/preferences/service";

import type { TimeCtx } from "./ctx";
import { cleanDescription } from "./description";
import { resolveRateSnapshot, type RateSnapshot } from "./rates";

/**
 * What an entry is ABOUT, resolved once for timer start, manual create,
 * continue and edit (D2 + D4 + D5):
 *  - a work item implies its project; a project implies its client
 *    (the scope guard trigger re-derives client_id regardless);
 *  - the agreement defaults from Project.defaultServiceId and must
 *    belong to the same client (and project, when project-scoped);
 *  - billable seeds explicit choice → workType.defaultBillable →
 *    project.defaultBillable; an ad-hoc (project-less) entry is forced
 *    non-billable and must carry a description;
 *  - scope is asserted on the project (deny-default; NOT_FOUND).
 */

export type EntryTargetInput = {
  readonly projectId?: string | null;
  readonly workItemId?: string | null;
  readonly serviceId?: string | null;
  readonly workTypeId?: string | null;
  readonly billable?: boolean | null;
  readonly description?: string | null;
};

export type ResolvedTarget = {
  projectId: string | null;
  clientId: string | null;
  workItemId: string | null;
  serviceId: string | null;
  workTypeId: string | null;
  billable: boolean;
  description: string | null;
  /** Project billing currency (or the tenant default) — the entry's currency when billable. */
  currency: string;
};

export async function resolveTarget(
  tx: TenantDb,
  ctx: TimeCtx,
  input: EntryTargetInput,
  prefs: TenantPreferences,
): Promise<ResolvedTarget> {
  const description = cleanDescription(input.description);
  let projectId = input.projectId ?? null;
  const workItemId = input.workItemId ?? null;

  if (workItemId) {
    const item = await tx.workItem.findFirst({
      where: { tenantId: ctx.tenantId, id: workItemId, deletedAt: null },
      select: { projectId: true },
    });
    if (!item) fail("INVALID_INPUT", "unknown work item");
    if (projectId && projectId !== item!.projectId) fail("TARGET_MISMATCH");
    projectId = item!.projectId;
  }

  if (projectId === null) {
    // Ad-hoc "instant task" (D2): description-only, forced non-billable.
    if (!prefs.time.allowAdhocEntries) fail("ADHOC_DISABLED");
    if (!description) fail("DESCRIPTION_REQUIRED");
    if (input.serviceId) fail("SERVICE_CLIENT_MISMATCH", "an agreement implies client work");
    const workTypeId = await resolveWorkType(tx, ctx.tenantId, input.workTypeId ?? null);
    return {
      projectId: null,
      clientId: null,
      workItemId: null,
      serviceId: null,
      workTypeId,
      billable: false,
      description,
      currency: prefs.currencyDefault,
    };
  }

  await assertInScope(tx, ctx.actor, { projectId });
  const project = await tx.project.findFirst({
    where: { tenantId: ctx.tenantId, id: projectId },
    select: {
      clientId: true,
      defaultBillable: true,
      billingCurrency: true,
      defaultServiceId: true,
      archivedAt: true,
    },
  });
  if (!project) fail("INVALID_INPUT", "unknown project");
  if (project!.archivedAt) fail("ARCHIVED");
  if (!workItemId && !description) {
    fail(prefs.time.allowEntriesWithoutItem ? "DESCRIPTION_REQUIRED" : "ITEM_REQUIRED");
  }
  if (!workItemId && !prefs.time.allowEntriesWithoutItem) fail("ITEM_REQUIRED");

  const serviceId = input.serviceId === undefined ? project!.defaultServiceId : input.serviceId;
  if (serviceId) {
    const service = await tx.service.findFirst({
      where: { tenantId: ctx.tenantId, id: serviceId },
      select: { clientId: true, projectId: true },
    });
    if (!service || service.clientId !== project!.clientId || (service.projectId && service.projectId !== projectId)) {
      fail("SERVICE_CLIENT_MISMATCH");
    }
  }
  const workTypeId = await resolveWorkType(tx, ctx.tenantId, input.workTypeId ?? null);
  const workType = workTypeId
    ? await tx.workType.findFirst({ where: { tenantId: ctx.tenantId, id: workTypeId }, select: { defaultBillable: true } })
    : null;
  const billable = input.billable ?? workType?.defaultBillable ?? project!.defaultBillable;

  return {
    projectId,
    clientId: project!.clientId,
    workItemId,
    serviceId: serviceId ?? null,
    workTypeId,
    billable,
    description,
    currency: project!.billingCurrency ?? prefs.currencyDefault,
  };
}

async function resolveWorkType(tx: TenantDb, tenantId: string, workTypeId: string | null): Promise<string | null> {
  if (!workTypeId) return null;
  const wt = await tx.workType.findFirst({ where: { tenantId, id: workTypeId, archivedAt: null }, select: { id: true } });
  if (!wt) fail("INVALID_INPUT", "unknown or archived work type");
  return wt!.id;
}

/** The rate snapshot for a resolved target on a given local date. */
export async function snapshotFor(
  tx: TenantDb,
  tenantId: string,
  memberId: string,
  target: ResolvedTarget,
  localDate: Date,
): Promise<RateSnapshot> {
  return resolveRateSnapshot(tx, {
    tenantId,
    memberId,
    projectId: target.projectId,
    serviceId: target.serviceId,
    localDate,
    billable: target.billable,
  });
}

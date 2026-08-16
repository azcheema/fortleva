import { record } from "@/audit/record";
import { assertInScope, scopeWhere, type MemberActor } from "@/authz/authorize";
import { deny } from "@/authz/errors";
import { clean } from "@/clients/service";
import { withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import type {
  BillingInterval,
  ServiceKind,
  ServiceStatus,
  Visibility,
} from "@/generated/prisma/enums";
import { fail } from "@/lib/domain-error";
import { newId } from "@/lib/ids";

/**
 * Services — what the client buys, as a RECORD with renewal dates
 * (DATA_MODEL.md §6.6); no billing engine (Phase 4). Client-level rows
 * (projectId null) are reachable through DIRECT client scope only;
 * project-level rows through the project axis. internalNotes is
 * INTERNAL-ONLY. Permissions service:*; audit service.*.
 */

export type ServiceCtx = {
  readonly tenantId: string;
  /** From requireTenantContext() — never from form params. */
  readonly actor: MemberActor;
};

const principalOf = (ctx: ServiceCtx) =>
  ({ type: "member", id: ctx.actor.memberId }) as const;

export type ServiceRow = {
  id: string;
  clientId: string;
  projectId: string | null;
  projectKey: string | null;
  name: string;
  description: string | null;
  kind: ServiceKind;
  billingInterval: BillingInterval | null;
  /** Decimal(12,2) as a string — never a float on the wire. */
  priceExVat: string | null;
  currency: string | null;
  status: ServiceStatus;
  startedAt: Date | null;
  renewsAt: Date | null;
  endsAt: Date | null;
  internalNotes: string | null;
  visibility: Visibility;
  updatedAt: Date;
};

const toRow = (s: {
  id: string;
  clientId: string;
  projectId: string | null;
  project: { key: string } | null;
  name: string;
  description: string | null;
  kind: ServiceKind;
  billingInterval: BillingInterval | null;
  priceExVat: { toString(): string } | null;
  currency: string | null;
  status: ServiceStatus;
  startedAt: Date | null;
  renewsAt: Date | null;
  endsAt: Date | null;
  internalNotes: string | null;
  visibility: Visibility;
  updatedAt: Date;
}): ServiceRow => ({
  id: s.id,
  clientId: s.clientId,
  projectId: s.projectId,
  projectKey: s.project?.key ?? null,
  name: s.name,
  description: s.description,
  kind: s.kind,
  billingInterval: s.billingInterval,
  priceExVat: s.priceExVat === null ? null : s.priceExVat.toString(),
  currency: s.currency,
  status: s.status,
  startedAt: s.startedAt,
  renewsAt: s.renewsAt,
  endsAt: s.endsAt,
  internalNotes: s.internalNotes,
  visibility: s.visibility,
  updatedAt: s.updatedAt,
});

/**
 * service:view. `clientId` lists the client's services (client-level ∪
 * its projects' — each under its own scope term); `projectId` lists one
 * project's. Neither ⇒ every service in scope.
 */
export async function listServices(
  ctx: ServiceCtx,
  filter: { clientId?: string; projectId?: string } = {},
): Promise<ServiceRow[]> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "service:view");
    const clientScope = await scopeWhere(tx, ctx.actor, { clientField: "clientId" });
    const projectScope = await scopeWhere(tx, ctx.actor, {
      clientField: "clientId",
      projectField: "projectId",
    });
    const rows = await tx.service.findMany({
      where: {
        ...(filter.clientId ? { clientId: filter.clientId } : {}),
        ...(filter.projectId ? { projectId: filter.projectId } : {}),
        OR: [
          { projectId: null, ...clientScope },
          { projectId: { not: null }, ...projectScope },
        ],
      },
      orderBy: [{ status: "asc" }, { renewsAt: "asc" }, { name: "asc" }],
      include: { project: { select: { key: true } } },
    });
    return rows.map(toRow);
  });
}

const assertTarget = async (
  tx: TenantDb,
  actor: MemberActor,
  clientId: string,
  projectId: string | null,
): Promise<void> => {
  if (projectId) {
    await assertInScope(tx, actor, { projectId });
    const p = await tx.project.findFirst({ where: { id: projectId }, select: { clientId: true } });
    if (!p) deny("NOT_FOUND");
    if (p!.clientId !== clientId) fail("CLIENT_MISMATCH");
  } else {
    await assertInScope(tx, actor, { clientId });
  }
};

/** Decimal(12,2) input: "1 200,50" / "1200.50" ⇒ "1200.50"; null clears. */
export const parsePrice = (raw: string | null | undefined): string | null => {
  const s = clean(raw);
  if (s === null) return null;
  const normalized = s.replace(/\s/g, "").replace(",", ".");
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(normalized)) fail("INVALID_INPUT", "price");
  return normalized;
};

export type ServiceInput = {
  clientId: string;
  projectId?: string | null;
  name: string;
  description?: string | null;
  kind: ServiceKind;
  billingInterval?: BillingInterval | null;
  priceExVat?: string | null;
  currency?: string | null;
  startedAt?: Date | null;
  renewsAt?: Date | null;
  endsAt?: Date | null;
  internalNotes?: string | null;
  visibility?: Visibility;
};

/** service:create; scoped on the project (if any) else the client, directly. */
export async function createService(ctx: ServiceCtx, input: ServiceInput): Promise<{ id: string }> {
  const name = clean(input.name);
  if (!name) fail("NAME_REQUIRED");
  const price = parsePrice(input.priceExVat);
  const currency = clean(input.currency)?.toUpperCase() ?? null;
  if (currency && !/^[A-Z]{3}$/.test(currency)) fail("INVALID_INPUT", "currency");
  const id = newId();
  await withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "service:create");
    await assertTarget(tx, ctx.actor, input.clientId, input.projectId ?? null);
    await tx.service.create({
      data: {
        id,
        tenantId: ctx.tenantId,
        clientId: input.clientId,
        projectId: input.projectId ?? null,
        name: name!,
        description: clean(input.description),
        kind: input.kind,
        billingInterval: input.kind === "RECURRING" ? (input.billingInterval ?? "MONTHLY") : null,
        priceExVat: price,
        currency,
        startedAt: input.startedAt ?? null,
        renewsAt: input.kind === "RECURRING" ? (input.renewsAt ?? null) : null,
        endsAt: input.endsAt ?? null,
        internalNotes: clean(input.internalNotes),
        visibility: input.visibility ?? "INTERNAL",
      },
    });
    await record(tx, {
      action: "service.created",
      targetType: "Service",
      targetId: id,
      metadata: { clientId: input.clientId, projectId: input.projectId ?? null, kind: input.kind },
    });
  });
  return { id };
}

export type ServicePatch = Partial<Omit<ServiceInput, "clientId" | "projectId">>;

/** service:edit — changed field NAMES in the audit row (never internalNotes' value). */
export async function updateService(
  ctx: ServiceCtx,
  serviceId: string,
  patch: ServicePatch,
): Promise<{ changed: string[] }> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "service:edit");
    const s = await tx.service.findFirst({ where: { id: serviceId } });
    if (!s) deny("NOT_FOUND");
    await assertTarget(tx, ctx.actor, s!.clientId, s!.projectId);
    const data: Record<string, unknown> = {};
    const changed: string[] = [];
    const set = (field: string, next: unknown, cur: unknown) => {
      const same =
        next instanceof Date && cur instanceof Date
          ? next.getTime() === cur.getTime()
          : next === cur;
      if (!same) {
        data[field] = next;
        changed.push(field);
      }
    };
    if ("name" in patch) {
      const name = clean(patch.name);
      if (!name) fail("NAME_REQUIRED");
      set("name", name, s!.name);
    }
    if ("description" in patch) set("description", clean(patch.description), s!.description);
    if ("kind" in patch && patch.kind) set("kind", patch.kind, s!.kind);
    if ("billingInterval" in patch) set("billingInterval", patch.billingInterval ?? null, s!.billingInterval);
    if ("priceExVat" in patch) {
      set("priceExVat", parsePrice(patch.priceExVat), s!.priceExVat === null ? null : s!.priceExVat.toString());
    }
    if ("currency" in patch) {
      const currency = clean(patch.currency)?.toUpperCase() ?? null;
      if (currency && !/^[A-Z]{3}$/.test(currency)) fail("INVALID_INPUT", "currency");
      set("currency", currency, s!.currency);
    }
    if ("startedAt" in patch) set("startedAt", patch.startedAt ?? null, s!.startedAt);
    if ("renewsAt" in patch) set("renewsAt", patch.renewsAt ?? null, s!.renewsAt);
    if ("endsAt" in patch) set("endsAt", patch.endsAt ?? null, s!.endsAt);
    if ("internalNotes" in patch) set("internalNotes", clean(patch.internalNotes), s!.internalNotes);
    if ("visibility" in patch && patch.visibility) set("visibility", patch.visibility, s!.visibility);
    if (changed.length === 0) return { changed };
    await tx.service.update({ where: { id: serviceId }, data });
    await record(tx, {
      action: "service.updated",
      targetType: "Service",
      targetId: serviceId,
      metadata: { clientId: s!.clientId, fields: changed },
    });
    return { changed };
  });
}

/** service:edit — status ENDED with endsAt (default now); PAUSED/ACTIVE via setServiceStatus. */
export async function setServiceStatus(
  ctx: ServiceCtx,
  serviceId: string,
  status: ServiceStatus,
): Promise<{ changed: boolean }> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "service:edit");
    const s = await tx.service.findFirst({ where: { id: serviceId } });
    if (!s) deny("NOT_FOUND");
    await assertTarget(tx, ctx.actor, s!.clientId, s!.projectId);
    if (s!.status === status) return { changed: false };
    await tx.service.update({
      where: { id: serviceId },
      data: { status, ...(status === "ENDED" ? { endsAt: s!.endsAt ?? new Date() } : {}) },
    });
    await record(tx, {
      action: status === "ENDED" ? "service.ended" : "service.updated",
      targetType: "Service",
      targetId: serviceId,
      metadata: { clientId: s!.clientId, from: s!.status, to: status },
    });
    return { changed: true };
  });
}

export const endService = (ctx: ServiceCtx, serviceId: string) =>
  setServiceStatus(ctx, serviceId, "ENDED");

/** service:delete — hard delete of a record (no invoice lines yet in Phase 2). */
export async function deleteService(ctx: ServiceCtx, serviceId: string): Promise<void> {
  await withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "service:delete");
    const s = await tx.service.findFirst({ where: { id: serviceId } });
    if (!s) deny("NOT_FOUND");
    await assertTarget(tx, ctx.actor, s!.clientId, s!.projectId);
    await tx.service.delete({ where: { id: serviceId } });
    await record(tx, {
      action: "service.deleted",
      targetType: "Service",
      targetId: serviceId,
      metadata: { clientId: s!.clientId, projectId: s!.projectId },
    });
  });
}

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
import { dateColumn, localDateString } from "@/lib/duration";
import { newId } from "@/lib/ids";
import { readPreferences } from "@/preferences/service";

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
  /** Slice 113b (C88 (e)): "Invoice each renewal" — the renewal job drafts its invoices. */
  invoiceRenewals: boolean;
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
  invoiceRenewals: boolean;
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
  invoiceRenewals: s.invoiceRenewals,
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
  /** Slice 113b: "Invoice each renewal" (default on — C88 (e)). */
  invoiceRenewals?: boolean;
};

/**
 * A day the form sent: none, or a real date in 2000–2199. A browser's date
 * input takes a five-digit year, and a typo would otherwise be stored —
 * and, since slice 113, move a renewal date on by centuries or bill one
 * (invoices and assets hold the same range).
 */
export function checkDay(d: Date | null | undefined, field: string): Date | null {
  if (d === undefined || d === null) return null;
  const year = d.getUTCFullYear();
  if (Number.isNaN(d.getTime()) || year < 2000 || year > 2199) return fail("INVALID_INPUT", field);
  return d;
}

/**
 * The longest name an agreement may have — the form's own limit, held here
 * too (slice 113's security review): the name reaches the client's portal
 * and the reminder mails, and a crafted post is not bound by `maxLength`.
 */
export const SERVICE_NAME_MAX = 200;

const checkName = (raw: string | null | undefined): string => {
  const name = clean(raw);
  if (!name) return fail("NAME_REQUIRED");
  if (name.length > SERVICE_NAME_MAX) return fail("INVALID_INPUT", "name");
  return name;
};

/** A value as the audit row keeps it: a date as the day it names (`YYYY-MM-DD`), anything else as text, none as null. */
const dayText = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString().slice(0, 10) : v === null || v === undefined ? null : String(v);

/**
 * The fields whose old and new VALUES the audit row keeps (slice 113's
 * security review): what an agreement is billed and when — from slice 113b
 * they draft invoices. Staff-only facts; never `internalNotes` or the
 * description, which are named only.
 */
const VALUED_FIELDS: ReadonlySet<string> = new Set([
  "name",
  "kind",
  "billingInterval",
  "priceExVat",
  "currency",
  "startedAt",
  "renewsAt",
  "endsAt",
  "invoiceRenewals",
]);

/** service:create; scoped on the project (if any) else the client, directly. */
export async function createService(ctx: ServiceCtx, input: ServiceInput): Promise<{ id: string }> {
  const name = checkName(input.name);
  const price = parsePrice(input.priceExVat);
  const currency = clean(input.currency)?.toUpperCase() ?? null;
  if (currency && !/^[A-Z]{3}$/.test(currency)) fail("INVALID_INPUT", "currency");
  const startedAt = checkDay(input.startedAt, "startedAt");
  const renewsAt = checkDay(input.renewsAt, "renewsAt");
  const endsAt = checkDay(input.endsAt, "endsAt");
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
        name,
        description: clean(input.description),
        kind: input.kind,
        billingInterval: input.kind === "RECURRING" ? (input.billingInterval ?? "MONTHLY") : null,
        priceExVat: price,
        currency,
        startedAt,
        renewsAt: input.kind === "RECURRING" ? renewsAt : null,
        endsAt,
        internalNotes: clean(input.internalNotes),
        visibility: input.visibility ?? "INTERNAL",
        invoiceRenewals: input.invoiceRenewals ?? true,
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
    const values: Record<string, { from: string | null; to: string | null }> = {};
    const set = (field: string, next: unknown, cur: unknown) => {
      const same =
        next instanceof Date && cur instanceof Date
          ? next.getTime() === cur.getTime()
          : next === cur;
      if (!same) {
        data[field] = next;
        changed.push(field);
        if (VALUED_FIELDS.has(field)) values[field] = { from: dayText(cur), to: dayText(next) };
      }
    };
    if ("name" in patch) set("name", checkName(patch.name), s!.name);
    if ("description" in patch) set("description", clean(patch.description), s!.description);
    if ("kind" in patch && patch.kind) set("kind", patch.kind, s!.kind);
    // The kind's rules on every edit, as on create (slice 113): a one-time
    // agreement has no interval and no renewal date; a recurring one always
    // has an interval. Applied whatever the patch names, so a kind changed
    // alone never leaves a one-time agreement renewing.
    const kind = "kind" in patch && patch.kind ? patch.kind : s!.kind;
    const interval =
      kind === "RECURRING" ? (("billingInterval" in patch ? patch.billingInterval : s!.billingInterval) ?? "MONTHLY") : null;
    set("billingInterval", interval, s!.billingInterval);
    const renewsAt = kind === "RECURRING" ? ("renewsAt" in patch ? checkDay(patch.renewsAt, "renewsAt") : s!.renewsAt) : null;
    set("renewsAt", renewsAt, s!.renewsAt);
    // A date a person sets is the new anchor: the day the job kept goes
    // (`renewal-dates.ts`). Not a field anyone reads, so not in `changed`.
    // Unconditionally — never on what the unlocked read saw: a job moving the
    // date at the same moment writes the anchor after that read, and this
    // UPDATE, waiting on its lock, would keep the job's anchor with the
    // person's date (the design review's low).
    if (changed.includes("renewsAt")) data.renewalDay = null;
    if ("priceExVat" in patch) {
      set("priceExVat", parsePrice(patch.priceExVat), s!.priceExVat === null ? null : s!.priceExVat.toString());
    }
    if ("currency" in patch) {
      const currency = clean(patch.currency)?.toUpperCase() ?? null;
      if (currency && !/^[A-Z]{3}$/.test(currency)) fail("INVALID_INPUT", "currency");
      set("currency", currency, s!.currency);
    }
    if ("startedAt" in patch) set("startedAt", checkDay(patch.startedAt, "startedAt"), s!.startedAt);
    if ("endsAt" in patch) set("endsAt", checkDay(patch.endsAt, "endsAt"), s!.endsAt);
    // An ENDED agreement's end is the day it was ended (slice 113's code
    // review): never moved on or cleared afterwards — a stale page included.
    if (changed.includes("endsAt") && s!.status === "ENDED") fail("AGREEMENT_ENDED");
    if ("internalNotes" in patch) set("internalNotes", clean(patch.internalNotes), s!.internalNotes);
    if ("visibility" in patch && patch.visibility) set("visibility", patch.visibility, s!.visibility);
    // Slice 113b (C88 (e)): off, the renewal job drafts nothing for it; on
    // again, from its next renewal — a period already started never.
    if ("invoiceRenewals" in patch && typeof patch.invoiceRenewals === "boolean") {
      set("invoiceRenewals", patch.invoiceRenewals, s!.invoiceRenewals);
    }
    if (changed.length === 0) return { changed };
    // The end date's write re-checks the status in the same statement: an
    // End committed between the read above and this write would otherwise
    // be written over (the re-check's low — the read is not locked).
    const { count } = await tx.service.updateMany({
      where: { id: serviceId, ...(changed.includes("endsAt") ? { status: { not: "ENDED" as const } } : {}) },
      data,
    });
    if (count === 0) return changed.includes("endsAt") ? fail("AGREEMENT_ENDED") : deny("NOT_FOUND");
    await record(tx, {
      action: "service.updated",
      targetType: "Service",
      targetId: serviceId,
      metadata: { clientId: s!.clientId, fields: changed, values },
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
    // ENDING is "it ends today" (slice 113): its end is today — the
    // workspace's day, as a date — unless an EARLIER end is already set. A
    // later one would leave an ended agreement saying it runs on (and, from
    // slice 113b, decide what its last invoice bills).
    let endsAt: Date | null = null;
    if (status === "ENDED") {
      const today = dateColumn(localDateString(new Date(), (await readPreferences(tx, ctx.tenantId)).timezone));
      endsAt = s!.endsAt !== null && s!.endsAt.getTime() < today.getTime() ? s!.endsAt : today;
    }
    await tx.service.update({
      where: { id: serviceId },
      data: { status, ...(endsAt !== null ? { endsAt } : {}) },
      select: { id: true },
    });
    await record(tx, {
      action: status === "ENDED" ? "service.ended" : "service.updated",
      targetType: "Service",
      targetId: serviceId,
      // An end date ending wrote over is kept in the trail (the security review's low).
      metadata: {
        clientId: s!.clientId,
        from: s!.status,
        to: status,
        ...(endsAt !== null && s!.endsAt?.getTime() !== endsAt.getTime() ? { endsAt: { from: dayText(s!.endsAt), to: dayText(endsAt) } } : {}),
      },
    });
    return { changed: true };
  });
}

export const endService = (ctx: ServiceCtx, serviceId: string) =>
  setServiceStatus(ctx, serviceId, "ENDED");

/**
 * service:edit — PAUSE a running agreement, or let a paused one RUN again
 * (slice 113: its row's menu, one click each way). An ended agreement stays
 * ended (`AGREEMENT_ENDED` — the UI offers neither verb on one). A paused
 * agreement's renewal date does not move and nothing is drafted for it;
 * running again, a date that passed meanwhile moves on with the next run
 * and nothing is billed for the time it was paused (`renewals.ts`).
 */
export async function setAgreementRunning(ctx: ServiceCtx, serviceId: string, running: boolean): Promise<{ changed: boolean }> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "service:edit");
    const s = await tx.service.findFirst({
      where: { id: serviceId },
      select: { clientId: true, projectId: true, status: true, invoicedThrough: true },
    });
    if (!s) return deny("NOT_FOUND");
    await assertTarget(tx, ctx.actor, s.clientId, s.projectId);
    if (s.status === "ENDED") return fail("AGREEMENT_ENDED");
    const status: ServiceStatus = running ? "ACTIVE" : "PAUSED";
    if (s.status === status) return { changed: false };
    // Running again (slice 113b; the design review's #7): what was drafted up
    // to a day already past is forgotten, so the paused time is never billed —
    // the renewal job drafts late only a period drafted WITHOUT a gap up to it.
    let forget = false;
    if (running && s.invoicedThrough !== null) {
      const today = localDateString(new Date(), (await readPreferences(tx, ctx.tenantId)).timezone);
      forget = s.invoicedThrough.toISOString().slice(0, 10) < today;
    }
    await tx.service.update({ where: { id: serviceId }, data: { status, ...(forget ? { invoicedThrough: null } : {}) }, select: { id: true } });
    await record(tx, {
      action: "service.updated",
      targetType: "Service",
      targetId: serviceId,
      // What it had been drafted up to is kept in the trail when it is forgotten
      // (the security review of 113b: whether a pause was ever billed hangs on it).
      metadata: {
        clientId: s.clientId,
        from: s.status,
        to: status,
        ...(forget ? { invoicedThrough: { from: dayText(s.invoicedThrough), to: null } } : {}),
      },
    });
    return { changed: true };
  });
}

/**
 * service:delete — hard delete of a record. Its renewal lines on invoices keep
 * its id as a SNAPSHOT (no foreign key — slice 113b): an issued invoice is its
 * record for good, and a draft's lines are the person's to keep or remove.
 */
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

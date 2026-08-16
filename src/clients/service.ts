import { record } from "@/audit/record";
import {
  assertInScope,
  effectivePermissions,
  scopeWhere,
  type MemberActor,
} from "@/authz/authorize";
import { AuthzError, deny } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { enforceLimit, parseEntitlements, requireAccess } from "@/entitlements/resolver";
import type { ClientStatus, ProjectStatus, VatProfile } from "@/generated/prisma/enums";
import { fail, isUniqueViolation } from "@/lib/domain-error";
import { newId } from "@/lib/ids";

/**
 * Clients (companies) and their Contact RECORDS (DATA_MODEL.md §6.4,
 * PLAN.md Phase 2). Recipe per mutation: withTenant → requireAccess →
 * assertInScope → mutate → record, one transaction. Lists compose
 * scopeWhere: the Client table accepts the project→client lift
 * (a P1-only member sees Acme's card), content rows do not.
 * Client.internalNotes is INTERNAL-ONLY: only client:edit writes it,
 * audited as client.note_updated with no value in the metadata.
 */

export type ClientCtx = {
  readonly tenantId: string;
  /** From requireTenantContext() — never from form params. */
  readonly actor: MemberActor;
};

const principalOf = (ctx: ClientCtx) => ({ type: "member", id: ctx.actor.memberId }) as const;

export const CLIENT_CARD_FIELDS = [
  "name",
  "orgNr",
  "vatNumber",
  "vatProfile",
  "countryCode",
  "addressLine1",
  "addressLine2",
  "postalCode",
  "city",
  "billingEmail",
  "invoiceLocale",
] as const;
export type ClientCardField = (typeof CLIENT_CARD_FIELDS)[number];

export type ClientCardPatch = Partial<{
  name: string;
  orgNr: string | null;
  vatNumber: string | null;
  vatProfile: VatProfile | null;
  countryCode: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  postalCode: string | null;
  city: string | null;
  billingEmail: string | null;
  invoiceLocale: string | null;
}>;

/** Trim; empty ⇒ null (nullable text columns never store ""). */
export const clean = (v: string | null | undefined): string | null => {
  if (v === undefined || v === null) return null;
  const s = v.trim();
  return s.length === 0 ? null : s;
};

const inScope = async (tx: TenantDb, actor: MemberActor, clientId: string): Promise<boolean> => {
  try {
    await assertInScope(tx, actor, { clientId });
    return true;
  } catch (e) {
    if (e instanceof AuthzError && e.reason === "NOT_FOUND") return false;
    throw e;
  }
};

// ── Reads ────────────────────────────────────────────────────────────

export type ClientListRow = {
  id: string;
  name: string;
  status: ClientStatus;
  orgNr: string | null;
  city: string | null;
  projectCount: number;
  contactCount: number;
  assignedMembers: { memberId: string; name: string }[];
  updatedAt: Date;
};

/** client:view; scoped (lifted) — the freelancer sees the parent card. */
export async function listClients(
  ctx: ClientCtx,
  opts: { includeArchived?: boolean } = {},
): Promise<ClientListRow[]> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "client:view");
    const scope = await scopeWhere(tx, ctx.actor, { clientField: "id", lifted: true });
    // The Project table's own project column is "id" (children use "projectId").
    const projectScope = await scopeWhere(tx, ctx.actor, {
      clientField: "clientId",
      projectField: "id",
    });
    const rows = await tx.client.findMany({
      where: { ...scope, ...(opts.includeArchived ? {} : { status: "ACTIVE" }) },
      orderBy: [{ status: "asc" }, { name: "asc" }],
      select: {
        id: true,
        name: true,
        status: true,
        orgNr: true,
        city: true,
        updatedAt: true,
        _count: { select: { contacts: true } },
        memberClients: {
          select: { memberId: true, member: { select: { user: { select: { name: true } } } } },
        },
      },
    });
    // Project counts honour the actor's project scope (a P1-only member
    // sees "1 project" at Acme, not Acme's true total).
    const counts = rows.length
      ? await tx.project.groupBy({
          by: ["clientId"],
          where: {
            ...projectScope,
            clientId: { in: rows.map((r) => r.id) },
            status: { not: "ARCHIVED" },
          },
          _count: { _all: true },
        })
      : [];
    const countOf = new Map(counts.map((c) => [c.clientId, c._count._all]));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      orgNr: r.orgNr,
      city: r.city,
      projectCount: countOf.get(r.id) ?? 0,
      contactCount: r._count.contacts,
      assignedMembers: r.memberClients.map((mc) => ({
        memberId: mc.memberId,
        name: mc.member.user.name,
      })),
      updatedAt: r.updatedAt,
    }));
  });
}

export type ContactRow = {
  id: string;
  name: string;
  email: string;
  title: string | null;
  phone: string | null;
  portalProfile: "CONTACT_PRIMARY" | "CONTACT_COLLABORATOR";
  portalStatus: "NO_ACCESS" | "INVITED" | "ACTIVE" | "SUSPENDED" | "REVOKED";
  createdAt: Date;
};

export type ClientProjectRow = {
  id: string;
  key: string;
  name: string;
  status: ProjectStatus;
  milestoneTotal: number;
  milestoneDone: number;
  updatedAt: Date;
};

export type ClientDetail = {
  id: string;
  name: string;
  status: ClientStatus;
  orgNr: string | null;
  vatNumber: string | null;
  vatProfile: VatProfile | null;
  countryCode: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  postalCode: string | null;
  city: string | null;
  billingEmail: string | null;
  invoiceLocale: string | null;
  /** Present only when the actor holds client:edit AND is directly in scope. */
  internalNotes: string | null | undefined;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  contacts: ContactRow[];
  /** Scoped: a P1-only member sees P1 here, not the client's other projects. */
  projects: ClientProjectRow[];
  assignments: { memberId: string; name: string; email: string; createdAt: Date }[];
  /** Directly assigned (or view_all) — content rows (files, services) are reachable. */
  direct: boolean;
  caps: {
    edit: boolean;
    delete: boolean;
    manageAssignments: boolean;
    manageContacts: boolean;
    createProject: boolean;
    viewProjects: boolean;
    viewDocuments: boolean;
    uploadDocuments: boolean;
    deleteDocuments: boolean;
    changeDocumentVisibility: boolean;
    viewServices: boolean;
    createServices: boolean;
    editServices: boolean;
    deleteServices: boolean;
  };
};

/** client:view; assertInScope(lifted) ⇒ NOT_FOUND outside scope. */
export async function getClient(ctx: ClientCtx, clientId: string): Promise<ClientDetail> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "client:view");
    await assertInScope(tx, ctx.actor, { clientId, lifted: true });
    const held = await effectivePermissions(tx, ctx.actor.memberId);
    const direct = await inScope(tx, ctx.actor, clientId);
    // The Project table's own project column is "id" (children use "projectId").
    const projectScope = await scopeWhere(tx, ctx.actor, {
      clientField: "clientId",
      projectField: "id",
    });
    const row = await tx.client.findFirst({
      where: { id: clientId },
      include: {
        contacts: { orderBy: { createdAt: "asc" } },
        memberClients: {
          orderBy: { createdAt: "asc" },
          include: { member: { select: { user: { select: { name: true, email: true } } } } },
        },
        projects: {
          where: { ...projectScope },
          orderBy: [{ status: "asc" }, { name: "asc" }],
          select: {
            id: true,
            key: true,
            name: true,
            status: true,
            updatedAt: true,
            milestones: { select: { status: true } },
          },
        },
      },
    });
    if (!row) deny("NOT_FOUND");
    const c = row!;
    const canEdit = held.has("client:edit");
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      orgNr: c.orgNr,
      vatNumber: c.vatNumber,
      vatProfile: c.vatProfile,
      countryCode: c.countryCode,
      addressLine1: c.addressLine1,
      addressLine2: c.addressLine2,
      postalCode: c.postalCode,
      city: c.city,
      billingEmail: c.billingEmail,
      invoiceLocale: c.invoiceLocale,
      internalNotes: canEdit && direct ? c.internalNotes : undefined,
      archivedAt: c.archivedAt,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      contacts: c.contacts.map((k) => ({
        id: k.id,
        name: k.name,
        email: k.email,
        title: k.title,
        phone: k.phone,
        portalProfile: k.portalProfile,
        portalStatus: k.portalStatus,
        createdAt: k.createdAt,
      })),
      projects: c.projects.map((p) => ({
        id: p.id,
        key: p.key,
        name: p.name,
        status: p.status,
        milestoneTotal: p.milestones.filter((m) => m.status !== "CANCELLED").length,
        milestoneDone: p.milestones.filter((m) => m.status === "DONE").length,
        updatedAt: p.updatedAt,
      })),
      assignments: c.memberClients.map((mc) => ({
        memberId: mc.memberId,
        name: mc.member.user.name,
        email: mc.member.user.email,
        createdAt: mc.createdAt,
      })),
      direct,
      caps: {
        edit: canEdit,
        delete: held.has("client:delete") && direct,
        manageAssignments: held.has("client:manage_assignments") && direct,
        manageContacts: held.has("client:manage_contacts"),
        createProject: held.has("project:create") && direct,
        viewProjects: held.has("project:view"),
        viewDocuments: held.has("document:view") && direct,
        uploadDocuments: held.has("document:upload") && direct,
        deleteDocuments: held.has("document:delete") && direct,
        changeDocumentVisibility: held.has("document:change_visibility") && direct,
        viewServices: held.has("service:view") && direct,
        createServices: held.has("service:create") && direct,
        editServices: held.has("service:edit") && direct,
        deleteServices: held.has("service:delete") && direct,
      },
    };
  });
}

// ── Mutations ────────────────────────────────────────────────────────

/** client:create — inline creation: name is the only required field. */
export async function createClient(
  ctx: ClientCtx,
  input: { name: string } & Omit<ClientCardPatch, "name">,
): Promise<{ id: string }> {
  const name = clean(input.name);
  if (!name) fail("NAME_REQUIRED");
  const id = newId();
  await withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "client:create");
    const tenant = await tx.tenant.findFirst({
      where: { id: ctx.tenantId },
      select: { entitlements: true },
    });
    const count = await tx.client.count();
    enforceLimit(parseEntitlements(tenant?.entitlements), "maxClients", count);
    await tx.client.create({
      data: {
        id,
        tenantId: ctx.tenantId,
        name: name!,
        orgNr: clean(input.orgNr),
        vatNumber: clean(input.vatNumber),
        vatProfile: input.vatProfile ?? null,
        countryCode: clean(input.countryCode)?.toUpperCase() ?? null,
        addressLine1: clean(input.addressLine1),
        addressLine2: clean(input.addressLine2),
        postalCode: clean(input.postalCode),
        city: clean(input.city),
        billingEmail: clean(input.billingEmail)?.toLowerCase() ?? null,
        invoiceLocale: clean(input.invoiceLocale),
      },
    });
    await record(tx, {
      action: "client.created",
      targetType: "Client",
      targetId: id,
      metadata: { name },
    });
  });
  return { id };
}

/**
 * client:edit — the company card. Only changed fields are written and
 * listed in the audit metadata (names, never values).
 */
export async function updateClient(
  ctx: ClientCtx,
  clientId: string,
  patch: ClientCardPatch,
): Promise<{ changed: ClientCardField[] }> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "client:edit");
    await assertInScope(tx, ctx.actor, { clientId, lifted: true });
    const current = await tx.client.findFirst({ where: { id: clientId } });
    if (!current) deny("NOT_FOUND");
    if (current!.status === "ARCHIVED") fail("ARCHIVED");
    const data: Record<string, unknown> = {};
    const changed: ClientCardField[] = [];
    for (const f of CLIENT_CARD_FIELDS) {
      if (!(f in patch)) continue;
      let next: unknown;
      if (f === "name") {
        next = clean(patch.name);
        if (!next) fail("NAME_REQUIRED");
      } else if (f === "vatProfile") {
        next = patch.vatProfile ?? null;
      } else if (f === "countryCode") {
        next = clean(patch.countryCode)?.toUpperCase() ?? null;
      } else if (f === "billingEmail") {
        next = clean(patch.billingEmail)?.toLowerCase() ?? null;
      } else {
        next = clean(patch[f]);
      }
      if (next !== current![f]) {
        data[f] = next;
        changed.push(f);
      }
    }
    if (changed.length === 0) return { changed };
    await tx.client.update({ where: { id: clientId }, data });
    await record(tx, {
      action: "client.updated",
      targetType: "Client",
      targetId: clientId,
      metadata: { fields: changed },
    });
    return { changed };
  });
}

/** client:edit, DIRECT scope only — internal notes never travel with the lift. */
export async function updateClientNotes(
  ctx: ClientCtx,
  clientId: string,
  internalNotes: string | null,
): Promise<{ changed: boolean }> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "client:edit");
    await assertInScope(tx, ctx.actor, { clientId });
    const current = await tx.client.findFirst({
      where: { id: clientId },
      select: { internalNotes: true, status: true },
    });
    if (!current) deny("NOT_FOUND");
    const next = internalNotes === null ? null : internalNotes.trimEnd() || null;
    if (next === current!.internalNotes) return { changed: false };
    await tx.client.update({ where: { id: clientId }, data: { internalNotes: next } });
    // No value in metadata — INTERNAL-ONLY (DATA_MODEL.md §6.4).
    await record(tx, { action: "client.note_updated", targetType: "Client", targetId: clientId });
    return { changed: true };
  });
}

/** client:delete — archive (soft). Projects and records stay. */
export async function archiveClient(ctx: ClientCtx, clientId: string): Promise<void> {
  await withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "client:delete");
    await assertInScope(tx, ctx.actor, { clientId });
    const c = await tx.client.findFirst({ where: { id: clientId }, select: { status: true } });
    if (!c) deny("NOT_FOUND");
    if (c!.status === "ARCHIVED") return;
    await tx.client.update({
      where: { id: clientId },
      data: { status: "ARCHIVED", archivedAt: new Date() },
    });
    await record(tx, { action: "client.archived", targetType: "Client", targetId: clientId });
  });
}

/** client:delete — restore an archived client (explicit over silent, UI.md rule 12). */
export async function unarchiveClient(ctx: ClientCtx, clientId: string): Promise<void> {
  await withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "client:delete");
    await assertInScope(tx, ctx.actor, { clientId });
    const c = await tx.client.findFirst({ where: { id: clientId }, select: { status: true } });
    if (!c) deny("NOT_FOUND");
    if (c!.status === "ACTIVE") return;
    await tx.client.update({
      where: { id: clientId },
      data: { status: "ACTIVE", archivedAt: null },
    });
    await record(tx, { action: "client.unarchived", targetType: "Client", targetId: clientId });
  });
}

// ── Contacts (records only in Phase 2 — no invites) ──────────────────

export type ContactInput = {
  name: string;
  email: string;
  title?: string | null;
  phone?: string | null;
  portalProfile?: "CONTACT_PRIMARY" | "CONTACT_COLLABORATOR";
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** client:manage_contacts; lifted scope (the card includes its contacts). */
export async function createContact(
  ctx: ClientCtx,
  clientId: string,
  input: ContactInput,
): Promise<{ id: string }> {
  const name = clean(input.name);
  if (!name) fail("NAME_REQUIRED");
  const email = clean(input.email)?.toLowerCase();
  if (!email || !EMAIL_RE.test(email)) fail("EMAIL_INVALID");
  const id = newId();
  await withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "client:manage_contacts");
    await assertInScope(tx, ctx.actor, { clientId, lifted: true });
    const client = await tx.client.findFirst({ where: { id: clientId }, select: { status: true } });
    if (!client) deny("NOT_FOUND");
    if (client!.status === "ARCHIVED") fail("ARCHIVED");
    try {
      await tx.contact.create({
        data: {
          id,
          tenantId: ctx.tenantId,
          clientId,
          name: name!,
          email: email!,
          title: clean(input.title),
          phone: clean(input.phone),
          portalProfile: input.portalProfile ?? "CONTACT_COLLABORATOR",
        },
      });
    } catch (e) {
      if (isUniqueViolation(e)) fail("EMAIL_TAKEN");
      throw e;
    }
    await record(tx, {
      action: "contact.created",
      targetType: "Contact",
      targetId: id,
      metadata: { clientId, portalProfile: input.portalProfile ?? "CONTACT_COLLABORATOR" },
    });
  });
  return { id };
}

export async function updateContact(
  ctx: ClientCtx,
  contactId: string,
  patch: Partial<ContactInput>,
): Promise<{ changed: string[] }> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "client:manage_contacts");
    const current = await tx.contact.findFirst({ where: { id: contactId } });
    if (!current) deny("NOT_FOUND");
    await assertInScope(tx, ctx.actor, { clientId: current!.clientId, lifted: true });
    const data: Record<string, unknown> = {};
    const changed: string[] = [];
    if ("name" in patch) {
      const name = clean(patch.name);
      if (!name) fail("NAME_REQUIRED");
      if (name !== current!.name) {
        data.name = name;
        changed.push("name");
      }
    }
    if ("email" in patch) {
      const email = clean(patch.email)?.toLowerCase();
      if (!email || !EMAIL_RE.test(email)) fail("EMAIL_INVALID");
      if (email !== current!.email) {
        data.email = email;
        changed.push("email");
      }
    }
    if ("title" in patch && clean(patch.title) !== current!.title) {
      data.title = clean(patch.title);
      changed.push("title");
    }
    if ("phone" in patch && clean(patch.phone) !== current!.phone) {
      data.phone = clean(patch.phone);
      changed.push("phone");
    }
    if (patch.portalProfile && patch.portalProfile !== current!.portalProfile) {
      data.portalProfile = patch.portalProfile;
      changed.push("portalProfile");
    }
    if (changed.length === 0) return { changed };
    try {
      await tx.contact.update({ where: { id: contactId }, data });
    } catch (e) {
      if (isUniqueViolation(e)) fail("EMAIL_TAKEN");
      throw e;
    }
    await record(tx, {
      action: "contact.updated",
      targetType: "Contact",
      targetId: contactId,
      metadata: { clientId: current!.clientId, fields: changed },
    });
    return { changed };
  });
}

/** Records only: a contact with portal access (Phase 3) is revoked, not deleted — refused here. */
export async function deleteContact(ctx: ClientCtx, contactId: string): Promise<void> {
  await withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "client:manage_contacts");
    const current = await tx.contact.findFirst({
      where: { id: contactId },
      select: { clientId: true, portalStatus: true },
    });
    if (!current) deny("NOT_FOUND");
    await assertInScope(tx, ctx.actor, { clientId: current!.clientId, lifted: true });
    if (current!.portalStatus !== "NO_ACCESS") fail("INVALID_INPUT", "contact has portal access");
    await tx.contact.delete({ where: { id: contactId } });
    await record(tx, {
      action: "contact.deleted",
      targetType: "Contact",
      targetId: contactId,
      metadata: { clientId: current!.clientId },
    });
  });
}

/** Members eligible for assignment pickers (Team tabs): active members of the tenant. */
export async function listAssignableMembers(
  tx: TenantDb,
): Promise<{ memberId: string; name: string; email: string }[]> {
  const rows = await tx.member.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, user: { select: { name: true, email: true } } },
    orderBy: { joinedAt: "asc" },
  });
  return rows.map((m) => ({ memberId: m.id, name: m.user.name, email: m.user.email }));
}

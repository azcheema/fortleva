import { record } from "@/audit/record";
import {
  assertInScope,
  authorize,
  scopeWhere,
  type MemberActor,
} from "@/authz/authorize";
import { AuthzError, deny } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { enforceLimit, heldAndAccessibleCodes, parseEntitlements, requireAccess } from "@/entitlements/resolver";
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

/**
 * The language the client's invoices are written in (Phase 4 slice 108,
 * founder decision C76 (e)): Swedish, English, or blank — "by country"
 * (`src/modules/invoicing/issue.ts`'s rule). Anything else is refused: an
 * invoice is printed in one of the two, and a free-text value would silently
 * mean "by country". (The field was free text until this slice; a stored
 * value that is neither reads as blank.)
 */
const cleanInvoiceLocale = (v: string | null | undefined): "sv" | "en" | null => {
  const s = clean(v)?.toLowerCase() ?? null;
  if (s === null) return null;
  if (s === "sv" || s === "en") return s;
  return fail("INVALID_INPUT", "invoice language");
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
    /**
     * The portal verbs — Invite, Resend, Pause, Resume, End access:
     * `client:manage_contacts` on all four gates, so none with the portal
     * switched off.
     */
    manageContacts: boolean;
    /**
     * Writing a contact RECORD — add, edit, delete: the same code at gate
     * 4 only, as `authorizeContactRecordWrite` checks it (C48), so with
     * the portal switched off too.
     */
    manageContactRecords: boolean;
    createProject: boolean;
    viewProjects: boolean;
    viewDocuments: boolean;
    /**
     * `document:view` on all four gates WHATEVER the scope — whether a
     * Files tab should exist at all. `viewDocuments` adds the direct
     * scope; a member who reaches the client through a project gets the
     * tab only to be told the files live under that project, and not
     * even that when the documentation module is off.
     */
    viewDocumentsAnyScope: boolean;
    uploadDocuments: boolean;
    /** `document:edit` — asking the client to sign a deliverable off rides on it (Phase 3). */
    editDocuments: boolean;
    deleteDocuments: boolean;
    changeDocumentVisibility: boolean;
    viewServices: boolean;
    createServices: boolean;
    editServices: boolean;
    deleteServices: boolean;
    /**
     * `credential:view` on all four gates — whether a Vault tab exists at
     * all (Phase 3V). What the tab then shows is the vault module's own
     * answer: its door wants a fresh factor (C52), and its scope keeps a
     * member reached through a project to that project's logins.
     */
    viewCredentials: boolean;
    /**
     * `asset:*` on all four gates (Phase 3V slice 87) — whether an Assets
     * tab exists, and which controls it draws. The module is `vault`, so
     * switching the vault off closes the tab too. No `&& direct`: a member
     * reached through a project sees and keeps that project's assets, and
     * the registry's own scope decides the rest (`src/modules/vault/assets.ts`).
     */
    viewAssets: boolean;
    manageAssets: boolean;
    deleteAssets: boolean;
  };
};

/**
 * EVERY CODE `ClientDetail.caps` ANSWERS, read ONCE through
 * `heldAndAccessibleCodes`. Every cap but one answers all four gates, so
 * a cap whose module a tenant can switch off closes with it:
 * `client:manage_contacts` is `portal`, the five `document:*` are
 * `documentation`, and `credential:view` and the three `asset:*` are `vault`; the rest are `core`. The one is `manageContactRecords`,
 * on gate 4 by C48. None is a ✦ code, which is what lets the helper answer
 * them. `CapCode` makes `can()` — and `holds()`, the gate-4 answer — on a
 * code missing from this list a type error; a hand-written permission
 * check would bypass it, so do not.
 */
const CAP_CODES = [
  "client:edit",
  "client:delete",
  "client:manage_assignments",
  "client:manage_contacts",
  "project:create",
  "project:view",
  "document:view",
  "document:upload",
  "document:edit",
  "document:delete",
  "document:change_visibility",
  "service:view",
  "service:create",
  "service:edit",
  "service:delete",
  "credential:view",
  "asset:view",
  "asset:manage",
  "asset:delete",
] as const;
type CapCode = (typeof CAP_CODES)[number];

/** client:view; assertInScope(lifted) ⇒ NOT_FOUND outside scope. */
export async function getClient(ctx: ClientCtx, clientId: string): Promise<ClientDetail> {
  return withTenant(ctx.tenantId, principalOf(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "client:view");
    await assertInScope(tx, ctx.actor, { clientId, lifted: true });
    // THE CAPS ANSWER ALL FOUR GATES, not the bare permission (2026-09-29).
    // `effectivePermissions` alone drew the Contacts tab's Invite / Pause /
    // End access — and, until C48 moved the record writes to gate 4, every
    // contact edit — with the portal switched off,
    // over services that `requireAccess` then refused; and with
    // documentation off the Files tab opened onto `listDocuments`'
    // refusal, i.e. the error page. In sequence, never a `Promise.all` leg
    // (AGENTS.md). The same read's permission-only answer is kept for the
    // one cap that must follow gate 4: contact records (C48).
    const answers = await heldAndAccessibleCodes(tx, ctx.tenantId, ctx.actor, CAP_CODES);
    const can = (code: CapCode): boolean => answers.accessible.has(code);
    const holds = (code: CapCode): boolean => answers.held.has(code);
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
    const canEdit = can("client:edit");
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
        delete: can("client:delete") && direct,
        manageAssignments: can("client:manage_assignments") && direct,
        manageContacts: can("client:manage_contacts"),
        // The ONE cap on the permission alone, and on purpose (C48): it
        // must answer exactly as the record writes' gate-4 check does.
        manageContactRecords: holds("client:manage_contacts"),
        createProject: can("project:create") && direct,
        viewProjects: can("project:view"),
        viewDocuments: can("document:view") && direct,
        viewDocumentsAnyScope: can("document:view"),
        uploadDocuments: can("document:upload") && direct,
        editDocuments: can("document:edit") && direct,
        deleteDocuments: can("document:delete") && direct,
        changeDocumentVisibility: can("document:change_visibility") && direct,
        viewServices: can("service:view") && direct,
        createServices: can("service:create") && direct,
        editServices: can("service:edit") && direct,
        deleteServices: can("service:delete") && direct,
        viewCredentials: can("credential:view"),
        viewAssets: can("asset:view"),
        manageAssets: can("asset:manage"),
        deleteAssets: can("asset:delete"),
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
        invoiceLocale: cleanInvoiceLocale(input.invoiceLocale),
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
      } else if (f === "invoiceLocale") {
        // The card posts every field: a value from before slice 108, when this
        // was free text ("sv-SE", "Svenska"), comes back unchanged with any
        // other edit and must not refuse it (the code review's medium). It is
        // checked only when it CHANGES.
        next = clean(patch.invoiceLocale) === current!.invoiceLocale ? current!.invoiceLocale : cleanInvoiceLocale(patch.invoiceLocale);
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

/**
 * THE GATE FOR A CONTACT *RECORD* WRITE — add, edit, delete — IS THE
 * PERMISSION ALONE (gate 4), not `requireAccess` (founder decision C48,
 * 2026-09-29). `client:manage_contacts` is a PORTAL-module code, so
 * `requireAccess` closed every record write whenever a tenant switched
 * the portal off — a rename and an erasure included. A contact is a
 * record of a person at a client and belongs with the client; only the
 * portal verbs (`inviteContact`, `setContactPortalAccess`) keep all four
 * gates. Same code, same roles: nothing is granted here that the
 * permission did not already grant with the portal on.
 */
const authorizeContactRecordWrite = (tx: TenantDb, actor: MemberActor): Promise<void> =>
  authorize(tx, actor, "client:manage_contacts");

/** client:manage_contacts at gate 4 (C48); lifted scope (the card includes its contacts). */
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
    await authorizeContactRecordWrite(tx, ctx.actor);
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
    await authorizeContactRecordWrite(tx, ctx.actor);
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
    if ("email" in data) {
      // **A NEW ADDRESS KILLS EVERY PASSWORD-RESET LINK MAILED TO THE OLD
      // ONE** (the portal reset screens' review). A reset row is keyed to the
      // contact, not to the address it was sent to, so without this the old
      // mailbox — a departed employee's, a mistyped one, exactly the mailbox
      // a member changes the address to cut off — could open its link for
      // the rest of the hour, read the NEW address off the page, set the
      // password and be signed in. By `value`, the contact id on every reset
      // row, the key `setContactPortalAccess` purges by for the same reason.
      // This purge is HALF of it: a request already in flight can still
      // write its row after this statement, so the delivery re-reads the
      // contact and sends only to the address it was asked for
      // (`deliverPortalReset`, src/auth/portal.ts).
      await tx.contactVerification.deleteMany({ where: { value: contactId } });
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
    await authorizeContactRecordWrite(tx, ctx.actor);
    // The id is held to its shape before it reaches SQL or a `where`
    // (Prisma drops an `undefined` filter silently — the 2026-08-31 lesson).
    if (typeof contactId !== "string" || contactId.length === 0 || contactId.length > 64) deny("NOT_FOUND");
    const found = await tx.contact.findFirst({ where: { id: contactId }, select: { clientId: true } });
    if (!found) deny("NOT_FOUND");
    await assertInScope(tx, ctx.actor, { clientId: found!.clientId, lifted: true });
    // THE ROW, LOCKED BEFORE ITS STATUS IS READ (slice 96's design review),
    // and only once the member is known to reach it: the status read and
    // the counts below must still hold at the DELETE. A portal hand-over
    // locks this row `FOR SHARE` before it writes (the migration's guard,
    // 20261006180000), and a re-invitation is an UPDATE of it — so with the
    // row held, neither can commit between this read and the delete: a
    // hand-over either committed before it (and is counted below) or finds
    // no contact. Under the member's own RLS; `app_runtime` holds UPDATE.
    await tx.$executeRaw`SELECT 1 FROM contact WHERE id = ${contactId} FOR UPDATE`;
    const current = await tx.contact.findFirst({
      where: { id: contactId },
      select: { clientId: true, portalStatus: true },
    });
    if (!current) deny("NOT_FOUND");
    // **NO_ACCESS OR REVOKED — both mean "no live access", which is what
    // this guard is actually protecting.** It read `!== "NO_ACCESS"`
    // until the invite slice gave `portalStatus` its first writer, at
    // which point a removed contact became permanently undeletable:
    // REVOKED is not NO_ACCESS, so the record of somebody whose access
    // the agency had deliberately ended could never be erased. That is
    // the wrong way for an erasure control to fail. INVITED, ACTIVE and
    // SUSPENDED are still refused — each is a person who can sign in, or
    // is one click from it, and deleting them is a decision to make
    // through `setContactPortalAccess` first.
    if (current!.portalStatus !== "NO_ACCESS" && current!.portalStatus !== "REVOKED") {
      fail("CONTACT_HAS_ACCESS", "contact has portal access");
    }
    // **AND NOT IF THEY HAVE WRITTEN ANYTHING** (founder decision,
    // 2026-09-23). Admitting REVOKED made it possible for the first time
    // to hard-delete somebody who had actually USED the portal — and a
    // `Contact` is hard-deleted, while their comments, their requests and
    // their history rows carry only attribution with no foreign key. So
    // the delete would leave their words in the portal their COLLEAGUES
    // still read (`portal_gate` is client-scoped), authored by nobody.
    //
    // The founder's answer: keep the name, refuse the delete. "Remove
    // access" is the verb that cuts somebody off, and it is instant; a
    // record with history stays readable. If a real erasure request ever
    // arrives, scrubbing the person's fields in place is the shape to
    // build then — a decision worth making against a real demand rather
    // than in advance. Raised by a fresh code review, which spotted that
    // the widening above had quietly changed what deletion can destroy.
    //
    // **SEQUENTIAL, NEVER A `Promise.all`** — AGENTS.md's standing trap,
    // and the first draft of this very check broke it. Prisma over the
    // `pg` adapter does not serialise concurrent statements inside an
    // interactive transaction, and the leg that loses can resolve
    // `undefined`, taking an unrelated part of the request down with it.
    // Eight cheap counts that short-circuit are worth one round trip
    // each.
    //
    // **A SIGN-OFF IS SOMETHING THEY WROTE, TOO** (slice 79's security
    // review, 2026-09-29). A client's approve / request-changes stamps
    // `approvalByContactId` on a shipped version or a deliverable — an
    // attribution column with no foreign key — and it was not counted
    // here, so a contact who approved but never commented could be
    // deleted and the approval would read as decided by nobody: the same
    // outcome the founder refused for comments.
    const wrote =
      (await tx.comment.count({ where: { tenantId: ctx.tenantId, authorContactId: contactId } })) > 0 ||
      (await tx.workItem.count({ where: { tenantId: ctx.tenantId, reportedByContactId: contactId } })) > 0 ||
      (await tx.workItemActivity.count({
        where: { tenantId: ctx.tenantId, actorContactId: contactId },
      })) > 0 ||
      (await tx.projectVersion.count({ where: { tenantId: ctx.tenantId, approvalByContactId: contactId } })) > 0 ||
      (await tx.document.count({ where: { tenantId: ctx.tenantId, approvalByContactId: contactId } })) > 0 ||
      // The three a portal UPLOAD will write — no writer yet (checked
      // 2026-09-29), counted now so the upload slice cannot reopen the
      // same hole the sign-off opened. With them, all eight `*ContactId`
      // columns the schema then tagged "attribution, no FK" were here (twelve
      // since slice 96, below — every one pinned by
      // `attribution-columns.test.ts`). The two
      // other contact references without a foreign key are not the
      // contact's own writing: `CommentMention.mentionedContactId` (written
      // ABOUT them, by someone else) and `Notification.receiverId`
      // (polymorphic; a contact never acts through it).
      (await tx.document.count({ where: { tenantId: ctx.tenantId, createdByContactId: contactId } })) > 0 ||
      (await tx.fileVersion.count({ where: { tenantId: ctx.tenantId, uploadedByContactId: contactId } })) > 0 ||
      (await tx.fileObject.count({ where: { tenantId: ctx.tenantId, createdByContactId: contactId } })) > 0 ||
      // A client's ask to open their sealed logins (slice 93) — who asked,
      // confirmed or withdrew it, and the reason they wrote. Slice 93 added
      // three attribution columns and none was counted here, which reopened
      // the hole above for a contact who only ever asked (found by slice
      // 96); `attribution-columns.test.ts` now fails the unit suite on the
      // next one.
      (await tx.sealedOpenRequest.count({ where: { tenantId: ctx.tenantId, askedByContactId: contactId } })) > 0 ||
      (await tx.sealedOpenRequest.count({ where: { tenantId: ctx.tenantId, confirmedByContactId: contactId } })) > 0 ||
      (await tx.sealedOpenRequest.count({ where: { tenantId: ctx.tenantId, withdrawnByContactId: contactId } })) > 0 ||
      // A login they handed over through the portal (slice 96, C64): the
      // vault row says who sent it. Binned and ERASED ones too: once its 30
      // days in the bin are up, the row stays as the client's record of what
      // they sent — their name for it and the date, nothing else (slice 99,
      // C67 (a)) — and that record is their writing.
      (await tx.credentialItem.count({ where: { tenantId: ctx.tenantId, submittedByContactId: contactId } })) > 0 ||
      // An ask of the agency they DECLINED, with a note (slice 98, C66 (c)).
      // An ask they never answered, or one the team cancelled, is not their
      // writing: it goes with them (the FK cascade).
      (await tx.credentialAsk.count({ where: { tenantId: ctx.tenantId, declinedByContactId: contactId } })) > 0;
    // **AND ITS MESSAGE MAY NOT SAY "end their access instead"**, which
    // is what it said for an afternoon. This guard sits BELOW the status
    // check, so it is reachable only for a NO_ACCESS or REVOKED contact
    // — somebody who already cannot sign in. Advice to end their access
    // would name a verb the row does not even offer them.
    if (wrote) fail("CONTACT_HAS_HISTORY", "contact has portal history");
    // Their own mail settings go with them (Phase 5 slice 101): a stopped
    // weekly summary is a setting ABOUT the person — polymorphic, no foreign
    // key — never their writing, so nothing above counts it and nothing
    // should outlive them.
    await tx.notificationPreference.deleteMany({
      where: { tenantId: ctx.tenantId, receiverType: "CONTACT", receiverId: contactId },
    });
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

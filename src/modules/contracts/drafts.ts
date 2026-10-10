import { record } from "@/audit/record";
import { assertInScope, scopeWhere } from "@/authz/authorize";
import { deny } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { hasAccess, requireAccess } from "@/entitlements/resolver";
import { fail } from "@/lib/domain-error";
import { normalizeContractBody } from "@/lib/rich-text/normalize";

import { guarded } from "./db-errors";
import { fillIn, remainingFillIns, type FillInKey } from "./fill-ins";
import { fillInValuesFor, readLiveParties } from "./parties";
import { isContractLocale, type ContractLocale } from "./print";
import { readSigners, type SignerOption } from "./signers";
import { memberPrincipal, type ContractsCtx } from "./templates";

/**
 * CONTRACT DRAFTS (Phase 4 slice 112; founder decision C84 (a), (c), (e)).
 *
 * A contract belongs to ONE client, chosen when it is started and never
 * changed (the database holds it). It is started from a template — the
 * template's body COPIED and its fill-ins filled ONCE from the client's card,
 * the workspace's company details, the signer picked and today's date
 * (`fill-ins.ts`) — or blank; after that any of its text is edited freely
 * while it is a draft. Sending is slice 112b.
 *
 * Every verb is `requireAccess` → `assertInScope({ clientId })` — DIRECT
 * client assignment, as every client-level record (the invoice's rule) — then
 * the contract locked `FOR UPDATE` and its status re-read (a draft, or
 * `CONTRACT_NOT_DRAFT`), then the write, then the audit row, in one
 * transaction. Reads and writes `select` what they need: a body can be half a
 * megabyte (AGENTS.md's whole-row trap).
 *
 * AUDIT, without a carve-out: `contract.created` (the template's id),
 * `contract.draft_edited` (which fields), `contract.draft_deleted`.
 */

export const CONTRACT_TITLE_MAX = 200;
export const CONTRACT_LIST_LIMIT = 200;

export type ContractStatus = "DRAFT" | "SENT" | "SIGNED" | "DECLINED" | "WITHDRAWN";

export type ContractListRow = {
  readonly id: string;
  readonly title: string;
  readonly status: ContractStatus;
  readonly version: number;
  readonly client: { readonly id: string; readonly name: string };
  readonly endsOn: string | null;
  readonly updatedAt: Date;
};

export type ContractDetail = {
  readonly id: string;
  readonly title: string;
  readonly status: ContractStatus;
  readonly version: number;
  readonly client: { readonly id: string; readonly name: string };
  readonly language: ContractLocale;
  readonly body: unknown;
  readonly signerContactId: string | null;
  /** The signer as a person, or null when none is picked or the contact is gone. */
  readonly signer: { readonly id: string; readonly name: string; readonly canSign: boolean } | null;
  readonly startsOn: string | null;
  readonly endsOn: string | null;
  readonly templateName: string | null;
  /** The fill-ins still in the text (sending refuses while any is — 112b). */
  readonly remainingFillIns: readonly FillInKey[];
  /** The client's main contacts in the portal — who could sign. */
  readonly signers: readonly SignerOption[];
  readonly updatedAt: Date;
};

const isoDay = (d: Date | null): string | null => (d === null ? null : d.toISOString().slice(0, 10));

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A calendar day from a form ("2026-10-10"), or null for an empty one. */
function dayOf(raw: unknown, what: string): Date | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw !== "string" || !DAY.test(raw)) fail("INVALID_INPUT", what);
  const d = new Date(`${raw as string}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) fail("INVALID_INPUT", what);
  const year = d.getUTCFullYear();
  if (year < 2000 || year > 2100) fail("INVALID_INPUT", what);
  return d;
}

function titleOf(raw: unknown): string {
  const title = typeof raw === "string" ? raw.trim() : "";
  if (title.length === 0 || title.length > CONTRACT_TITLE_MAX) fail("INVALID_INPUT", "title");
  return title;
}

/** The contract row locked FOR UPDATE, in the member's scope — the first statement of every draft write. */
async function lockDraft(
  tx: TenantDb,
  ctx: ContractsCtx,
  id: string,
): Promise<{ id: string; client_id: string; status: ContractStatus }> {
  // The scope FIRST, on an unlocked read (its client never changes — the
  // guard holds it): a member outside the client's scope never takes the
  // row's lock, even for the moment before their NOT_FOUND (the security
  // review's nit).
  const seen = await tx.contract.findFirst({ where: { tenantId: ctx.tenantId, id }, select: { clientId: true } });
  if (!seen) return deny("NOT_FOUND", "contract");
  await assertInScope(tx, ctx.actor, { clientId: seen.clientId });
  const rows = await tx.$queryRaw<{ id: string; client_id: string; status: ContractStatus }[]>`
    SELECT id, client_id, status::text AS status FROM contract
     WHERE tenant_id = ${ctx.tenantId} AND id = ${id} FOR UPDATE`;
  if (rows.length === 0) return deny("NOT_FOUND", "contract");
  if (rows[0]!.status !== "DRAFT") fail("CONTRACT_NOT_DRAFT");
  return rows[0]!;
}

/** contract:view — the list, newest change first; `clientId` narrows it (AND, never a spread — the invoice list's lesson). */
export async function listContracts(
  ctx: ContractsCtx,
  filter: { readonly clientId?: string | null; readonly status?: ContractStatus | null } = {},
): Promise<{ rows: ContractListRow[]; more: boolean }> {
  return withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "contract:view");
    const scope = await scopeWhere(tx, ctx.actor, { clientField: "clientId" });
    const rows = await tx.contract.findMany({
      where: {
        AND: [
          { tenantId: ctx.tenantId },
          scope,
          ...(filter.clientId ? [{ clientId: filter.clientId }] : []),
          ...(filter.status ? [{ status: filter.status }] : []),
        ],
      },
      select: {
        id: true,
        title: true,
        status: true,
        version: true,
        endsOn: true,
        updatedAt: true,
        client: { select: { id: true, name: true } },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: CONTRACT_LIST_LIMIT + 1,
    });
    const more = rows.length > CONTRACT_LIST_LIMIT;
    return {
      more,
      rows: rows.slice(0, CONTRACT_LIST_LIMIT).map((r) => ({ ...r, endsOn: isoDay(r.endsOn) })),
    };
  });
}

/** contract:create — the clients a member may start a contract for (the New contract form's list). */
export async function listContractClients(ctx: ContractsCtx): Promise<{ id: string; name: string }[]> {
  return withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "contract:create");
    const scope = await scopeWhere(tx, ctx.actor, { clientField: "id" });
    return tx.client.findMany({
      where: { AND: [{ tenantId: ctx.tenantId }, scope, { status: "ACTIVE" }] },
      select: { id: true, name: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: 500,
    });
  });
}

/** contract:create — the main contacts of one client in the portal, for the New contract dialog. */
export async function listContractSigners(ctx: ContractsCtx, clientId: string): Promise<SignerOption[]> {
  return withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "contract:create");
    await assertInScope(tx, ctx.actor, { clientId });
    return readSigners(tx, ctx.tenantId, clientId);
  });
}

/** contract:view — one contract, for its page. */
export async function readContract(ctx: ContractsCtx, id: string): Promise<ContractDetail> {
  return withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "contract:view");
    const row = await tx.contract.findFirst({
      where: { tenantId: ctx.tenantId, id },
      select: {
        id: true,
        title: true,
        status: true,
        version: true,
        language: true,
        body: true,
        signerContactId: true,
        startsOn: true,
        endsOn: true,
        templateId: true,
        updatedAt: true,
        client: { select: { id: true, name: true } },
      },
    });
    if (!row) return deny("NOT_FOUND", "contract");
    await assertInScope(tx, ctx.actor, { clientId: row.client.id });
    const signers = await readSigners(tx, ctx.tenantId, row.client.id);
    let signer: ContractDetail["signer"] = null;
    if (row.signerContactId) {
      const option = signers.find((s) => s.id === row.signerContactId);
      if (option) signer = { id: option.id, name: option.name, canSign: true };
      else {
        const contact = await tx.contact.findFirst({
          where: { tenantId: ctx.tenantId, clientId: row.client.id, id: row.signerContactId },
          select: { id: true, name: true },
        });
        if (contact) signer = { id: contact.id, name: contact.name, canSign: false };
      }
    }
    const template = row.templateId
      ? await tx.contractTemplate.findFirst({ where: { tenantId: ctx.tenantId, id: row.templateId }, select: { name: true } })
      : null;
    return {
      id: row.id,
      title: row.title,
      status: row.status,
      version: row.version,
      client: row.client,
      language: isContractLocale(row.language) ? row.language : "sv",
      body: row.body,
      signerContactId: row.signerContactId,
      signer,
      startsOn: isoDay(row.startsOn),
      endsOn: isoDay(row.endsOn),
      templateName: template?.name ?? null,
      remainingFillIns: remainingFillIns(row.body),
      signers,
      updatedAt: row.updatedAt,
    };
  });
}

export type StartInput = {
  readonly clientId: unknown;
  /** A template's id, or null for a blank contract. */
  readonly templateId: unknown;
  readonly title: unknown;
  readonly signerContactId: unknown;
};

/**
 * contract:create — start a contract for a client in DIRECT scope: from a
 * template (its body copied, its fill-ins filled once) or blank. Its language
 * is the client's (the language its invoices use), else the workspace's.
 * Starting from a template needs no template code: reading the one picked is
 * part of starting (`contract:create`'s holders see the list).
 */
export async function startContract(ctx: ContractsCtx, input: StartInput): Promise<{ id: string }> {
  const clientId = typeof input.clientId === "string" ? input.clientId : "";
  if (!clientId) fail("INVALID_INPUT", "client");
  const templateId = typeof input.templateId === "string" && input.templateId ? input.templateId : null;
  const signerContactId = typeof input.signerContactId === "string" && input.signerContactId ? input.signerContactId : null;
  const askedTitle = typeof input.title === "string" ? input.title.trim() : "";
  return withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "contract:create");
      await assertInScope(tx, ctx.actor, { clientId });
      const client = await tx.client.findFirst({
        where: { tenantId: ctx.tenantId, id: clientId, status: "ACTIVE" },
        select: { id: true },
      });
      if (!client) fail("INVALID_INPUT", "client");

      let signerName: string | null = null;
      if (signerContactId) {
        const signers = await readSigners(tx, ctx.tenantId, clientId);
        const signer = signers.find((s) => s.id === signerContactId);
        if (!signer) fail("CONTRACT_SIGNER_INVALID");
        signerName = signer!.name;
      }

      let body: unknown = null;
      let templateName: string | null = null;
      if (templateId) {
        const template = await tx.contractTemplate.findFirst({
          where: { tenantId: ctx.tenantId, id: templateId },
          select: { name: true, body: true },
        });
        if (!template) fail("INVALID_INPUT", "unknown template");
        templateName = template!.name;
        body = template!.body;
      }

      const live = await readLiveParties(tx, ctx.tenantId, clientId, null);
      const language: ContractLocale = live.clientLocale ?? live.workspaceLocale;
      if (body !== null) {
        // Filled ONCE, then re-normalised: what is stored is what the
        // contract schema allows, whatever a value held.
        body = normalizeContractBody(fillIn(body, fillInValuesFor(live, signerName, language))).doc;
      }
      const title = titleOf(askedTitle || templateName || "");

      const row = await tx.contract.create({
        data: {
          tenantId: ctx.tenantId,
          clientId,
          title,
          language,
          templateId,
          signerContactId,
          ...(body !== null ? { body: body as object } : {}),
          createdByMemberId: ctx.actor.memberId,
        },
        select: { id: true },
      });
      await record(tx, {
        action: "contract.created",
        targetType: "Contract",
        targetId: row.id,
        metadata: { clientId, templateId },
      });
      return row;
    }),
  );
}

export type DraftPatch = {
  readonly title?: unknown;
  readonly body?: unknown;
  readonly language?: unknown;
  readonly signerContactId?: unknown;
  readonly startsOn?: unknown;
  readonly endsOn?: unknown;
};

/**
 * contract:edit — change a draft. Only what CHANGED is written and audited.
 * Written in ONE raw statement (jsonb — the body's change decided by Postgres
 * — and one clock for `updated_at`). A signer must be a main contact of the client in the portal
 * when picked (the database holds only "of this client"; whether they may sign
 * is re-checked at sending, 112b).
 */
export async function updateContractDraft(ctx: ContractsCtx, id: string, patch: DraftPatch): Promise<{ id: string; remainingFillIns: FillInKey[] }> {
  const data: {
    title?: string;
    language?: ContractLocale;
    signerContactId?: string | null;
    startsOn?: Date | null;
    endsOn?: Date | null;
  } = {};
  if (patch.title !== undefined) data.title = titleOf(patch.title);
  if (patch.language !== undefined) {
    if (!isContractLocale(patch.language)) fail("INVALID_INPUT", "language");
    data.language = patch.language as ContractLocale;
  }
  if (patch.signerContactId !== undefined) {
    data.signerContactId = typeof patch.signerContactId === "string" && patch.signerContactId ? patch.signerContactId : null;
  }
  if (patch.startsOn !== undefined) data.startsOn = dayOf(patch.startsOn, "start date");
  if (patch.endsOn !== undefined) data.endsOn = dayOf(patch.endsOn, "end date");
  const body = patch.body !== undefined ? normalizeContractBody(patch.body).doc : undefined;

  return withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "contract:edit");
      const locked = await lockDraft(tx, ctx, id);
      // What the row holds now, and whether the body would change — decided by
      // POSTGRES (jsonb `IS DISTINCT FROM`: key order is the database's).
      const stored = body === undefined || body === null ? null : JSON.stringify(body);
      const read = await tx.$queryRaw<
        {
          title: string;
          language: string;
          signer_contact_id: string | null;
          starts_on: Date | null;
          ends_on: Date | null;
          body_changed: boolean;
        }[]
      >`
        SELECT title, language, signer_contact_id, starts_on, ends_on,
               body IS DISTINCT FROM ${stored}::jsonb AS body_changed
          FROM contract WHERE tenant_id = ${ctx.tenantId} AND id = ${id}`;
      const current = read[0]!;
      const fields: string[] = [];
      const changed: typeof data = {};
      if (data.title !== undefined && data.title !== current.title) changed.title = data.title;
      if (data.language !== undefined && data.language !== current.language) changed.language = data.language;
      if (data.signerContactId !== undefined && data.signerContactId !== current.signer_contact_id) {
        if (data.signerContactId !== null) {
          const signers = await readSigners(tx, ctx.tenantId, locked.client_id);
          if (!signers.some((s) => s.id === data.signerContactId)) fail("CONTRACT_SIGNER_INVALID");
        }
        changed.signerContactId = data.signerContactId;
      }
      if (data.startsOn !== undefined && isoDay(data.startsOn) !== isoDay(current.starts_on)) changed.startsOn = data.startsOn;
      if (data.endsOn !== undefined && isoDay(data.endsOn) !== isoDay(current.ends_on)) changed.endsOn = data.endsOn;
      const startsOn = changed.startsOn !== undefined ? changed.startsOn : current.starts_on;
      const endsOn = changed.endsOn !== undefined ? changed.endsOn : current.ends_on;
      if (startsOn !== null && endsOn !== null && endsOn < startsOn) fail("INVALID_INPUT", "end before start");
      fields.push(...Object.keys(changed));
      const bodyChanged = body !== undefined && current.body_changed;
      if (bodyChanged) fields.push("body");

      // ONE statement, ONE clock: every field as it now stands and the row's
      // `updated_at` from the database (the security review's low — two writes
      // on two clocks could leave it equal to, or before, the last save's).
      if (fields.length > 0) {
        const title = changed.title ?? current.title;
        const language = changed.language ?? current.language;
        const signer = changed.signerContactId !== undefined ? changed.signerContactId : current.signer_contact_id;
        const day = (d: Date | null) => (d === null ? null : isoDay(d));
        await tx.$executeRaw`
          UPDATE contract
             SET title = ${title},
                 language = ${language},
                 signer_contact_id = ${signer},
                 starts_on = ${day(startsOn)}::date,
                 ends_on = ${day(endsOn)}::date,
                 body = CASE WHEN ${bodyChanged} THEN ${stored}::jsonb ELSE body END,
                 updated_at = clock_timestamp()
           WHERE tenant_id = ${ctx.tenantId} AND id = ${id}`;
      }
      if (fields.length > 0) {
        await record(tx, {
          action: "contract.draft_edited",
          targetType: "Contract",
          targetId: id,
          metadata: { clientId: locked.client_id, fields },
        });
      }
      const after = await tx.$queryRaw<{ body: unknown }[]>`SELECT body FROM contract WHERE tenant_id = ${ctx.tenantId} AND id = ${id}`;
      return { id, remainingFillIns: remainingFillIns(after[0]?.body ?? null) };
    }),
  );
}

/** contract:delete — delete a draft (a sent contract is never deleted — 112b withdraws it). */
export async function deleteContractDraft(ctx: ContractsCtx, id: string): Promise<void> {
  await withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "contract:delete");
      const locked = await lockDraft(tx, ctx, id);
      await tx.contract.delete({ where: { id }, select: { id: true } });
      await record(tx, {
        action: "contract.draft_deleted",
        targetType: "Contract",
        targetId: id,
        metadata: { clientId: locked.client_id },
      });
    }),
  );
}

/** What the page offers: each verb shown exactly where the service accepts it (UI.md §3.1). */
export async function contractVerbs(
  ctx: ContractsCtx,
): Promise<{ create: boolean; edit: boolean; delete: boolean; manageTemplates: boolean }> {
  return withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    // In SEQUENCE: a per-code check is never a leg of a batch (AGENTS.md).
    const create = await hasAccess(tx, ctx.tenantId, ctx.actor, "contract:create");
    const edit = await hasAccess(tx, ctx.tenantId, ctx.actor, "contract:edit");
    const del = await hasAccess(tx, ctx.tenantId, ctx.actor, "contract:delete");
    const manageTemplates = await hasAccess(tx, ctx.tenantId, ctx.actor, "contract:manage_templates");
    return { create, edit, delete: del, manageTemplates };
  });
}


import { record } from "@/audit/record";
import type { MemberActor } from "@/authz/authorize";
import { withTenant, type TenantDb } from "@/db";
import { hasAccess, requireAccess } from "@/entitlements/resolver";
import { fail } from "@/lib/domain-error";
import { normalizeContractBody } from "@/lib/rich-text/normalize";

import { guarded } from "./db-errors";
import { splitFillIns, type FillInKey } from "./fill-ins";

/**
 * CONTRACT TEMPLATES (Phase 4 slice 112; founder decision C84 (e), (g)) — the
 * company's standard wording with `{{key}}` fill-ins, on Settings → Contract
 * templates. Kept by OWNERS AND ADMINS (`contract:manage_templates`; the
 * database holds the code, `contract_template_guard`); a manager who starts
 * contracts (`contract:create`) reads the list to pick one.
 *
 * A contract COPIES a template's body when it is started (`drafts.ts`), so a
 * template is renamed, rewritten or deleted freely: no contract changes with
 * it. Every write is audited (`contract_template.created|updated|deleted`) —
 * ids and which fields, never the text.
 */

export type ContractsCtx = { readonly tenantId: string; readonly actor: MemberActor };

export const memberPrincipal = (ctx: ContractsCtx) => ({ type: "member", id: ctx.actor.memberId }) as const;

export const TEMPLATE_NAME_MAX = 120;
/** A workspace keeps at most this many — far past any honest use, and the picker's bound. */
export const TEMPLATE_LIMIT = 100;

export type ContractTemplateRow = {
  readonly id: string;
  readonly name: string;
  readonly updatedAt: Date;
};

export type ContractTemplateDetail = ContractTemplateRow & {
  /** The normalised document, or null when blank. */
  readonly body: unknown;
};

export type TemplateSaved = {
  readonly id: string;
  readonly name: string;
  /** Fill-ins split by formatting — they will not be filled (the save warns). */
  readonly splitFillIns: readonly FillInKey[];
};

function nameOf(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (name.length === 0 || name.length > TEMPLATE_NAME_MAX) fail("INVALID_INPUT", "template name");
  return name;
}

/**
 * A name the workspace already uses, whatever its case — asked first, so the
 * UNIQUE is only the race's belt. Raw `lower(name) = lower($1)`, the index's
 * own expression (`update-templates.ts` says why not Prisma's insensitive
 * `equals`).
 */
async function assertNameFree(tx: TenantDb, tenantId: string, name: string, exceptId: string | null): Promise<void> {
  const clash = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM contract_template
    WHERE tenant_id = ${tenantId} AND lower(name) = lower(${name}) AND id IS DISTINCT FROM ${exceptId}
    LIMIT 1`;
  if (clash.length > 0) fail("CONTRACT_TEMPLATE_NAME_TAKEN");
}

/**
 * The list — for the template keepers' Settings page and the "New contract"
 * picker: either code reads it. A member holding neither is refused as the
 * keepers' code refuses (`requireAccess` on it), never told which gate.
 */
export async function listContractTemplates(ctx: ContractsCtx): Promise<ContractTemplateRow[]> {
  return withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    if (!(await hasAccess(tx, ctx.tenantId, ctx.actor, "contract:create"))) {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "contract:manage_templates");
    }
    return tx.contractTemplate.findMany({
      where: { tenantId: ctx.tenantId },
      select: { id: true, name: true, updatedAt: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: TEMPLATE_LIMIT,
    });
  });
}

/** contract:manage_templates — one template, to edit. */
export async function readContractTemplate(ctx: ContractsCtx, id: string): Promise<ContractTemplateDetail> {
  return withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) => {
    await requireAccess(tx, ctx.tenantId, ctx.actor, "contract:manage_templates");
    const row = await tx.contractTemplate.findFirst({
      where: { tenantId: ctx.tenantId, id },
      select: { id: true, name: true, updatedAt: true, body: true },
    });
    if (!row) fail("INVALID_INPUT", "unknown template");
    return row!;
  });
}

export type TemplateInput = { readonly name: unknown; readonly body: unknown };

/** contract:manage_templates — a new template. */
export async function createContractTemplate(ctx: ContractsCtx, input: TemplateInput): Promise<TemplateSaved> {
  const name = nameOf(input.name);
  const body = normalizeContractBody(input.body).doc;
  return withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "contract:manage_templates");
      const count = await tx.contractTemplate.count({ where: { tenantId: ctx.tenantId } });
      if (count >= TEMPLATE_LIMIT) fail("INVALID_INPUT", "too many templates");
      await assertNameFree(tx, ctx.tenantId, name, null);
      const row = await tx.contractTemplate.create({
        data: {
          tenantId: ctx.tenantId,
          name,
          ...(body !== null ? { body: body as object } : {}),
          createdByMemberId: ctx.actor.memberId,
          updatedByMemberId: ctx.actor.memberId,
        },
        select: { id: true, name: true },
      });
      await record(tx, { action: "contract_template.created", targetType: "ContractTemplate", targetId: row.id });
      return { ...row, splitFillIns: splitFillIns(body) };
    }),
  );
}

/**
 * contract:manage_templates — rename it, rewrite it. Only what CHANGED is
 * written and audited; an edit that changes nothing writes nothing. Whether
 * the body changed is decided by POSTGRES (`IS DISTINCT FROM` on jsonb — key
 * order is the database's, not this process's), and the body is written raw:
 * a JSON `null` is SQL NULL that way, with no Prisma null sentinel to import
 * from the generated client.
 */
export async function updateContractTemplate(
  ctx: ContractsCtx,
  id: string,
  input: Partial<TemplateInput>,
): Promise<TemplateSaved> {
  const name = input.name !== undefined ? nameOf(input.name) : undefined;
  const body = input.body !== undefined ? normalizeContractBody(input.body).doc : undefined;
  return withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "contract:manage_templates");
      const locked = await tx.$queryRaw<{ name: string; body: unknown; body_changed: boolean }[]>`
        SELECT name, body, body IS DISTINCT FROM ${body === undefined || body === null ? null : JSON.stringify(body)}::jsonb AS body_changed
          FROM contract_template WHERE tenant_id = ${ctx.tenantId} AND id = ${id} FOR UPDATE`;
      if (locked.length === 0) fail("INVALID_INPUT", "unknown template");
      const existing = locked[0]!;
      const fields: string[] = [];
      if (name !== undefined && name !== existing.name) fields.push("name");
      if (body !== undefined && existing.body_changed) fields.push("body");
      const finalBody = body !== undefined ? body : existing.body;
      if (fields.length === 0) return { id, name: existing.name, splitFillIns: splitFillIns(finalBody) };
      if (fields.includes("name")) await assertNameFree(tx, ctx.tenantId, name!, id);
      const finalName = fields.includes("name") ? name! : existing.name;
      const stored = finalBody === null || finalBody === undefined ? null : JSON.stringify(finalBody);
      await tx.$executeRaw`
        UPDATE contract_template
           SET name = ${finalName},
               body = ${stored}::jsonb,
               updated_by_member_id = ${ctx.actor.memberId},
               updated_at = now()
         WHERE tenant_id = ${ctx.tenantId} AND id = ${id}`;
      await record(tx, {
        action: "contract_template.updated",
        targetType: "ContractTemplate",
        targetId: id,
        metadata: { fields },
      });
      return { id, name: finalName, splitFillIns: splitFillIns(finalBody) };
    }),
  );
}

/** contract:manage_templates — delete it. Contracts started from it keep their text. */
export async function deleteContractTemplate(ctx: ContractsCtx, id: string): Promise<void> {
  await withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "contract:manage_templates");
      const { count } = await tx.contractTemplate.deleteMany({ where: { tenantId: ctx.tenantId, id } });
      if (count === 0) fail("INVALID_INPUT", "unknown template");
      await record(tx, { action: "contract_template.deleted", targetType: "ContractTemplate", targetId: id });
    }),
  );
}

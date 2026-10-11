import { record } from "@/audit/record";
import { assertInScope } from "@/authz/authorize";
import { deny } from "@/authz/errors";
import { withTenant, type TenantDb } from "@/db";
import { requireAccess } from "@/entitlements/resolver";
import { fail } from "@/lib/domain-error";
import { newId } from "@/lib/ids";

import { guarded } from "./db-errors";
import { remainingFillIns } from "./fill-ins";
import { readSigners } from "./signers";
import { memberPrincipal, type ContractsCtx } from "./templates";

/**
 * SENDING A CONTRACT, AND WHAT FOLLOWS (Phase 4 slice 112b; founder decisions
 * C84 (b)–(d), C85 (c)). The design: docs/research/2026-10-10-slice-112-
 * contracts-design.md §3.4 and §10.
 *
 * SEND (`contract:send`, the client in DIRECT scope): the sender types their
 * name and that is the agency's signature (C84 (b)); no authenticator code
 * (C85 (c)). ONE transaction, the contract locked FOR UPDATE first:
 *   - bound to what the sender SAW (§10 item 4): the page's `updated_at`, the
 *     database's own clock since slice 112b — a draft changed since is
 *     CONTRACT_CHANGED, never sent;
 *   - the app's own checks first (text, fill-ins — including one split by
 *     formatting, which the database's regex cannot see —, the signer in the
 *     portal), so the person reads a sentence; the guard holds them all again;
 *   - UPDATE to SENT: the guard writes the parties and the fingerprint;
 *   - INSERT the two signature rows, IN SEQUENCE (never a `Promise.all` on one
 *     transaction): the agency's SIGNED by the sender with the name typed, the
 *     client's PENDING for the signer; their guard copies names, emails and the
 *     fingerprint from the record;
 *   - audit `contract.sent`; the deferred trigger checks both rows at commit.
 * The PDF as sent is drawn AFTER the commit (`ensureContractPdf`) — a render
 * and an upload never hold the contract's lock.
 *
 * WITHDRAW (`contract:send`): SENT → WITHDRAWN; the client's pending row can no
 * longer move it. NEW VERSION (`contract:create`): a copy of a DECLINED or
 * WITHDRAWN contract as version n + 1, a draft. CHANGE IT (`contract:send` +
 * `contract:create`): a SENT one withdrawn and copied, in one transaction.
 */

export const TYPED_NAME_MAX = 200;

/** The row locked FOR UPDATE, in the member's scope — the scope first, on an unlocked read. */
async function lockContract(
  tx: TenantDb,
  ctx: ContractsCtx,
  id: string,
): Promise<{ id: string; client_id: string; status: string; updated_at: Date; body: unknown; signer_contact_id: string | null; version: number }> {
  const seen = await tx.contract.findFirst({ where: { tenantId: ctx.tenantId, id }, select: { clientId: true } });
  if (!seen) return deny("NOT_FOUND", "contract");
  await assertInScope(tx, ctx.actor, { clientId: seen.clientId });
  const rows = await tx.$queryRaw<
    { id: string; client_id: string; status: string; updated_at: Date; body: unknown; signer_contact_id: string | null; version: number }[]
  >`
    SELECT id, client_id, status::text AS status, updated_at, body, signer_contact_id, version
      FROM contract WHERE tenant_id = ${ctx.tenantId} AND id = ${id} FOR UPDATE`;
  if (rows.length === 0) return deny("NOT_FOUND", "contract");
  return rows[0]!;
}

/** Some text node with text in it — an empty document is not a contract (the database checks the same). */
function hasText(node: unknown): boolean {
  if (node === null || typeof node !== "object") return false;
  const n = node as { type?: unknown; text?: unknown; content?: unknown };
  if (n.type === "text" && typeof n.text === "string" && n.text.length > 0) return true;
  return Array.isArray(n.content) && n.content.some(hasText);
}

function typedNameOf(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  if (name.length === 0 || name.length > TYPED_NAME_MAX) fail("INVALID_INPUT", "typed name");
  return name;
}

export type SendInput = {
  /** The draft's `updatedAt` as the page read it (ISO) — what the sender saw. */
  readonly seen: unknown;
  /** The sender's name as they typed it: the agency's signature. */
  readonly typedName: unknown;
};

/** contract:send — send a draft for signature. */
export async function sendContract(ctx: ContractsCtx, id: string, input: SendInput): Promise<{ id: string; contentSha256: string }> {
  const typedName = typedNameOf(input.typedName);
  const seen = typeof input.seen === "string" ? new Date(input.seen) : null;
  if (seen === null || Number.isNaN(seen.getTime())) fail("INVALID_INPUT", "seen");
  return withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "contract:send");
      const row = await lockContract(tx, ctx, id);
      if (row.status !== "DRAFT") fail("CONTRACT_NOT_DRAFT");
      if (row.updated_at.getTime() !== seen!.getTime()) fail("CONTRACT_CHANGED");
      if (row.body === null || !hasText(row.body)) fail("CONTRACT_NOT_READY");
      if (remainingFillIns(row.body).length > 0) fail("CONTRACT_FILL_INS_LEFT");
      if (row.signer_contact_id === null) fail("CONTRACT_SIGNER_INVALID");
      const signers = await readSigners(tx, ctx.tenantId, row.client_id);
      if (!signers.some((s) => s.id === row.signer_contact_id)) fail("CONTRACT_SIGNER_INVALID");

      const sent = await tx.$queryRaw<{ content_sha256: string }[]>`
        UPDATE contract
           SET status = 'SENT', sent_at = now(), sent_by_member_id = ${ctx.actor.memberId}
         WHERE tenant_id = ${ctx.tenantId} AND id = ${id} AND status = 'DRAFT'
        RETURNING content_sha256`;
      if (sent.length !== 1) fail("CONTRACT_NOT_DRAFT");
      // The names, emails and fingerprint are the guard's to write; these
      // placeholders never survive it.
      await tx.contractSignature.create({
        data: {
          id: newId(),
          tenantId: ctx.tenantId,
          clientId: row.client_id,
          contractId: id,
          party: "TENANT",
          signerMemberId: ctx.actor.memberId,
          signerName: "-",
          signerEmail: "-",
          status: "SIGNED",
          typedName,
          decidedAt: new Date(),
          contentSha256: sent[0]!.content_sha256,
        },
        select: { id: true },
      });
      await tx.contractSignature.create({
        data: {
          id: newId(),
          tenantId: ctx.tenantId,
          clientId: row.client_id,
          contractId: id,
          party: "CLIENT",
          signerContactId: row.signer_contact_id!,
          signerName: "-",
          signerEmail: "-",
          contentSha256: sent[0]!.content_sha256,
        },
        select: { id: true },
      });
      await record(tx, {
        action: "contract.sent",
        targetType: "Contract",
        targetId: id,
        // Ids and the fingerprint — never the text or the name typed.
        metadata: { clientId: row.client_id, signerContactId: row.signer_contact_id, version: row.version, contentSha256: sent[0]!.content_sha256 },
      });
      return { id, contentSha256: sent[0]!.content_sha256 };
    }),
  );
}

/** contract:send — take a sent contract back before the client signs it. */
export async function withdrawContract(ctx: ContractsCtx, id: string): Promise<void> {
  await withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "contract:send");
      const row = await lockContract(tx, ctx, id);
      if (row.status !== "SENT") fail("CONTRACT_NOT_OPEN");
      await withdrawLocked(tx, ctx, row);
    }),
  );
}

async function withdrawLocked(tx: TenantDb, ctx: ContractsCtx, row: { id: string; client_id: string; version: number }): Promise<void> {
  await tx.$executeRaw`
    UPDATE contract SET status = 'WITHDRAWN', withdrawn_at = now(), withdrawn_by_member_id = ${ctx.actor.memberId}
     WHERE tenant_id = ${ctx.tenantId} AND id = ${row.id} AND status = 'SENT'`;
  await record(tx, {
    action: "contract.withdrawn",
    targetType: "Contract",
    targetId: row.id,
    metadata: { clientId: row.client_id, version: row.version },
  });
}

/** The draft that replaces `prev` — its text, title, signer, language and dates copied. */
async function copyAsNewVersion(tx: TenantDb, ctx: ContractsCtx, prevId: string): Promise<string> {
  const prev = await tx.contract.findFirst({
    where: { tenantId: ctx.tenantId, id: prevId },
    select: {
      clientId: true,
      title: true,
      version: true,
      templateId: true,
      body: true,
      language: true,
      signerContactId: true,
      startsOn: true,
      endsOn: true,
    },
  });
  if (!prev) return deny("NOT_FOUND", "contract");
  const id = newId();
  await tx.contract.create({
    data: {
      id,
      tenantId: ctx.tenantId,
      clientId: prev.clientId,
      title: prev.title,
      version: prev.version + 1,
      supersedesId: prevId,
      templateId: prev.templateId,
      ...(prev.body !== null ? { body: prev.body as object } : {}),
      language: prev.language,
      signerContactId: prev.signerContactId,
      startsOn: prev.startsOn,
      endsOn: prev.endsOn,
      createdByMemberId: ctx.actor.memberId,
    },
    select: { id: true },
  });
  await record(tx, {
    action: "contract.created",
    targetType: "Contract",
    targetId: id,
    metadata: { clientId: prev.clientId, templateId: prev.templateId, supersedesId: prevId, version: prev.version + 1 },
  });
  return id;
}

/** contract:create — a new version (a draft) of a declined or withdrawn contract. */
export async function newContractVersion(ctx: ContractsCtx, id: string): Promise<{ id: string }> {
  return withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) =>
    guarded(async () => {
      await requireAccess(tx, ctx.tenantId, ctx.actor, "contract:create");
      const row = await lockContract(tx, ctx, id);
      if (row.status !== "DECLINED" && row.status !== "WITHDRAWN") fail("CONTRACT_NOT_REPLACEABLE");
      const already = await tx.contract.findFirst({ where: { tenantId: ctx.tenantId, supersedesId: id }, select: { id: true } });
      if (already) fail("CONTRACT_NOT_REPLACEABLE");
      return { id: await copyAsNewVersion(tx, ctx, id) };
    }),
  );
}

/** contract:send + contract:create — "Change it": a sent contract withdrawn and copied as a new draft, at once. */
export async function changeSentContract(ctx: ContractsCtx, id: string): Promise<{ id: string }> {
  return withTenant(ctx.tenantId, memberPrincipal(ctx), async (tx) =>
    guarded(async () => {
      // In sequence: a per-code check is never a leg of a batch (AGENTS.md).
      await requireAccess(tx, ctx.tenantId, ctx.actor, "contract:send");
      await requireAccess(tx, ctx.tenantId, ctx.actor, "contract:create");
      const row = await lockContract(tx, ctx, id);
      if (row.status !== "SENT") fail("CONTRACT_NOT_OPEN");
      await withdrawLocked(tx, ctx, row);
      return { id: await copyAsNewVersion(tx, ctx, id) };
    }),
  );
}

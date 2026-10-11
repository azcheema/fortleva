import { scopeWhere, type MemberActor } from "@/authz/authorize";
import type { TenantDb } from "@/db";
import { accessibleCodes } from "@/entitlements/resolver";

/**
 * WHAT "A CLIENT SIGNED / DECLINED A CONTRACT" MAY NAME IN THE INBOX
 * (Phase 4 slice 112b2; founder decision C85 (a)) — the inbox's subject
 * resolution for `contract.signed` and `contract.declined`, handed over by
 * `src/notify/inbox.ts` because who may read a contract is this module's rule.
 *
 * The notification's entity is the CONTRACT; the row names it by its title and
 * its client and links to its page. Under the READER's own principal, at read
 * time: named and linked only while the reader holds `contract:view` on all
 * four gates (the contracts module switched off, the code taken away — the
 * row then says only what happened) and reaches the contract's client by
 * their scope, which is what the page the link opens asks too. Otherwise the
 * row resolves to nothing and the inbox draws the kind's label with no name
 * and no link — the same answer for a deleted, an out-of-scope and a
 * not-permitted contract.
 *
 * Reads in sequence on the caller's transaction (AGENTS.md's trap); the
 * permission read is ONE `accessibleCodes`, never a leg.
 */

export const CONTRACT_DECISION_KINDS: readonly string[] = ["contract.signed", "contract.declined"];

export const isContractDecisionKind = (kind: string): boolean => CONTRACT_DECISION_KINDS.includes(kind);

export type ContractSubjectRef = {
  /** The notification's id — the key of the answer. */
  readonly id: string;
  readonly kind: string;
  readonly entityType: string;
  readonly entityId: string;
};

export type ContractSubject = { readonly title: string; readonly href: string };

export async function contractSubjects(
  tx: TenantDb,
  tenantId: string,
  actor: MemberActor,
  refs: readonly ContractSubjectRef[],
): Promise<Map<string, ContractSubject>> {
  const out = new Map<string, ContractSubject>();
  const mine = refs.filter((r) => isContractDecisionKind(r.kind) && r.entityType === "Contract");
  if (mine.length === 0) return out;
  const may = await accessibleCodes(tx, tenantId, actor, ["contract:view"]);
  if (!may.has("contract:view")) return out;
  const scope = await scopeWhere(tx, actor, { clientField: "clientId" });
  const contracts = await tx.contract.findMany({
    where: { AND: [{ tenantId }, scope, { id: { in: [...new Set(mine.map((r) => r.entityId))] } }] },
    select: { id: true, title: true, client: { select: { name: true } } },
  });
  const byId = new Map(contracts.map((c) => [c.id, c]));
  for (const r of mine) {
    const c = byId.get(r.entityId);
    if (c) out.set(r.id, { title: `${c.title} · ${c.client.name}`, href: `/contracts/${c.id}` });
  }
  return out;
}

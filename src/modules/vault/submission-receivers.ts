import { resolveScope, type MemberActor } from "@/authz/authorize";
import type { TenantDb } from "@/db";
import { accessibleCodes } from "@/entitlements/resolver";

import { anchorInScope, type VaultAnchor } from "./scope";

/**
 * WHO IS TOLD THAT A CLIENT HANDED A LOGIN OVER (Phase 3V slice 96; founder
 * decision C64 (c)): the people assigned to that client — for a login sent
 * for a project, that project's people (its assignees and its lead); for
 * one sent for the company itself, the members assigned to the client
 * directly — AND the workspace's owners, always: the renewal reminders'
 * rule (`reminders.ts`, C53 as amended by C57), which the founder chose for
 * this too when asked again after the design review (C64 (c)).
 *
 * EACH ONE IS HELD, AS THEMSELVES, to what they will be told about: an
 * ACTIVE member who holds `credential:view` on all four gates and whose
 * scope reaches the login by the vault's anchor rule (`anchorInScope`) —
 * so nobody is told a client sent a login they could never open, and the
 * notification names the CLIENT only, never the login (C54).
 *
 * Read in a SYSTEM transaction of the broker's own, BEFORE the hand-over's
 * write, so the write's locks are not held while each member's codes and
 * scope are read — one member at a time, in sequence (AGENTS.md: a per-code
 * check is never a leg of a batch). The anchor is known from the request,
 * and the broker has already proved it is the contact's to name.
 *
 * Kept off the portal's side of the wall, as the request intake's
 * `requestReceivers` is (`src/modules/work/notify.ts`): it reads a
 * project's lead, a member column no portal surface may name.
 */
export async function submissionReceivers(
  tx: TenantDb,
  tenantId: string,
  anchor: { readonly clientId: string; readonly projectId: string | null },
): Promise<string[]> {
  const candidates: string[] = [];
  if (anchor.projectId !== null) {
    const assigned = await tx.memberProject.findMany({
      where: { tenantId, projectId: anchor.projectId },
      select: { memberId: true },
    });
    candidates.push(...assigned.map((r) => r.memberId));
    const project = await tx.project.findFirst({
      where: { tenantId, id: anchor.projectId },
      select: { leadMemberId: true },
    });
    if (project?.leadMemberId) candidates.push(project.leadMemberId);
  } else {
    const assigned = await tx.memberClient.findMany({
      where: { tenantId, clientId: anchor.clientId },
      select: { memberId: true },
    });
    candidates.push(...assigned.map((r) => r.memberId));
  }
  const owners = await tx.memberRole.findMany({
    where: { tenantId, role: { isSystem: true, templateKey: "owner" } },
    select: { memberId: true },
  });
  candidates.push(...owners.map((o) => o.memberId));
  return keep(tx, tenantId, anchor, candidates);
}

/** The active members among `ids` who may open the login — one row each, in a stable order. */
async function keep(tx: TenantDb, tenantId: string, anchor: VaultAnchor, ids: readonly string[]): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const active = await tx.member.findMany({
    where: { tenantId, id: { in: unique }, status: "ACTIVE" },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  const out: string[] = [];
  for (const { id } of active) {
    const actor: MemberActor = { memberId: id };
    const codes = await accessibleCodes(tx, tenantId, actor, ["credential:view"]);
    if (!codes.has("credential:view")) continue;
    const scope = await resolveScope(tx, actor);
    if (anchorInScope(scope, anchor)) out.push(id);
  }
  return out;
}

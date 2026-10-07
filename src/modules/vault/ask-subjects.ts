import { resolveScope, type MemberActor } from "@/authz/authorize";
import type { TenantDb } from "@/db";
import { accessibleCodes } from "@/entitlements/resolver";

import { anchorInScope } from "./scope";

/**
 * WHAT "A CLIENT CAN'T SEND A LOGIN YOU ASKED FOR" MAY NAME IN THE INBOX
 * (Phase 3V slice 98; founder decision C66 (c)) — the inbox's subject
 * resolution for `credential.ask_declined`, handed over by
 * `src/notify/inbox.ts` because its rules are the vault's, as a hand-over's
 * are (`submission-subjects.ts`).
 *
 * The notification's entity is the ASK; the row names the CLIENT (and the
 * project's key for a project's ask), never what was asked — the names of
 * a client's logins, asked for or kept, stay behind the vault's door
 * (C54). Under the READER's own principal, at read time: named and linked
 * only while the reader holds `credential:view` on all four gates, is not
 * impersonating (the vault refuses impersonation before it reads anything
 * — `door.ts`), and reaches the ask's anchor by the vault's rule. The link
 * is the Vault tab where the ask is listed: the project's for a project's
 * ask, else the client's (whose client-level anchor the reader reaches
 * only by a direct assignment or a tenant-wide scope, which open that
 * tab). Otherwise the row resolves to nothing and the inbox draws the
 * kind's generic label with no name and no link.
 *
 * Reads in sequence on the caller's transaction (AGENTS.md's trap); the
 * permission read is ONE `accessibleCodes`, never a leg.
 */

export const ASK_DECLINED_KIND = "credential.ask_declined";

export const isAskDeclineKind = (kind: string): boolean => kind === ASK_DECLINED_KIND;

export type AskDeclineRef = {
  /** The notification's id — the key of the answer. */
  readonly id: string;
  readonly kind: string;
  readonly entityType: string;
  readonly entityId: string;
};

export type AskDeclineSubject = { readonly title: string; readonly href: string };

export async function askDeclineSubjects(
  tx: TenantDb,
  tenantId: string,
  actor: MemberActor,
  refs: readonly AskDeclineRef[],
): Promise<Map<string, AskDeclineSubject>> {
  const out = new Map<string, AskDeclineSubject>();
  const mine = refs.filter((r) => isAskDeclineKind(r.kind) && r.entityType === "CredentialAsk");
  if (mine.length === 0 || actor.impersonated) return out;
  const may = await accessibleCodes(tx, tenantId, actor, ["credential:view"]);
  if (!may.has("credential:view")) return out;
  const scope = await resolveScope(tx, actor);

  const asks = await tx.credentialAsk.findMany({
    where: { tenantId, id: { in: [...new Set(mine.map((r) => r.entityId))] } },
    select: { id: true, clientId: true, projectId: true, client: { select: { name: true } }, project: { select: { key: true } } },
  });
  const byId = new Map(asks.map((a) => [a.id, a]));
  for (const r of mine) {
    const a = byId.get(r.entityId);
    if (!a || !anchorInScope(scope, { clientId: a.clientId, projectId: a.projectId })) continue;
    out.set(
      r.id,
      a.project
        ? { title: `${a.client.name} · ${a.project.key}`, href: `/projects/${a.project.key}/vault` }
        : { title: a.client.name, href: `/clients/${a.clientId}/vault` },
    );
  }
  return out;
}

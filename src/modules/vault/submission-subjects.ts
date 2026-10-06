import { resolveScope, type MemberActor } from "@/authz/authorize";
import type { TenantDb } from "@/db";
import { accessibleCodes } from "@/entitlements/resolver";

import { anchorScopeWhere } from "./scope";

/**
 * WHAT "A CLIENT SENT A LOGIN" MAY NAME IN THE INBOX (Phase 3V slice 96;
 * founder decision C64 (c)) — the inbox's subject resolution for
 * `credential.submitted`, which `src/notify/inbox.ts` hands over because
 * its rules are the vault's, as it does the renewal reminders
 * (`reminder-subjects.ts`).
 *
 * The notification's entity is the CLIENT, never the login (C54: which
 * logins stays behind the vault's door). Under the READER's own principal,
 * at read time: the client is named — and linked to `/vault` filtered to
 * it, which `credential:view` opens — only while the reader holds
 * `credential:view` on all four gates, is not impersonating (the vault
 * refuses impersonation before it reads anything — `door.ts`), and reaches,
 * by the vault's anchor rule, at least one live login of that client a
 * contact handed over. Otherwise the row resolves to nothing and the inbox
 * draws the kind's generic label with no name and no link — an assignment
 * removed, the module or the code taken away since the fan-out chose them.
 *
 * Reads in sequence on the caller's transaction (AGENTS.md's trap); the
 * permission read is ONE `accessibleCodes`, never a leg.
 */

export const SUBMISSION_KIND = "credential.submitted";

export const isSubmissionKind = (kind: string): boolean => kind === SUBMISSION_KIND;

export type SubmissionRef = {
  /** The notification's id — the key of the answer. */
  readonly id: string;
  readonly kind: string;
  readonly entityType: string;
  readonly entityId: string;
};

export type SubmissionSubject = { readonly title: string; readonly href: string };

export async function submissionSubjects(
  tx: TenantDb,
  tenantId: string,
  actor: MemberActor,
  refs: readonly SubmissionRef[],
): Promise<Map<string, SubmissionSubject>> {
  const out = new Map<string, SubmissionSubject>();
  const mine = refs.filter((r) => isSubmissionKind(r.kind) && r.entityType === "Client");
  if (mine.length === 0 || actor.impersonated) return out;
  const may = await accessibleCodes(tx, tenantId, actor, ["credential:view"]);
  if (!may.has("credential:view")) return out;
  const scope = await resolveScope(tx, actor);
  const inScope = anchorScopeWhere(scope);

  const reached: string[] = [];
  // One bounded probe per client on the page, in turn — an inbox page holds
  // a handful, and a per-client `findFirst` reads one row each.
  for (const clientId of new Set(mine.map((r) => r.entityId))) {
    const one = await tx.credentialItem.findFirst({
      where: { AND: [{ tenantId, clientId, deletedAt: null, submittedByContactId: { not: null } }, inScope] },
      select: { id: true },
    });
    if (one) reached.push(clientId);
  }
  if (reached.length === 0) return out;
  const clients = await tx.client.findMany({
    where: { tenantId, id: { in: reached } },
    select: { id: true, name: true },
  });
  const byClient = new Map(clients.map((c) => [c.id, c]));
  for (const r of mine) {
    const c = byClient.get(r.entityId);
    if (c) out.set(r.id, { title: c.name, href: `/vault?client=${c.id}` });
  }
  return out;
}

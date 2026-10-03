import { resolveScope, type MemberActor } from "@/authz/authorize";
import type { TenantDb } from "@/db";
import { accessibleCodes } from "@/entitlements/resolver";

import { loginWindowOf } from "./reminder-bands";
import { anchorScopeWhere } from "./scope";

/**
 * WHAT A RENEWAL REMINDER IN THE INBOX MAY NAME (Phase 3V slice 89) — the
 * inbox's subject resolution for the three `expiration.*` kinds, which
 * `src/notify/inbox.ts` hands over because their rules are the vault's.
 *
 * It runs under the READER's own principal, at read time, and is
 * SCOPE-FILTERED rather than scope-checked, as the inbox is: a row whose
 * subject the reader can no longer see is not refused — it resolves to
 * nothing, and the inbox draws the kind's generic label with no name, no
 * link and no number (an asset re-anchored, an assignment removed, the
 * module or the code taken away since the job chose them). The job decided
 * who to TELL; this decides what each reader may READ, now.
 *
 *   - an ASSET: `asset:view` on all four gates and the vault's anchor
 *     rule (`anchorScopeWhere`) — named, and linked to its line on the
 *     client's Assets tab with `client:view` (every `/clients/[id]` page
 *     wants it), else to Renewals, which `asset:view` opens;
 *   - an AGREEMENT: `service:view` and the same rule (= `listServices`') —
 *     linked to the client's Agreements tab only for DIRECT assignment with
 *     `client:view` (the tab's own rule), else to Renewals with
 *     `asset:view`, else named without a link (C34's rule: never a link to
 *     a page that refuses);
 *   - LOGINS: `credential:view` and never under impersonation (the vault
 *     refuses impersonation before it reads anything — `door.ts`): the
 *     CLIENT is named, never a login (C54, C56), and only while the reader
 *     still reaches — by the anchor rule the job counted by — at least one
 *     live login of that client that COULD HAVE BEEN IN THAT REMINDER: one
 *     whose UTC expiry day falls in the band counted from the tenant's day
 *     the job decided on (`from` in the row's params). The number drawn
 *     is capped at how many such logins they reach NOW, so a reader moved
 *     from the client to one of its projects is never shown the count they
 *     were sent as a direct member, and a login expiring years away cannot
 *     keep the row named (the security review's low, then the fix-pass
 *     review's). Linked to the client's Vault tab with `client:view`, else
 *     to `/vault` filtered to the client. Our own logins (the tenant) only
 *     to tenant-wide scope (C49), linked to `/vault` filtered to our own.
 *
 * Reads in sequence on the caller's transaction (AGENTS.md's trap); the
 * permission read is ONE `accessibleCodes`, never a leg.
 */

export const REMINDER_KINDS = [
  "expiration.asset_due",
  "expiration.agreement_ending",
  "expiration.logins_expiring",
] as const;

export type ReminderKind = (typeof REMINDER_KINDS)[number];

export const isReminderKind = (kind: string): kind is ReminderKind =>
  (REMINDER_KINDS as readonly string[]).includes(kind);

export type ReminderRef = {
  /** The notification's id — the key of the answer. */
  readonly id: string;
  readonly kind: string;
  readonly entityType: string;
  readonly entityId: string;
  /** Its band from `params`, already held to `REMINDER_BANDS` by the caller; null when unreadable. */
  readonly days: number | null;
  /** The tenant's day the job decided on, `YYYY-MM-DD`, from a login reminder's `params`; null otherwise. */
  readonly from: string | null;
};

/**
 * At most this many logins are read to bound a page's counts, the LATEST
 * expiries first — a cut can only lower a count, and it lowers the oldest
 * rows' first, never today's (the narrow review).
 */
const LOGIN_READ_LIMIT = 2000;

export type ReminderSubject = {
  readonly title: string;
  readonly href: string | null;
  /**
   * Logins only: the most the row may say expire — how many of that
   * client's (or our own) logins the reader reaches now that could have been
   * in it (`windowOf`). Null for an asset or an agreement.
   */
  readonly countCap: number | null;
};

export async function reminderSubjects(
  tx: TenantDb,
  tenantId: string,
  actor: MemberActor,
  refs: readonly ReminderRef[],
): Promise<Map<string, ReminderSubject>> {
  const out = new Map<string, ReminderSubject>();
  const mine = refs.filter((r) => isReminderKind(r.kind));
  if (mine.length === 0) return out;

  const may = await accessibleCodes(tx, tenantId, actor, ["asset:view", "service:view", "credential:view", "client:view"]);
  if (!may.has("asset:view") && !may.has("service:view") && !may.has("credential:view")) return out;
  const scope = await resolveScope(tx, actor);
  const inScope = anchorScopeWhere(scope);
  const clientPages = may.has("client:view");
  const direct = (clientId: string) => scope.all || scope.directClientIds.includes(clientId);
  const idsOf = (kind: ReminderKind, entityType: string) => [
    ...new Set(mine.filter((r) => r.kind === kind && r.entityType === entityType).map((r) => r.entityId)),
  ];

  const assetIds = may.has("asset:view") ? idsOf("expiration.asset_due", "ClientAsset") : [];
  const assets = assetIds.length
    ? await tx.clientAsset.findMany({
        where: { AND: [{ tenantId, id: { in: assetIds } }, inScope] },
        select: { id: true, name: true, clientId: true },
      })
    : [];
  const byAsset = new Map(assets.map((a) => [a.id, a]));

  const serviceIds = may.has("service:view") ? idsOf("expiration.agreement_ending", "Service") : [];
  const services = serviceIds.length
    ? await tx.service.findMany({
        where: { AND: [{ tenantId, id: { in: serviceIds } }, inScope] },
        select: { id: true, name: true, clientId: true },
      })
    : [];
  const byService = new Map(services.map((s) => [s.id, s]));

  // LOGINS: what the reader reaches NOW, per row, by the anchor rule and
  // the row's own window (`windowOf`) — our own (a null client) only under
  // tenant-wide scope, the second of C49's two checks.
  const logins = may.has("credential:view") && !actor.impersonated;
  const loginRefs = logins
    ? mine.flatMap((r) => {
        if (r.kind !== "expiration.logins_expiring" || r.days === null || r.from === null) return [];
        if (r.entityType !== "Client" && !(r.entityType === "Tenant" && r.entityId === tenantId && scope.all)) return [];
        const window = loginWindowOf(r.from, r.days);
        return window ? [{ ...r, window }] : [];
      })
    : [];
  const loginClientIds = [...new Set(loginRefs.filter((r) => r.entityType === "Client").map((r) => r.entityId))];
  const wantsOurs = loginRefs.some((r) => r.entityType === "Tenant");
  const spans = loginRefs.map((r) => r.window);
  const expiring = loginRefs.length
    ? await tx.credentialItem.findMany({
        where: {
          AND: [
            {
              tenantId,
              deletedAt: null,
              expiresAt: { gte: new Date(Math.min(...spans.map((w) => w.start))), lt: new Date(Math.max(...spans.map((w) => w.end))) },
              OR: [...(loginClientIds.length ? [{ clientId: { in: loginClientIds } }] : []), ...(wantsOurs ? [{ clientId: null }] : [])],
            },
            inScope,
          ],
        },
        select: { clientId: true, expiresAt: true },
        orderBy: [{ expiresAt: "desc" }, { id: "asc" }],
        take: LOGIN_READ_LIMIT,
      })
    : [];
  const capOf = new Map(
    loginRefs.map((r) => {
      const w = r.window;
      const client = r.entityType === "Client" ? r.entityId : null;
      const n = expiring.filter((l) => {
        const t = l.expiresAt?.getTime() ?? Number.NaN;
        return l.clientId === client && t >= w.start && t < w.end;
      }).length;
      return [r.id, n] as const;
    }),
  );
  const named = loginRefs.filter((r) => (capOf.get(r.id) ?? 0) > 0);
  const reachedClientIds = [...new Set(named.filter((r) => r.entityType === "Client").map((r) => r.entityId))];
  const clients = reachedClientIds.length
    ? await tx.client.findMany({ where: { tenantId, id: { in: reachedClientIds } }, select: { id: true, name: true } })
    : [];
  const byClient = new Map(clients.map((c) => [c.id, c]));
  const ours = named.some((r) => r.entityType === "Tenant")
    ? await tx.tenant.findFirst({ where: { id: tenantId }, select: { name: true } })
    : null;

  for (const r of mine) {
    if (r.kind === "expiration.asset_due" && r.entityType === "ClientAsset") {
      const a = byAsset.get(r.entityId);
      if (a) {
        out.set(r.id, {
          title: a.name,
          href: clientPages ? `/clients/${a.clientId}/assets#asset-${a.id}` : "/expirations",
          countCap: null,
        });
      }
    } else if (r.kind === "expiration.agreement_ending" && r.entityType === "Service") {
      const s = byService.get(r.entityId);
      if (s) {
        out.set(r.id, {
          title: s.name,
          href:
            direct(s.clientId) && clientPages
              ? `/clients/${s.clientId}/agreements`
              : may.has("asset:view")
                ? "/expirations"
                : null,
          countCap: null,
        });
      }
    } else if (r.kind === "expiration.logins_expiring") {
      const cap = capOf.get(r.id) ?? 0;
      if (cap === 0) continue; // nothing this reader reaches could have been in it
      if (r.entityType === "Client") {
        const c = byClient.get(r.entityId);
        if (c) out.set(r.id, { title: c.name, href: clientPages ? `/clients/${c.id}/vault` : `/vault?client=${c.id}`, countCap: cap });
      } else if (r.entityType === "Tenant" && r.entityId === tenantId && ours) {
        out.set(r.id, { title: ours.name, href: "/vault?client=agency", countCap: cap });
      }
    }
  }
  return out;
}

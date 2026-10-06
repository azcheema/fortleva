import { recordMany } from "@/audit/record";
import type { TenantDb } from "@/db";

import { holdRevealsOf } from "./budget";

/**
 * OFFBOARDING FLAGS (Phase 3V slice 94; plan §3.4 "Offboarding";
 * SECURITY.md §6.3; DATA_MODEL.md §6.17): removing a member marks every
 * login whose secret they could know — from what they did in the last 90
 * days — as needing a change (`needsRotation`, the vault's "Change
 * soon"), one `credential.rotation_flagged` per login, in the removal's own
 * transaction — and cancels the share links they made that are still
 * open (`revokeShareLinksMadeBy`, C62 (a)). The agency changes the secret
 * at the source and saves the new values here; the flag goes once no old
 * secret value is left (`replaceCredentialSecret`, C62 (b)).
 *
 * WHAT COUNTS AS KNOWING IT, read from the member's OWN audit rows — the
 * reveal budget's authority (`budget.ts`), so there is no second record
 * to keep in step:
 *  - a reveal or a copy (`credential.revealed | copied`);
 *  - a share link they made (`credential.shared`; target the link, the
 *    login in its metadata) — the budget's own reasoning: a link to one's
 *    own address is a reveal by another door;
 *  - a secret they TYPED: creating the login (`credential.created`), or
 *    changing its secret or setting a seed (`credential.updated` with
 *    `secretChanged`, or `totpChanged` leaving a seed). An employee may
 *    create logins and never reveal one, so "revealed" alone would flag
 *    none of a departing employee's.
 * NOT a TOTP code (`credential.totp_generated`): a code is dead in thirty
 * seconds and the seed never leaves the server. Nor a contact's acts —
 * the actor is the MEMBER.
 *
 * NOT NARROWED BY A LATER ROTATION. A rotation is per login, not per
 * field: an API key rotated on one field still has the other field the
 * member saw. Flagging a login too many costs one change; a login too few
 * is the hole this exists to close.
 *
 * EVERY such login, archived or in the bin too — a restore must not bring
 * back a secret a departed member knows without its flag. One already
 * flagged is left as it is and recorded again by nobody.
 *
 * THE LOCK: the member's reveal key is held before anything is read
 * (`holdRevealsOf`), so a reveal racing the removal either landed first
 * and is read here, or waits and is then refused (`lockRevealBudget`).
 * The 90 days run on the DATABASE's clock, as the audit rows' stamps do.
 *
 * Precondition: the caller has authorised the removal and holds the
 * tenant row's lock; the audit rows name the caller as the actor.
 */

export const ROTATION_WINDOW_DAYS = 90;

/** Flag what `memberId` could know; returns how many logins were newly flagged. */
export async function flagLoginsKnownBy(tx: TenantDb, tenantId: string, memberId: string): Promise<number> {
  await holdRevealsOf(tx, tenantId, memberId);
  const known = await tx.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT c.id
    FROM audit_event a
    JOIN credential_item c
      ON c.tenant_id = a.tenant_id
     AND c.id = CASE WHEN a.action = 'credential.shared' THEN a.metadata->>'credentialId' ELSE a.target_id END
    WHERE a.tenant_id = ${tenantId}
      AND a.actor_type = 'MEMBER'
      AND a.actor_id = ${memberId}
      AND a.created_at >= now() - make_interval(days => ${ROTATION_WINDOW_DAYS}::int)
      AND (
        a.action IN ('credential.revealed', 'credential.copied', 'credential.shared', 'credential.created')
        OR (
          a.action = 'credential.updated'
          AND (
            a.metadata->'secretChanged' = 'true'::jsonb
            OR (a.metadata->'totpChanged' = 'true'::jsonb AND a.metadata->'hasTotp' = 'true'::jsonb)
          )
        )
      )
      AND NOT c.needs_rotation`;
  if (known.length === 0) return 0;
  const flagged = await tx.credentialItem.updateManyAndReturn({
    where: { tenantId, id: { in: known.map((k) => k.id) }, needsRotation: false },
    data: { needsRotation: true },
    select: { id: true },
  });
  await recordMany(
    tx,
    flagged.map((c) => ({
      action: "credential.rotation_flagged" as const,
      targetType: "CredentialItem",
      targetId: c.id,
      metadata: { memberId, cause: "member_removed" },
    })),
  );
  return flagged.length;
}

/**
 * Removing a member CANCELS every share link they made that is still open
 * (founder decision C62 (a), 2026-10-06): not opened, not revoked, still in
 * date — revoked as the REMOVER (the link guard's "a member revokes as
 * themselves"), one `credential.share_revoked` each with `cause:
 * "member_removed"`, as a seal revokes a login's links. A link meant for
 * a client or contractor is sent again by a colleague.
 *
 * Call it AFTER `flagLoginsKnownBy`, in the same transaction: the member's
 * key is then held, so no link of theirs can be born unseen, and the order
 * is login rows before link rows — the order a seal keeps (each link's
 * login is locked first, below); opening a link locks only the link.
 * Stamped by the database's clock, read now.
 */
export async function revokeShareLinksMadeBy(
  tx: TenantDb,
  tenantId: string,
  memberId: string,
  /** The remover — the transaction's own member principal, as the guard requires. */
  byMemberId: string,
): Promise<number> {
  const rows = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  const now = rows[0]?.now;
  if (!now) throw new Error("vault: no clock");
  // The links' LOGINS first, in id order — a seal locks its login and then
  // its links, and a login already marked was never locked by the flags
  // above (slice 94b's review: a removal and a seal of one login could
  // otherwise take two of its links in opposite orders and deadlock).
  await tx.$queryRaw`
    SELECT c.id FROM credential_item c
    WHERE c.tenant_id = ${tenantId}
      AND c.id IN (
        SELECT l.credential_id FROM credential_share_link l
        WHERE l.tenant_id = ${tenantId} AND l.created_by_member_id = ${memberId}
          AND l.viewed_at IS NULL AND l.revoked_at IS NULL AND l.expires_at > ${now})
    ORDER BY c.id
    FOR SHARE`;
  const revoked = await tx.credentialShareLink.updateManyAndReturn({
    where: { tenantId, createdByMemberId: memberId, viewedAt: null, revokedAt: null, expiresAt: { gt: now } },
    data: { revokedAt: now, revokedByMemberId: byMemberId },
    select: { id: true, credentialId: true },
  });
  await recordMany(
    tx,
    revoked.map((link) => ({
      action: "credential.share_revoked" as const,
      targetType: "CredentialShareLink",
      targetId: link.id,
      metadata: { credentialId: link.credentialId, memberId, cause: "member_removed" },
    })),
  );
  return revoked.length;
}

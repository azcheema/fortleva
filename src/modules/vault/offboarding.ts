import { recordMany } from "@/audit/record";
import type { TenantDb } from "@/db";

import { holdRevealsOf } from "./budget";

/**
 * OFFBOARDING FLAGS (Phase 3V slice 94; plan §3.4 "Offboarding";
 * SECURITY.md §6.3; DATA_MODEL.md §6.17): removing a member marks every
 * login whose secret they could know — from what they did in the last 90
 * days — as needing a change (`needsRotation`, the vault's "Change
 * soon"), one `credential.rotation_flagged` per login, in the removal's own
 * transaction. The agency changes the secret at the source and saves the
 * new value here, which clears the flag (`replaceCredentialSecret`).
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

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
 *  - an export (`credential.exported`, one row per login in the file —
 *    slice 95; founder decision C63 (d)): they had every exported secret
 *    in a file, so an owner who exported the whole vault and then leaves
 *    marks the whole vault;
 *  - a secret they TYPED: creating the login (`credential.created`), or
 *    changing its secret or setting a seed (`credential.updated` with
 *    `secretChanged`, or `totpChanged` leaving a seed). An employee may
 *    create logins and never reveal one, so "revealed" alone would flag
 *    none of a departing employee's.
 * NOT a TOTP code (`credential.totp_generated`): a code is dead in thirty
 * seconds and the seed never leaves the server — except in an export, which
 * counts above for the whole login anyway. Nor a contact's acts — the
 * actor is the MEMBER.
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
 * The 90 days run on the database's clock; an audit row is stamped by the
 * APP at its insert (Prisma's `@default(now())` — measured in slice 95), so
 * the window's edge can move by the clocks' drift, never by a day.
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
        a.action IN ('credential.revealed', 'credential.copied', 'credential.shared', 'credential.created', 'credential.exported')
        OR (
          a.action = 'credential.updated'
          AND (
            a.metadata->'secretChanged' = 'true'::jsonb
            OR (a.metadata->'totpChanged' = 'true'::jsonb AND a.metadata->'hasTotp' = 'true'::jsonb)
          )
        )
      )`;
  if (known.length === 0) return 0;
  // EVERY candidate locked, the ones already marked included, in id order
  // (slice 95's fix-round review): a change of a MARKED login holds its row
  // while it decides whether the mark may go — and asks whether a seed's
  // exporter is still ACTIVE (C63 (e), `seedTakenByLeaver`). Unlocked, this
  // removal would skip the login as "already marked" while that change,
  // still seeing this member active, cleared it: both commit, and the login
  // is clean with a leaver holding its seed. Locked, the change finishes
  // first and the update below marks it again, or waits and then sees this
  // member gone. NO KEY UPDATE: it conflicts with the change's FOR UPDATE
  // and lets a row that merely REFERENCES the login be inserted meanwhile.
  // Login rows before link rows, as `revokeShareLinksMadeBy` and a seal keep
  // it; a login's change locks only its own row. (A login whose seed they
  // exported more than 90 days ago is not locked: this removal never writes
  // it, so a change racing it ends as one of the two serial orders would —
  // the third review's low, answered.)
  await tx.$queryRaw`
    SELECT id FROM credential_item
    WHERE tenant_id = ${tenantId} AND id = ANY(${known.map((k) => k.id)}::text[])
    ORDER BY id
    FOR NO KEY UPDATE`;
  // Never an ERASED login (slice 99): the tombstone of one a client sent is
  // kept for the client's record and holds no secret to change — and the
  // purge guard refuses any write to it, which would abort this removal
  // (the design review's low). A binned login not yet erased is still
  // flagged, as before.
  const flagged = await tx.credentialItem.updateManyAndReturn({
    where: { tenantId, id: { in: known.map((k) => k.id) }, needsRotation: false, purgedAt: null },
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
 * THE AUTHENTICATOR SEED A LEAVER TOOK (founder decision C63 (e),
 * 2026-10-06). C62 (b) lets "Change soon" go without a new seed because
 * nobody ever sees one — but an export puts the seed in the file. So a seed
 * that a member who is NO LONGER ACTIVE exported, after it was last set, is
 * a part they still hold: `replaceCredentialSecret` keeps the mark on a
 * login that keeps that seed. An exporter who still works here does not
 * count — their knowledge never marked anything. Read from the export's own
 * audit rows (`seed: true`) and the seed changes (`credential.updated` with
 * `totpChanged`); a member row that is gone counts as gone.
 */
export async function seedTakenByLeaver(tx: TenantDb, tenantId: string, credentialId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ hit: number }[]>`
    SELECT 1 AS hit
    FROM audit_event e
    LEFT JOIN member m ON m.tenant_id = e.tenant_id AND m.id = e.actor_id
    WHERE e.tenant_id = ${tenantId}
      AND e.target_type = 'CredentialItem'
      AND e.target_id = ${credentialId}
      AND e.action = 'credential.exported'
      AND e.actor_type = 'MEMBER'
      AND e.metadata->'seed' = 'true'::jsonb
      AND (m.id IS NULL OR m.status <> 'ACTIVE')
      -- An audit row is stamped at its INSERT, and the export writes its rows
      -- after it read the seed: a seed change that committed while it waited
      -- is older than its row (measured in export.dbtest.ts).
      AND e.created_at > COALESCE(
        (SELECT max(s.created_at) FROM audit_event s
          WHERE s.tenant_id = ${tenantId}
            AND s.target_type = 'CredentialItem'
            AND s.target_id = ${credentialId}
            AND s.action = 'credential.updated'
            AND s.metadata->'totpChanged' = 'true'::jsonb),
        '-infinity'::timestamptz)
    LIMIT 1`;
  return rows.length > 0;
}

/**
 * WHETHER A TAKEN SEED IS ALL THAT HOLDS THE MARK (C63 (e); slice 95's
 * fix-round review). A member who follows the hint in two saves — every
 * field new first, then the new key — must see the mark go on the second:
 * the first save's `credential.updated` says `heldBySeed` when it would
 * have cleared the mark but for the seed, and a later change of the seed
 * finishes it — so long as NOBODY HAS BEEN REMOVED since that save. A
 * removal in between may be of somebody who saw the new fields, and it
 * writes no flag row for a login already marked, so nothing else here
 * could tell; failing closed costs one save of every new value in one go.
 * Both rows are stamped at their insert (by the app's clock), and the
 * removal writes `member.suspended` AFTER it held the departing member's
 * key and flagged (`suspendMember`) — so a save or a reveal of theirs that
 * the removal waited on is older than the removal's row, and counts (the
 * third review: written first, the row was older than the leaver's own
 * save made during that wait).
 */
export async function fieldsClearedSinceMarked(tx: TenantDb, tenantId: string, credentialId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ hit: number }[]>`
    SELECT 1 AS hit
    FROM audit_event u
    WHERE u.tenant_id = ${tenantId}
      AND u.target_type = 'CredentialItem'
      AND u.target_id = ${credentialId}
      AND u.action = 'credential.updated'
      AND u.metadata->'heldBySeed' = 'true'::jsonb
      AND u.created_at > COALESCE(
        (SELECT max(r.created_at) FROM audit_event r
          WHERE r.tenant_id = ${tenantId}
            AND r.target_type = 'CredentialItem'
            AND r.target_id = ${credentialId}
            AND r.action = 'credential.rotation_flagged'),
        '-infinity'::timestamptz)
      AND NOT EXISTS (
        SELECT 1 FROM audit_event s
        WHERE s.tenant_id = ${tenantId}
          AND s.action = 'member.suspended'
          AND s.created_at >= u.created_at)
    ORDER BY u.created_at DESC
    LIMIT 1`;
  return rows.length > 0;
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
  // its links (slice 94b's review: a removal and a seal of one login could
  // otherwise take two of its links in opposite orders and deadlock). Since
  // slice 95 the flags above already lock every candidate login, marked or
  // not, and a link's login is always one (a link lives ≤ 168 h, inside the
  // 90 days) — so this re-takes rows already held: kept as the belt that
  // holds the order if the flags' candidates ever narrow.
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

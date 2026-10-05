import type { TenantDb } from "@/db";

/**
 * THE CLIENT'S DOOR, ITS FOUR RAW STATEMENTS (Phase 3V slice 91) — the
 * row lock, the clock, "is it open" and "is it waiting for a code", kept
 * out of the portal broker (`portal-writes.ts`) because the portal tripwire's AST tier
 * bans raw SQL in every portal file ("raw SQL has no allow-list a reader
 * can check", `src/authz/portal-projections.test.ts`) and these must be
 * raw: a `FOR UPDATE`, and a comparison made on the DATABASE'S clock, the
 * clock that stamped `open_until`. `src/portal/contact-budget-lock.ts` is
 * the precedent for the split. Each takes a SYSTEM transaction (the broker
 * is the only caller); `contact_vault_unlock` is class A, so a contact's
 * transaction would read nothing here anyway.
 */

/**
 * How long a door waits for its code after the password made it: an hour.
 * Past it, the password is asked again — C52 (k)'s "each time" is about a
 * sitting, not a session that stays signed in for days — and BOTH the
 * code check (`lockPendingDoor`) and the page's "waiting" read
 * (`doorWaitingForCode`) use this one figure, so they cannot disagree (the
 * fix-pass review).
 */
export const DOOR_WAITS_MINUTES = 60;

/**
 * The newest door of this contact's SESSION that is not open yet and still
 * waiting (made within `DOOR_WAITS_MINUTES`), locked `FOR UPDATE` — the one
 * a code is checked against or re-sent for — or null. Locked so two checks
 * of one code queue: the second, reading again once it holds the lock, sees
 * the first one's count. Its wait is bounded by the caller
 * (`boundedVaultWrite`).
 */
export async function lockPendingDoor(
  tx: TenantDb,
  tenantId: string,
  contactId: string,
  sessionId: string,
): Promise<string | null> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM contact_vault_unlock
     WHERE tenant_id = ${tenantId} AND contact_id = ${contactId} AND session_id = ${sessionId}
       AND opened_at IS NULL
       AND created_at > now() - make_interval(mins => ${DOOR_WAITS_MINUTES}::int)
     ORDER BY created_at DESC, id DESC
     LIMIT 1
     FOR UPDATE`;
  return rows[0]?.id ?? null;
}

/**
 * Until when this contact's logins are open in THIS session — the latest
 * `open_until` still ahead of the database's `now()` — or null when they
 * are locked. One session's door never opens another's.
 */
export async function doorOpenUntil(
  tx: TenantDb,
  tenantId: string,
  contactId: string,
  sessionId: string,
): Promise<Date | null> {
  const rows = await tx.$queryRaw<{ open_until: Date | null }[]>`
    SELECT max(open_until) AS open_until FROM contact_vault_unlock
     WHERE tenant_id = ${tenantId} AND contact_id = ${contactId} AND session_id = ${sessionId}
       AND open_until > now()`;
  return rows[0]?.open_until ?? null;
}

/**
 * Is a door of THIS session waiting for its code — made within
 * `DOOR_WAITS_MINUTES`, not opened, checks left, and a code still live or a
 * new one still to be had? The page then starts at the code step, so a
 * reload or a mail that failed does not send the client back to their
 * password (and a second door the first code no longer fits).
 */
export async function doorWaitingForCode(
  tx: TenantDb,
  tenantId: string,
  contactId: string,
  sessionId: string,
): Promise<boolean> {
  // The door `lockPendingDoor` would lock — the newest unopened one within
  // the same age — so "waiting" and the check agree on which door, and on
  // its age; the rest (checks left, a code live or one to be had) is what
  // the broker then refuses as start_again.
  const rows = await tx.$queryRaw<{ waiting: boolean }[]>`
    SELECT (code_attempts < 5
            AND (code_expires_at > now() OR codes_sent < 5)) AS waiting
      FROM contact_vault_unlock
     WHERE tenant_id = ${tenantId} AND contact_id = ${contactId} AND session_id = ${sessionId}
       AND opened_at IS NULL
       AND created_at > now() - make_interval(mins => ${DOOR_WAITS_MINUTES}::int)
     ORDER BY created_at DESC, id DESC
     LIMIT 1`;
  return rows[0]?.waiting === true;
}

/** The database's clock — the one every CHECK and stamp on the door is measured by. */
export async function doorClock(tx: TenantDb): Promise<Date> {
  const rows = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
  const row = rows[0];
  if (!row) throw new Error("vault: the database returned no clock");
  return row.now;
}

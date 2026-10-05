import type { TenantDb } from "@/db";
import { askWaitState, type AskWaitStamps } from "@/lib/ask-and-wait";
import { dbErrorMapper } from "@/lib/db-error-map";

import { SEALED_RULES, sealedAskLockKey } from "./sealed-rules";

/**
 * THE SEALED ASK'S RAW STATEMENTS (Phase 3V slice 93) — the locks and the
 * clock, kept out of the portal broker (`sealed-portal-writes.ts`) because
 * the portal tripwire bans raw SQL in every portal file, and these must be
 * raw: an advisory lock, a `FOR UPDATE` / `FOR SHARE`, and comparisons on
 * the DATABASE'S clock — the clock the guard trigger judges every
 * transition by (`client-door.ts` is the precedent for the split). Waits
 * are bounded by the caller (`boundedVaultWrite`).
 */

/** The database's clock NOW — `clock_timestamp()`, read after any lock wait, never the transaction's start. */
export async function sealedClock(tx: TenantDb): Promise<Date> {
  const rows = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  const row = rows[0];
  if (!row) throw new Error("vault: the database returned no clock");
  return row.now;
}

/**
 * Take one client's ask lock — the guard trigger's own key, so an ask
 * decided here and the trigger's belt see one ask at a time per client.
 * `$executeRaw`: the lock returns `void`, which `$queryRaw` cannot read.
 */
export async function lockClientAsks(tx: TenantDb, tenantId: string, clientId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${sealedAskLockKey(tenantId, clientId)}))`;
}

/**
 * Lock one ask's row `FOR UPDATE` for the rest of the transaction — the
 * row every answer, confirmation and withdrawal is decided on — and say
 * whether it exists. The caller reads it AFTER this (a fresh statement
 * under READ COMMITTED sees whatever committed while it waited).
 */
export async function lockAsk(tx: TenantDb, tenantId: string, id: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM sealed_open_request WHERE tenant_id = ${tenantId} AND id = ${id} FOR UPDATE`;
  return rows.length === 1;
}

/**
 * An ask that has the client's sealed logins open: until when, and when it
 * was DECIDED — approved, or confirmed after the silent wait. WHAT it opens
 * is the logins sealed at that moment and no later (both reviews' medium):
 * a login sealed while the window is open stays shut, as sealing promises —
 * it "only locks it more" (C52 (e)); nobody consented to it, and on the
 * silent path nobody consented at all.
 */
export type OpenAsk = { readonly id: string; readonly openUntil: Date; readonly decidedAt: Date };

/**
 * The ask under which this client's sealed logins are OPEN right now — on
 * the database's clock — taken `FOR SHARE`, or null. Shared, so a look
 * and a denial cannot cross: a denial that holds the row (its `FOR UPDATE`)
 * makes the look wait, and the look then re-reads the row as the denial
 * left it (a denial clears `opens_at`), so nothing is shown after an
 * answer that ended it. A denial can only be made BEFORE the opening
 * (the guard), so in practice the two race only at that moment.
 */
export async function openAskOf(
  tx: TenantDb,
  tenantId: string,
  clientId: string,
): Promise<OpenAsk | null> {
  const rows = await tx.$queryRaw<{ id: string; open_until: Date; decided_at: Date }[]>`
    SELECT id, open_until, COALESCE(approved_at, confirmed_at) AS decided_at FROM sealed_open_request
     WHERE tenant_id = ${tenantId} AND client_id = ${clientId}
       AND denied_at IS NULL AND withdrawn_at IS NULL
       AND opens_at <= clock_timestamp() AND open_until > clock_timestamp()
     ORDER BY open_until DESC, id DESC
     LIMIT 1
     FOR SHARE`;
  const row = rows[0];
  return row ? { id: row.id, openUntil: row.open_until, decidedAt: row.decided_at } : null;
}

/**
 * `openAskOf` without the lock — for a LIST of what is open, which shows
 * names and decides nothing: the look at a field takes the lock itself.
 */
export async function openAskPeek(
  tx: TenantDb,
  tenantId: string,
  clientId: string,
): Promise<OpenAsk | null> {
  const rows = await tx.$queryRaw<{ id: string; open_until: Date; decided_at: Date }[]>`
    SELECT id, open_until, COALESCE(approved_at, confirmed_at) AS decided_at FROM sealed_open_request
     WHERE tenant_id = ${tenantId} AND client_id = ${clientId}
       AND denied_at IS NULL AND withdrawn_at IS NULL
       AND opens_at <= clock_timestamp() AND open_until > clock_timestamp()
     ORDER BY open_until DESC, id DESC
     LIMIT 1`;
  const row = rows[0];
  return row ? { id: row.id, openUntil: row.open_until, decidedAt: row.decided_at } : null;
}

/** The stamps the ask-and-wait machine reads, as a Prisma select. */
export const ASK_STAMPS = {
  askedAt: true,
  waitDays: true,
  confirmedAt: true,
  approvedAt: true,
  deniedAt: true,
  withdrawnAt: true,
  opensAt: true,
  openUntil: true,
} as const satisfies Record<keyof AskWaitStamps, true>;

/**
 * This client's one ask that can still be in play — the newest neither
 * denied nor withdrawn. At most one ask per client is live (the guard
 * refuses a second), and none can be made while one is, so the newest of
 * the rest is the only candidate; the caller derives its state.
 */
export async function newestUnendedAsk(tx: TenantDb, tenantId: string, clientId: string) {
  return tx.sealedOpenRequest.findFirst({
    where: { tenantId, clientId, deniedAt: null, withdrawnAt: null },
    orderBy: [{ askedAt: "desc" }, { id: "desc" }],
    select: { id: true, ...ASK_STAMPS },
  });
}

/**
 * Does the client's door have a SEALED purpose right now (slice 93): their
 * sealed logins open, or an ask waiting for their confirmation — which is
 * made through the door (C52 (f))? On the database's clock.
 */
export async function sealedNeedsDoor(tx: TenantDb, tenantId: string, clientId: string): Promise<boolean> {
  const ask = await newestUnendedAsk(tx, tenantId, clientId);
  if (!ask) return false;
  const kind = askWaitState(ask, SEALED_RULES, await sealedClock(tx)).kind;
  return kind === "open" || kind === "confirmable";
}

/**
 * Is THIS session's door open for a CONFIRMATION — opened after the wait
 * ran out, and still open on the database's clock? The guard's own rule
 * (`u.opened_at >= wait_end AND u.open_until > clock_timestamp()`), asked
 * here first so a door opened before the wait ended answers "open the door
 * again" rather than the guard's raw refusal (the migration's re-review).
 */
export async function doorOpenedSince(
  tx: TenantDb,
  tenantId: string,
  contactId: string,
  sessionId: string,
  since: Date,
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM contact_vault_unlock
     WHERE tenant_id = ${tenantId} AND contact_id = ${contactId} AND session_id = ${sessionId}
       AND opened_at >= ${since} AND open_until > clock_timestamp()
     LIMIT 1`;
  return rows.length === 1;
}

/**
 * The guard trigger's refusal (`SEALED_OPEN_REQUEST_GUARD`) read as
 * `SEALED_REQUEST_SETTLED`: the services decide on the database's clock a
 * statement before the guard does, so at the very instant of a deadline —
 * the opening, the lapse, a door closing — the guard can refuse what the
 * service let through. It fails closed either way; this makes it a
 * sentence instead of an error page (the re-review's nit).
 */
export const { guarded: sealedGuarded } = dbErrorMapper([["SEALED_OPEN_REQUEST_GUARD", "SEALED_REQUEST_SETTLED"]]);

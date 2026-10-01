import type { TenantDb } from "@/db";

/**
 * THE REVEAL BUDGET'S AUTHORITY (SECURITY.md §6.3 "per-member reveal
 * budget"; DATA_MODEL.md §6.17 "Reveal budget fallback").
 *
 * The spec names Upstash as the primary limiter and an in-Postgres
 * counter as the fail-CLOSED fallback. What is built is the download
 * budget's layering (`src/documents/portal-writes.ts`): Upstash
 * (`vault.reveal`) is the cheap filter in front, and THIS is the
 * authority behind it, on every call, whether or not Upstash exists. It
 * counts the member's OWN `credential.revealed | copied | totp_generated`
 * audit rows of the last hour — the rows each reveal writes in the same
 * transaction that decrypts — so there is no counter to drift, no second
 * clock, and nothing that can fail open: if the database cannot answer,
 * there is no reveal to make either.
 *
 * THE LOCK serialises one member's reveals, so two concurrent calls
 * cannot both read "29 of 30" and both proceed: the second waits for the
 * first to commit, and its count (a new statement under READ COMMITTED)
 * sees the first one's row. A transaction-scoped advisory lock is the
 * only kind safe behind Neon's transaction-mode pooler. It shares the one
 * 64-bit key space every single-argument `pg_advisory_xact_lock` in the
 * product shares (`src/portal/contact-budget-lock.ts` says why that is
 * acceptable): the `vault_reveal:` prefix changes the hash input, and a
 * collision serialises two waiters and nothing more. Nothing else takes
 * this key, and the reveal takes no other advisory lock, so it can close
 * no cycle.
 *
 * THE CLOCK is Postgres's — `now()`, the TRANSACTION's start, returned
 * by the statement that takes the lock — because the rows being counted
 * are stamped by Postgres too. A transaction that waited for the lock
 * measures its hour from before the wait, which can only count a row or
 * two more, never fewer: the safe direction.
 */

export const REVEAL_ACTIONS = ["credential.revealed", "credential.copied", "credential.totp_generated"] as const;

const WINDOW_MS = 60 * 60_000;

/** Take the member's reveal lock; returns the database clock. */
export async function lockRevealBudget(tx: TenantDb, tenantId: string, memberId: string): Promise<Date> {
  const rows = await tx.$queryRaw<{ now: Date }[]>`
    WITH locked AS (SELECT pg_advisory_xact_lock(hashtext(${`vault_reveal:${tenantId}:${memberId}`})))
    SELECT now() AS now FROM locked`;
  const clock = rows[0];
  if (!clock) throw new Error("vault: the reveal budget lock returned no clock");
  return clock.now;
}

/** The member's reveals, copies and codes in the hour before `now`. */
export async function revealsInLastHour(
  tx: TenantDb,
  tenantId: string,
  memberId: string,
  now: Date,
): Promise<number> {
  return tx.auditEvent.count({
    where: {
      tenantId,
      actorType: "MEMBER",
      actorId: memberId,
      action: { in: [...REVEAL_ACTIONS] },
      createdAt: { gte: new Date(now.getTime() - WINDOW_MS) },
    },
  });
}

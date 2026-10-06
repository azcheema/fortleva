import { deny } from "@/authz/errors";
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
 * transaction that decrypts — and, since slice 90, `credential.shared`
 * (a share link is a reveal by another door) — so there is no counter to drift, no second
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
 * collision serialises two waiters and nothing more. The reveal path and,
 * since slice 90, `createShareLink` take this key — the latter after the
 * share switch's SHARED lock and before a share lock on the login's row,
 * always in that one order; the reveal takes no other lock, and nothing
 * takes these in the other order, so no cycle can close.
 *
 * A REMOVAL TAKES IT TOO (slice 94, `holdRevealsOf`): suspending a member
 * takes THEIR key after the tenant row's lock (and their own row's) and
 * before it flags the logins they could know. And EVERY way a member comes
 * to know a secret takes their key first: a reveal, a copy, a code, a
 * share link and an export (`lockRevealBudget` — the export, slice 95,
 * without spending the hour's budget), and typing one — creating a login or
 * changing its secret (`lockSecretWrite`, before the login's row lock;
 * slice 94's security review). Nothing that holds the key waits on the
 * tenant or member row in a mode the removal's non-key UPDATEs block (an
 * insert's foreign keys take KEY SHARE). So any of these racing the
 * removal either commits first — and the removal, waiting on the key,
 * then reads its row and flags the login — or waits for the removal and
 * then finds the member no longer active: the standing is re-read AFTER
 * the lock, in a new statement, because every gate before the lock was
 * answered while they still were.
 *
 * THE CLOCK is Postgres's — `now()`, the TRANSACTION's start, returned
 * by the statement that takes the lock. The rows being counted are stamped
 * by the APP at their insert (Prisma's `@default(now())` — measured in
 * slice 95, which corrected this note), so the hour's edge moves by the
 * clocks' drift; a transaction that waited for the lock measures its hour
 * from before the wait, which can only count a row or two more, never
 * fewer: the safe direction.
 */

/**
 * What counts against the hour. `credential.shared` since slice 90 (the
 * security review): a share link to one's own address is a reveal by
 * another door, so a tenant that lowers the budget lowers links with it.
 */
export const REVEAL_ACTIONS = [
  "credential.revealed",
  "credential.copied",
  "credential.totp_generated",
  "credential.shared",
] as const;

const WINDOW_MS = 60 * 60_000;

const revealKey = (tenantId: string, memberId: string) => `vault_reveal:${tenantId}:${memberId}`;

/**
 * Take the member's reveal lock; returns the database clock. Refuses a
 * member who is no longer active once the lock is theirs — a removal
 * that committed while this waited (`holdRevealsOf`).
 */
export async function lockRevealBudget(tx: TenantDb, tenantId: string, memberId: string): Promise<Date> {
  const rows = await tx.$queryRaw<{ now: Date }[]>`
    WITH locked AS (SELECT pg_advisory_xact_lock(hashtext(${revealKey(tenantId, memberId)})))
    SELECT now() AS now FROM locked`;
  const clock = rows[0];
  if (!clock) throw new Error("vault: the reveal budget lock returned no clock");
  // A NEW statement, so it sees what committed while the lock was awaited:
  // the statement above took its snapshot before it began to wait.
  const active = await tx.member.findFirst({
    where: { tenantId, id: memberId, status: "ACTIVE" },
    select: { id: true },
  });
  if (!active) deny("FORBIDDEN", "the member is no longer active");
  return clock.now;
}

/**
 * A secret TYPED by the member — a new login, a changed secret or seed —
 * takes the same key and the same re-read (slice 94): a removal counts
 * what they typed as known, so a write racing it must land before its
 * read or be refused after its commit. Call it before any row lock on the
 * login, so the order is always key → row, as `createShareLink`'s is.
 */
export async function lockSecretWrite(tx: TenantDb, tenantId: string, memberId: string): Promise<void> {
  await lockRevealBudget(tx, tenantId, memberId);
}

/**
 * The removal's half of the lock (slice 94): hold `memberId`'s reveal key
 * until this transaction ends, so none of their reveals or typed secrets
 * can commit unseen between the read of what they could know and the
 * suspension's commit.
 */
export async function holdRevealsOf(tx: TenantDb, tenantId: string, memberId: string): Promise<void> {
  // `$executeRaw`: the lock returns `void`, which `$queryRaw` cannot read.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${revealKey(tenantId, memberId)}))`;
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

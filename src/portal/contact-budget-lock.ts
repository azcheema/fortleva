import type { TenantDb } from "@/db";

/**
 * THE PER-CONTACT ADVISORY LOCK BEHIND EVERY PORTAL BUDGET — one raw
 * statement, in one core file, for the request intake's budget
 * (`assertRequestBudget`, `src/modules/work/requests.ts`), the file
 * download's (`assertDownloadBudget`, `src/documents/portal-writes.ts`)
 * and, since slice 75, a task comment's (`assertCommentBudget`,
 * `src/modules/work/portal-comment.ts`). The first cut of the download slice copied the statement into a
 * second file; a review pointed out that the CTE trick, the clock-row
 * guard and the key-space caveat were then documented twice and would
 * be copied a third time by the next budget. `work → core` is the
 * allowed import direction, so the work module's `rank-lock.ts` — where
 * every other `pg_advisory_xact_lock` in the product lives — delegates
 * here rather than the other way round. (Corrected 2026-09-28, slice
 * 74: not every other. The one-bigint keys also include
 * `milestone_rank:` in `src/projects/milestones.ts` and the time
 * module's `tenant:member` in `src/modules/time/ctx.ts`; and the portal
 * switch GATE's locks — two int4 keys per project, a separate key space
 * — live in SQL, migration `20260928180000`, wrapped for application
 * code by `src/projects/portal-gate.ts`. The request intake takes that
 * gate, shared, BEFORE this key. And, since Phase 3V slice 1, the vault's
 * per-member `vault_reveal:` key in `src/modules/vault/budget.ts` — a
 * deliberate copy of this statement, for a MEMBER, that takes no other
 * lock.)
 *
 * WHY IT IS RAW SQL IN A FILE OF ITS OWN: the brokers that call it are
 * scanned by the portal tripwire's AST tier (`src/authz/portal-projections.test.ts`),
 * which bans raw SQL outright — "raw SQL has no allow-list a reader can
 * check" — and a lock has to be raw SQL. This file mentions none of the
 * seam's names, so the tripwire does not scan it, and the one statement
 * that must be raw stays where a reviewer of locks will look.
 *
 * **IT SHARES THE ONE 64-BIT KEY SPACE** every single-argument
 * `pg_advisory_xact_lock` in the product shares: the `<budget>:` prefix
 * changes the hash INPUT, not the namespace, and `hashtext` is 32-bit,
 * so a collision with an unrelated key serialises two waiters and
 * nothing more. The cycle argument is each caller's: the intake takes
 * this key BEFORE the project's rank key and nothing takes them in the
 * other order (and AFTER the portal gate, slice 74 — an order the code
 * keeps, not the database: the gate's SQL refuses only a transaction
 * that has written or row-locked something, and cannot see this key);
 * the download takes this key and no other; the comment takes it AFTER
 * the portal gate and BEFORE its task's row lock, and nothing takes a
 * task row lock and then this key.
 *
 * THE CLOCK RIDES ALONG because it costs nothing to return it from the
 * statement that takes the lock, and because the alternative compares
 * two clocks: the rows each budget counts are stamped by Postgres, so a
 * window computed from a serverless instance's `Date.now()` silently
 * narrows when that instance runs fast and widens when it runs slow.
 *
 * Since Phase 3V slice 91, two more: `portal_logins` — the client's door to
 * the logins shown to them (password checks and mailed codes,
 * `src/modules/vault/portal-writes.ts`), taken BEFORE that door's row lock
 * and never after it — and `portal_logins_reveal`, a look at one of them,
 * which takes no other lock.
 */
export type ContactBudget =
  | "portal_request"
  | "portal_download"
  | "portal_comment"
  | "portal_logins"
  | "portal_logins_reveal";

export async function lockContactBudget(tx: TenantDb, budget: ContactBudget, contactId: string): Promise<Date> {
  // The CTE is what makes this ONE statement: the lock is taken while
  // the row carrying `now()` is produced.
  const rows = await tx.$queryRaw<{ now: Date }[]>`
    WITH locked AS (SELECT pg_advisory_xact_lock(hashtext(${`${budget}:${contactId}`})))
    SELECT now() AS now FROM locked`;
  const clock = rows[0];
  // Postgres cannot return zero rows here; if it somehow does, the
  // budget has no window to measure and must not be guessed at.
  if (!clock) throw new Error(`lockContactBudget(${budget}): no clock row`);
  return clock.now;
}

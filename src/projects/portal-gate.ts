import { record } from "@/audit/record";
import { lockTimeoutSetting, withTenant, type Principal, type TenantDb } from "@/db";
import { retryOnContention } from "@/lib/retry";

/**
 * THE PORTAL SWITCH GATE (Phase 3 slice 74, OPEN_QUESTIONS C40) — the
 * TypeScript side of migration `20260928180000_portal_switch_gate`,
 * whose header is the full argument. In one paragraph:
 *
 * A child row's `portal_enabled` is a COPY of its project's switch,
 * stamped by `stamp_portal_enabled()` when the row is written and
 * rewritten by the project's fan-out when the switch moves. Until this
 * slice the stamp read the project with a plain, lock-free SELECT, so a
 * row written by a transaction still open when a DISABLE's fan-out ran
 * kept `true` after the portal was off. Every project now has a GATE —
 * one transaction-scoped advisory key in the (int4, int4) space, the
 * 64-bit `hashtextextended` of the project id — that the switch holds
 * EXCLUSIVE and every stamp tries SHARED. A stamp NEVER WAITS: if it
 * cannot take the gate a switch is in flight, and it writes `false`
 * (fail closed) and arms a commit-time heal. So the gate adds no wait
 * and no deadlock to any write EXCEPT the one that asks to wait —
 * `enterPortalGateShared`, the client's request, below. (The fan-out's
 * row locks block and can deadlock with writers exactly as they did
 * before; `modules/work/rank-lock.ts` keeps that ledger.)
 *
 * The calls this file wraps are the only ones application code makes;
 * the key derivation lives in SQL alone.
 *
 * THE TWO BLOCKING ENTRIES MUST COME BEFORE THE TRANSACTION WRITES OR
 * ROW-LOCKS ANYTHING, and the SQL refuses a transaction that already has
 * a transaction id (`pg_current_xact_id_if_assigned()`), which is what a
 * write or a row lock assigns. Waiting on the gate while holding no row
 * is what makes the wait cycle-free: whoever holds the gate never waits
 * on it in turn (stamps only try), and cannot be waiting on a row this
 * transaction holds. The SQL CANNOT see an advisory lock taken earlier —
 * those assign no id — so "the gate before the budget key and the rank
 * queue" is kept by the calling code, not by the database.
 */

/**
 * The switch's EXCLUSIVE entry — `setPortalEnabled` calls it before it
 * reads the switch it is about to decide on. BLOCKING, bounded by the
 * caller's `lock_timeout` (`withTenant`'s `lockTimeoutMs`): it waits
 * only for writes already in flight that stamped this project's rows
 * normally, and while it is queued every NEW stamp fails closed rather
 * than queueing behind it, so a stream of writers cannot starve it
 * within an attempt. `$executeRaw` because the SQL function returns
 * void, which the pg adapter cannot decode on `$queryRaw`.
 */
export async function beginPortalSwitch(tx: TenantDb, projectId: string): Promise<void> {
  await tx.$executeRaw`SELECT portal_switch_begin(${projectId})`;
}

/**
 * A writer's SHARED entry, blocking, for the one writer that must not
 * fail closed: a CLIENT's request (`createPortalRequest`). It waits out a
 * switch in flight instead of stamping the new row `false`, so the
 * request's own "is the portal on" check (`requests.ts`) reads a value
 * no switch can change before this transaction commits — a request is
 * refused into a switched-off project, never born invisible to the
 * person who sent it. Bounded by the caller's `lock_timeout`; a spent
 * bound is the broker's REQUEST_BUSY.
 */
export async function enterPortalGateShared(tx: TenantDb, projectId: string): Promise<void> {
  await tx.$executeRaw`SELECT portal_gate_enter_shared(${projectId})`;
}

/** How long a reconcile pass may wait on the gate — behind a switch still in flight. */
const RECONCILE_LOCK_WAIT_MS = 1_500;
/** A pass's whole transaction: eleven indexed UPDATEs over (normally zero) stale rows, and two scans. */
const RECONCILE_TX_MS = 15_000;
/** Passes while rows were skipped because another transaction held them. */
const RECONCILE_PASSES = 3;
/**
 * How long the reconcile polls for the in-doubt writers to END before it
 * reconciles anyway (scaled by the link factor, like every lock bound). A
 * writer still running after this heals itself at its own commit,
 * because the switch that put it in doubt is over by then; what the wait
 * buys is the writer whose heal ran while the switch still held the gate
 * and whose commit became visible only afterwards. That window is the
 * writer's commit — normally milliseconds, but a large in-doubt writer
 * runs one heal per row it wrote false before its commit is visible, and
 * one whose heals outlast this is residual (a) of the migration header.
 */
const DRAIN_DEADLINE_MS = 1_000;

/** The reconcile, the drain and the alarm act as the system: they decide nothing. */
const SYSTEM: Principal = { type: "system" };

/**
 * Wait, WITHOUT QUEUEING, until no writer is registered in doubt for the
 * project (the migration's D key). Each poll is its own short transaction
 * — a try that, when it succeeds, holds D only until that transaction
 * commits a round trip later — so a writer's registration is refused only
 * in that instant, never for the length of a wait. A poll that FAILS
 * (a pool timeout, say) counts as "not drained yet": the drain is an
 * optimisation for a rare writer, and must never cost the passes that
 * follow it. Returns whether it drained before the deadline.
 */
async function drainInDoubtWriters(tenantId: string, projectId: string): Promise<boolean> {
  const deadline = Date.now() + Number(lockTimeoutSetting(DRAIN_DEADLINE_MS));
  for (let pause = 25; ; pause = Math.min(pause * 2, 250)) {
    try {
      const [row] = await withTenant(tenantId, SYSTEM, (tx) =>
        tx.$queryRaw<Array<{ drained: boolean }>>`SELECT portal_doubt_drained(${projectId}) AS drained`,
      );
      if (row?.drained) return true;
    } catch (error) {
      console.error("[portal-gate] a drain poll failed; counted as not drained", { tenantId, projectId, error });
    }
    if (Date.now() + pause > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pause));
  }
}

export type PortalReconcile = {
  /** Rows re-derived to the project's switch, over every pass. */
  readonly fixed: number;
  /** Rows still disagreeing after the last pass — held by another transaction, or written since. */
  readonly skipped: number;
  /** The switch the rows were re-derived to, as the last pass read it. */
  readonly enabled: boolean | null;
};

type PassRow = { rows_fixed: number; rows_skipped: number; portal_on: boolean | null };

/**
 * One pass, in its own transaction. When it reads the switch OFF and
 * CORRECTS rows, the alarm is recorded in the SAME transaction: the
 * correction destroys the evidence (a TRUE turned false), so the two
 * commit together or not at all.
 */
async function reconcilePass(tenantId: string, projectId: string): Promise<PassRow | undefined> {
  return withTenant(
    tenantId,
    SYSTEM,
    async (tx) => {
      const [row] = await tx.$queryRaw<PassRow[]>`
        SELECT rows_fixed, rows_skipped, portal_on
          FROM portal_switch_reconcile(${tenantId}, ${projectId})`;
      if (row?.portal_on === false && row.rows_fixed > 0) {
        await recordAlarm(tx, tenantId, projectId, row.rows_fixed, row.rows_skipped);
      }
      return row;
    },
    { timeoutMs: RECONCILE_TX_MS, lockTimeoutMs: RECONCILE_LOCK_WAIT_MS },
  );
}

/**
 * RE-DERIVE every row of the project whose copy disagrees with the
 * switch — the LIVENESS half of the gate, never its safety.
 *
 * A write that failed closed while a switch held the gate either heals
 * itself at its own commit (the deferred `<t>_portal_heal` trigger, once
 * the gate is free) or, if its heal ran WHILE the switch still held it,
 * is left `false` for this call to find. So `setPortalEnabled` runs it
 * ONCE PER CALL, in its `finally`, after the last attempt, whenever any
 * attempt asked for the gate — a committed ENABLE, a no-op, and a DISABLE
 * that was refused or rolled back all leave such rows in a project that
 * may be ON. It first waits (polling, never queueing) for those writers
 * to END, because a heal runs before its transaction's commit is
 * visible: without the wait a writer could turn visible just after the
 * reconcile looked. When the switch ended OFF (`endedOff`) every row in
 * doubt is already right (false) and the wait is skipped; the passes
 * still run, as the ALARM.
 *
 * THE ALARM. A pass that reads the switch OFF and finds rows disagreeing
 * has found rows a client could read on a switched-off project — what the
 * gate exists to make impossible. It is logged, and recorded as
 * `project.portal_stamp_alarm` (ids and counts): in the pass's own
 * transaction when the pass corrected rows (with its still-disagreeing
 * count), and — when a pass only found such rows HELD by writers and no
 * later correcting pass reported them — once more as this call ends,
 * however it ends.
 *
 * IT NEVER THROWS. It never waits on a row a WRITER holds (the SQL skips
 * locked rows and reports them; the passes retry them); a leg's search
 * feed can wait on a concurrent reconcile's search leg or on the locale
 * restamp (`restampSearchLang`) — bounded, and retried here as a lock
 * timeout or deadlock (rank-lock.ts records the second as a possible
 * deadlock partner). The gate is taken SHARED inside each pass before the
 * switch is read, so no switch can commit between that read and the
 * writes. It runs as the SYSTEM and writes no audit row for a routine
 * correction: like the fan-out it re-derives a trigger-maintained copy
 * and changes nothing anyone decided — which is also why it does not
 * matter if the member lost access between the switch's attempts. A
 * give-up is logged. What it leaves under an ON switch is fail-closed
 * only — rows hidden from the client until the project is next switched;
 * what it leaves under an OFF switch is what the alarm reports.
 */
export async function reconcilePortalStamps(
  tenantId: string,
  projectId: string,
  { endedOff }: { readonly endedOff: boolean },
): Promise<PortalReconcile | null> {
  let fixed = 0;
  let last: PortalReconcile | null = null;
  // Rows of a switched-off project that a pass saw only HELD — nothing it
  // could correct, so no alarm was recorded with a correction. Reported
  // once, on whatever way this call ends, unless a later pass's own alarm
  // (which carries its still-disagreeing count) covered it.
  let heldUnreported: number | null = null;
  const reportHeld = async (): Promise<void> => {
    if (heldUnreported === null) return;
    const stillDisagreeing = heldUnreported;
    heldUnreported = null;
    try {
      // Its own transaction: nothing was corrected, so there is no
      // evidence to keep in step with.
      await withTenant(tenantId, SYSTEM, (tx) => recordAlarm(tx, tenantId, projectId, 0, stillDisagreeing));
    } catch (error) {
      console.error("[portal-gate] could not record the safety alarm", { tenantId, projectId, stillDisagreeing, error });
    }
  };
  try {
    if (!endedOff && !(await drainInDoubtWriters(tenantId, projectId))) {
      console.error("[portal-gate] in-doubt writers still running at the reconcile's deadline; they heal at their own commit", {
        tenantId,
        projectId,
      });
    }
    for (let pass = 0; pass < RECONCILE_PASSES; pass++) {
      if (pass > 0) await new Promise((resolve) => setTimeout(resolve, 100 + 150 * pass));
      const row = await retryOnContention(() => reconcilePass(tenantId, projectId));
      fixed += row?.rows_fixed ?? 0;
      last = { fixed, skipped: row?.rows_skipped ?? 0, enabled: row?.portal_on ?? null };
      if (last.enabled === false) {
        // A pass that corrected rows recorded its alarm, with its
        // still-disagreeing count, in its own transaction.
        heldUnreported = (row?.rows_fixed ?? 0) > 0 || last.skipped === 0 ? null : last.skipped;
      }
      if (last.skipped === 0) {
        await reportHeld();
        return last;
      }
    }
    await reportHeld();
    if (last?.enabled !== false) {
      console.error("[portal-gate] reconcile gave up with rows still disagreeing (held by other writers, or written since)", {
        tenantId,
        projectId,
        skipped: last?.skipped,
      });
    }
    return last;
  } catch (error) {
    // Rows left disagreeing with an ON switch are fail-closed (hidden from
    // the client). Rows left disagreeing with an OFF switch are the
    // alarm's business: what a pass saw is reported here; a pass that
    // failed before it could say what it found reports nothing, and the
    // log line is all there is.
    await reportHeld();
    console.error("[portal-gate] reconcile failed; rows still disagreeing with the switch stay as they are until the next switch", {
      tenantId,
      projectId,
      lastReadOff: last?.enabled === false,
      error,
    });
    return last;
  }
}

/**
 * Rows of a switched-off project disagreed with the switch. The gate
 * exists so that this cannot happen; say so loudly, and durably, in the
 * caller's transaction. SYSTEM is the actor: nobody did this, a check
 * found it.
 */
async function recordAlarm(
  tx: TenantDb,
  tenantId: string,
  projectId: string,
  corrected: number,
  stillDisagreeing: number,
): Promise<void> {
  console.error("[portal-gate] SAFETY: rows of a portal-OFF project disagreed with the switch", {
    tenantId,
    projectId,
    corrected,
    stillDisagreeing,
  });
  await record(tx, {
    action: "project.portal_stamp_alarm",
    targetType: "Project",
    targetId: projectId,
    metadata: { corrected, stillDisagreeing },
  });
}

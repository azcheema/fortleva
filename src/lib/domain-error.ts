/**
 * Business-rule failures that are neither authorization denials
 * (AuthzError) nor bugs: the caller (server action) maps `code` to an
 * i18n message. Codes are a closed union so the UI catalog stays exact.
 */
export type DomainErrorCode =
  | "NAME_REQUIRED"
  | "KEY_INVALID" // Project.key must match ^[A-Z][A-Z0-9]{0,7}$
  | "KEY_TAKEN" // Project.key unique per tenant
  | "EMAIL_INVALID"
  | "EMAIL_TAKEN" // Contact.email unique
  | "VERSION_TAKEN" // ProjectVersion.version unique per project
  | "ALREADY_SHIPPED"
  | "ARCHIVED" // mutation on an archived client/project
  | "CLIENT_MISMATCH" // projectId does not belong to clientId
  | "INVALID_INPUT"
  | "APPROVAL_REQUIRED" // entering a requiresApproval WorkflowState without work_item:approve (2W-R)
  // Portal switch (slice 43 — src/projects/service.ts). A statement in the switch's
  // transaction — in practice the fan-out, but the bound covers them all — could not
  // take its row locks past a concurrent writer within lockTimeoutMs, on every attempt.
  | "PORTAL_SWITCH_BUSY"
  // Work tree (2W — trigger tokens map 1:1 in src/modules/work/db-errors.ts)
  | "HAS_VISIBLE_CHILDREN" // make-private refused while client-visible subtasks/comments/attachments live
  | "PARENT_NOT_VISIBLE" // a child cannot be client-visible under an internal parent
  | "CANNOT_NEST" // parent type must be strictly higher (EPIC > TASK > SUBTASK)
  | "HAS_CHILDREN" // delete refused while live subtasks exist
  | "DESCRIPTION_TOO_LARGE" // the description's JSON or its extracted text is past its cap
  | "STALE_DESCRIPTION" // someone else saved this description while this editor held it
  // Comments (2W panel slice 10 — the trigger token maps in src/modules/work/db-errors.ts)
  | "COMMENT_EMPTY" // a comment with no text
  | "COMMENT_TOO_LARGE" // the comment's JSON or its extracted text is past its cap
  | "SUBJECT_NOT_VISIBLE" // a comment cannot be client-visible on a task the client cannot see
  // Labels (2W panel slice 12 — src/modules/work/labels.ts)
  | "LABEL_TAKEN" // a label with that name already exists (case-insensitive, tenant-wide)
  // Time (2T — DATA_MODEL.md §6.15; trigger tokens map 1:1 in src/modules/time/ctx.ts)
  | "NOTICE_UNACKNOWLEDGED" // staff notice not acknowledged — timers and clock-in refuse
  | "TIMER_ALREADY_RUNNING" // one running timer per member (partial unique)
  | "TIMER_NOT_RUNNING"
  | "SHIFT_ALREADY_OPEN"
  | "SHIFT_NOT_OPEN"
  | "BREAK_ALREADY_OPEN"
  | "BREAK_NOT_OPEN"
  | "SHIFTS_DISABLED" // time.shiftsEnabled = false
  | "ADHOC_DISABLED" // time.allowAdhocEntries = false
  | "DESCRIPTION_REQUIRED" // ad-hoc or project-level entry without a note
  | "ITEM_REQUIRED" // time.allowEntriesWithoutItem = false
  | "TARGET_MISMATCH" // work item is not in the given project
  | "OVERLAP_BLOCKED" // tenant switched time.allowOverlap off
  | "ENTRY_LOCKED" // invoiced / locked entry (trigger)
  | "INVALID_DURATION"
  | "ENDS_IN_FUTURE" // a positioned entry may not end in the future (create and edit, with a minute of slack)
  | "SPLIT_TOO_SHORT" // a split must leave both halves at least a whole minute
  | "SERVICE_CLIENT_MISMATCH" // agreement belongs to another client/project (trigger)
  | "RATE_OVERLAP" // EXCLUDE rate_card_no_overlap
  | "RATE_CARD_IMMUTABLE" // trigger
  | "REPORT_IMMUTABLE" // published TimeReport (trigger)
  | "BREAK_OUT_OF_BOUNDS" // trigger
  | "SHIFT_SHRINK" // trigger
  | "WORK_TYPE_TAKEN"; // live name unique per tenant

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "DomainError";
  }
}

export const fail = (code: DomainErrorCode, detail?: string): never => {
  throw new DomainError(code, detail);
};

/** Prisma unique-violation duck test (no runtime import of the client — one-seam rule). */
export const isUniqueViolation = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as { code?: unknown }).code === "P2002";

/**
 * Postgres DEADLOCK (SQLSTATE 40P01), duck-tested the same way and for
 * the same reason — no runtime import of the generated client.
 *
 * A deadlock is not a bug in the caller and not a state the data is in:
 * Postgres detects the cycle, picks a victim, aborts exactly one of the
 * transactions and lets the other finish. The victim's work is simply
 * undone, so redoing it is the textbook remedy and the only one — there
 * is nothing to "handle" and nothing to report to the member.
 *
 * THREE SHAPES, because Prisma surfaces the same 40P01 three ways, and
 * WHICH ONE depends on the statement that hit it — verified against the
 * installed runtime rather than inferred (review), because the first
 * draft of this accepted only the raw one and would therefore have
 * missed every case the retry is actually for:
 *   • P2010 — a `$queryRaw`. `@prisma/adapter-pg` has no mapping for
 *     40P01, so it stays `kind: "postgres"` and the client's raw branch
 *     wraps it.
 *   • P2039 — ANY model call (`tx.milestone.update`, a `record()` audit
 *     write). The same driver error down the client's non-raw branch.
 *     This is the one that matters: once a queue lock has removed the
 *     cycle two rank writers made between themselves, what is LEFT is a
 *     cycle through another table, and that is a model call by
 *     definition.
 *   • P2034 — Prisma's own write-conflict/deadlock code.
 * The nested driver shape (`meta.driverAdapterError.cause.code`) is too
 * brittle to walk, and both the code and the words appear in the
 * message Prisma builds for all three, so that is what this reads.
 *
 * Found on CI run 35440299558, where four concurrent milestone reorders
 * deadlocked on `SELECT … FOR UPDATE` and `retryOnRankCollision` —
 * which tested only for P2002 — rethrew it as a 500.
 */
const DEADLOCK_CODES = new Set(["P2010", "P2039", "P2034"]);

/**
 * Postgres LOCK TIMEOUT (SQLSTATE 55P03, "canceling statement due to
 * lock timeout") — the OTHER shape contention takes, and the reason
 * `isDeadlock` alone was never enough.
 *
 * A deadlock is a CYCLE: Postgres sees it, picks a victim and aborts
 * it. A writer that merely waits on a row another transaction holds is
 * not a cycle, so nothing is detected and nothing is aborted — it waits
 * until it gets the lock or something cancels it. Only a transaction
 * that ASKED for a bound (`withTenant`'s `lockTimeoutMs`) can raise
 * this at all, and without one there is no reliable end to the wait at
 * all: `lock_timeout` defaults to 0 and Prisma's transaction timeout is
 * enforced around the queries it issues, not inside one the DATABASE
 * has parked. Measured, not assumed — a blocked fan-out with a 3 s
 * transaction budget was still waiting past 30 s
 * (`portal-contention.dbtest.ts`). Anywhere this repo says such a wait
 * "dies as P2028", that sentence predates the measurement.
 *
 * Duck-tested for the same reason as the deadlock test — no runtime
 * import of the generated client — and reading the same two wrappers,
 * since Prisma has no code of its own for 55P03: P2010 for a
 * `$queryRaw`, P2039 for any model call. Both carry the SQLSTATE and
 * the words in the message Prisma builds, which is what this reads.
 *
 * P2039 IS MEASURED, P2010 IS CARRIED OVER. `portal-contention.dbtest`
 * provokes a real 55P03 through `setPortalEnabled` rather than
 * synthesising one, and a mutation check with this set emptied printed
 * the arriving error verbatim: `PrismaClientKnownRequestError`,
 * `code: "P2039"` — the fan-out rides a model call
 * (`tx.project.update`), so that is the branch this needs. P2010 is
 * here by the same symmetry the deadlock test rests on rather than by
 * measurement: nothing in the product yet waits on a lock from a
 * `$queryRaw` under a bound, so there is no way to provoke it without
 * writing a caller that does. Keep it, and do not claim it is proven.
 */
const LOCK_TIMEOUT_CODES = new Set(["P2010", "P2039"]);

export const isLockTimeout = (e: unknown): boolean => {
  if (typeof e !== "object" || e === null) return false;
  const code = (e as { code?: unknown }).code;
  if (typeof code !== "string" || !LOCK_TIMEOUT_CODES.has(code)) return false;
  const message = String((e as { message?: unknown }).message ?? "");
  return /55P03|lock timeout/i.test(message);
};

export const isDeadlock = (e: unknown): boolean => {
  if (typeof e !== "object" || e === null) return false;
  const code = (e as { code?: unknown }).code;
  if (typeof code !== "string" || !DEADLOCK_CODES.has(code)) return false;
  // P2034 is a deadlock by definition; the other two are generic
  // wrappers and must say so.
  if (code === "P2034") return true;
  const message = String((e as { message?: unknown }).message ?? "");
  return /40P01|deadlock detected/i.test(message);
};

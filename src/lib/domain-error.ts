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

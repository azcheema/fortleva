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

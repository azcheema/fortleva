import type { Tone } from "./tones";

/**
 * Enum -> tone + icon + shape (DESIGN SPEC §2.5). The single source of
 * truth behind <StatusBadge>: no screen decides for itself what colour
 * "ACTIVE" is, so the same word can never mean two things in two
 * places.
 *
 * `icon` is a lucide name resolved by src/components/semantic/status-icon.tsx
 * (a string keeps this module serialisable across the RSC boundary).
 * Labels are NOT here — they come from t("states.<domain>.<value>").
 *
 * Rules encoded below, not re-decided per screen:
 *  - hue is never the only signal: every value carries a distinct icon
 *    silhouette, and terminal values additionally strike their label;
 *  - Priority is deliberately not hue-coded across levels — only URGENT
 *    is red, everything else is neutral geometry;
 *  - Health keeps RAG because stakeholders read it that way, but always
 *    renders its text.
 */

export type StatusShape = "tinted" | "outline" | "text";

export type StatusSpec = {
  tone: Tone;
  icon: StatusIconName;
  shape: StatusShape;
};

export type StatusIconName =
  | "circle-check"
  | "circle-check-big"
  | "circle-dashed"
  | "circle-dot"
  | "circle-pause"
  | "circle-x"
  | "archive"
  | "file-pen"
  | "package-check"
  | "minus"
  | "clock"
  | "clock-alert"
  | "check"
  | "undo-2"
  | "lock"
  | "eye"
  | "user-round"
  | "user-round-x"
  | "mail-question"
  | "mail-check"
  | "mail-x"
  | "triangle-alert"
  | "octagon-alert"
  | "flag"
  | "square-check"
  | "bug"
  | "inbox"
  | "layers"
  | "corner-down-right"
  | "globe"
  | "info"
  | "ban";

const spec = (tone: Tone, icon: StatusIconName, shape: StatusShape = "tinted"): StatusSpec => ({
  tone,
  icon,
  shape,
});

export const STATUS_MAP = {
  clientStatus: {
    ACTIVE: spec("success", "circle-check"),
    ARCHIVED: spec("quiet", "archive", "outline"),
  },
  projectStatus: {
    PLANNED: spec("neutral", "circle-dashed"),
    ACTIVE: spec("brand", "circle-dot"),
    PAUSED: spec("caution", "circle-pause"),
    COMPLETED: spec("success", "circle-check"),
    CANCELLED: spec("quiet", "circle-x"),
    ARCHIVED: spec("quiet", "archive"),
  },
  milestoneStatus: {
    PLANNED: spec("neutral", "circle-dashed"),
    IN_PROGRESS: spec("caution", "circle-dot"),
    PAUSED: spec("caution", "circle-pause"),
    DONE: spec("success", "circle-check-big"),
    CANCELLED: spec("quiet", "circle-x"),
  },
  versionStatus: {
    DRAFT: spec("neutral", "file-pen", "outline"),
    SHIPPED: spec("success", "package-check"),
  },
  approvalStatus: {
    NOT_REQUESTED: spec("quiet", "minus", "outline"),
    PENDING: spec("caution", "clock"),
    APPROVED: spec("success", "check"),
    CHANGES_REQUESTED: spec("danger", "undo-2"),
  },
  memberStatus: {
    // A tinted chip, like clientStatus.ACTIVE — as bare text it read as
    // less important than the PENDING invitation two cards below it,
    // which is the wrong ranking on a page about who is in the
    // workspace. The person silhouette stays: within a domain the icon
    // is what survives greyscale.
    ACTIVE: spec("success", "user-round"),
    SUSPENDED: spec("danger", "user-round-x"),
  },
  inviteStatus: {
    PENDING: spec("caution", "mail-question"),
    ACCEPTED: spec("success", "mail-check"),
    EXPIRED: spec("quiet", "clock-alert"),
    REVOKED: spec("danger", "mail-x"),
  },
  serviceStatus: {
    ACTIVE: spec("success", "circle-check"),
    PAUSED: spec("caution", "circle-pause"),
    ENDED: spec("quiet", "circle-x"),
  },
  portalStatus: {
    NO_ACCESS: spec("quiet", "minus", "outline"),
    INVITED: spec("caution", "mail-question"),
    ACTIVE: spec("success", "circle-check"),
    SUSPENDED: spec("caution", "circle-pause"),
    REVOKED: spec("danger", "ban"),
  },
  /** Phase 2W: the board's state categories. Geometry, not hue. */
  stateCategory: {
    BACKLOG: spec("neutral", "circle-dashed"),
    TODO: spec("neutral", "circle-dot"),
    IN_PROGRESS: spec("caution", "circle-dot"),
    DONE: spec("success", "circle-check"),
    CANCELLED: spec("quiet", "circle-x"),
    TRIAGE: spec("danger", "triangle-alert"),
  },
  /**
   * Phase 3: the PORTAL's six categories — the only state fact a
   * contact ever sees (UI.md §11). A domain of its own rather than a
   * relabelling of `stateCategory`, for the reason `StatusBadge` gives
   * about labels: the two vocabularies are different on purpose
   * ("Requested", never "Triage"; "Cancelled" only for a REQUEST the
   * agency had agreed to, never for a task), and a shared domain is how
   * one of them quietly becomes the other. The values are
   * `PortalTaskCategory` in src/modules/work/portal.ts.
   */
  portalTaskCategory: {
    REQUESTED: spec("neutral", "mail-question"),
    PLANNED: spec("neutral", "circle-dashed"),
    IN_PROGRESS: spec("caution", "circle-dot"),
    DONE: spec("success", "circle-check"),
    // The agency answered no (slice 6b). NEUTRAL, not `danger`: nothing
    // went wrong and nobody is at fault — a declined request is an
    // answer, and painting it red on a client's screen would read as an
    // alarm about their own account. It is told apart from the other
    // four by its glyph and its position (last), not by alarm.
    //
    // `mail-x` is `REQUESTED`'s own `mail-question` answered, which is
    // exactly what this category is: the same envelope, closed. It also
    // keeps the pair legible in greyscale, which `circle-*` glyphs
    // beside `PLANNED`'s `circle-dashed` would not.
    DECLINED: spec("neutral", "mail-x"),
    // Agreed work the agency then stopped (founder decision C31,
    // 2026-09-25). NEUTRAL for the reason DECLINED is. `circle-x` is
    // the circle family the three live categories wear — dashed, dot,
    // check — closed with a cross: this WAS work on the board, and it
    // stopped, where `mail-x` is a request answered at the door. Not
    // `quiet`, which is how the member-side `stateCategory` draws its
    // CANCELLED: that tone strikes the label through, and a struck-out
    // heading on a client's screen would read as an erasure of
    // something they asked for rather than an answer to it.
    CANCELLED: spec("neutral", "circle-x"),
  },
  /** Phase 6: portfolio health. RAG, but never without its text. */
  projectHealth: {
    ON_TRACK: spec("success", "circle-check"),
    AT_RISK: spec("caution", "triangle-alert"),
    OFF_TRACK: spec("danger", "octagon-alert"),
    ON_HOLD: spec("neutral", "circle-pause"),
    COMPLETE: spec("brand", "flag"),
  },
  workItemKind: {
    TASK: spec("neutral", "square-check", "text"),
    BUG: spec("neutral", "bug", "text"),
    REQUEST: spec("neutral", "inbox", "text"),
  },
  workItemType: {
    EPIC: spec("neutral", "layers", "text"),
    TASK: spec("neutral", "square-check", "text"),
    SUBTASK: spec("neutral", "corner-down-right", "text"),
  },
} as const satisfies Record<string, Record<string, StatusSpec>>;

export type StatusDomain = keyof typeof STATUS_MAP;
export type StatusValue<D extends StatusDomain> = keyof (typeof STATUS_MAP)[D] & string;

/**
 * The hierarchy (plan §3.1): Epic → Task → Subtask, three levels, and
 * what a level's CHILDREN are — `null` for a Subtask, the lowest. The
 * one place the rule is spelled: `createItem` derives a child's type
 * from it, the panel decides from it whether an item has a Subtasks
 * section at all, and the section keys its copy by it (an Epic's
 * children are Tasks, so its button says "Add task"). The database
 * trigger has the last word; this is the same rule, readable.
 */
export const childTypeOf = (type: StatusValue<"workItemType">): "TASK" | "SUBTASK" | null =>
  type === "EPIC" ? "TASK" : type === "TASK" ? "SUBTASK" : null;

/** Priority: geometry all the way up, hue only at URGENT. */
export const PRIORITIES = ["NONE", "LOW", "MEDIUM", "HIGH", "URGENT"] as const;
export type Priority = (typeof PRIORITIES)[number];

/**
 * Which seeded default a workflow state started as (DATA_MODEL §6.14).
 * SEVEN keys against six `StateCategory` values, for one narrow reason:
 * the IN_PROGRESS category carries TWO seeded defaults (In progress,
 * then In review — 2W-R), while every other category carries exactly
 * one. So a seed key cannot be derived from a category. Do NOT render these
 * through the `states.stateCategory` messages — that catalogue has no
 * IN_REVIEW and its Swedish differs from the seed's ("Klart"/"Avbrutet"
 * vs "Klar"/"Avbruten"), so reusing it would silently change what
 * Swedish tenants read. `states.seed.*` is this list's own namespace.
 */
export const STATE_SEED_KEYS = [
  "BACKLOG",
  "TODO",
  "IN_PROGRESS",
  "IN_REVIEW",
  "DONE",
  "CANCELLED",
  "TRIAGE",
] as const;
export type StateSeedKey = (typeof STATE_SEED_KEYS)[number];

/** Project health, as its own union until the Phase 6 enum exists. */
export const PROJECT_HEALTHS = ["ON_TRACK", "AT_RISK", "OFF_TRACK", "ON_HOLD", "COMPLETE"] as const;
export type ProjectHealth = (typeof PROJECT_HEALTHS)[number];

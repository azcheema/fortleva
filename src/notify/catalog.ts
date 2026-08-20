/**
 * The static notification-kind catalog (DATA_MODEL.md §6.18, plan
 * §3.5). One entry per kind fixes its audience, class and email
 * behaviour — never decided at a call site. Kind codes reuse the audit
 * namespace shape (`entity.verb`) but are their OWN catalog: a kind is
 * a fan-out decision, an audit action is a record.
 *
 * CI-tested invariant (kind-catalog audience test, PLAN §2 tripwire):
 * every CONTACT-audience kind is `clientVisibleOnly` — its fan-out may
 * only ever run from a CLIENT_VISIBLE fact. 2W ships MEMBER kinds only;
 * the first CONTACT kinds arrive with the Phase 3 portal.
 */

export type NotificationAudience = "MEMBER" | "CONTACT";

export type NotificationKindSpec = {
  readonly audience: NotificationAudience;
  readonly class: "INSTANT" | "COALESCED" | "DIGEST_ONLY";
  /** REQUIRED true for CONTACT kinds (CI tripwire). */
  readonly clientVisibleOnly?: true;
  /** INSTANT kinds only: email delivery detail. */
  readonly email?: {
    /** Delay before the outbox may send (assignment: 2 min). */
    readonly debounceMinutes?: number;
    /** Worker marks SKIPPED when every linked notification is read. */
    readonly cancelledIfRead?: true;
  };
};

/** The 2W set: assignment + mention are the ONLY instant email kinds
 * (plan §3.5); everything else coalesces until Phase 5 digests. */
const KINDS = {
  "work_item.assigned": {
    audience: "MEMBER",
    class: "INSTANT",
    email: { debounceMinutes: 2, cancelledIfRead: true },
  },
  "comment.mentioned": {
    audience: "MEMBER",
    class: "INSTANT",
    email: {},
  },
  "work_item.commented": {
    audience: "MEMBER",
    class: "COALESCED",
  },
  // 2T: budget threshold crossed (once per budget × period × threshold —
  // the BudgetAlert unique dedupes; ids only; coalesces until digests).
  "budget.threshold_reached": {
    audience: "MEMBER",
    class: "COALESCED",
  },
} as const satisfies Record<string, NotificationKindSpec>;

export type NotificationKind = keyof typeof KINDS;

/** Values deliberately widened to the spec type so consumers see the
 * optional fields (email, clientVisibleOnly) uniformly. */
export const NOTIFICATION_KINDS: Readonly<Record<NotificationKind, NotificationKindSpec>> = KINDS;

export const isNotificationKind = (kind: string): kind is NotificationKind =>
  kind in NOTIFICATION_KINDS;

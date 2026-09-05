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

/**
 * `NotificationPreference.emailLevel`, ORDERED from silent to loudest.
 * The order is the whole mechanism: a kind names the weakest level that
 * still gets it, and a receiver gets the mail when their level is at
 * least that loud. Index order is load-bearing — do not re-sort.
 */
export const EMAIL_LEVELS = ["NONE", "MENTIONS", "PARTICIPATING", "ALL"] as const;

export type EmailLevelValue = (typeof EMAIL_LEVELS)[number];

export const isEmailLevel = (v: string | null | undefined): v is EmailLevelValue =>
  v !== null && v !== undefined && (EMAIL_LEVELS as readonly string[]).includes(v);

export type NotificationKindSpec = {
  readonly audience: NotificationAudience;
  readonly class: "INSTANT" | "COALESCED" | "DIGEST_ONLY";
  /** REQUIRED true for CONTACT kinds (CI tripwire). */
  readonly clientVisibleOnly?: true;
  /** INSTANT kinds only: email delivery detail. */
  readonly email?: {
    /**
     * The WEAKEST `emailLevel` that still receives this kind by mail.
     * Required, so a new emailing kind cannot be added without deciding
     * where it sits — "NONE" is deliberately not expressible: a level
     * of NONE means no mail, ever, and a kind that could override it
     * would make the setting a suggestion.
     */
    readonly atLevel: Exclude<EmailLevelValue, "NONE">;
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
    // Being handed a task IS participating in it.
    email: { atLevel: "PARTICIPATING", debounceMinutes: 2, cancelledIfRead: true },
  },
  "comment.mentioned": {
    audience: "MEMBER",
    class: "INSTANT",
    // The quietest setting that still mails: someone typed your name.
    email: { atLevel: "MENTIONS" },
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
  Object.hasOwn(NOTIFICATION_KINDS, kind); // own keys only —  admits "constructor"

const LEVEL_RANK: Record<EmailLevelValue, number> = {
  NONE: 0,
  MENTIONS: 1,
  PARTICIPATING: 2,
  ALL: 3,
};

/**
 * May this receiver be mailed about this kind, at this level?
 *
 * A kind with no `email` block never mails at all (COALESCED and
 * DIGEST_ONLY kinds wait for the Phase-5 digest), so the answer is no
 * regardless of the level — the setting cannot make a silent kind
 * loud, only a loud kind silent.
 */
export function emailAllowed(level: EmailLevelValue, kind: NotificationKind): boolean {
  const spec = NOTIFICATION_KINDS[kind].email;
  if (!spec) return false;
  return LEVEL_RANK[level] >= LEVEL_RANK[spec.atLevel];
}

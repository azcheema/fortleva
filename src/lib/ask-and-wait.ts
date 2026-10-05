/**
 * THE ASK-AND-WAIT MACHINE (Phase 3V slice 93; founder decisions C52 (f)–(j)
 * and C61). Somebody outside the agency ASKS for something the agency
 * holds for them; the agency may answer — approve, and it opens at once;
 * deny, and the asker waits out a cool-down before asking again — until the
 * moment it opens; if nobody answers within the wait, the asker CONFIRMS,
 * and it opens a notice period later unless somebody denies it first; once
 * open it stays open for a while and then closes again. An unconfirmed ask
 * lapses some time after its wait; the asker may withdraw one that has not
 * opened.
 *
 * C52 (j): ONE machine. The vault's sealed layer is its first user
 * (`src/modules/vault/sealed-rules.ts` holds that layer's figures); the
 * continuity box (Phase 8) reuses this and adds only its card and its
 * trustee, never a second state machine.
 *
 * PURE, AND DERIVED FROM STAMPS. The state is never stored: it is computed
 * here, at read time, from when things happened and the clock — so nothing
 * has to run at the moment the wait ends or the opening begins, and a
 * missed job run can neither delay nor extend an opening (the job only
 * mails). The database holds the same rules as CHECKs and a guard trigger,
 * so a writer cannot store stamps this would read as something the rules
 * forbid; the figures are pinned to that migration by test.
 *
 * Every period is a whole number of HOURS (a day is 24 of them), the unit
 * the migration uses: an interval of days added across a daylight-saving
 * change depends on the session's time zone, and hours do not.
 */

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

/** The periods one user of the machine runs on. */
export type AskWaitRules = {
  /** After a confirmation, it opens this many hours later (the last chance to deny). */
  readonly noticeHours: number;
  /** Once open, it stays open this many days. */
  readonly openDays: number;
  /** After the wait, a confirmation may be made for this many days; then the ask lapses. */
  readonly confirmDays: number;
  /** After a denial, a new ask waits this many days. */
  readonly cooldownDays: number;
};

/** What one ask's row records — every stamp the state is derived from. */
export type AskWaitStamps = {
  readonly askedAt: Date;
  /** The wait, frozen when the ask was made. */
  readonly waitDays: number;
  readonly confirmedAt: Date | null;
  readonly approvedAt: Date | null;
  readonly deniedAt: Date | null;
  readonly withdrawnAt: Date | null;
  /** The scheduled opening: the approval itself, or the confirmation plus the notice. Cleared by a denial or a withdrawal. */
  readonly opensAt: Date | null;
  readonly openUntil: Date | null;
};

export type AskWaitState =
  /** Nobody has answered and the wait is still running. */
  | { readonly kind: "waiting"; readonly confirmableAt: Date }
  /** The wait has run with no answer: the asker may confirm, until it lapses. */
  | { readonly kind: "confirmable"; readonly confirmableAt: Date; readonly lapsesAt: Date }
  /** Confirmed: it opens at `opensAt` unless somebody denies it first. */
  | { readonly kind: "opening"; readonly opensAt: Date }
  | { readonly kind: "open"; readonly openedAt: Date; readonly openUntil: Date }
  /** It was open, and has closed again. */
  | { readonly kind: "closed"; readonly openedAt: Date; readonly closedAt: Date }
  | { readonly kind: "denied"; readonly deniedAt: Date; readonly askAgainAt: Date }
  | { readonly kind: "withdrawn"; readonly withdrawnAt: Date }
  /** The wait ran and no confirmation came within the days allowed. */
  | { readonly kind: "lapsed"; readonly lapsedAt: Date };

export type AskWaitKind = AskWaitState["kind"];

const plusHours = (at: Date, hours: number): Date => new Date(at.getTime() + hours * HOUR_MS);

/** When the wait runs out and a confirmation becomes possible. */
export const confirmableAt = (s: Pick<AskWaitStamps, "askedAt" | "waitDays">): Date => plusHours(s.askedAt, s.waitDays * 24);

/** When an unconfirmed, unanswered ask lapses. */
export const lapsesAt = (s: Pick<AskWaitStamps, "askedAt" | "waitDays">, rules: AskWaitRules): Date =>
  plusHours(s.askedAt, (s.waitDays + rules.confirmDays) * 24);

/** The opening a confirmation made at `at` schedules. */
export const scheduledByConfirmation = (at: Date, rules: AskWaitRules): { opensAt: Date; openUntil: Date } => {
  const opensAt = plusHours(at, rules.noticeHours);
  return { opensAt, openUntil: plusHours(opensAt, rules.openDays * 24) };
};

/** The opening an approval made at `at` schedules: now. */
export const scheduledByApproval = (at: Date, rules: AskWaitRules): { opensAt: Date; openUntil: Date } => ({
  opensAt: at,
  openUntil: plusHours(at, rules.openDays * 24),
});

/**
 * Where an ask stands at `now`. Ending acts first (a withdrawal, a denial),
 * then a scheduled opening, then the wait — the order the stamps can only
 * have been written in, which the database's CHECKs hold the row to.
 */
export function askWaitState(s: AskWaitStamps, rules: AskWaitRules, now: Date): AskWaitState {
  const t = now.getTime();
  if (s.withdrawnAt) return { kind: "withdrawn", withdrawnAt: s.withdrawnAt };
  if (s.deniedAt) return { kind: "denied", deniedAt: s.deniedAt, askAgainAt: plusHours(s.deniedAt, rules.cooldownDays * 24) };
  if (s.opensAt && s.openUntil) {
    if (t < s.opensAt.getTime()) return { kind: "opening", opensAt: s.opensAt };
    if (t < s.openUntil.getTime()) return { kind: "open", openedAt: s.opensAt, openUntil: s.openUntil };
    return { kind: "closed", openedAt: s.opensAt, closedAt: s.openUntil };
  }
  const ready = confirmableAt(s);
  if (t < ready.getTime()) return { kind: "waiting", confirmableAt: ready };
  const lapse = lapsesAt(s, rules);
  if (t < lapse.getTime()) return { kind: "confirmable", confirmableAt: ready, lapsesAt: lapse };
  return { kind: "lapsed", lapsedAt: lapse };
}

/** Still in play — a new ask by the same asker for the same thing is refused while one is. */
export const isLive = (k: AskWaitKind): boolean => k === "waiting" || k === "confirmable" || k === "opening" || k === "open";

/** Can still be approved, denied or withdrawn: every state before it opens (C61 (c)). */
export const isAnswerable = (k: AskWaitKind): boolean => k === "waiting" || k === "confirmable" || k === "opening";

/**
 * THE REMINDER CADENCE (C52 (f)): the answerers hear on day 0, 3 and 6, and
 * then every day until the ask is settled. `reminderOffsetDays(n)` is the
 * day the n-th mail (counting from 0) is due on.
 */
export function reminderOffsetDays(n: number): number {
  if (!Number.isInteger(n) || n < 0) throw new RangeError("ask-and-wait: a reminder's number is a whole number from 0");
  if (n < 3) return n * 3; // 0, 3, 6
  return n + 4; // 7, 8, 9, …
}

/**
 * How many reminder mails should have gone out by `now` — every offset
 * already reached. The job sends ONE when this exceeds what was sent and
 * records this figure, so a run that was missed for days sends one mail,
 * never a burst.
 */
export function remindersDue(askedAt: Date, now: Date): number {
  const elapsed = now.getTime() - askedAt.getTime();
  if (elapsed < 0) return 0;
  const days = Math.floor(elapsed / DAY_MS);
  // Offsets 0, 3, 6 are reminders 0–2; from day 7, reminder n is due on day n + 4.
  if (days < 3) return 1;
  if (days < 6) return 2;
  if (days < 7) return 3;
  return days - 3;
}

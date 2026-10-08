import { localDateString, localHourInstant } from "@/lib/duration";
import { addDays } from "@/lib/week";

import { NOTIFICATION_KINDS, isNotificationKind, type NotificationKind } from "./catalog";
import { dueAt } from "./weekly-reminder";

/**
 * THE TEAM'S SUMMARY EMAIL — its PURE half (Phase 5 slice 100; founder
 * decision C68 (b), (e), (h); DATA_MODEL.md §6.18's digests).
 *
 * A member gets one mail a day (or a week, or never — their choice on
 * `/settings/notifications`) counting EVERYTHING that arrived in their inbox
 * since their last summary and is still unread — what they were already
 * emailed about included (C68 (h): a morning overview, not a second channel
 * for leftovers). It says HOW MANY and links (C68 (e), ARC-09): no client,
 * project, task or workspace name ever reaches it, so a summary cannot leak
 * what it does not carry.
 *
 * Everything here decides WHEN a summary is due and WHAT one counts, and none
 * of it touches the database — `src/jobs/digests.ts` is then only queries,
 * and these rules are unit-tested (the weekly reminder's split, and for its
 * reason: `@/db` cannot load in the unit suite).
 */

/** The outbox TEMPLATE key of a member's summary (not a notification kind). */
export const MEMBER_DIGEST_MAIL = "digest.member";

export type DigestCadenceValue = "NONE" | "DAILY" | "WEEKLY";

export const DIGEST_CADENCES = ["DAILY", "WEEKLY", "NONE"] as const satisfies readonly DigestCadenceValue[];

export const isDigestCadence = (v: unknown): v is DigestCadenceValue =>
  typeof v === "string" && (DIGEST_CADENCES as readonly string[]).includes(v);

/** The schema defaults, restated so "no row" and "a default row" answer alike. */
export const DEFAULT_DIGEST_CADENCE: DigestCadenceValue = "DAILY";
export const DEFAULT_DIGEST_HOUR = 8;
/** 1 = Monday, as `NotificationPreference.digestWeekday`. */
export const DEFAULT_DIGEST_WEEKDAY = 1;

/**
 * A summary goes ONLY in the hours just after its time — at 08:00, or by
 * 11:00 if the hourly job missed a run or two — never at 15:00 because a
 * comment landed after lunch (the design review's finding: "each morning at
 * 08:00" is the decision, and a summary is conditional on there being news,
 * so a missed morning must not turn into an afternoon mail). Whatever arrives
 * after the window waits for the next summary, which counts from this one.
 */
export const DIGEST_CATCH_UP_HOURS = 3;

/** The inbox's own ceiling; a summary never links more rows than this. */
export const DIGEST_MAX_ROWS = 500;

/**
 * This period's summary for one member: the instant it becomes due, the
 * previous period's (where a FIRST summary starts counting), and the key that
 * makes it once-only. Null when summaries are off, or for a stored hour or
 * weekday outside its range (data this build did not write — guessing what it
 * meant is worse than skipping one mail).
 *
 * DAILY: today's LOCAL date at the hour; the key is that date, so a member who
 * moves their hour after today's summary went does not get a second one.
 * WEEKLY: the weekly reminder's `dueAt` (the ISO week of the member's local
 * date, at weekday + hour); the key is the ISO week.
 */
export function digestPeriod(
  now: Date,
  timeZone: string,
  cadence: DigestCadenceValue,
  hour: number,
  weekday: number,
): { at: Date; previousAt: Date; periodKey: string } | null {
  if (cadence === "NONE") return null;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (cadence === "WEEKLY") {
    const due = dueAt(now, timeZone, weekday, hour);
    if (due === null) return null;
    // The same weekday and hour a week earlier, read on the wall clock: the
    // summary's LOCAL date minus seven days. Subtracting 168 hours instead and
    // asking `dueAt` again landed in the SAME ISO week when the week held a
    // clock change and the summary sat at its edge (Sunday 23:00 in the
    // fall-back week is Monday 00:00 a week earlier), so `previousAt` came out
    // equal to `at` and a first summary counted nothing (the final check's low).
    const dueDay = localDateString(due.at, timeZone);
    return {
      at: due.at,
      previousAt: localHourInstant(addDays(dueDay, -7), hour, timeZone),
      periodKey: `${due.isoYear}-W${String(due.isoWeek).padStart(2, "0")}`,
    };
  }
  const today = localDateString(now, timeZone);
  // The hour on the member's wall clock, a change of clocks included.
  return {
    at: localHourInstant(today, hour, timeZone),
    previousAt: localHourInstant(addDays(today, -1), hour, timeZone),
    periodKey: today,
  };
}

/** Is `now` inside the hours a summary of this period may go in? */
export const insideCatchUp = (now: Date, at: Date): boolean =>
  now.getTime() >= at.getTime() && now.getTime() < at.getTime() + DIGEST_CATCH_UP_HOURS * 3_600_000;

/**
 * The period whose catch-up hours contain `now`, or null. Two periods are
 * tried — the one `now` falls in, and the one three hours earlier fell in —
 * because the hours after a late summary run past local midnight (a 23:00
 * summary's catch-up is 23:00–02:00) and a Sunday-evening weekly one past the
 * ISO week's end; reading only today's date lost yesterday's last hours (the
 * code review's low).
 */
export function periodDueNow(
  now: Date,
  timeZone: string,
  cadence: DigestCadenceValue,
  hour: number,
  weekday: number,
): { at: Date; previousAt: Date; periodKey: string } | null {
  for (const probe of [now, new Date(now.getTime() - DIGEST_CATCH_UP_HOURS * 3_600_000)]) {
    const period = digestPeriod(probe, timeZone, cadence, hour, weekday);
    if (period && insideCatchUp(now, period.at)) return period;
  }
  return null;
}

/**
 * A summary counts up to a minute BEFORE the moment it is made, and the next
 * one starts there. A notification's `created_at` is its transaction's start,
 * so a row stamped just before the job read but committed just after would
 * otherwise fall between two summaries (the code review's low); a minute is
 * twelve times the default transaction budget.
 */
export const DIGEST_SETTLE_MS = 60_000;

/**
 * Why the outbox DROPPED a summary before sending it, written to the row's
 * `lastError`: too late (past its hours and the grace hour), or no longer
 * wanted (the member opted out, was suspended, or the workspace stopped
 * sending). A dropped summary is NOT a link in the chain (`src/jobs/digests.ts`
 * reads the last summary from the rest): its news reached nobody, so the next
 * one counts from the one before it (the final check's low). A summary skipped
 * because everything in it had been read carries no reason and still chains.
 */
export const DIGEST_DROPPED_LATE = "digest:late";
export const DIGEST_DROPPED_UNWANTED = "digest:unwanted";

/** Workspaces whose people still hear from Fortleva; the rest get no summary. */
export const DIGEST_SENDING_TENANT_STATUSES = ["TRIALING", "ACTIVE", "PAST_DUE"] as const;

/**
 * A summary still unsent this long after its catch-up hours is dropped by the
 * outbox. One hour of grace beyond the three: the summary made in its third
 * hour is next drained an hour later by an hourly kick, and measuring "late"
 * from the summary's own time without it dropped exactly that one every time
 * (the narrow re-check's medium) — a summary goes within four hours of its
 * time, or not at all.
 */
export const DIGEST_SEND_GRACE_HOURS = 1;

/**
 * How far back a member's last summary still CHAINS to the next: two periods
 * (a day, or a week, of slack, plus an hour for a clock change and the
 * settling minute). Within it, the next summary counts from exactly where the
 * last one stopped — through a missed morning, or an hour moved later (the
 * narrow re-check's low: chaining only from the previous period's time lost
 * everything between the old hour and the new). Beyond it — summaries off for
 * a while, or a weekly member gone daily — a summary counts one period back.
 */
const CHAIN_REACH_MS: Readonly<Record<"DAILY" | "WEEKLY", number>> = {
  DAILY: 25 * 3_600_000,
  WEEKLY: (7 * 24 + 1) * 3_600_000,
};

/**
 * Where a summary starts counting: just after the member's LAST summary, so
 * each one counts what arrived since the one before and no row is counted
 * twice — or, for a first summary (or the first after summaries were off a
 * while), a minute before the previous period's time: one day's news, or one
 * week's, never months of old unread rows.
 */
export const digestSince = (
  lastSummaryAt: Date | null,
  previousAt: Date,
  cadence: "DAILY" | "WEEKLY",
): Date => {
  // A summary's row is stamped a minute BEFORE it was made (`DIGEST_SETTLE_MS`),
  // so the last period's can sit up to a minute before that period's time — a
  // job run seconds after the hour — and it is still the chain (the fix-pass
  // review). A first summary likewise starts a minute before the previous
  // period's time.
  const start = previousAt.getTime() - DIGEST_SETTLE_MS;
  const reach = digestChainFloor(previousAt, cadence).getTime();
  return lastSummaryAt && lastSummaryAt.getTime() >= reach ? lastSummaryAt : new Date(start);
};

/**
 * The oldest a last summary may be and still chain (`digestSince`): a query
 * for the last summary need read nothing older (slice 101's code review).
 */
export const digestChainFloor = (previousAt: Date, cadence: "DAILY" | "WEEKLY"): Date =>
  new Date(previousAt.getTime() - DIGEST_SETTLE_MS - CHAIN_REACH_MS[cadence]);

/** The outbox idempotency key — DATA_MODEL §6.18's `digest:<receiver>:<periodKey>`. */
export const memberDigestKey = (memberId: string, periodKey: string): string =>
  `digest:member:${memberId}:${periodKey}`;

type Line = { readonly en: (n: number) => string; readonly sv: (n: number) => string };

const line = (en: [string, string], sv: [string, string]): Line => ({
  en: (n) => (n === 1 ? en[0] : en[1].replace("#", String(n))),
  sv: (n) => (n === 1 ? sv[0] : sv[1].replace("#", String(n))),
});

/**
 * One line per notification kind — what a summary says about N rows of it —
 * or NULL when a summary never counts that kind.
 *
 * EXHAUSTIVE BY TYPE: a new kind cannot ship without deciding whether a
 * summary counts it. A row is one dedupe unit, not one event (a task with
 * five new comments is one unread `work_item.commented` row until it is
 * read), so the lines count the THINGS — tasks, budgets, clients — never the
 * events. Every line names nothing (C68 (e)).
 */
export const SUMMARY_LINES: Readonly<Record<NotificationKind, Line | null>> = {
  "work_item.assigned": line(
    ["1 task was assigned to you", "# tasks were assigned to you"],
    ["1 uppgift har tilldelats dig", "# uppgifter har tilldelats dig"],
  ),
  "comment.mentioned": line(
    ["You were mentioned in 1 comment", "You were mentioned in # comments"],
    ["Du nämndes i 1 kommentar", "Du nämndes i # kommentarer"],
  ),
  "work_item.commented": line(
    ["1 task you follow has new comments", "# tasks you follow have new comments"],
    ["1 uppgift du följer har nya kommentarer", "# uppgifter du följer har nya kommentarer"],
  ),
  "work_item.request_received": line(
    ["1 client request is waiting in triage", "# client requests are waiting in triage"],
    ["1 förfrågan från en kund väntar i sorteringen", "# förfrågningar från kunder väntar i sorteringen"],
  ),
  "work_item.completed_by_contact": line(
    ["A client marked 1 task as done", "Clients marked # tasks as done"],
    ["En kund har markerat 1 uppgift som klar", "Kunder har markerat # uppgifter som klara"],
  ),
  "work_item.client_commented": line(
    ["1 task has new comments from a client", "# tasks have new comments from clients"],
    ["1 uppgift har nya kommentarer från en kund", "# uppgifter har nya kommentarer från kunder"],
  ),
  "approval.decided": line(
    ["A client answered 1 sign-off request", "Clients answered # sign-off requests"],
    ["En kund har svarat på 1 begäran om godkännande", "Kunder har svarat på # begäranden om godkännande"],
  ),
  "budget.threshold_reached": line(
    ["1 project budget reached a threshold", "# project budgets reached a threshold"],
    ["1 projektbudget har nått en tröskel", "# projektbudgetar har nått en tröskel"],
  ),
  "expiration.asset_due": line(
    ["1 renewal is coming up", "# renewals are coming up"],
    ["1 förnyelse närmar sig", "# förnyelser närmar sig"],
  ),
  "expiration.agreement_ending": line(
    ["1 agreement is ending", "# agreements are ending"],
    ["1 avtal löper ut", "# avtal löper ut"],
  ),
  "expiration.logins_expiring": line(
    ["1 reminder about expiring logins", "# reminders about expiring logins"],
    ["1 påminnelse om inloggningar som går ut", "# påminnelser om inloggningar som går ut"],
  ),
  "credential.submitted": line(
    ["1 client sent you logins", "# clients sent you logins"],
    ["1 kund har skickat inloggningar till er", "# kunder har skickat inloggningar till er"],
  ),
  "credential.ask_declined": line(
    ["1 client can't send a login you asked for", "# clients can't send logins you asked for"],
    ["1 kund kan inte skicka en inloggning ni bad om", "# kunder kan inte skicka inloggningar ni bad om"],
  ),
  // The owners were mailed a security notice at once (`door-alarm.ts`); the
  // summary still counts the unread row, as it counts every kind already
  // mailed (C68 (h)) — it is an overview, not a second notice.
  "contact.logins_alarm": line(
    ["1 alert about failed attempts at a client's logins", "# alerts about failed attempts at clients' logins"],
    [
      "1 varning om misslyckade försök att öppna en kunds inloggningar",
      "# varningar om misslyckade försök att öppna kunders inloggningar",
    ],
  ),
  "project_update.due": line(
    ["1 reminder to write a project update", "# reminders to write project updates"],
    ["1 påminnelse om att skriva en projektuppdatering", "# påminnelser om att skriva projektuppdateringar"],
  ),
};

const OTHER: Line = line(["1 other update", "# other updates"], ["1 annan uppdatering", "# andra uppdateringar"]);

/**
 * The kinds a summary counts, catalog order: every kind with a line. NOT
 * filtered by the member's email level (C68 (h)): the level decides what is
 * mailed the moment it happens; the summary is the overview of everything
 * still unread, and a member who wants none turns it off.
 */
export function summarisedKinds(): NotificationKind[] {
  return (Object.keys(NOTIFICATION_KINDS) as NotificationKind[]).filter((k) => SUMMARY_LINES[k] !== null);
}

/**
 * The mail itself, from counts per kind taken AT SEND (the outbox re-counts
 * the linked rows still unread). Null when nothing is left to count, which the
 * outbox turns into SKIPPED. `counts` is untrusted Json: anything that is not
 * a positive whole number is ignored, and a kind this build does not know —
 * or one a summary does not count — is folded into "other".
 */
export function renderMemberDigest(
  locale: string,
  counts: unknown,
  links: { readonly inbox: string; readonly settings: string },
): { subject: string; text: string } | null {
  const lang = locale === "sv" ? "sv" : "en";
  const known: [NotificationKind, number][] = [];
  let other = 0;
  if (counts !== null && typeof counts === "object" && !Array.isArray(counts)) {
    for (const [kind, raw] of Object.entries(counts as Record<string, unknown>)) {
      if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) continue;
      if (isNotificationKind(kind) && SUMMARY_LINES[kind] !== null) known.push([kind, raw]);
      else other += raw;
    }
  }
  const order = Object.keys(NOTIFICATION_KINDS);
  known.sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
  const total = known.reduce((sum, [, n]) => sum + n, 0) + other;
  if (total === 0) return null;

  const lines = known.map(([kind, n]) => `- ${SUMMARY_LINES[kind]![lang](n)}`);
  if (other > 0) lines.push(`- ${OTHER[lang](other)}`);

  if (lang === "sv") {
    return {
      subject: `Fortleva: ${total === 1 ? "1 ny uppdatering" : `${total} nya uppdateringar`} i din inkorg`,
      text:
        `Det här är nytt i din inkorg i Fortleva sedan din förra sammanfattning:\n\n` +
        `${lines.join("\n")}\n\n` +
        `Öppna inkorgen: ${links.inbox}\n\n` +
        `Du får den här sammanfattningen enligt dina aviseringsinställningar. Ändra hur ofta den kommer, eller stäng av den: ${links.settings}`,
    };
  }
  return {
    subject: `Fortleva: ${total === 1 ? "1 new update" : `${total} new updates`} in your inbox`,
    text:
      `Here is what's new in your Fortleva inbox since your last summary:\n\n` +
      `${lines.join("\n")}\n\n` +
      `Open your inbox: ${links.inbox}\n\n` +
      `You get this summary because of your notification settings. Change how often it comes, or turn it off: ${links.settings}`,
  };
}

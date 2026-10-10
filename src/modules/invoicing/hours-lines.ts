import { divRoundHalfAway, lineAmount, type Minor } from "./money";

/**
 * TRACKED HOURS → INVOICE LINES (Phase 4 slice 110; founder decisions C75 (b),
 * C80 (b), (c)). Pure: no database, so the unit suite covers it, and the
 * client's hours page draws its preview with the very function the action
 * then runs on the hours it has locked.
 *
 * ROUNDING (C75 (b), C80 (c)) is each project's own, off by default, and
 * rounds EACH TIME ENTRY: a step of 1, 6, 10, 15, 30 or 60 minutes, a
 * direction, and an optional minimum. Three 5-minute calls at a 15-minute
 * step up bill 45 minutes. Only what is billed is rounded — the tracked
 * seconds never change.
 *
 * A LINE'S QUANTITY is the sum of its entries' billed seconds converted ONCE
 * to hours at three decimals, half away from zero (`money.ts`'s rule): a
 * 10-minute step sums to whole hours exactly before it is converted, so six
 * of them bill 1,000 h, never 6 × 0,167. Its amount is quantity × price, the
 * line arithmetic every other line uses (EN 16931: the line net amount IS
 * quantity × price).
 *
 * THE LINES (C80 (b)) are chosen each time — by project (the default), by
 * task, by agreement or by person — and an hour at a different hourly rate
 * is always its own line (a line has one price); hours with no rate make a
 * line of their own at no price, for the member to price. When the hours span
 * more than one project, every grouping but the project's also splits by
 * project and says which. A task the client may not see is "Other work",
 * never its title (the time report's one rule, `namedTaskShared`); an
 * agreement the client may not see falls back to its project's name.
 */

export const ROUNDING_STEPS = [1, 6, 10, 15, 30, 60] as const;
export type RoundingStep = (typeof ROUNDING_STEPS)[number];
export const ROUNDING_MODES = ["UP", "NEAREST", "DOWN"] as const;
export type RoundingMode = (typeof ROUNDING_MODES)[number];
/** The largest minimum, in minutes (a working day). */
export const ROUNDING_MINIMUM_MAX = 480;

export type RoundingRule = {
  readonly stepMinutes: RoundingStep;
  readonly mode: RoundingMode;
  /** Minutes; null for none. */
  readonly minimumMinutes: number | null;
};

export const isRoundingStep = (n: unknown): n is RoundingStep =>
  typeof n === "number" && (ROUNDING_STEPS as readonly number[]).includes(n);

export const isRoundingMode = (s: unknown): s is RoundingMode =>
  typeof s === "string" && (ROUNDING_MODES as readonly string[]).includes(s);

/** The project's columns as a rule — null when rounding is off (or the columns disagree, which the CHECK forbids). */
export function roundingRuleOf(p: {
  readonly invoiceRoundingStep: number | null;
  readonly invoiceRoundingMode: string | null;
  readonly invoiceRoundingMinimum: number | null;
}): RoundingRule | null {
  if (!isRoundingStep(p.invoiceRoundingStep) || !isRoundingMode(p.invoiceRoundingMode)) return null;
  return { stepMinutes: p.invoiceRoundingStep, mode: p.invoiceRoundingMode, minimumMinutes: p.invoiceRoundingMinimum };
}

/**
 * One entry's billed seconds under its project's rule. Whole seconds in, whole
 * seconds out; an entry of nothing bills nothing, whatever the minimum (a
 * 0-second row is a placeholder, not work). The SQL twin
 * `time_billed_seconds()` (migration 20261010180000) must agree — a dbtest
 * runs both over the same matrix.
 */
export function billedSeconds(raw: number, rule: RoundingRule | null): number {
  if (!Number.isInteger(raw) || raw < 0) throw new Error("billedSeconds: a whole, non-negative number of seconds");
  if (rule === null || raw === 0) return raw;
  const step = rule.stepMinutes * 60;
  const steps =
    rule.mode === "UP" ? Math.ceil(raw / step) : rule.mode === "DOWN" ? Math.floor(raw / step) : Math.floor((raw + step / 2) / step);
  const rounded = steps * step;
  return rule.minimumMinutes !== null ? Math.max(rounded, rule.minimumMinutes * 60) : rounded;
}

/** Seconds as hours in thousandths, half away from zero: 1 h 23 min = 1 383n (1,383 h). */
export function hoursQuantity(seconds: number): bigint {
  if (!Number.isInteger(seconds) || seconds < 0) throw new Error("hoursQuantity: a whole, non-negative number of seconds");
  // seconds × 1000 / 3600 = seconds × 5 / 18.
  return divRoundHalfAway(BigInt(seconds) * 5n, 18n);
}

export const LINE_GROUPINGS = ["PROJECT", "TASK", "AGREEMENT", "PERSON"] as const;
export type LineGrouping = (typeof LINE_GROUPINGS)[number];
export const isLineGrouping = (s: unknown): s is LineGrouping =>
  typeof s === "string" && (LINE_GROUPINGS as readonly string[]).includes(s);

/** One hour as the line builder needs it — every name already decided client-safe by the caller. */
export type HourForLine = {
  readonly id: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly workItemId: string | null;
  /** The task's title when the client may see it (`namedTaskShared`); null otherwise, or with no task. */
  readonly sharedTaskTitle: string | null;
  readonly serviceId: string | null;
  /** The agreement's name when it is CLIENT_VISIBLE; null otherwise, or with no agreement. */
  readonly visibleAgreementName: string | null;
  readonly memberId: string;
  readonly memberName: string;
  /** The entry's bill rate in hundredths; null when it has none. */
  readonly rate: Minor | null;
  readonly billedSeconds: number;
};

/** The words the lines are written with, in the INVOICE's language. */
export type LineTexts = { readonly otherWork: string };

export type HoursLine = {
  /** Stable for the same hours and grouping — the preview's React key. */
  readonly key: string;
  readonly description: string;
  readonly projectId: string;
  /** Thousandths of an hour. */
  readonly quantity: bigint;
  /** Hundredths; 0 for hours with no rate. */
  readonly unitPrice: Minor;
  readonly noRate: boolean;
  readonly amount: Minor;
  readonly seconds: number;
  readonly entryIds: readonly string[];
};

/** A line's text, at most this long (`drafts.ts`'s LINE_TEXT_MAX.description). */
const DESCRIPTION_MAX = 2000;

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The lines a set of hours makes. Ordered by project name, then text, then
 * price (highest first, no rate last) — code-unit order, so the server and
 * the browser agree on it.
 */
export function hoursLines(hours: readonly HourForLine[], grouping: LineGrouping, texts: LineTexts): HoursLine[] {
  const multiProject = new Set(hours.map((h) => h.projectId)).size > 1;
  type Acc = { key: string; description: string; projectId: string; projectName: string; rate: Minor | null; seconds: number; ids: string[] };
  const groups = new Map<string, Acc>();
  for (const h of hours) {
    if (!Number.isInteger(h.billedSeconds) || h.billedSeconds < 0) throw new Error("hoursLines: billed seconds");
    const withProject = (text: string) => (multiProject ? `${text} — ${h.projectName}` : text);
    let part: string;
    let description: string;
    switch (grouping) {
      case "PROJECT":
        part = `p:${h.projectId}`;
        description = h.projectName;
        break;
      case "TASK":
        if (h.sharedTaskTitle !== null && h.workItemId !== null) {
          part = `t:${h.workItemId}`;
          description = withProject(h.sharedTaskTitle);
        } else {
          part = `t:other:${h.projectId}`;
          description = withProject(texts.otherWork);
        }
        break;
      case "AGREEMENT":
        if (h.visibleAgreementName !== null && h.serviceId !== null) {
          part = multiProject ? `a:${h.serviceId}:${h.projectId}` : `a:${h.serviceId}`;
          description = withProject(h.visibleAgreementName);
        } else {
          part = `a:none:${h.projectId}`;
          description = h.projectName;
        }
        break;
      case "PERSON":
        part = multiProject ? `m:${h.memberId}:${h.projectId}` : `m:${h.memberId}`;
        description = withProject(h.memberName);
        break;
    }
    const key = `${part}|${h.rate === null ? "none" : h.rate.toString()}`;
    const acc = groups.get(key) ?? {
      key,
      description: description.slice(0, DESCRIPTION_MAX),
      // A line by person or agreement across projects is still one project's
      // (the key splits them); the first hour's otherwise — the same project.
      projectId: h.projectId,
      projectName: h.projectName,
      rate: h.rate,
      seconds: 0,
      ids: [],
    };
    acc.seconds += h.billedSeconds;
    acc.ids.push(h.id);
    groups.set(key, acc);
  }
  return [...groups.values()]
    .sort(
      (a, b) =>
        compare(a.projectName, b.projectName) ||
        compare(a.description, b.description) ||
        (a.rate === b.rate ? 0 : a.rate === null ? 1 : b.rate === null ? -1 : a.rate > b.rate ? -1 : 1),
    )
    .map((g) => {
      const quantity = hoursQuantity(g.seconds);
      const unitPrice = g.rate ?? 0n;
      return {
        key: g.key,
        description: g.description,
        projectId: g.projectId,
        quantity,
        unitPrice,
        noRate: g.rate === null,
        amount: lineAmount(quantity, unitPrice),
        seconds: g.seconds,
        entryIds: g.ids,
      };
    });
}

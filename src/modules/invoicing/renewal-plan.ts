import { daysCovered, MAX_RENEWAL_STEPS, periodOf, type RenewalInterval } from "@/services/renewal-dates";

import { divRoundHalfAway } from "./money";

/**
 * WHICH DAYS A RENEWAL DRAFTS, AND FOR HOW MUCH (Phase 4 slice 113b; founder
 * decision C88). Pure — no database, no clock — so the job's one judgement
 * is pinned by `renewal-plan.test.ts`.
 *
 * THE PERIOD (C88 (b)): the COMING one, from the renewal day D to the day
 * before the next renewal (`periodOf`, on the agreement's anchor day).
 *
 * WHEN (C88 (a), (e)): from 14 days before D. NEVER a period already started
 * (go-live, an agreement run again after a pause) — UNLESS the agreement has
 * been drafted without a gap up to it (`invoicedThrough` is the day before
 * what is drafted now): then a job that was down for the whole window, a
 * longer interval, or a renewal date a person moved EARLIER still bills every
 * day once (the design review's #5 and #7), and never a day twice. A renewal
 * date moved LATER than the day after `invoicedThrough` leaves the days
 * between unbilled — as switching renewal invoices off and on, a closed module
 * or an archived client do, by intent: the job bills what the agreement says
 * from now on, never a gap behind it (the re-check's low; said to the founder).
 *
 * WHAT IS LEFT (the design review's #5): a period part of which an earlier
 * draft covered — a monthly agreement drafted to 30 November, then made
 * quarterly from 1 November — drafts only the remainder, from the day after
 * `invoicedThrough`.
 *
 * AN END INSIDE THE PERIOD (C88 (f), (h)): "Ends on" is the LAST DAY it runs,
 * so the period stops there, and a period starting after it drafts nothing.
 *
 * THE PRICE: the agreement's for the whole period; a part of it — a
 * remainder, an end inside it — the price × days covered ÷ days in the
 * period, to the öre, half away from zero (`money.ts`). Never more than the
 * price (the database's line guard holds it too).
 */

/** How far ahead of a renewal its invoice is drafted (C88 (a)). */
export const DRAFT_LEAD_DAYS = 14;

export type RenewalDraftInput = {
  /** D: the renewal day (`renews_at`'s UTC day). */
  readonly renewsOn: string;
  readonly interval: RenewalInterval;
  readonly anchorDay: number;
  /** The last day it runs, or null. */
  readonly endsOn: string | null;
  /** The last day already drafted, or null. */
  readonly invoicedThrough: string | null;
  /** The workspace's today. */
  readonly today: string;
  /** The agreement's price, in hundredths (> 0). */
  readonly price: bigint;
};

export type RenewalDraft = {
  /** The days this line bills, both included. */
  readonly start: string;
  readonly end: string;
  /** The line's price, in hundredths: the agreement's, or its share for a part. */
  readonly amount: bigint;
  /** True when it bills less than the whole period. */
  readonly prorated: boolean;
};

const shift = (day: string, days: number): string => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** The renewal to draft now, or null when there is none. */
export function renewalToDraft(input: RenewalDraftInput): RenewalDraft | null {
  const { renewsOn, interval, anchorDay, endsOn, invoicedThrough, today, price } = input;
  if (price <= 0n) return null;
  // Not yet: more than 14 days before the renewal.
  if (renewsOn > shift(today, DRAFT_LEAD_DAYS)) return null;
  const period = periodOf(renewsOn, interval, anchorDay);
  if (period === null) return null;
  // Everything up to the period's end is already drafted.
  if (invoicedThrough !== null && invoicedThrough >= period.end) return null;
  const start = invoicedThrough !== null && invoicedThrough >= renewsOn ? shift(invoicedThrough, 1) : renewsOn;
  // A period already started is drafted only without a gap (see above).
  const continuous = invoicedThrough !== null && shift(invoicedThrough, 1) === start;
  if (start < today && !continuous) return null;
  const end = endsOn !== null && endsOn < period.end ? endsOn : period.end;
  if (end < start) return null; // it ends before this renewal: nothing left to bill
  const whole = daysCovered(period.start, period.end);
  const covered = daysCovered(start, end);
  if (!(whole > 0) || !(covered > 0)) return null;
  const prorated = covered !== whole;
  const amount = prorated ? divRoundHalfAway(price * BigInt(covered), BigInt(whole)) : price;
  return { start, end, amount, prorated };
}

/** A renewal to draft, and the renewal day of the period it belongs to. */
export type RenewalDraftOf = RenewalDraft & { readonly renewsOn: string };

/** The most periods one run drafts for one agreement — two years of months after an outage. */
export const MAX_PERIODS_PER_RUN = 24;

/**
 * EVERY renewal to draft now, walking forward from the stored renewal day
 * (the design reviews' #2 / #5 and the code and security reviews of 113b): a
 * period fully drafted — before, or just now — leads on to the next one, as
 * long as that one starts within the 14-day window and before the end. So a
 * job that was down for longer than one interval still drafts every day once
 * (each later period CONTINUES the one before it), and a date moved on past
 * them afterwards loses nothing. A period not fully drafted — ended inside it,
 * or never drafted and already started — stops the walk.
 */
export function renewalsToDraft(input: RenewalDraftInput, max: number = MAX_PERIODS_PER_RUN): RenewalDraftOf[] {
  const out: RenewalDraftOf[] = [];
  let renewsOn = input.renewsOn;
  let invoicedThrough = input.invoicedThrough;
  const horizon = shift(input.today, DRAFT_LEAD_DAYS);
  // The bound is on DRAFTS, not on steps (the re-check's low): periods already
  // drafted are walked past freely — within the move's own step bound — so
  // after a run that drafted the most it may, the hold still finds the next
  // period owed and keeps the date.
  for (let steps = 0; steps < MAX_RENEWAL_STEPS && out.length < max && renewsOn <= horizon; steps++) {
    const draft = renewalToDraft({ ...input, renewsOn, invoicedThrough });
    if (draft !== null) {
      out.push({ ...draft, renewsOn });
      invoicedThrough = draft.end;
    }
    const period = periodOf(renewsOn, input.interval, input.anchorDay);
    if (period === null || invoicedThrough === null || invoicedThrough < period.end) break;
    renewsOn = shift(period.end, 1);
    if (input.endsOn !== null && renewsOn > input.endsOn) break;
  }
  return out;
}

/**
 * MAY THIS AGREEMENT'S RENEWAL DATE MOVE ON? (the reviews of 113b: the move
 * is held PER AGREEMENT, never for a whole workspace.) It is held while a
 * period that has ALREADY STARTED is still owed a draft — the move jumps to
 * the first renewal after today, so such a period would never be drafted
 * after it. A period still to come is drafted from the moved date, and
 * nothing at all is owed for an agreement that does not invoice its renewals.
 */
export function renewalHoldsDate(input: RenewalDraftInput): boolean {
  return renewalsToDraft(input).some((d) => d.renewsOn <= input.today);
}

/** An agreement as the renewal date's move reads it (its locked row, in plain values). */
export type AgreementRenewalFacts = {
  readonly renewsOn: string;
  readonly interval: RenewalDraftInput["interval"];
  readonly anchorDay: number;
  readonly endsOn: string | null;
  readonly invoicedThrough: string | null;
  readonly invoiceRenewals: boolean;
  /** Hundredths, or null without a price. */
  readonly price: bigint | null;
  readonly currency: string | null;
  readonly clientActive: boolean;
  readonly name: string;
};

/**
 * `renewalHoldsDate` for an agreement as it stands: only one the renewal job
 * WOULD draft can be owed anything — invoicing its renewals, priced, with a
 * currency of its own, its client active, and a line text that fits (the job
 * skips the rest, so holding their dates would wedge them for good). The
 * invoicing module being open is the caller's to ask.
 */
export function agreementHoldsDate(facts: AgreementRenewalFacts, today: string, lineTextMax: number): boolean {
  if (!facts.invoiceRenewals || facts.price === null || facts.price <= 0n || facts.currency === null || !facts.clientActive) return false;
  const input: RenewalDraftInput = {
    renewsOn: facts.renewsOn,
    interval: facts.interval,
    anchorDay: facts.anchorDay,
    endsOn: facts.endsOn,
    invoicedThrough: facts.invoicedThrough,
    today,
    price: facts.price,
  };
  const owed = renewalsToDraft(input).filter((d) => d.renewsOn <= today);
  return owed.length > 0 && owed.every((d) => renewalLineText(facts.name, d.start, d.end, lineTextMax) !== null);
}

/**
 * A renewal line's text: the agreement's name and the days it bills, as the
 * invoice PDF writes a period ("{start} – {end}", ISO days in both languages).
 * EXACTLY that — the database holds a renewal line to it (`invoice_line_guard`,
 * so no free text rides on one) — and so never shortened: a name too long for
 * a line (only an agreement named before slice 113's 200-character limit
 * could be) gives null, and that renewal is not drafted.
 */
export function renewalLineText(name: string, start: string, end: string, max: number): string | null {
  const text = `${name}, ${start} – ${end}`;
  return text.length > max ? null : text;
}

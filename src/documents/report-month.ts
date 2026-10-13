/**
 * A client report's MONTH (Phase 6 slice 115; founder decision C91 (d)) — the
 * pure half: parsing what a form sends, and reading the `report_month` column
 * back. The column is a `date` holding the month's FIRST day (the database
 * CHECKs it: `document_report_month_first`); Prisma reads a `date` as UTC
 * midnight, so every conversion here is in UTC and never touches the process
 * zone.
 */

/** `YYYY-MM` — what the upload and edit forms send. */
const FORM_MONTH = /^(\d{4})-(\d{2})$/;

/** The range the database allows (`document_report_month_first`). */
const FIRST_YEAR = 2000;
const LAST_YEAR = 2099;

/**
 * `"2026-09"` → `"2026-09-01"`, or null for anything that is not a real month
 * inside the range. Untrusted input: a form value.
 */
export function parseReportMonth(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const m = FORM_MONTH.exec(raw.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (year < FIRST_YEAR || year > LAST_YEAR || month < 1 || month > 12) return null;
  return `${m[1]}-${m[2]}-01`;
}

/** `"2026-09-01"` → the Date Prisma writes to a `date` column. */
export const reportMonthDate = (month: string): Date => new Date(`${month}T00:00:00.000Z`);

/** The column read back (UTC midnight of the 1st) → `"2026-09-01"`. */
export const reportMonthOf = (d: Date): string => d.toISOString().slice(0, 10);

/** `"2026-09-01"` → `"2026-09"`, a form's value. */
export const reportMonthFormValue = (month: string): string => month.slice(0, 7);

/**
 * The newest month a report may cover: the workspace's CURRENT month (`today`
 * is its local `YYYY-MM-DD`). A report for next month is a typo, refused.
 */
export const latestReportMonth = (today: string): string => `${today.slice(0, 7)}-01`;

/**
 * The month a new report most likely covers: the one BEFORE the workspace's
 * current month — a monthly report is written once the month is over. The
 * upload form starts there.
 */
export function defaultReportMonth(today: string): string {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const prevYear = month === 1 ? year - 1 : year;
  const prevMonth = month === 1 ? 12 : month - 1;
  return `${String(prevYear).padStart(4, "0")}-${String(prevMonth).padStart(2, "0")}-01`;
}

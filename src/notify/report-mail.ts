/**
 * THE MAIL A CLIENT'S PEOPLE GET WHEN THE AGENCY PUBLISHES A REPORT (Phase 6
 * slice 115; founder decision C91 (c)) — a template key, not a notification
 * kind: a contact has no inbox and no email level, so it is enqueued straight
 * into the outbox by the publish itself (`src/documents/report-mail.ts`), as a
 * contract's mail is (`contract-mail-keys.ts`).
 *
 * ONCE PER PERSON PER REPORT, whatever happens to the report afterwards — the
 * idempotency key (`reportMailKey`): hiding a report and publishing it again
 * tells nobody twice. A mail the outbox DROPPED unsent (`REPORT_MAIL_DROPPED`)
 * told nobody, so a later publish queues it again.
 *
 * CHECKED AGAIN AT SEND, AS THE PERSON (`src/jobs/outbox.ts`): the outbox asks
 * the portal's own projection, under the person's principal, for the report's
 * month (`portalReportMonth`); a report hidden or deleted since, a person
 * paused, the portal or the reports module switched off — any answer but a
 * month — sends nothing. So the month in the text is read at send, from a row
 * the person could open at that moment, and the outbox row itself carries the
 * document's id only; the renderer refuses to write the mail without it.
 *
 * WHAT IT SAYS: the month, which is the reader's own, and a link — never the
 * agency's name, the client's, the file's or the report's (C68 (e), ARC-09);
 * the portal page says the rest to the one person signed in. It carries the
 * workspace's Reply-To: a question about a report is a reply worth getting.
 */

export const REPORT_PUBLISHED_MAIL = "portal.report_published" as const;

/** The outbox idempotency key: one mail per person per report, ever. */
export const reportMailKey = (documentId: string, contactId: string): string =>
  `report:${documentId}:CONTACT:${contactId}`;

/**
 * Why the outbox dropped a report's mail UNSENT — its `lastError` tag (the
 * design review's L2). A mail dropped so told nobody, so publishing the report
 * again puts it back in the queue (`enqueueReportMails`) instead of the key
 * refusing a new one for ever:
 *   - `UNWANTED`: at the claim, the person was no longer active, invited, at
 *     a client still kept, at that address, or the workspace not sending;
 *   - `NOT_VISIBLE`: at send, as the person, the report was not theirs to see.
 */
export const REPORT_MAIL_UNWANTED = "report_unwanted";
export const REPORT_MAIL_NOT_VISIBLE = "report_not_visible";
export const REPORT_MAIL_DROPPED = [REPORT_MAIL_UNWANTED, REPORT_MAIL_NOT_VISIBLE] as const;

const MONTH = /^(\d{4})-(\d{2})-01$/;

/**
 * "September 2026" / "september 2026" from a report month (`YYYY-MM-01`, the
 * column's day), or null for anything else. In UTC: the column is a date with
 * no zone, and a zone would move the 1st into the previous month.
 */
export function reportMonthLabel(month: unknown, locale: string): string | null {
  if (typeof month !== "string") return null;
  const m = MONTH.exec(month);
  if (!m) return null;
  const monthIndex = Number(m[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) return null;
  const at = new Date(Date.UTC(Number(m[1]), monthIndex, 1));
  return new Intl.DateTimeFormat(locale === "sv" ? "sv-SE" : "en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(at);
}

/**
 * The mail. `month` is what the outbox read at send, as the person. WITHOUT A
 * READABLE ONE IT THROWS — fail closed (the design review's L1): the only path
 * that hands a month is the outbox's check-at-send, so a row reaching the
 * renderer any other way (a regression that routed it through the generic
 * claim) goes FAILED and then DEAD, never out unchecked.
 */
export function renderReportMail(
  locale: string,
  month: unknown,
  link: string,
): { subject: string; text: string } {
  const lang = locale === "sv" ? "sv" : "en";
  const label = reportMonthLabel(month, lang);
  if (label === null) throw new Error("report mail: no month checked at send");
  if (lang === "sv") {
    return {
      subject: `Din rapport för ${label} är klar`,
      text: `Din byrå har publicerat din rapport för ${label} i kundportalen.\n\nÖppna den: ${link}`,
    };
  }
  return {
    subject: `Your ${label} report is ready`,
    text: `Your agency has published your report for ${label} in your client portal.\n\nOpen it: ${link}`,
  };
}

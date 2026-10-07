/**
 * THE CLIENTS' WEEKLY SUMMARY EMAIL — its PURE half (Phase 5 slice 101;
 * founder decision C69, on C68 (b), (e); DATA_MODEL.md §6.18 item 9).
 *
 * Every person at a client with portal access gets one mail on Monday at
 * 08:00 in the WORKSPACE's time zone, counting what is new in their portal
 * since their last summary and what is still waiting on them — each person
 * only what THEY can see there, because every number comes from the portal's
 * own projections run as that person (`src/jobs/client-digests.ts`). It goes
 * while something waits on them even when nothing is new (C69 (c)), and
 * never when there is neither.
 *
 * It says HOW MANY and links (C68 (e), ARC-09): no project, task, file or
 * agency name ever reaches it — a mail cannot leak what it does not carry,
 * and a client mail has said "your agency" since slice 96.
 *
 * Everything here decides what a summary SAYS and is unit-tested; the job is
 * queries, the outbox sends.
 */

/** The outbox TEMPLATE key of a client person's summary (not a notification kind). */
export const CONTACT_DIGEST_MAIL = "digest.contact";

/** Monday (`NotificationPreference.digestWeekday`'s numbering) at 08:00 — C68 (b). */
export const CLIENT_DIGEST_WEEKDAY = 1;
export const CLIENT_DIGEST_HOUR = 8;

/** The outbox idempotency key — DATA_MODEL §6.18's `digest:<receiver>:<periodKey>`, one per ISO week. */
export const contactDigestKey = (contactId: string, periodKey: string): string =>
  `digest:contact:${contactId}:${periodKey}`;

/**
 * What a summary counts, in the order it says it. The first three are NEW
 * since the last summary; the last three are WAITING on the reader now,
 * however old.
 */
export const CLIENT_DIGEST_COUNTS = ["updates", "replies", "files", "signoffs", "tasks", "logins"] as const;
export type ClientDigestCount = (typeof CLIENT_DIGEST_COUNTS)[number];
export type ClientDigestCounts = Readonly<Record<ClientDigestCount, number>>;

const NEW: readonly ClientDigestCount[] = ["updates", "replies", "files"];
const WAITING: readonly ClientDigestCount[] = ["signoffs", "tasks", "logins"];

/**
 * `counts` as stored in an outbox row's `params` — untrusted Json: only a
 * known key with a positive whole number survives; everything else is 0.
 */
export function readClientDigestCounts(raw: unknown): ClientDigestCounts {
  const out = Object.fromEntries(CLIENT_DIGEST_COUNTS.map((k) => [k, 0])) as Record<ClientDigestCount, number>;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const key of CLIENT_DIGEST_COUNTS) {
    const v = (raw as Record<string, unknown>)[key];
    if (typeof v === "number" && Number.isInteger(v) && v > 0) out[key] = v;
  }
  return out;
}

/** Is there anything to say? Something new, or something waiting (C69 (c)). */
export const clientDigestHasNews = (counts: ClientDigestCounts): boolean =>
  CLIENT_DIGEST_COUNTS.some((k) => counts[k] > 0);

type Line = { readonly en: (n: number) => string; readonly sv: (n: number) => string };

const line = (en: [string, string], sv: [string, string]): Line => ({
  en: (n) => (n === 1 ? en[0] : en[1].replace("#", String(n))),
  sv: (n) => (n === 1 ? sv[0] : sv[1].replace("#", String(n))),
});

/** One line per count. Every line names nothing (C68 (e)). */
const LINES: Readonly<Record<ClientDigestCount, Line>> = {
  updates: line(
    ["1 new update from your agency", "# new updates from your agency"],
    ["1 ny uppdatering från din byrå", "# nya uppdateringar från din byrå"],
  ),
  replies: line(
    ["Your agency replied on 1 task", "Your agency replied on # tasks"],
    ["Din byrå har svarat på 1 uppgift", "Din byrå har svarat på # uppgifter"],
  ),
  files: line(
    ["1 file was shared with you or updated", "# files were shared with you or updated"],
    ["1 fil har delats med dig eller uppdaterats", "# filer har delats med dig eller uppdaterats"],
  ),
  signoffs: line(
    ["1 thing is waiting for your sign-off", "# things are waiting for your sign-off"],
    ["1 sak väntar på ditt godkännande", "# saker väntar på ditt godkännande"],
  ),
  tasks: line(
    ["1 task is waiting for you", "# tasks are waiting for you"],
    ["1 uppgift väntar på dig", "# uppgifter väntar på dig"],
  ),
  logins: line(
    ["Your agency asked you for 1 login", "Your agency asked you for # logins"],
    ["Din byrå har bett dig om 1 inloggning", "Din byrå har bett dig om # inloggningar"],
  ),
};

/**
 * The mail, or null when there is nothing to say (the outbox turns that into
 * SKIPPED). `links` are built by the caller: the portal, and this person's
 * own unsubscribe page.
 */
export function renderContactDigest(
  locale: string,
  rawCounts: unknown,
  links: { readonly portal: string; readonly unsubscribe: string },
): { subject: string; text: string } | null {
  const counts = readClientDigestCounts(rawCounts);
  if (!clientDigestHasNews(counts)) return null;
  const lang = locale === "sv" ? "sv" : "en";
  const block = (keys: readonly ClientDigestCount[]): string[] =>
    keys.filter((k) => counts[k] > 0).map((k) => `- ${LINES[k][lang](counts[k])}`);
  const fresh = block(NEW);
  const waiting = block(WAITING);

  if (lang === "sv") {
    const parts = [`Här är din veckosammanfattning från din byrås kundportal.`];
    if (fresh.length > 0) parts.push(`Nytt sedan din förra sammanfattning:\n${fresh.join("\n")}`);
    if (waiting.length > 0) parts.push(`Väntar på dig:\n${waiting.join("\n")}`);
    parts.push(`Öppna kundportalen: ${links.portal}`);
    parts.push(
      `Du får det här mejlet en gång i veckan eftersom du har tillgång till din byrås kundportal. Vill du inte få de här mejlen längre? ${links.unsubscribe}`,
    );
    return { subject: "Din veckosammanfattning från din byrå", text: parts.join("\n\n") };
  }
  const parts = [`Here is your weekly summary from your agency's client portal.`];
  // "Since your last summary", not "since last week": the chain can reach back
  // two weeks when last week's was dropped unsent (`digestSince`).
  if (fresh.length > 0) parts.push(`New since your last summary:\n${fresh.join("\n")}`);
  if (waiting.length > 0) parts.push(`Waiting for you:\n${waiting.join("\n")}`);
  parts.push(`Open your portal: ${links.portal}`);
  parts.push(
    `You get this email once a week because you have access to your agency's client portal. Don't want these emails? ${links.unsubscribe}`,
  );
  return { subject: "Your weekly summary from your agency", text: parts.join("\n\n") };
}

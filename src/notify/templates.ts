import { appUrl } from "@/config";
import { isNotificationKind, type NotificationKind } from "./catalog";
import { WEEKLY_REMINDER_KIND } from "./weekly-reminder";

/**
 * Minimal email rendering — deliberately tiny: emails carry LINKS, not
 * data (ARC-09). Subject/body are generic per template + locale; the
 * deep link is built from ids in `params`. Proper templating (digests,
 * rich bodies) is Phase 5; adding a template here without both locales
 * is a type error.
 *
 * A TEMPLATE KEY IS NOT A NOTIFICATION KIND, and this file is where the
 * two part company. `EmailOutbox.kind` is documented in the schema as a
 * *template key*: every notification kind that mails has one, but a
 * template may also exist for mail that no fan-out produces — the 2T
 * weekly self-reminder (D6) is addressed to one person who asked for
 * it, has no actor, no entity and no inbox row, and is enqueued
 * straight into the outbox. Until now the outbox worker treated an
 * unknown *notification kind* as a dead letter, which would have killed
 * exactly that mail; `isEmailTemplate` is the check it needs instead.
 */

type Copy = { readonly subject: string; readonly body: string };

/** Templates that are not also a fan-out kind. */
const EXTRA_TEMPLATES = [WEEKLY_REMINDER_KIND] as const;

export type EmailTemplateKey = NotificationKind | (typeof EXTRA_TEMPLATES)[number];

const COPY: Record<EmailTemplateKey, Record<"en" | "sv", Copy>> = {
  "work_item.assigned": {
    en: { subject: "A task was assigned to you", body: "A task in Fortleva was assigned to you." },
    sv: { subject: "En uppgift tilldelades dig", body: "En uppgift i Fortleva tilldelades dig." },
  },
  "comment.mentioned": {
    en: { subject: "You were mentioned", body: "You were mentioned in a comment in Fortleva." },
    sv: { subject: "Du omnämndes", body: "Du omnämndes i en kommentar i Fortleva." },
  },
  "work_item.commented": {
    en: { subject: "New comment", body: "A task you follow has a new comment." },
    sv: { subject: "Ny kommentar", body: "En uppgift du följer har en ny kommentar." },
  },
  "budget.threshold_reached": {
    en: { subject: "A project budget reached a threshold", body: "A project budget in Fortleva reached one of its thresholds." },
    sv: { subject: "En projektbudget har nått en tröskel", body: "En projektbudget i Fortleva har nått en av sina trösklar." },
  },
  "time.weekly_reminder": {
    en: {
      subject: "Your weekly time reminder",
      body: "You asked Fortleva to remind you once a week to check your tracked time. Open your week and fill in anything that is missing.",
    },
    sv: {
      subject: "Din veckopåminnelse om tid",
      body: "Du har bett Fortleva påminna dig en gång i veckan om att se över din tidrapportering. Öppna veckan och fyll i det som saknas.",
    },
  },
};

export const isEmailTemplate = (key: string): key is EmailTemplateKey =>
  isNotificationKind(key) || (EXTRA_TEMPLATES as readonly string[]).includes(key);

/** Where each template sends the reader. Item-scoped kinds deep-link to
 * the peek when `params` names one; everything else has one home. */
const linkFor = (
  key: EmailTemplateKey,
  params: Readonly<Record<string, unknown>> | null,
): URL => {
  if (key === "time.weekly_reminder") return new URL("/time", appUrl);
  const projectKey = typeof params?.["projectKey"] === "string" ? params["projectKey"] : null;
  const itemNumber = typeof params?.["itemNumber"] === "string" ? params["itemNumber"] : null;
  return projectKey && itemNumber
    ? new URL(`/projects/${projectKey}/backlog?item=${projectKey}-${itemNumber}`, appUrl)
    : new URL("/home", appUrl);
};

export function renderEmail(
  key: EmailTemplateKey,
  locale: string,
  params: Readonly<Record<string, unknown>> | null,
): { subject: string; text: string } {
  const copy = COPY[key][locale === "sv" ? "sv" : "en"];
  return { subject: copy.subject, text: `${copy.body}\n\n${linkFor(key, params).toString()}` };
}

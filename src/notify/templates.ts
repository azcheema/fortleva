import { appUrl } from "@/config";
import { isUuid } from "@/db/context";
import { isNotificationKind, type NotificationKind } from "./catalog";
import { SEALED_CONTACT_MAIL, SEALED_MAIL_KEYS, SEALED_MEMBER_MAIL } from "./sealed-mail-keys";
import { VAULT_EXPORTED_MAIL } from "./vault-export-mail-key";
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
const EXTRA_TEMPLATES = [WEEKLY_REMINDER_KIND, ...SEALED_MAIL_KEYS, VAULT_EXPORTED_MAIL] as const;

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
  "work_item.request_received": {
    en: { subject: "A client sent a request", body: "A client submitted a request through the portal. It is waiting in triage." },
    sv: { subject: "En kund har skickat en förfrågan", body: "En kund har skickat en förfrågan via portalen. Den väntar i sorteringen." },
  },
  "work_item.completed_by_contact": {
    en: {
      subject: "A client marked their task as done",
      body: "A client says they have finished a task you assigned to them. It is waiting for you to check.",
    },
    sv: {
      subject: "En kund har markerat sin uppgift som klar",
      body: "En kund uppger att de har slutfört en uppgift ni tilldelat dem. Den väntar på att ni kontrollerar den.",
    },
  },
  "work_item.client_commented": {
    en: {
      subject: "A client commented on a task",
      body: "A client wrote a comment on a task through the portal. Open the task to read it and reply.",
    },
    sv: {
      subject: "En kund har kommenterat en uppgift",
      body: "En kund har skrivit en kommentar på en uppgift via portalen. Öppna uppgiften för att läsa den och svara.",
    },
  },
  "approval.decided": {
    en: {
      subject: "A client answered a sign-off request",
      body: "A client has approved, or asked for changes to, something you asked them to sign off. Open the project to see their answer.",
    },
    sv: {
      subject: "En kund har svarat på en begäran om godkännande",
      body: "En kund har godkänt, eller bett om ändringar i, något ni bad dem godkänna. Öppna projektet för att se svaret.",
    },
  },
  "budget.threshold_reached": {
    en: { subject: "A project budget reached a threshold", body: "A project budget in Fortleva reached one of its thresholds." },
    sv: { subject: "En projektbudget har nått en tröskel", body: "En projektbudget i Fortleva har nått en av sina trösklar." },
  },
  // Phase 3V slice 89 — the renewal reminders. LINKS, NOT DATA, as every
  // mail here: no asset, agreement, client or login is named, and the
  // count and the days stay in the inbox, which renders them under the
  // reader's own principal.
  "expiration.asset_due": {
    en: {
      subject: "A renewal is coming up",
      body: "A domain, certificate, licence or other service your agency looks after for a client is due for renewal soon. Open it to check the date.",
    },
    sv: {
      subject: "En förnyelse närmar sig",
      body: "En domän, ett certifikat, en licens eller en annan tjänst som ni sköter åt en kund ska snart förnyas. Öppna den för att se datumet.",
    },
  },
  "expiration.agreement_ending": {
    en: {
      subject: "An agreement is ending",
      body: "An agreement with a client ends soon. Decide whether to extend it.",
    },
    sv: {
      subject: "Ett avtal löper ut",
      body: "Ett avtal med en kund upphör snart. Bestäm om det ska förlängas.",
    },
  },
  "expiration.logins_expiring": {
    en: {
      subject: "Logins are expiring",
      body: "Some logins you can open in the Vault expire soon. Open the Vault to see which.",
    },
    sv: {
      subject: "Inloggningar går ut",
      body: "Några inloggningar som du kan öppna i valvet går snart ut. Öppna valvet för att se vilka.",
    },
  },
  // Phase 3V slice 96 — a client handed a login over through the portal.
  // LINKS, NOT DATA: neither the client nor the login is named; the inbox
  // names the client under the reader's own principal.
  "credential.submitted": {
    en: {
      subject: "A client sent you a login",
      body: "A client handed a login over through the portal. It is in your Vault, for your team only. Open the Vault to see it.",
    },
    sv: {
      subject: "En kund har skickat en inloggning",
      body: "En kund har lämnat över en inloggning via portalen. Den finns i ert valv och syns bara för ert team. Öppna valvet för att se den.",
    },
  },
  // Phase 3V slice 93 — a client's ask to open their SEALED logins
  // (`sealed-mail-keys.ts`). Security notices, sent whatever the reader's
  // email level; LINKS, NOT DATA — no client, login or reason is named.
  [SEALED_MEMBER_MAIL.asked]: {
    en: {
      subject: "A client asked to open their sealed logins",
      body: "A client asked to open the logins your agency keeps sealed for them. Approve or deny the request in Fortleva. If nobody answers, the client can open them after the waiting period.",
    },
    sv: {
      subject: "En kund vill öppna sina förseglade inloggningar",
      body: "En kund har bett att få öppna de inloggningar som ni håller förseglade åt dem. Godkänn eller avslå begäran i Fortleva. Om ingen svarar kan kunden öppna dem när väntetiden har gått.",
    },
  },
  [SEALED_MEMBER_MAIL.reminder]: {
    en: {
      subject: "Reminder: a client is waiting for an answer",
      body: "Nobody has answered a client's request to open the logins your agency keeps sealed for them. If nobody answers, the client can open them after the waiting period. Approve or deny the request in Fortleva.",
    },
    sv: {
      subject: "Påminnelse: en kund väntar på svar",
      body: "Ingen har svarat på en kunds begäran om att öppna de inloggningar som ni håller förseglade åt dem. Om ingen svarar kan kunden öppna dem när väntetiden har gått. Godkänn eller avslå begäran i Fortleva.",
    },
  },
  [SEALED_MEMBER_MAIL.confirmable]: {
    en: {
      subject: "A client can now open their sealed logins",
      body: "Nobody answered a client's request to open the logins your agency keeps sealed for them within the waiting period. The client can now confirm it, and the logins open 48 hours after they do. You can still approve or deny the request in Fortleva.",
    },
    sv: {
      subject: "En kund kan nu öppna sina förseglade inloggningar",
      body: "Ingen svarade inom väntetiden på en kunds begäran om att öppna de inloggningar som ni håller förseglade åt dem. Kunden kan nu bekräfta den, och inloggningarna öppnas 48 timmar efter det. Ni kan fortfarande godkänna eller avslå begäran i Fortleva.",
    },
  },
  [SEALED_MEMBER_MAIL.opening]: {
    en: {
      subject: "A client's sealed logins open soon",
      body: "A client confirmed their request to open the logins your agency keeps sealed for them. They open 48 hours after the confirmation unless someone denies the request first. Approve or deny it in Fortleva.",
    },
    sv: {
      subject: "En kunds förseglade inloggningar öppnas snart",
      body: "En kund har bekräftat sin begäran om att öppna de inloggningar som ni håller förseglade åt dem. De öppnas 48 timmar efter bekräftelsen om ingen avslår begäran innan dess. Godkänn eller avslå den i Fortleva.",
    },
  },
  [SEALED_MEMBER_MAIL.confirmed]: {
    en: {
      subject: "A client's sealed logins open in 48 hours",
      body: "Nobody answered a client's request to open the logins your agency keeps sealed for them, and the client has now confirmed it. They open in 48 hours unless someone denies the request before then.",
    },
    sv: {
      subject: "En kunds förseglade inloggningar öppnas om 48 timmar",
      body: "Ingen svarade på en kunds begäran om att öppna de inloggningar som ni håller förseglade åt dem, och nu har kunden bekräftat den. De öppnas om 48 timmar om ingen avslår begäran innan dess.",
    },
  },
  [SEALED_MEMBER_MAIL.opened]: {
    en: {
      subject: "A client's sealed logins are open",
      body: "A client can now open the logins your agency keeps sealed for them, for 7 days. Every look is logged. Once they have locked again, change those passwords.",
    },
    sv: {
      subject: "En kunds förseglade inloggningar är öppna",
      body: "En kund kan nu öppna de inloggningar som ni håller förseglade åt dem, i 7 dagar. Varje visning loggas. Byt lösenorden när de har låsts igen.",
    },
  },
  [SEALED_CONTACT_MAIL]: {
    en: {
      subject: "News about your request to open your sealed logins",
      body: "There is news about your request to open the logins your agency keeps sealed for you. Sign in to the portal to see it.",
    },
    sv: {
      subject: "Nytt om din begäran att öppna dina förseglade inloggningar",
      body: "Det finns nytt om din begäran att öppna de inloggningar som din byrå håller förseglade åt dig. Logga in i kundportalen för att se det.",
    },
  },
  // Phase 3V slice 95 — somebody exported logins (C63 (b); `vault-export-
  // mail-key.ts`). A security notice to every holder of `credential:export`,
  // the exporter included, whatever their email level; LINKS, NOT DATA — no
  // name, count or client: the exports page says who, how many and when.
  [VAULT_EXPORTED_MAIL]: {
    en: {
      subject: "Logins were exported from your vault",
      body: "Someone in your workspace exported logins from the Vault, with their passwords in plain text. See who and when in Fortleva. If you did not expect this, change those passwords.",
    },
    sv: {
      subject: "Inloggningar har exporterats från ert valv",
      body: "Någon i er arbetsyta har exporterat inloggningar från valvet, med lösenorden i klartext. Se vem och när i Fortleva. Om ni inte väntade er detta, byt de lösenorden.",
    },
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

/** A param that is a uuid, or null. */
const uuidParam = (params: Readonly<Record<string, unknown>> | null, key: string): string | null => {
  const v = params?.[key];
  return typeof v === "string" && isUuid(v) ? v : null;
};

/** Where each template sends the reader. Item-scoped kinds deep-link to
 * the peek when `params` names one; everything else has one home. */
const linkFor = (
  key: EmailTemplateKey,
  params: Readonly<Record<string, unknown>> | null,
): URL => {
  if (key === "time.weekly_reminder") return new URL("/time", appUrl);
  // An export (slice 95): the exports page, behind the vault's door, says
  // who exported what and when — the mail itself names nothing.
  if (key === VAULT_EXPORTED_MAIL) return new URL("/vault/exports", appUrl);
  // A sealed ask (slice 93): an answerer's mail opens the ask itself —
  // `credential:unseal`, which every answerer holds, reads it; the id came
  // from the vault, never a person, and is held to a uuid's shape. The
  // client's opens their Logins page.
  if (key === SEALED_CONTACT_MAIL) return new URL("/portal/logins", appUrl);
  if ((Object.values(SEALED_MEMBER_MAIL) as string[]).includes(key)) {
    const requestId = uuidParam(params, "requestId");
    return new URL(requestId ? `/vault/requests/${requestId}` : "/vault", appUrl);
  }
  // The renewal reminders (slice 89). The job chose, per receiver, a page
  // that receiver may open (`linkOf`, src/modules/vault/reminders.ts) and
  // fanned out once per choice, with the choice as a closed token in
  // `link`: an asset's own line on the client's Assets tab (`client:view`)
  // or Renewals (`asset:view`, which every asset receiver holds); an
  // agreement's Agreements tab (direct assignment and `client:view`), or
  // Renewals, or the inbox. Logins open on `/vault` filtered to the client
  // — `credential:view`, which every login receiver holds, opens it — or to
  // our own when there is no client (C49). The ids came from the job,
  // never a person, and are still held to a uuid's shape before they reach
  // a path; anything unexpected falls back to a page with no id in it.
  if (key === "expiration.asset_due") {
    const clientId = uuidParam(params, "clientId");
    const assetId = uuidParam(params, "assetId");
    return new URL(
      params?.["link"] === "asset" && clientId && assetId ? `/clients/${clientId}/assets#asset-${assetId}` : "/expirations",
      appUrl,
    );
  }
  if (key === "expiration.agreement_ending") {
    const clientId = uuidParam(params, "clientId");
    if (params?.["link"] === "agreements" && clientId) return new URL(`/clients/${clientId}/agreements`, appUrl);
    return new URL(params?.["link"] === "renewals" ? "/expirations" : "/inbox", appUrl);
  }
  if (key === "expiration.logins_expiring") {
    const clientId = uuidParam(params, "clientId");
    return new URL(clientId ? `/vault?client=${clientId}` : "/vault?client=agency", appUrl);
  }
  // A login a client handed over (slice 96): `/vault` filtered to that
  // client — `credential:view`, which every receiver holds, opens it. The id
  // came from the broker, never a person, and is held to a uuid's shape.
  if (key === "credential.submitted") {
    const clientId = uuidParam(params, "clientId");
    return new URL(clientId ? `/vault?client=${clientId}` : "/vault", appUrl);
  }
  const projectKey = typeof params?.["projectKey"] === "string" ? params["projectKey"] : null;
  const itemNumber = typeof params?.["itemNumber"] === "string" ? params["itemNumber"] : null;
  // A sign-off decision lands on the project's Timeline tab (a version)
  // or its Files tab (a deliverable); a deliverable shared with the
  // company itself has no project and takes the one home.
  if (key === "approval.decided") {
    if (projectKey) {
      return new URL(
        params?.["subject"] === "deliverable" ? `/projects/${projectKey}/files` : `/projects/${projectKey}/timeline`,
        appUrl,
      );
    }
    const clientId = typeof params?.["clientId"] === "string" ? params["clientId"] : null;
    if (clientId) return new URL(`/clients/${clientId}/files`, appUrl);
  }
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

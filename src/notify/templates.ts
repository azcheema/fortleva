import { appUrl } from "@/config";
import { isUuid } from "@/db/context";
import { isNotificationKind, type NotificationKind } from "./catalog";
import { CONTACT_DIGEST_MAIL } from "./client-digest";
import { MEMBER_DIGEST_MAIL, renderMemberDigest } from "./digest";
import { REPLY_ADDRESS_CHANGED_MAIL } from "./reply-address-mail-key";
import { INVOICE_DETAILS_CHANGED_MAIL } from "./invoice-details-mail-key";
import { INVOICE_PAY_LINK_ISSUED_MAIL } from "./invoice-pay-link-mail-key";
import { DOOR_ALARM_CONTACT_MAIL, DOOR_ALARM_MAIL_KEYS, DOOR_ALARM_MEMBER_MAIL } from "./door-alarm-mail-keys";
import { LOGIN_ASK_MAIL } from "./login-ask-mail-key";
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
const EXTRA_TEMPLATES = [
  WEEKLY_REMINDER_KIND,
  ...SEALED_MAIL_KEYS,
  VAULT_EXPORTED_MAIL,
  LOGIN_ASK_MAIL,
  ...DOOR_ALARM_MAIL_KEYS,
  MEMBER_DIGEST_MAIL,
  REPLY_ADDRESS_CHANGED_MAIL,
  CONTACT_DIGEST_MAIL,
  INVOICE_DETAILS_CHANGED_MAIL,
  INVOICE_PAY_LINK_ISSUED_MAIL,
] as const;

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
  // Phase 3V slice 98 — the contact asked for a login pressed "We don't
  // have this" (C66 (c)). LINKS, NOT DATA: neither the client nor what was
  // asked is named; the Vault tab it opens lists the ask and the client's
  // note, behind the vault's door.
  "credential.ask_declined": {
    en: {
      subject: "A client can't send a login you asked for",
      body: "A client says they don't have a login your team asked them for, and may have left a note. Open the Vault tab to read it.",
    },
    sv: {
      subject: "En kund kan inte skicka en inloggning ni bad om",
      body: "En kund säger att de inte har en inloggning som ert team bad dem om, och kan ha lämnat en kommentar. Öppna fliken Valv för att läsa den.",
    },
  },
  // Phase 3V slice 98 — to the ONE contact the agency asked for a login
  // (C66 (b); `login-ask-mail-key.ts`). At most one per person per 12 hours. LINKS, NOT DATA: the
  // portal page says what the agency needs.
  [LOGIN_ASK_MAIL]: {
    en: {
      subject: "Your agency asked you for a login",
      body: "Your agency has asked you to send them a login through your client portal. Sign in to see what they need and send it securely there. Never send a password by email.",
    },
    sv: {
      subject: "Din byrå har bett dig om en inloggning",
      body: "Din byrå har bett dig skicka en inloggning till dem via kundportalen. Logga in för att se vad de behöver och skicka den säkert där. Skicka aldrig ett lösenord via e-post.",
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
  // Phase 3V slice 99 — the client's door's alarm (C67 (b), (c);
  // `door-alarm-mail-keys.ts`). The owners' is a security notice, sent
  // whatever their email level; the client person's tells them what to do.
  // LINKS, NOT DATA — no client, person, login or attempt is named. The
  // kind's own copy below is never mailed (`contact.logins_alarm` has no
  // `email` block — the notice IS its mail); it is here because every kind
  // must have copy.
  [DOOR_ALARM_MEMBER_MAIL]: {
    en: {
      subject: "Someone keeps failing to open a client's logins",
      body: "Someone signed in to a client's portal account kept getting the password or the emailed code wrong on the logins page. It may not be that person. See who in Fortleva, and pause their portal access if you need to.",
    },
    sv: {
      subject: "Någon misslyckas upprepade gånger med att öppna en kunds inloggningar",
      body: "Någon som är inloggad på en kunds portalkonto har upprepade gånger angett fel lösenord eller fel kod från e-posten på sidan med inloggningar. Det kanske inte är den personen. Se vem i Fortleva och pausa personens tillgång till portalen om det behövs.",
    },
  },
  [DOOR_ALARM_CONTACT_MAIL]: {
    en: {
      subject: "Was this you? Failed attempts to open your logins",
      body: "Someone signed in to your client portal account kept getting the password or the emailed code wrong when opening the logins your agency keeps for you. If this wasn't you, set a new password with the link below — that also signs everyone else out of your account.",
    },
    sv: {
      subject: "Var det du? Misslyckade försök att öppna dina inloggningar",
      body: "Någon som är inloggad på ditt konto i kundportalen har upprepade gånger angett fel lösenord eller fel kod från e-posten när de försökte öppna de inloggningar som din byrå har åt dig. Om det inte var du, välj ett nytt lösenord via länken nedan – då loggas också alla andra ut från ditt konto.",
    },
  },
  "contact.logins_alarm": {
    en: {
      subject: "Someone keeps failing to open a client's logins",
      body: "Someone signed in to a client's portal account kept getting the answers wrong on the logins page.",
    },
    sv: {
      subject: "Någon misslyckas upprepade gånger med att öppna en kunds inloggningar",
      body: "Någon som är inloggad på en kunds portalkonto har upprepade gånger svarat fel på sidan med inloggningar.",
    },
  },
  // Phase 5 slice 100 — a member's summary (C68 (b), (e); `digest.ts`). The
  // real mail is `renderMemberDigest`, from counts the outbox takes at send;
  // this copy is only what renders if those counts arrive empty, which the
  // outbox SKIPS before rendering — kept because every template has copy.
  [MEMBER_DIGEST_MAIL]: {
    en: {
      subject: "Fortleva: new updates in your inbox",
      body: "There is news in your Fortleva inbox. Open it to see what is new.",
    },
    sv: {
      subject: "Fortleva: nya uppdateringar i din inkorg",
      body: "Det finns nytt i din inkorg i Fortleva. Öppna den för att se vad som är nytt.",
    },
  },
  // Phase 5 slice 100 — a new reply address was confirmed (C68 (i);
  // `reply-address-mail-key.ts`). A security notice to every owner, whatever
  // their level; LINKS, NOT DATA — the address is not in it.
  [REPLY_ADDRESS_CHANGED_MAIL]: {
    en: {
      subject: "Your workspace's reply address was changed",
      body: "Replies to your workspace's emails — from your team and your clients — now go to a new address. See it in Fortleva, under Settings, Preferences. If you did not expect this, change it there.",
    },
    sv: {
      subject: "Svarsadressen för er arbetsyta har ändrats",
      body: "Svar på arbetsytans e-post – från ert team och era kunder – går nu till en ny adress. Se den i Fortleva under Inställningar, Preferenser. Om ni inte väntade er detta, ändra den där.",
    },
  },
  // Phase 4 slice 107 — what the invoices say about the workspace changed:
  // the company details, the bank details or the note on every invoice (C75
  // (h)–(j); `invoice-details-mail-key.ts`). A security notice to every owner,
  // whatever their level; LINKS, NOT DATA — nothing of the details is in it.
  [INVOICE_DETAILS_CHANGED_MAIL]: {
    en: {
      subject: "The details on your invoices were changed",
      body: "The company details, bank details or note printed on your workspace's invoices were changed. See what they are now, and who changed them, in Fortleva under Settings, Invoicing. If you did not expect this, check them before you send another invoice.",
    },
    sv: {
      subject: "Uppgifterna på era fakturor har ändrats",
      body: "Företagsuppgifterna, bankuppgifterna eller meddelandet som skrivs ut på arbetsytans fakturor har ändrats. Se vad de är nu, och vem som ändrade dem, i Fortleva under Inställningar, Fakturering. Om ni inte väntade er detta, kontrollera dem innan ni skickar nästa faktura.",
    },
  },
  // Phase 4 slice 109 — an invoice ISSUED WITH A PAY NOW LINK (C79 (g);
  // `invoice-pay-link-mail-key.ts`). A security notice to every owner,
  // whatever their level; LINKS, NOT DATA — neither the link nor the amount.
  [INVOICE_PAY_LINK_ISSUED_MAIL]: {
    en: {
      subject: "An invoice was issued with a Pay now link",
      body: "An invoice in your workspace was issued with a Pay now link — the client can pay it through that Stripe or PayPal page. Open the invoice to see the link and who issued it. If you did not expect this, check that the link goes to your own account before the client pays.",
    },
    sv: {
      subject: "En faktura utfärdades med en betallänk",
      body: "En faktura i er arbetsyta utfärdades med en betallänk – kunden kan betala den via den sidan hos Stripe eller PayPal. Öppna fakturan för att se länken och vem som utfärdade den. Om ni inte väntade er detta, kontrollera att länken går till ert eget konto innan kunden betalar.",
    },
  },
  // Phase 5 slice 101 — a client person's weekly summary (C69;
  // `client-digest.ts`). The real mail is `renderContactDigest`, rendered by
  // the outbox with the person's own unsubscribe link; this copy is only what
  // a row would read with that branch bypassed — kept because every template
  // has copy, and it names nothing.
  [CONTACT_DIGEST_MAIL]: {
    en: {
      subject: "Your weekly summary from your agency",
      body: "There is news in your agency's client portal. Sign in to see it.",
    },
    sv: {
      subject: "Din veckosammanfattning från din byrå",
      body: "Det finns nytt i din byrås kundportal. Logga in för att se det.",
    },
  },
  // Phase 5 slice 102 — a project's progress update is due today (C70).
  // LINKS, NOT DATA: neither the project nor its client is named; the inbox
  // names the project under the reader's own principal. The late reminders'
  // copy is `UPDATE_LATE_COPY` below, chosen by `params.late`.
  "project_update.due": {
    en: {
      subject: "A project update is due today",
      body: "A project you look after is due a progress update today. Open its Updates tab to write it.",
    },
    sv: {
      subject: "En projektuppdatering ska skrivas i dag",
      body: "Ett projekt du ansvarar för ska ha en lägesuppdatering i dag. Öppna fliken Uppdateringar i projektet för att skriva den.",
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

/**
 * A progress-update reminder once the update is LATE (slice 102): the same
 * mail, saying so. `params.late` is the job's own flag, never a person's —
 * anything but "1" reads as due today.
 */
const UPDATE_LATE_COPY: Record<"en" | "sv", Copy> = {
  en: {
    subject: "A project update is late",
    body: "A project you look after was due a progress update and none has been published yet. Open its Updates tab to write it.",
  },
  sv: {
    subject: "En projektuppdatering är försenad",
    body: "Ett projekt du ansvarar för skulle ha haft en lägesuppdatering, och ingen har publicerats ännu. Öppna fliken Uppdateringar i projektet för att skriva den.",
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
  if (key === MEMBER_DIGEST_MAIL) return new URL("/inbox", appUrl);
  if (key === CONTACT_DIGEST_MAIL) return new URL("/portal", appUrl);
  if (key === REPLY_ADDRESS_CHANGED_MAIL) return new URL("/settings/preferences", appUrl);
  if (key === INVOICE_DETAILS_CHANGED_MAIL) return new URL("/settings/invoicing", appUrl);
  // An invoice issued with a Pay now link (slice 109): that invoice's page —
  // the id the issue put in `params`, else the list.
  if (key === INVOICE_PAY_LINK_ISSUED_MAIL) {
    const invoiceId = uuidParam(params, "invoiceId");
    return new URL(invoiceId ? `/invoices/${invoiceId}` : "/invoices", appUrl);
  }
  // An export (slice 95): the exports page, behind the vault's door, says
  // who exported what and when — the mail itself names nothing.
  if (key === VAULT_EXPORTED_MAIL) return new URL("/vault/exports", appUrl);
  // A sealed ask (slice 93): an answerer's mail opens the ask itself —
  // `credential:unseal`, which every answerer holds, reads it; the id came
  // from the vault, never a person, and is held to a uuid's shape. The
  // client's opens their Logins page.
  if (key === SEALED_CONTACT_MAIL) return new URL("/portal/logins", appUrl);
  // The door's alarm (slice 99): the owners' opens the client's Contacts
  // tab, where that person's portal access is paused — the id came from the
  // vault, never a person, and is held to a uuid's shape. The client
  // person's opens the portal's "forgot your password" page: a reset there
  // signs every other session out.
  if (key === DOOR_ALARM_MEMBER_MAIL) {
    const clientId = uuidParam(params, "clientId");
    return new URL(clientId ? `/clients/${clientId}/contacts` : "/clients", appUrl);
  }
  if (key === DOOR_ALARM_CONTACT_MAIL) return new URL("/portal/reset-password", appUrl);
  // A login asked of a contact (slice 98): the ask's own page in their
  // portal, which answers only to the one contact asked. The id came from
  // the vault, never a person, and is held to a uuid's shape.
  if (key === LOGIN_ASK_MAIL) {
    const askId = uuidParam(params, "askId");
    return new URL(askId ? `/portal/send-login?ask=${askId}` : "/portal", appUrl);
  }
  // A decline (slice 98): the Vault tab where the ask is listed — the
  // project's for a project's ask, else the client's. The fan-out chose
  // receivers who reach that anchor; the ids are held to their shapes.
  if (key === "credential.ask_declined") {
    // `PROJECT_KEY_RE`'s shape (src/projects/service.ts), restated: that
    // module reaches the database.
    const projectKey =
      typeof params?.["projectKey"] === "string" && /^[A-Z][A-Z0-9]{0,7}$/.test(params["projectKey"])
        ? params["projectKey"]
        : null;
    if (projectKey) return new URL(`/projects/${projectKey}/vault`, appUrl);
    const clientId = uuidParam(params, "clientId");
    return new URL(clientId ? `/clients/${clientId}/vault` : "/vault", appUrl);
  }
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
  // A progress update due (slice 102): the project's Updates tab, which
  // `project_update:view` opens — every receiver holds it on all four gates
  // (`RECEIVER_CODES`, src/modules/work/update-reminders.ts).
  // The key came from the job, never a person, and is held to
  // `PROJECT_KEY_RE`'s shape (src/projects/service.ts reaches the database).
  if (key === "project_update.due") {
    const projectKey =
      typeof params?.["projectKey"] === "string" && /^[A-Z][A-Z0-9]{0,7}$/.test(params["projectKey"])
        ? params["projectKey"]
        : null;
    return new URL(projectKey ? `/projects/${projectKey}/updates` : "/inbox", appUrl);
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
  if (key === MEMBER_DIGEST_MAIL) {
    // Counts, never names (C68 (e)): the outbox puts `{ counts }` here from
    // the linked rows still unread at send.
    const digest = renderMemberDigest(locale, params?.["counts"], {
      inbox: new URL("/inbox", appUrl).toString(),
      settings: new URL("/settings/notifications", appUrl).toString(),
    });
    if (digest) return digest;
  }
  const lang = locale === "sv" ? "sv" : "en";
  const late = key === "project_update.due" && params?.["late"] === "1";
  const copy = late ? UPDATE_LATE_COPY[lang] : COPY[key][lang];
  return { subject: copy.subject, text: `${copy.body}\n\n${linkFor(key, params).toString()}` };
}

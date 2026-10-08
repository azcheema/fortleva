import { createVerify, type KeyObject } from "node:crypto";

/**
 * AMAZON SNS, AS FAR AS AMAZON SES'S FEEDBACK NEEDS IT (Phase 5 slice 103,
 * founder decision C71; ARCHITECTURE.md ARC-09) — the pure half of
 * `POST /api/mail-feedback`: reading an SNS envelope, checking its signature,
 * pinning the two URLs it names, and reading the SES event inside it. Nothing
 * here touches the network or the database; the route wires a certificate
 * loader (`sns-cert.ts`) and the writer (`src/jobs/mail-feedback.ts`).
 *
 * **WHY EVERY CHECK, AND IN THIS ORDER.** What the webhook does with a message
 * is BLOCK AN ADDRESS — for every workspace, password resets included
 * (C71 (e)). A forged complaint would therefore be a way to cut anyone off
 * from Fortleva's mail. Two things together make a message ours: AWS signed it
 * (the signature, under a certificate fetched from AWS's own host over TLS),
 * and it came from OUR topic (`TopicArn`, which is inside what is signed).
 * Either alone is not enough — anybody may create an SNS topic in their own
 * AWS account, and its messages are signed by the same AWS certificate — so the
 * topic is checked first (it costs nothing, and a stranger's message is turned
 * away before anything is fetched), and the signature is what makes the topic
 * name trustworthy.
 *
 * Message format: https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html
 * and https://docs.aws.amazon.com/sns/latest/dg/sns-message-and-json-formats.html.
 */

export const SNS_MESSAGE_TYPES = ["Notification", "SubscriptionConfirmation", "UnsubscribeConfirmation"] as const;
export type SnsMessageType = (typeof SNS_MESSAGE_TYPES)[number];

/** An envelope with every field the signature covers, as strings. */
export type SnsEnvelope = {
  readonly Type: SnsMessageType;
  readonly MessageId: string;
  readonly TopicArn: string;
  readonly Message: string;
  readonly Timestamp: string;
  readonly SignatureVersion: "1" | "2";
  readonly Signature: string;
  readonly SigningCertURL: string;
  /** Notification only, and only when the publisher gave one. */
  readonly Subject?: string;
  /** SubscriptionConfirmation / UnsubscribeConfirmation only. */
  readonly Token?: string;
  readonly SubscribeURL?: string;
};

const isString = (v: unknown): v is string => typeof v === "string";

/**
 * Read a parsed JSON body as an envelope, or `null` when it is not one: a
 * known `Type`, every field the signature for that type covers present as a
 * string, and a signature version we verify. Nothing is trusted yet.
 */
export function readSnsEnvelope(body: unknown): SnsEnvelope | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const type = b["Type"];
  if (!isString(type) || !(SNS_MESSAGE_TYPES as readonly string[]).includes(type)) return null;
  // VERSION 2 (RSA-SHA256) ONLY (the security review's low): RUNBOOK §9 sets
  // the topic to it before anything subscribes, and the attribute covers the
  // confirmations too, so a version-1 message is a misconfigured topic or not
  // ours. (`verifySnsSignature` still knows version 1, for the record.)
  const version = b["SignatureVersion"];
  if (version !== "2") return null;
  for (const key of ["MessageId", "TopicArn", "Message", "Timestamp", "Signature", "SigningCertURL"]) {
    if (!isString(b[key])) return null;
  }
  const subject = b["Subject"];
  // `Subject` is part of what is signed only when it is there; SNS sends
  // `null` (or nothing) for a message published without one.
  if (subject !== undefined && subject !== null && !isString(subject)) return null;
  if (type !== "Notification" && (!isString(b["Token"]) || !isString(b["SubscribeURL"]))) return null;
  return {
    Type: type as SnsMessageType,
    MessageId: b["MessageId"] as string,
    TopicArn: b["TopicArn"] as string,
    Message: b["Message"] as string,
    Timestamp: b["Timestamp"] as string,
    SignatureVersion: version,
    Signature: b["Signature"] as string,
    SigningCertURL: b["SigningCertURL"] as string,
    ...(type === "Notification" && isString(subject) ? { Subject: subject } : {}),
    ...(type !== "Notification" ? { Token: b["Token"] as string, SubscribeURL: b["SubscribeURL"] as string } : {}),
  };
}

/**
 * The exact bytes SNS signed: `Name\nValue\n` for each field the type covers,
 * in byte order of the names. A Notification covers `Subject` only when it
 * has one.
 */
export function snsStringToSign(e: SnsEnvelope): string {
  const fields: [string, string | undefined][] =
    e.Type === "Notification"
      ? [
          ["Message", e.Message],
          ["MessageId", e.MessageId],
          ["Subject", e.Subject],
          ["Timestamp", e.Timestamp],
          ["TopicArn", e.TopicArn],
          ["Type", e.Type],
        ]
      : [
          ["Message", e.Message],
          ["MessageId", e.MessageId],
          ["SubscribeURL", e.SubscribeURL],
          ["Timestamp", e.Timestamp],
          ["Token", e.Token],
          ["TopicArn", e.TopicArn],
          ["Type", e.Type],
        ];
  return fields
    .filter((f): f is [string, string] => f[1] !== undefined)
    .map(([name, value]) => `${name}\n${value}\n`)
    .join("");
}

/** Did the holder of `key` sign this envelope? Version 1 is RSA-SHA1, version 2 RSA-SHA256. */
export function verifySnsSignature(e: SnsEnvelope, key: KeyObject): boolean {
  try {
    return createVerify(e.SignatureVersion === "2" ? "RSA-SHA256" : "RSA-SHA1")
      .update(snsStringToSign(e), "utf8")
      .verify(key, e.Signature, "base64");
  } catch {
    // A key of the wrong type, or a signature that is not base64 — not ours.
    return false;
  }
}

/**
 * A URL on exactly the pinned SNS host, over https, with no credentials, no
 * port and no fragment — the checks both URLs below share. The WHATWG parser
 * decides what the host IS, so `https://sns.eu-central-1.amazonaws.com.evil.example/`
 * and `https://sns.eu-central-1.amazonaws.com@evil.example/` are each refused
 * on their real host rather than matched on a prefix.
 */
function onPinnedHost(raw: string, snsHost: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.hostname !== snsHost || url.port !== "") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.hash !== "") return null;
  return url;
}

/**
 * The certificate SNS signed with: `https://<snsHost>/SimpleNotificationService-<id>.pem`
 * and nothing else. Pinning the PATH as well as the host keeps the fetch to
 * AWS's certificate files — a caller who knows our topic cannot make this
 * server fetch arbitrary pages of that host.
 */
export function isPinnedCertUrl(raw: string, snsHost: string): boolean {
  const url = onPinnedHost(raw, snsHost);
  return (
    url !== null &&
    url.search === "" &&
    /^\/SimpleNotificationService-[A-Za-z0-9]+\.pem$/.test(url.pathname) &&
    // CANONICAL, or refused (the fix-pass review's low): the loader's cache,
    // refusal memory and in-flight map are keyed by this string, and
    // `SNS.eu-central-1…` or `…amazonaws.com:443/…` parse to the same
    // certificate under a different key — eight such variants would evict the
    // genuine one and spend the fetch budget. SNS sends the canonical form.
    url.href === raw
  );
}

/**
 * The address a subscription is confirmed by: SNS's own `ConfirmSubscription`
 * action, for OUR topic, with a token. Signed, so it cannot have been altered —
 * the pin is the second belt against fetching anything else.
 */
export function isPinnedSubscribeUrl(raw: string, snsHost: string, topicArn: string): boolean {
  const url = onPinnedHost(raw, snsHost);
  if (url === null || url.pathname !== "/") return false;
  const q = url.searchParams;
  return q.get("Action") === "ConfirmSubscription" && q.get("TopicArn") === topicArn && (q.get("Token") ?? "") !== "";
}

/** The reasons a feedback event blocks an address (the `suppression_reason` values it may write). */
export type FeedbackReason = "HARD_BOUNCE" | "COMPLAINT";
export type SesFeedback = { readonly reason: FeedbackReason; readonly addresses: readonly string[] };

/** SES puts at most 50 recipients on one message; Fortleva sends one. */
const MAX_ADDRESSES = 50;
/** RFC 5321's limit on a path, which bounds any real address. */
const MAX_ADDRESS_LENGTH = 254;

/**
 * One recipient address as SES reports it, lower-cased (every suppression
 * check compares lower-case), or `null` when it does not look like an address.
 * SES reports the bare address; a `Name <addr>` form is read for its address.
 */
export function normaliseFeedbackAddress(raw: unknown): string | null {
  if (!isString(raw)) return null;
  const angled = /<([^<>]*)>\s*$/.exec(raw);
  const address = (angled ? angled[1]! : raw).trim().toLowerCase();
  if (address.length === 0 || address.length > MAX_ADDRESS_LENGTH) return null;
  return /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/.test(address) ? address : null;
}

/**
 * The feedback types a COMPLAINT may carry that are not the person saying
 * they do not want our mail (RFC 5965): `not-spam` is a mailbox provider
 * reporting the OPPOSITE — the person said it is not spam — and
 * `auth-failure` / `virus` describe the message, not the person's wish.
 * None of them blocks anyone (the design review's medium: C71 (e) is about
 * a spam report). An absent type, `abuse`, `fraud` and `other` do.
 */
const NOT_A_SPAM_REPORT = new Set(["not-spam", "auth-failure", "virus"]);

/**
 * The Permanent bounce subtypes that block (the security review's low): the
 * address does not exist (`General`, `NoEmail`), or OUR account's own list
 * already holds it (`OnAccountSuppressionList` — how a lost bounce heals on the
 * next send). Not `Suppressed` (SES's GLOBAL list, built from other customers'
 * bounces and kept there only for a while — SES refuses the send meanwhile, so
 * nothing is lost), nor SES's other policy decisions (`UnsubscribedRecipient`,
 * `EmailValidationSuppressed`, `OnTenantSuppressionList`), none of which is a
 * fact about our mail to that person.
 */
const BLOCKING_BOUNCE_SUBTYPES = new Set(["General", "NoEmail", "OnAccountSuppressionList"]);

/**
 * What `readSesFeedback` found: the addresses to block, if any, and — for a
 * bounce or complaint it refused or trimmed — a NOTE for the log, a reason and
 * counts only, never an address (the security review's nit: a silent 200
 * would hide a misconfiguration, such as SES sending from another account).
 */
export type SesFeedbackRead = { readonly feedback: SesFeedback | null; readonly note: string | null };

const ignored: SesFeedbackRead = { feedback: null, note: null };
const refused = (note: string): SesFeedbackRead => ({ feedback: null, note });

/**
 * The SES event inside a Notification's `Message`, read for what blocks an
 * address. Both of SES's shapes: an identity's feedback notifications
 * (`notificationType`) and a configuration set's event publishing
 * (`eventType`), which carry the same `bounce` / `complaint` / `mail` objects.
 *
 * **THE EVENT MUST BE ABOUT A MAIL OUR OWN ACCOUNT SENT** (`mail.sendingAccountId`
 * = the account that owns our topic — the design review's medium). The topic
 * pin and the signature prove AWS delivered it to our topic; they do not prove
 * whose mail it describes. Any AWS account can put any address on its OWN
 * suppression list, send to it, and receive a genuine, signed Permanent bounce
 * naming it — and if our topic's policy ever let SES publish without a
 * source-account condition, that account could route the event here and block
 * the address for every workspace. RUNBOOK §9 sets the condition; this is the
 * second belt, in code.
 *
 * **AND WHAT IS BLOCKED IS THE ADDRESS THAT MAIL WAS SENT TO** (`mail.destination`
 * — the security review's HIGH, and the fix-pass review's refinement). A
 * bounce's `emailAddress` is the `Final-Recipient` of the report the remote
 * server sent back, which that server WRITES: anyone who receives one of our
 * mails (a sign-up at their own domain is enough) can answer its bounce address
 * with a forged delivery-status report naming up to fifty victims, and SES
 * publishes it as a genuine, signed, our-account Permanent bounce. So the
 * reported addresses are never what is blocked: Fortleva sends every message to
 * exactly ONE address, an event about a mail with any other number of
 * recipients is refused, and a bounce or complaint about that mail blocks THAT
 * recipient — a forger's own mail went to the forger, so they can block no one
 * else. The reported address only has to agree that the mail failed; when it
 * differs from the recipient (a forwarding or aliased mailbox whose final
 * address is dead) the block still lands on the address we actually mail,
 * which is the one that will keep bouncing — and the note says it was
 * attributed.
 *
 * - A **Permanent** bounce of a `BLOCKING_BOUNCE_SUBTYPES` subtype blocks
 *   (`HARD_BOUNCE`) when at least one reported recipient FAILED — its `action`
 *   `failed` and its `status` a 5.x.x, where those are given (SES's own example
 *   Permanent bounce carries a `delayed` 4.0.0 recipient beside the failed
 *   one). A Transient or Undetermined bounce does not — it may deliver tomorrow.
 * - A **complaint** — a spam report — blocks (`COMPLAINT`; C71 (e): ALL mail
 *   stops), unless its feedback type says it is not one (`NOT_A_SPAM_REPORT`).
 * - Anything else — deliveries, sends, rejects, rendering failures, opens —
 *   is not feedback about an address, and is ignored without a note.
 */
export function readSesFeedback(message: string, sendingAccountId: string): SesFeedbackRead {
  let event: unknown;
  try {
    event = JSON.parse(message);
  } catch {
    return ignored;
  }
  if (typeof event !== "object" || event === null) return ignored;
  const e = event as Record<string, unknown>;
  const kind = isString(e["notificationType"]) ? e["notificationType"] : e["eventType"];
  if (kind !== "Bounce" && kind !== "Complaint") return ignored;

  const mail = e["mail"];
  if (typeof mail !== "object" || mail === null) return refused(`${kind}: no mail object`);
  const m = mail as Record<string, unknown>;
  if (m["sendingAccountId"] !== sendingAccountId) return refused(`${kind}: not about mail our account sent`);
  const destination = Array.isArray(m["destination"]) ? m["destination"] : [];
  if (destination.length !== 1) return refused(`${kind}: the mail had ${Math.min(destination.length, 99)} recipients, not one`);
  const recipient = normaliseFeedbackAddress(destination[0]);
  if (recipient === null) return refused(`${kind}: the mail's recipient is not an address`);

  let reason: FeedbackReason;
  let recipients: unknown;
  let failedOnly = false;
  if (kind === "Bounce") {
    const bounce = e["bounce"];
    if (typeof bounce !== "object" || bounce === null) return refused("Bounce: no bounce object");
    const b = bounce as Record<string, unknown>;
    if (b["bounceType"] !== "Permanent") return ignored;
    if (!isString(b["bounceSubType"]) || !BLOCKING_BOUNCE_SUBTYPES.has(b["bounceSubType"])) {
      return refused(`Bounce: permanent subtype ${isString(b["bounceSubType"]) ? b["bounceSubType"].slice(0, 40) : "missing"} not recorded`);
    }
    reason = "HARD_BOUNCE";
    recipients = b["bouncedRecipients"];
    failedOnly = true;
  } else {
    const complaint = e["complaint"];
    if (typeof complaint !== "object" || complaint === null) return refused("Complaint: no complaint object");
    const c = complaint as Record<string, unknown>;
    const type = c["complaintFeedbackType"];
    if (type !== undefined && type !== null && (!isString(type) || NOT_A_SPAM_REPORT.has(type.toLowerCase()))) {
      return refused("Complaint: not a spam report");
    }
    reason = "COMPLAINT";
    recipients = c["complainedRecipients"];
  }
  // A bounce must REPORT a failure, so it needs its recipients; a complaint is
  // about the mail itself, whose one recipient is what is blocked (SES fills
  // `complainedRecipients` from the original mail anyway — the narrow
  // re-check's nit).
  if (failedOnly && (!Array.isArray(recipients) || recipients.length === 0)) return refused(`${kind}: no recipients`);

  // Does the report say the mail FAILED (a bounce), and does it name the mail's
  // own recipient? Only the first decides; the second only shapes the note.
  let failed = !failedOnly;
  // A report with no recipients (a complaint may come without) names no OTHER
  // address either — so no note for it.
  let namesRecipient = !Array.isArray(recipients) || recipients.length === 0;
  for (const r of (Array.isArray(recipients) ? recipients : []).slice(0, MAX_ADDRESSES)) {
    if (typeof r !== "object" || r === null) continue;
    const rec = r as Record<string, unknown>;
    if (failedOnly) {
      const action = rec["action"];
      const status = rec["status"];
      const recFailed =
        (action === undefined || (isString(action) && action.toLowerCase() === "failed")) &&
        (status === undefined || (isString(status) && status.startsWith("5")));
      if (!recFailed) continue;
      failed = true;
    }
    if (normaliseFeedbackAddress(rec["emailAddress"]) === recipient) namesRecipient = true;
  }
  if (!failed) return refused(`${kind}: no recipient failed`);
  return {
    feedback: { reason, addresses: [recipient] },
    note: namesRecipient ? null : `${kind}: the report named another address; attributed to the mail's one recipient`,
  };
}

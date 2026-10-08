import { SendEmailCommand, SESv2Client, type SendEmailCommandInput } from "@aws-sdk/client-sesv2";

import type { AmazonSesConfig } from "@/config";

import type { MailMessage } from "./index";

/**
 * THE AMAZON SES TRANSPORT (ARCHITECTURE.md ARC-09; Phase 5 slice 103, founder
 * decision C71) — the SESv2 API, never SMTP (ARC-09: the IAM policy that scopes
 * the key to our identity and From domain is what makes a leaked key useless
 * for anything else). `src/mailer/index.ts` chooses it (`mailTransportKind`,
 * src/config); nothing else in the product imports it (tests do).
 *
 * One message, one recipient, plain text (and HTML only if a caller ever gives
 * one) — emails carry links, not data. `Reply-To` when the caller resolved one
 * (C68), and RFC 8058's two headers when the mail carries a one-click
 * unsubscribe (C69): `List-Unsubscribe: <url>` and
 * `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, which RFC 8058 wants
 * covered by the DKIM signature — Easy DKIM is expected to sign them, and the
 * go-live smoke checks the `h=` tag rather than trusting that (RUNBOOK §9 step
 * 9 (a)). A configuration set, when configured, routes this send's
 * events to the feedback topic (RUNBOOK §9).
 *
 * **A FAILURE IS RE-THROWN AS ITS NAME AND STATUS ONLY.** An SES error message
 * can quote the recipient ("Email address is not verified. The following
 * identities failed the check …: <address>"), and the outbox keeps the message
 * in `lastError` — 90 days, and in the tenant's own data export. The name
 * (`MessageRejected`, `TooManyRequestsException`, …) and the HTTP status are
 * what an operator needs; the outbox's backoff retries whatever it was.
 */

/** The client calls this transport makes — a seam the unit test fills. */
export type SesSend = (input: SendEmailCommandInput) => Promise<unknown>;

export function sesClientSend(config: AmazonSesConfig): SesSend {
  const client = new SESv2Client({
    region: config.region,
    // Pinned in src/config: no `AWS_ENDPOINT_URL*` variable redirects a signed request.
    endpoint: config.endpoint,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    // The SDK's own retry once (a throttle, a dropped connection), then the
    // outbox's backoff — never a minute of retries inside one drain.
    maxAttempts: 2,
    requestHandler: { connectionTimeout: 5_000, requestTimeout: 10_000 },
  });
  return (input) => client.send(new SendEmailCommand(input));
}

export function sendEmailInput(
  msg: MailMessage & { from: string },
  configurationSet: string | null,
): SendEmailCommandInput {
  return {
    FromEmailAddress: msg.from,
    Destination: { ToAddresses: [msg.to] },
    ...(msg.replyTo ? { ReplyToAddresses: [msg.replyTo] } : {}),
    ...(configurationSet ? { ConfigurationSetName: configurationSet } : {}),
    Content: {
      Simple: {
        Subject: { Data: msg.subject, Charset: "UTF-8" },
        Body: {
          Text: { Data: msg.text, Charset: "UTF-8" },
          ...(msg.html ? { Html: { Data: msg.html, Charset: "UTF-8" } } : {}),
        },
        ...(msg.listUnsubscribe
          ? {
              Headers: [
                { Name: "List-Unsubscribe", Value: `<${msg.listUnsubscribe}>` },
                { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
              ],
            }
          : {}),
      },
    },
  };
}

/** `amazon-ses: <ErrorName> (<status>)` — never the error's message (see the header). */
export function sanitisedSesError(e: unknown): Error {
  const name = e instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,80}$/.test(e.name) ? e.name : "Error";
  const meta = typeof e === "object" && e !== null ? (e as { $metadata?: { httpStatusCode?: unknown } }).$metadata : undefined;
  const status = typeof meta?.httpStatusCode === "number" ? ` (${meta.httpStatusCode})` : "";
  return new Error(`amazon-ses: ${name}${status}`);
}

/**
 * Domains no real mailbox lives at (RFC 2606 / RFC 6761): every fixture,
 * dbtest and e2e address uses one. Sent through SES, each is a hard bounce —
 * and a run of them counts against the ACCOUNT's bounce rate, which SES pauses
 * at, with production's mail (the design review's medium). Refused in every
 * mode, before SES is asked.
 */
const RESERVED_DOMAIN = /(^|\.)(invalid|test|example|localhost)$|(^|\.)example\.(com|net|org)$/i;

/**
 * A refusal of ONE recipient, decided here before SES is asked — it costs
 * nothing and says nothing about the transport, so the outbox does not count
 * it toward "the transport is down" (`isRecipientRefusal`, src/mailer).
 */
export class RecipientRefusedError extends Error {
  constructor(what: "ReservedRecipientDomain" | "RecipientNotAllowedHere") {
    super(`amazon-ses: ${what}`);
    this.name = "RecipientRefused";
  }
}

export function isReservedRecipient(address: string): boolean {
  const at = address.lastIndexOf("@");
  return at < 0 || RESERVED_DOMAIN.test(address.slice(at + 1).trim());
}

export function amazonSesTransport(
  config: AmazonSesConfig,
  sendCommand: SesSend = sesClientSend(config),
): (msg: MailMessage & { from: string }) => Promise<void> {
  return async (msg) => {
    if (isReservedRecipient(msg.to)) throw new RecipientRefusedError("ReservedRecipientDomain");
    // A machine that is not a deployment mails only the addresses it was given
    // (`MAIL_DEV_RECIPIENTS`, src/config `mailTransportKind`).
    if (config.allowedRecipients !== null && !config.allowedRecipients.has(msg.to.trim().toLowerCase())) {
      throw new RecipientRefusedError("RecipientNotAllowedHere");
    }
    try {
      await sendCommand(sendEmailInput(msg, config.configurationSet));
    } catch (e) {
      throw sanitisedSesError(e);
    }
  };
}

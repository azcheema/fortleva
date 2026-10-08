import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { allowDevMailOutbox, amazonSesConfig, isProduction, mailFrom, mailTransportKind } from "@/config";
import { isAddressSuppressed } from "@/db";

import { amazonSesTransport, RecipientRefusedError } from "./amazon-ses";

/**
 * Did the transport refuse this one recipient (a reserved domain, a dev
 * allowlist) rather than fail? The outbox counts only real failures toward
 * "the transport is down" (slice 103).
 */
export const isRecipientRefusal = (e: unknown): boolean => e instanceof RecipientRefusedError;

/**
 * The one-interface mail adapter (ARC-09): everything that sends email
 * goes through send(). A deployment with Amazon SES credentials sends
 * through Amazon SES (`./amazon-ses.ts`, Phase 5 slice 103); every process
 * serving itself on loopback — dev, the dbtests, the e2e harness — uses
 * the dev transport, which logs to console and appends to
 * .dev-outbox/outbox.jsonl (gitignored) so flows are fully testable
 * without a provider (`mailTransportKind`, src/config, says when).
 *
 * **A BLOCKED ADDRESS GETS NOTHING** (founder decision C71 (e)): before
 * every message, `send()` asks the suppression list — an address that
 * bounced for good or reported our mail as spam — and answers
 * `"suppressed"` without sending. That covers the mail sent straight from
 * a request, which no outbox check reaches: password resets, sign-in
 * codes, invitations, share links' codes. Support lifts a block (RUNBOOK
 * §8); fixing a person's address starts their mail again.
 *
 * Module is named `mailer`, NEVER `ses` — bare "SES" means Simple
 * Electronic Signature in this codebase (SignatureLevel.SES, Phase 4).
 *
 * Policy (ARC-09): emails carry links, not data — deep links to the
 * canonical app origin, no attachments, no sensitive contents, and
 * NEVER key material (CONTINUITY_BOX.md INV-3).
 */

export type MailMessage = {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  /**
   * Where a reply goes (Phase 5 slice 100, founder decision C68 (c), (f), (j)):
   * the workspace's own confirmed reply address, else its owner's — never the
   * sending domain, which receives nothing. Resolved by the caller through
   * `resolveReplyAddress` (src/notify/reply-address-resolve.ts) for mail that
   * belongs to a workspace — EXCEPT mail carrying a client's live link or code
   * and the security notices to a workspace's own members (that module's
   * `MAIL_WITHOUT_REPLY_TO` note) — and absent on mail about a person's
   * Fortleva ACCOUNT, which is not any one agency's.
   */
  readonly replyTo?: string;
  /**
   * RFC 8058 one-click unsubscribe (Phase 5 slice 101): an https URL the
   * mailbox provider POSTs `List-Unsubscribe=One-Click` to. A transport that
   * sends real mail sets BOTH headers from it — `List-Unsubscribe: <url>` and
   * `List-Unsubscribe-Post: List-Unsubscribe=One-Click` — and the message
   * must be DKIM-signed with those headers covered (RFC 8058 §4; whether
   * Amazon SES's Easy DKIM covers them is checked at go-live — RUNBOOK §9
   * step 9 (a), the `h=` tag — not assumed). Only the clients' weekly summary carries one: it is the
   * one mail sent to a person on a schedule rather than because something
   * happened to them.
   */
  readonly listUnsubscribe?: string;
};

export type MailTransport = (msg: MailMessage & { from: string }) => Promise<void>;

const devTransport: MailTransport = async (msg) => {
  const line = JSON.stringify({ at: new Date().toISOString(), ...msg });
  console.log(`[mailer:dev] to=${msg.to} subject="${msg.subject}"`);
  try {
    const dir = join(process.cwd(), ".dev-outbox");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "outbox.jsonl"), line + "\n");
  } catch {
    // outbox is a dev convenience, never a failure path
  }
};

let transport: MailTransport =
  mailTransportKind === "amazon-ses" && amazonSesConfig !== null ? amazonSesTransport(amazonSesConfig) : devTransport;

/**
 * Swap the transport — tests only. Returns the transport it replaced, so a
 * test that swaps one in — the portal reset's, which needs a transport that
 * never answers — can put the real one back.
 */
export const setTransport = (t: MailTransport): MailTransport => {
  const previous = transport;
  transport = t;
  return previous;
};

let announcedDevOutbox = false;

/**
 * What became of a message: `"sent"` (handed to the transport, which
 * resolved) or `"suppressed"` (the address is blocked — nothing was sent,
 * nothing will be). A transport failure throws, as it always has.
 */
export type SendOutcome = "sent" | "suppressed";

/**
 * What a caller that catches a transport failure reports instead of throwing
 * it — an invitation, which has committed before its mail goes (slice 103).
 */
export type DeliveryOutcome = SendOutcome | "failed";

export async function send(msg: MailMessage): Promise<SendOutcome> {
  // Before the transport guard below, so a blocked address is answered the
  // same in every mode. A failed lookup throws — fail closed, like a failed
  // transport: nothing is sent to an address we could not check — and throws
  // its NAME and code only, as the SES transport does: a Prisma message prints
  // its arguments (the address), and the outbox keeps the message in
  // `lastError`, in the tenant's own export (the design review's low).
  let suppressed: boolean;
  try {
    suppressed = await isAddressSuppressed(msg.to);
  } catch (e) {
    const code = typeof e === "object" && e !== null && "code" in e ? ` (${String((e as { code: unknown }).code)})` : "";
    throw new Error(`mailer: suppression lookup failed: ${e instanceof Error ? e.name : typeof e}${code}`);
  }
  if (suppressed) {
    // Never the address: logs leave the database's protection.
    console.warn("[mailer] recipient is on the suppression list — not sent");
    return "suppressed";
  }
  if (isProduction && transport === devTransport) {
    // **THE ONE WAY PAST THIS GUARD, and it is the e2e harness's.**
    // `next start` sets NODE_ENV=production, so the browser harness runs
    // a production build — which made every mail-sending FLOW untestable
    // end to end, not merely the mail. `inviteContact` sends after its
    // transaction commits, so pressing Invite would have written the row
    // and then thrown, and the acceptance token exists nowhere but that
    // message. `MAIL_DEV_OUTBOX=1` is set in `playwright.config.ts`'s
    // `webServer.env` and nowhere else in the repository.
    //
    // It is opt-IN and it is LOUD: without the flag this throws exactly
    // as it always has, and with it every process that honours it says
    // so once. A real deployment cannot turn mail into a silent drop by
    // accident, and could not do it quietly on purpose.
    if (!allowDevMailOutbox) {
      throw new Error(
        "mailer: production requires a real transport — the deployment needs AMAZON_SES_ACCESS_KEY_ID, AMAZON_SES_SECRET_ACCESS_KEY and MAIL_SEND_TO_ANYONE=1 (RUNBOOK §1); any other production build on loopback uses MAIL_DEV_OUTBOX=1, or MAIL_TRANSPORT=amazon-ses with MAIL_DEV_RECIPIENTS",
      );
    }
    if (!announcedDevOutbox) {
      announcedDevOutbox = true;
      console.warn("[mailer] MAIL_DEV_OUTBOX=1 — production build writing to .dev-outbox, NOT sending");
    }
  }
  await transport({ ...msg, from: mailFrom.header });
  return "sent";
}

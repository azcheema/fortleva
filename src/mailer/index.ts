import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { allowDevMailOutbox, isProduction, mailFrom } from "@/config";

/**
 * The one-interface mail adapter (ARC-09): everything that sends email
 * goes through send(). The Amazon SES transport lands when the
 * mailer.naxdor.com identity exists; until then the dev transport logs
 * to console and appends to .dev-outbox.jsonl (gitignored) so flows
 * are fully testable without a provider.
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

let transport: MailTransport = devTransport;

/**
 * Amazon SES transport plugs in here (Phase 1, post-identity). Returns the
 * transport it replaced, so a test that swaps one in — the portal reset's,
 * which needs a transport that never answers — can put the real one back.
 */
export const setTransport = (t: MailTransport): MailTransport => {
  const previous = transport;
  transport = t;
  return previous;
};

let announcedDevOutbox = false;

export async function send(msg: MailMessage): Promise<void> {
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
      throw new Error("mailer: production requires a real transport (Amazon SES not yet wired)");
    }
    if (!announcedDevOutbox) {
      announcedDevOutbox = true;
      console.warn("[mailer] MAIL_DEV_OUTBOX=1 — production build writing to .dev-outbox, NOT sending");
    }
  }
  await transport({ ...msg, from: mailFrom.header });
}

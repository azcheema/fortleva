import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { isProduction, mailFrom } from "@/config";

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

/** Amazon SES transport plugs in here (Phase 1, post-identity). */
export const setTransport = (t: MailTransport): void => {
  transport = t;
};

export async function send(msg: MailMessage): Promise<void> {
  if (isProduction && transport === devTransport) {
    throw new Error("mailer: production requires a real transport (Amazon SES not yet wired)");
  }
  await transport({ ...msg, from: mailFrom.header });
}

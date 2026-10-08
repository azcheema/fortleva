// lift-mail-block — SUPPORT LETS FORTLEVA MAIL AN ADDRESS AGAIN
// (Phase 5 slice 103, founder decision C71 (f); RUNBOOK §8, "lift a block").
//
//   pnpm exec tsx scripts/lift-mail-block.ts --email <address> --reason "<why>" [--dry-run]
//   pnpm exec tsx scripts/lift-mail-block.ts --help
//
// An address that bounced for good, or whose owner reported our mail as spam,
// gets no mail from any workspace — password resets included. Only support
// lifts that, and only on the person's own request. This removes the address
// from Fortleva's list in one audited transaction (`liftMailBlock`,
// src/jobs/lift-mail-block.ts: a `platform.system_job` row naming the address and
// your reason); Amazon's own account-level list is the second step, printed at
// the end.
//
// RUN IT AS THE OPERATOR, with the target database's PLATFORM_DATABASE_URL and
// DATABASE_URL in the shell's environment (they win over `.env.local`). It
// prints the database it is about to write to; read it. `--dry-run` changes no
// row (its audit line still names the address and your reason).
//
// **AGENTS NEVER RUN THIS AGAINST A REAL DATABASE.** Its behaviour is pinned by
// `src/jobs/mail-feedback.dbtest.ts`.
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

const HELP = `lift-mail-block — let Fortleva mail an address again

  --email   <address>   required: the blocked address
  --reason  "<why>"     required: written to the audit trail (e.g. "asked by phone 2026-10-08, mailbox fixed")
  --dry-run             say what is on the list for it; remove nothing
  --help

Run it with the target database's PLATFORM_DATABASE_URL and DATABASE_URL in the
environment. Afterwards remove the address from Amazon's own list too:
  aws sesv2 delete-suppressed-destination --email-address <address> --region <AMAZON_SES_REGION>
`;

function parse(argv: readonly string[]): { email: string; reason: string; dryRun: boolean } | "help" | string {
  let email: string | undefined;
  let reason: string | undefined;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help") return "help";
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--email") email = argv[++i];
    else if (arg === "--reason") reason = argv[++i];
    else return `unknown argument: ${arg}`;
  }
  if (!email) return "--email is required";
  if (!reason || reason.trim().length === 0) return "--reason is required";
  return { email, reason, dryRun };
}

function describeTarget(): string {
  const raw = process.env["PLATFORM_DATABASE_URL"];
  if (!raw) return "(PLATFORM_DATABASE_URL is not set)";
  try {
    const url = new URL(raw);
    return `${url.hostname}${url.pathname}`;
  } catch {
    return "(PLATFORM_DATABASE_URL is not a URL)";
  }
}

async function main(): Promise<number> {
  const args = parse(process.argv.slice(2));
  if (args === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (typeof args === "string") {
    console.error(`lift-mail-block: ${args}\n\n${HELP}`);
    return 2;
  }
  console.log(`database: ${describeTarget()}`);
  const { liftMailBlock } = await import("../src/jobs/lift-mail-block");
  const result = await liftMailBlock(args.email, args.reason, args.dryRun);
  if (!result.found) {
    console.log("not on Fortleva's list — nothing to lift here (Amazon's own list may still hold it).");
    return 0;
  }
  console.log(
    `${result.removed ? "lifted" : "would lift"}: ${result.reason} from ${result.source ?? "?"} since ${result.since.toISOString()}`,
  );
  if (result.reason === "COMPLAINT") console.log("note: COMPLAINT means they pressed 'spam' — be sure they asked for mail again.");
  console.log(
    `next: aws sesv2 delete-suppressed-destination --email-address ${args.email.trim().toLowerCase()} --region <AMAZON_SES_REGION>`,
  );
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`lift-mail-block: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);

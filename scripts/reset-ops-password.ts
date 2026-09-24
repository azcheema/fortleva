// reset-ops-password — THE OPERATOR'S REMEDY FOR A FORGOTTEN CONSOLE PASSWORD
// (OPEN_QUESTIONS C30e; RUNBOOK §8, "A forgotten ops password").
//
// WHY A SCRIPT. The console serves no password reset (slice 58), and the
// member plane's reset DECLINES anybody with a platform role (C30): one
// `account` row serves both planes, so a mailbox must never be able to set the
// console password. That leaves exactly one remedy, and it is this — run by the
// operator, at a shell, with the production database's credentials.
//
//   pnpm exec tsx scripts/reset-ops-password.ts --email <address> --reason "<why>" [--dry-run]
//   pnpm exec tsx scripts/reset-ops-password.ts --help
//
// RUN IT AS THE OPERATOR, AGAINST PRODUCTION: put production's DATABASE_URL and
// PLATFORM_DATABASE_URL in the environment of the shell that runs it (dotenv
// never overrides a variable that is already set, so they win over
// `.env.local`). It prints the database it is about to write to; read it.
//
// THE NEW PASSWORD IS READ FROM STDIN, NEVER FROM ARGV. On a terminal it is
// asked for twice, without echo. Piped, it is the whole of stdin less one
// trailing line break. A `--password` argument is REFUSED, and so is any
// argument this script does not know: argv lands in shell history and in every
// process listing.
//
// What it changes, in ONE transaction (`src/jobs/reset-ops-password.ts`): the
// credential; every session of the account on BOTH planes; its sign-ins
// waiting for a code; its reset links. Not the second factor, not trusted
// devices. One `platform.password_changed` audit row, actor SYSTEM, beside the
// seam's `platform.system_job` row carrying the reason. A refusal writes
// nothing; `--dry-run` writes nothing but the seam's audit of its read.
//
// **AGENTS NEVER RUN THIS AGAINST A REAL DATABASE** (AGENTS.md: never create
// or reset credentials outside a throwaway fixture). Its behaviour is pinned by
// `src/jobs/reset-ops-password.dbtest.ts`, which provisions and tears down its
// own users; nothing else should ever need to execute it but the operator.
import { config as loadEnv } from "dotenv";

import {
  applyKeystrokes,
  formatOpsResetOutcome,
  parseResetOpsArgs,
  passwordFromPipedStdin,
} from "../src/jobs/reset-ops-password-policy";

loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

const HELP = `reset-ops-password — set a new console (ops) password for a SUPERADMIN

  --email   <address>   required: the console account's address
  --reason  "<why>"     required: written to the audit trail
  --dry-run             check everything and report what would change; change nothing
  --help

The new password is read from stdin, never from the command line:
  - on a terminal you are asked for it twice, and nothing is echoed;
  - piped, it is the whole input less one trailing line break.
Windows PowerShell 5.1 re-encodes what it pipes to a program (non-ASCII
characters arrive as '?'), so type it at the prompt there instead. Git Bash's
default terminal (mintty) is not one input can be hidden on: run this from
PowerShell or Windows Terminal, or prefix the command with \`winpty\`.

Run it with production's DATABASE_URL and PLATFORM_DATABASE_URL in the
environment. Every session of the account ends, on the console and the app;
the second factor is untouched. The new password is also the one for /login.
`;

/** Where the reset will land — host and database name only, never the credentials in the URL. */
function describeTarget(): string | null {
  const raw = process.env["PLATFORM_DATABASE_URL"];
  if (!raw || !process.env["DATABASE_URL"]) return null;
  try {
    const url = new URL(raw);
    return `${url.hostname}${url.pathname}`;
  } catch {
    return "(PLATFORM_DATABASE_URL is not a URL)";
  }
}

/** One hidden line from the terminal, or null if the operator cancelled (Ctrl+C / Ctrl+D). */
function promptHidden(question: string): Promise<string | null> {
  const stdin = process.stdin;
  process.stderr.write(question);
  stdin.setEncoding("utf8");
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve) => {
    let typed = "";
    const onData = (chunk: string) => {
      const next = applyKeystrokes(typed, chunk);
      typed = next.value;
      if (next.outcome === "typing") return;
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
      resolve(next.outcome === "entered" ? next.value : null);
    };
    stdin.on("data", onData);
  });
}

/** The whole of a piped stdin. */
async function readPipedStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The new password, or null when there is none to use (cancelled, or two entries that differ). */
async function readNewPassword(): Promise<string | null> {
  if (process.stdin.isTTY) {
    const firstEntry = await promptHidden("New console password: ");
    if (firstEntry === null) return null;
    const secondEntry = await promptHidden("The same again:       ");
    if (secondEntry === null) return null;
    if (firstEntry !== secondEntry) {
      console.error("reset-ops-password: the two entries differ — nothing was changed.");
      return null;
    }
    return firstEntry;
  }
  process.stderr.write(
    "reading the new password from stdin (not a terminal). If you meant to TYPE it, press Ctrl+C now:\n" +
      "this terminal cannot hide input — see --help.\n",
  );
  return passwordFromPipedStdin(await readPipedStdin());
}

/**
 * A failure's message with anything hash-shaped removed. The password itself
 * reaches no query (only its scrypt hash does, as hex), but a Prisma error can
 * render a failing call's arguments, and this output is somebody's terminal
 * scrollback.
 */
function redacted(error: unknown): string {
  const name = error instanceof Error ? error.name : "Error";
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  return `${name}${typeof code === "string" ? ` ${code}` : ""}: ${message.replace(/[0-9a-f]{32,}/gi, "[redacted]")}`;
}

async function main(): Promise<number> {
  const parsed = parseResetOpsArgs(process.argv.slice(2));
  if (parsed.kind === "help") {
    console.log(HELP);
    return 0;
  }
  if (parsed.kind === "error") {
    console.error(`reset-ops-password: ${parsed.message}\n`);
    console.error(HELP);
    return 1;
  }

  const target = describeTarget();
  if (target === null) {
    console.error("reset-ops-password: DATABASE_URL and PLATFORM_DATABASE_URL must both be set (see --help).");
    return 1;
  }
  console.error(`database: ${target}${parsed.dryRun ? "   (dry run)" : ""}`);

  const newPassword = await readNewPassword();
  if (newPassword === null) {
    console.error("reset-ops-password: cancelled — nothing was changed.");
    return 1;
  }

  // DYNAMIC, and after the environment is loaded: `src/db/client` throws at
  // import without a connection string.
  const { resetOpsPassword } = await import("../src/jobs/reset-ops-password");
  const { getPlatformClient, runtimeClient } = await import("../src/db/client");
  try {
    const outcome = await resetOpsPassword({
      email: parsed.email,
      password: newPassword,
      reason: parsed.reason,
      dryRun: parsed.dryRun,
    });
    for (const line of formatOpsResetOutcome(outcome)) {
      if (outcome.ok) console.log(line);
      else console.error(`reset-ops-password: ${line}`);
    }
    return outcome.ok ? 0 : 1;
  } catch (error) {
    console.error(`reset-ops-password: failed — ${redacted(error)}`);
    console.error("The reset is one transaction: a failure before it committed changed nothing.");
    return 1;
  } finally {
    await getPlatformClient().$disconnect();
    await runtimeClient.$disconnect();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    console.error(`reset-ops-password: failed — ${redacted(error)}`);
    process.exit(1);
  },
);

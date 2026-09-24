import { MEMBER_MIN_PASSWORD_LENGTH } from "@/auth/recovery-policy";

/**
 * THE OPERATOR'S CONSOLE-PASSWORD RESET, AS PURE POLICY (OPEN_QUESTIONS C30e).
 *
 * Why the script exists at all: slice 58 closed the console's reset endpoints,
 * and C30 makes the member plane's reset DECLINE anybody with a `platformRole`
 * — one `account` row serves both planes, so a mailbox must never be able to
 * set the console password. A forgotten ops password therefore has exactly one
 * remedy, `scripts/reset-ops-password.ts`, run by the operator against
 * production, and everything that script decides lives here.
 *
 * Split from `./reset-ops-password` (the writer) for `./platform-gate`'s
 * reason: the writer reaches `@/db`, whose client throws at import without a
 * connection string, and CI's unit job runs before any database exists. What
 * is refused, how a password is read and what the operator is told are the
 * interesting parts, so they are the parts testable with nothing running.
 * Imports only `@/auth/recovery-policy`, which imports nothing.
 */

/**
 * The longest password the product ever SETS: Better Auth's default
 * `maxPasswordLength`, which neither instance overrides and which sign-up,
 * `/account` and the reset all enforce. Sign-in does not check it — so a
 * longer one would work until the first time its holder tried to change it.
 */
export const OPS_PASSWORD_MAX_LENGTH = 128;

/** Every reason the reset refuses, in the order they are checked. */
export const OPS_RESET_REFUSALS = [
  "reason_missing",
  "password_too_short",
  "password_too_long",
  "password_has_control_characters",
  "password_is_address",
  "no_such_user",
  "not_superadmin",
  "unverified",
] as const;

export type OpsResetRefusal = (typeof OPS_RESET_REFUSALS)[number];

/**
 * What the job reports. NEVER the password, its hash, or a token: the CLI
 * prints this, and the dbtest pins that its serialisation contains neither.
 * On a dry run the counts are what WOULD be ended.
 */
export type OpsResetOutcome =
  | { readonly ok: false; readonly refusal: OpsResetRefusal }
  | {
      readonly ok: true;
      readonly dryRun: boolean;
      readonly userId: string;
      readonly email: string;
      /** `created` when the account had no credential row (Better Auth's `/reset-password` does the same). */
      readonly credential: "replaced" | "created";
      readonly sessionsEnded: number;
      readonly challengesCancelled: number;
      readonly resetLinksRevoked: number;
      readonly secondFactorEnrolled: boolean;
    };

/** Addresses are stored lowercase (Better Auth normalises at write) and matched exactly. */
export const normaliseOpsAddress = (raw: string): string => raw.trim().toLowerCase();

/**
 * A character no sign-in form can type: C0 controls (line breaks and tabs
 * included) and DEL. A browser's password input strips line breaks from its
 * value, so a password that contains one — two lines piped in where one was
 * meant — would be set and then match nothing anybody can enter.
 */
const isControl = (ch: string): boolean => {
  const code = ch.codePointAt(0) ?? 0;
  return code < 32 || code === 127;
};

/** The refusals that need no database: checked before anything connects or hashes. */
export function refuseOpsResetInput(input: {
  readonly email: string;
  readonly password: string;
  readonly reason: string;
}): OpsResetRefusal | null {
  if (input.reason.trim() === "") return "reason_missing";
  // `.length` in UTF-16 code units, exactly as Better Auth counts, so the
  // floor here is the floor `/account` will apply to the next change.
  if (input.password.length < MEMBER_MIN_PASSWORD_LENGTH) return "password_too_short";
  if (input.password.length > OPS_PASSWORD_MAX_LENGTH) return "password_too_long";
  if (Array.from(input.password).some(isControl)) return "password_has_control_characters";
  if (input.password.trim().toLowerCase() === normaliseOpsAddress(input.email)) return "password_is_address";
  return null;
}

/**
 * The refusals about the ACCOUNT, checked inside the writing transaction
 * against the row it has locked — a check made earlier would be a check of a
 * row that may since have changed.
 *
 *  - **`platformRole` must be exactly `"SUPERADMIN"`**, the console gate's own
 *    test (`./platform-gate`, `src/auth/platform-gate.ts`). Anything else is
 *    either a member — whose password is theirs to reset by mail, and which an
 *    operator must never be able to set silently — or an unknown role this
 *    script was not written for. Absent, null and `undefined` all refuse.
 *  - **The address must be confirmed**: the console signs nobody in whose
 *    address is not (`requireEmailVerification`), so a password set on such an
 *    account opens nothing, and the operator would believe it had.
 */
export function refuseOpsResetTarget(
  user: { readonly platformRole?: string | null; readonly emailVerified?: boolean | null } | null,
): OpsResetRefusal | null {
  if (!user) return "no_such_user";
  if (user.platformRole !== "SUPERADMIN") return "not_superadmin";
  if (user.emailVerified !== true) return "unverified";
  return null;
}

/** The whole matrix, input first — what the job applies, as one function the tests can drive. */
export function refuseOpsReset(
  input: { readonly email: string; readonly password: string; readonly reason: string },
  user: { readonly platformRole?: string | null; readonly emailVerified?: boolean | null } | null,
): OpsResetRefusal | null {
  return refuseOpsResetInput(input) ?? refuseOpsResetTarget(user);
}

/** What the operator reads for each refusal. Never echoes the password. */
export const OPS_RESET_REFUSAL_TEXT: Record<OpsResetRefusal, string> = {
  reason_missing:
    "--reason is blank. It goes into the audit trail: say why, in words a later reader will understand.",
  password_too_short: `the new password is shorter than ${MEMBER_MIN_PASSWORD_LENGTH} characters — the floor /account and the member reset apply.`,
  password_too_long: `the new password is longer than ${OPS_PASSWORD_MAX_LENGTH} characters, the most the product ever sets; /account could never change it later.`,
  password_has_control_characters:
    "the new password contains a line break, tab or other control character, which no sign-in form can type. If you piped it in, check that exactly one line went in.",
  password_is_address: "the new password is the account's own address.",
  no_such_user: "no account has that address (the match is exact, on the lowercase address).",
  not_superadmin:
    "that account is not a console principal (platform role SUPERADMIN). This script only resets the console password; a member resets their own at /reset-password on the app.",
  unverified:
    "that account's address is not confirmed, and the console signs nobody in until it is — a password set here would open nothing.",
};

/**
 * A new password piped in: the whole of stdin, less EXACTLY ONE trailing line
 * break (`\n` or `\r\n` — `echo`, a here-string, PowerShell's pipe) and a
 * leading byte-order mark (PowerShell can add one). Nothing else is trimmed:
 * spaces are legitimate characters, and a SECOND line break is left for
 * `password_has_control_characters` to refuse rather than silently dropped.
 */
export function passwordFromPipedStdin(raw: string): string {
  const text = raw.codePointAt(0) === 0xfeff ? raw.slice(1) : raw;
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}

export type KeystrokeState = {
  readonly value: string;
  readonly outcome: "typing" | "entered" | "aborted";
};

/**
 * One chunk of raw-mode terminal input applied to a hidden prompt's value —
 * the prompt's whole behaviour, so the prompt itself is only plumbing.
 *
 *  - Enter (CR or LF) finishes; anything after it in the same chunk (a paste
 *    that ended in a line break and carried on) is ignored.
 *  - Ctrl+C aborts; so does Ctrl+D on an empty line.
 *  - Backspace (BS on Windows, DEL elsewhere) removes one character — a whole
 *    code point, never half a surrogate pair. Ctrl+U clears the line.
 *  - An escape sequence (arrow keys, Home, function keys) arrives as one chunk
 *    beginning with ESC; none of it is the password, so all of it is dropped.
 *  - Any other control character is dropped: none can be typed at sign-in.
 */
export function applyKeystrokes(value: string, chunk: string): KeystrokeState {
  if (chunk.codePointAt(0) === 27) return { value, outcome: "typing" };
  let chars = Array.from(value);
  for (const ch of chunk) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 13 || code === 10) return { value: chars.join(""), outcome: "entered" };
    if (code === 3) return { value: "", outcome: "aborted" };
    if (code === 4) {
      if (chars.length === 0) return { value: "", outcome: "aborted" };
      continue;
    }
    if (code === 8 || code === 127) {
      chars.pop();
      continue;
    }
    if (code === 21) {
      chars = [];
      continue;
    }
    if (isControl(ch)) continue;
    chars.push(ch);
  }
  return { value: chars.join(""), outcome: "typing" };
}

/**
 * THE REFUSAL OF A PASSWORD ON THE COMMAND LINE, which fails closed and says
 * why: argv lands in shell history (bash, PowerShell's PSReadLine file) and in
 * every process listing — `ps`, Task Manager's command-line column — for as
 * long as the script runs, readable by any account on the machine.
 */
export const PASSWORD_ARGUMENT_REFUSED =
  "a password on the command line is refused: it lands in your shell history and in every process listing while this runs. " +
  "Let the script prompt for it, or pipe it on stdin. If you already typed a real one there, do not use it — choose another.";

/**
 * Anything that looks like a password flag, with or without `=value`. Checked
 * against EVERY argument, before `--help` and before any value is consumed, so
 * `--reason --password` and `--password=x --help` are refused as well.
 */
const PASSWORD_FLAG = /^-{1,2}(?:p|pw|pwd|pass|passwd|password|new-password|newpassword|secret)(?:=|$)/i;

export type OpsResetArgs =
  | { readonly kind: "help" }
  | { readonly kind: "run"; readonly email: string; readonly reason: string; readonly dryRun: boolean }
  | { readonly kind: "error"; readonly message: string };

/**
 * The command line: `--email <addr> --reason "<why>" [--dry-run]`, `--help`.
 * Unknown arguments FAIL rather than being ignored, and are never echoed: the
 * one most likely to be unknown is a password somebody typed as a positional.
 */
export function parseResetOpsArgs(argv: readonly string[]): OpsResetArgs {
  if (argv.some((arg) => PASSWORD_FLAG.test(arg))) {
    return { kind: "error", message: PASSWORD_ARGUMENT_REFUSED };
  }
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) return { kind: "help" };

  let email: string | undefined;
  let reason: string | undefined;
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    if (name === "--email" || name === "--reason") {
      const value = inline ?? argv[i + 1];
      if (inline === undefined) i += 1;
      if (value === undefined || (inline === undefined && value.startsWith("--"))) {
        return { kind: "error", message: `${name} needs a value.` };
      }
      if ((name === "--email" ? email : reason) !== undefined) {
        return { kind: "error", message: `${name} is given twice.` };
      }
      if (name === "--email") email = value;
      else reason = value;
      continue;
    }
    if (name === "--dry-run" && inline === undefined) {
      dryRun = true;
      continue;
    }
    return {
      kind: "error",
      message:
        `argument ${i + 1} is not one this script takes (--email, --reason, --dry-run, --help). ` +
        "If it was a password, it is now in your shell history — do not use it.",
    };
  }
  if (email === undefined || !email.includes("@")) {
    return { kind: "error", message: "--email is required, and must be the console account's address." };
  }
  if (reason === undefined || reason.trim() === "") {
    return { kind: "error", message: "--reason is required: it is written to the audit trail." };
  }
  return { kind: "run", email, reason, dryRun };
}

/**
 * The report the CLI prints — built from the outcome, which carries no secret,
 * so nothing this returns can either. The unenrolled warning is the line that
 * matters most: until a factor is verified, the console opens with the
 * password alone (SECURITY.md §3.5, the bounded window).
 */
export function formatOpsResetOutcome(outcome: OpsResetOutcome): string[] {
  if (!outcome.ok) return [`refused: ${OPS_RESET_REFUSAL_TEXT[outcome.refusal]}`];
  const created = outcome.credential === "created";
  const lines = outcome.dryRun
    ? [
        `DRY RUN — nothing was changed. Resetting the console password of ${outcome.email} would:`,
        `  end sessions (console and app):   ${outcome.sessionsEnded}`,
        `  cancel sign-ins awaiting a code:  ${outcome.challengesCancelled}`,
        `  revoke reset links:               ${outcome.resetLinksRevoked}`,
        `  credential:                       ${created ? "create one (there is none)" : "replace it"}`,
      ]
    : [
        `The console password of ${outcome.email} is reset.`,
        `  sessions ended (console and app): ${outcome.sessionsEnded}`,
        `  sign-ins awaiting a code, ended:  ${outcome.challengesCancelled}`,
        `  reset links revoked:              ${outcome.resetLinksRevoked}`,
        `  credential:                       ${created ? "created (there was none)" : "replaced"}`,
      ];
  if (outcome.secondFactorEnrolled) {
    lines.push("  second factor: enrolled, and untouched — the console will ask for a code as before.");
  } else {
    lines.push(
      "  second factor: NOT ENROLLED. Until one is, the password alone opens the console.",
      outcome.dryRun
        ? "  After the real reset, sign in at /ops/login at once and enrol an authenticator there."
        : "  Sign in at /ops/login NOW and enrol an authenticator on the page it shows you.",
    );
  }
  lines.push("This is also the password for /login on the app: one credential serves both planes.");
  return lines;
}

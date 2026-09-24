import { readFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { MEMBER_MIN_PASSWORD_LENGTH } from "@/auth/recovery-policy";

import {
  OPS_PASSWORD_MAX_LENGTH,
  OPS_RESET_REFUSALS,
  OPS_RESET_REFUSAL_TEXT,
  PASSWORD_ARGUMENT_REFUSED,
  applyKeystrokes,
  formatOpsResetOutcome,
  normaliseOpsAddress,
  parseResetOpsArgs,
  passwordFromPipedStdin,
  refuseOpsReset,
  refuseOpsResetInput,
  refuseOpsResetTarget,
  type OpsResetOutcome,
} from "./reset-ops-password-policy";

/**
 * The operator's console-password reset (C30e), with nothing running: the
 * refusal matrix, how a password is read off stdin and a terminal, the command
 * line that must never carry one, the report — and a source scan of the script
 * and the job, because the properties that matter most there ("the password
 * never reaches the terminal", "the factor is never touched") are properties
 * of the code's shape. What the job does to real rows is
 * `reset-ops-password.dbtest.ts`.
 */

const ok = "correct horse battery"; // 21 characters, no control characters
const input = (over: Partial<{ email: string; password: string; reason: string }> = {}) => ({
  email: "ops@example.test",
  password: ok,
  reason: "forgot it",
  ...over,
});
const superadmin = { platformRole: "SUPERADMIN", emailVerified: true };

describe("the refusal matrix", () => {
  it("passes a well-formed request for a confirmed SUPERADMIN", () => {
    expect(refuseOpsReset(input(), superadmin)).toBeNull();
  });

  it("refuses a blank or whitespace reason", () => {
    expect(refuseOpsResetInput(input({ reason: "" }))).toBe("reason_missing");
    expect(refuseOpsResetInput(input({ reason: "  \t " }))).toBe("reason_missing");
  });

  it("holds the member plane's floor and Better Auth's ceiling, counted as the library counts", () => {
    expect(MEMBER_MIN_PASSWORD_LENGTH).toBe(12);
    expect(refuseOpsResetInput(input({ password: "a".repeat(MEMBER_MIN_PASSWORD_LENGTH - 1) }))).toBe(
      "password_too_short",
    );
    expect(refuseOpsResetInput(input({ password: "a".repeat(MEMBER_MIN_PASSWORD_LENGTH) }))).toBeNull();
    expect(refuseOpsResetInput(input({ password: "a".repeat(OPS_PASSWORD_MAX_LENGTH) }))).toBeNull();
    expect(refuseOpsResetInput(input({ password: "a".repeat(OPS_PASSWORD_MAX_LENGTH + 1) }))).toBe(
      "password_too_long",
    );
    expect(refuseOpsResetInput(input({ password: "" }))).toBe("password_too_short");
  });

  it("refuses a password no sign-in form can type", () => {
    const withBreak = `first line ok${String.fromCharCode(10)}second`;
    const withTab = `tabbed${String.fromCharCode(9)}password1`;
    const withDel = `deleted${String.fromCharCode(127)}password`;
    const withNul = `nul${String.fromCharCode(0)}password-long`;
    for (const password of [withBreak, withTab, withDel, withNul]) {
      expect(refuseOpsResetInput(input({ password }))).toBe("password_has_control_characters");
    }
    // Spaces and non-ASCII are ordinary characters.
    expect(refuseOpsResetInput(input({ password: "  spaced out  " }))).toBeNull();
    expect(refuseOpsResetInput(input({ password: "räksmörgås åäö" }))).toBeNull();
  });

  it("refuses the account's own address as its password, in any case or padding", () => {
    const email = "operator-long@example.test";
    expect(refuseOpsResetInput(input({ email, password: email }))).toBe("password_is_address");
    expect(refuseOpsResetInput(input({ email, password: " OPERATOR-LONG@example.TEST " }))).toBe(
      "password_is_address",
    );
    expect(refuseOpsResetInput(input({ email: " Operator-Long@Example.test", password: email }))).toBe(
      "password_is_address",
    );
  });

  it("refuses anybody the console would not admit as a SUPERADMIN — and fails closed on absent fields", () => {
    expect(refuseOpsResetTarget(null)).toBe("no_such_user");
    expect(refuseOpsResetTarget({ platformRole: null, emailVerified: true })).toBe("not_superadmin");
    expect(refuseOpsResetTarget({ emailVerified: true })).toBe("not_superadmin");
    expect(refuseOpsResetTarget({ platformRole: "", emailVerified: true })).toBe("not_superadmin");
    expect(refuseOpsResetTarget({ platformRole: "superadmin", emailVerified: true })).toBe("not_superadmin");
    expect(refuseOpsResetTarget({ platformRole: "SUPERADMIN ", emailVerified: true })).toBe("not_superadmin");
    expect(refuseOpsResetTarget({ platformRole: "SUPPORT", emailVerified: true })).toBe("not_superadmin");
    expect(refuseOpsResetTarget({ platformRole: "SUPERADMIN", emailVerified: false })).toBe("unverified");
    expect(refuseOpsResetTarget({ platformRole: "SUPERADMIN", emailVerified: null })).toBe("unverified");
    expect(refuseOpsResetTarget({ platformRole: "SUPERADMIN" })).toBe("unverified");
    expect(refuseOpsResetTarget(superadmin)).toBeNull();
  });

  it("decides the input before the account, so a bad password is refused whoever it was for", () => {
    expect(refuseOpsReset(input({ password: "short" }), null)).toBe("password_too_short");
    expect(refuseOpsReset(input(), null)).toBe("no_such_user");
  });

  it("normalises the address as Better Auth stores it", () => {
    expect(normaliseOpsAddress("  Ops@Example.TEST ")).toBe("ops@example.test");
  });

  it("has operator-facing text for every refusal", () => {
    expect(Object.keys(OPS_RESET_REFUSAL_TEXT).sort()).toEqual([...OPS_RESET_REFUSALS].sort());
    for (const refusal of OPS_RESET_REFUSALS) expect(OPS_RESET_REFUSAL_TEXT[refusal].length).toBeGreaterThan(10);
  });
});

describe("a password piped on stdin", () => {
  const CR = String.fromCharCode(13);
  const LF = String.fromCharCode(10);
  const BOM = String.fromCharCode(0xfeff);

  it("strips exactly one trailing LF or CRLF, and nothing else", () => {
    expect(passwordFromPipedStdin(`${ok}${LF}`)).toBe(ok);
    expect(passwordFromPipedStdin(`${ok}${CR}${LF}`)).toBe(ok);
    expect(passwordFromPipedStdin(ok)).toBe(ok);
    expect(passwordFromPipedStdin(` ${ok} ${LF}`)).toBe(` ${ok} `);
    // A second break stays, for the control-character refusal to catch.
    expect(passwordFromPipedStdin(`${ok}${LF}${LF}`)).toBe(`${ok}${LF}`);
    expect(passwordFromPipedStdin(`${ok}${CR}${LF}${CR}${LF}`)).toBe(`${ok}${CR}${LF}`);
    // A lone CR is not a line ending here, and is refused downstream.
    expect(passwordFromPipedStdin(`${ok}${CR}`)).toBe(`${ok}${CR}`);
  });

  it("drops a leading byte-order mark", () => {
    expect(passwordFromPipedStdin(`${BOM}${ok}${CR}${LF}`)).toBe(ok);
  });

  it("feeds a two-line paste into a refusal rather than a password nobody can type", () => {
    const piped = passwordFromPipedStdin(`${ok}${LF}${ok}${LF}`);
    expect(refuseOpsResetInput(input({ password: piped }))).toBe("password_has_control_characters");
  });
});

describe("the hidden terminal prompt", () => {
  const key = (code: number) => String.fromCharCode(code);

  it("accumulates typing and finishes on Enter, CR or LF", () => {
    let state = applyKeystrokes("", "abc");
    expect(state).toEqual({ value: "abc", outcome: "typing" });
    state = applyKeystrokes(state.value, "def");
    expect(applyKeystrokes(state.value, key(13))).toEqual({ value: "abcdef", outcome: "entered" });
    expect(applyKeystrokes("xyz", key(10))).toEqual({ value: "xyz", outcome: "entered" });
  });

  it("ignores whatever follows Enter in the same chunk (a paste)", () => {
    expect(applyKeystrokes("", `pasted${key(13)}${key(10)}tail`)).toEqual({ value: "pasted", outcome: "entered" });
  });

  it("erases one whole character on Backspace (BS or DEL), never half a surrogate pair", () => {
    expect(applyKeystrokes("abc", key(8)).value).toBe("ab");
    expect(applyKeystrokes("abc", key(127)).value).toBe("ab");
    expect(applyKeystrokes(`a${String.fromCodePoint(0x1f511)}`, key(127)).value).toBe("a");
    expect(applyKeystrokes("", key(127)).value).toBe("");
  });

  it("clears the line on Ctrl+U", () => {
    expect(applyKeystrokes("abc", `${key(21)}z`).value).toBe("z");
  });

  it("aborts on Ctrl+C, and on Ctrl+D only when the line is empty", () => {
    expect(applyKeystrokes("secret-so-far", key(3))).toEqual({ value: "", outcome: "aborted" });
    expect(applyKeystrokes("", key(4))).toEqual({ value: "", outcome: "aborted" });
    expect(applyKeystrokes("abc", key(4))).toEqual({ value: "abc", outcome: "typing" });
  });

  it("drops an escape sequence whole, and every other control character", () => {
    expect(applyKeystrokes("abc", `${key(27)}[A`)).toEqual({ value: "abc", outcome: "typing" });
    expect(applyKeystrokes("abc", `${key(27)}[1;5D`)).toEqual({ value: "abc", outcome: "typing" });
    expect(applyKeystrokes("a", `${key(9)}b${key(0)}c${key(1)}`)).toEqual({ value: "abc", outcome: "typing" });
  });
});

describe("the command line", () => {
  it("prints help for no arguments, --help and -h", () => {
    expect(parseResetOpsArgs([])).toEqual({ kind: "help" });
    expect(parseResetOpsArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseResetOpsArgs(["--email", "a@b.test", "-h"])).toEqual({ kind: "help" });
  });

  it("REFUSES a password argument in every spelling, before --help and wherever it sits", () => {
    for (const argv of [
      ["--password", "hunter2hunter2"],
      ["--password=hunter2hunter2"],
      ["--email", "a@b.test", "--reason", "x", "--PASSWORD", "y"],
      ["--pass", "y"],
      ["--pw=y"],
      ["-p", "y"],
      ["--new-password", "y"],
      ["--secret=y"],
      ["--password=y", "--help"],
      ["--reason", "--password"],
    ]) {
      expect(parseResetOpsArgs(argv)).toEqual({ kind: "error", message: PASSWORD_ARGUMENT_REFUSED });
    }
    expect(PASSWORD_ARGUMENT_REFUSED).toMatch(/shell history/);
    expect(PASSWORD_ARGUMENT_REFUSED).toMatch(/process listing/);
  });

  it("refuses an unknown argument without echoing it", () => {
    const result = parseResetOpsArgs(["--email", "a@b.test", "--reason", "x", "Tr0ub4dor&3-long"]);
    expect(result.kind).toBe("error");
    expect(JSON.stringify(result)).not.toContain("Tr0ub4dor");
    expect(parseResetOpsArgs(["--email", "a@b.test", "--reason", "x", "--dry-run=yes"]).kind).toBe("error");
  });

  it("parses both spellings of a value and the dry-run switch", () => {
    expect(parseResetOpsArgs(["--email", "Ops@Example.test", "--reason", "forgot it"])).toEqual({
      kind: "run",
      email: "Ops@Example.test",
      reason: "forgot it",
      dryRun: false,
    });
    expect(parseResetOpsArgs(["--dry-run", "--email=ops@example.test", "--reason=a=b"])).toEqual({
      kind: "run",
      email: "ops@example.test",
      reason: "a=b",
      dryRun: true,
    });
  });

  it("requires an address and a non-blank reason, once each", () => {
    expect(parseResetOpsArgs(["--reason", "x"]).kind).toBe("error");
    expect(parseResetOpsArgs(["--email", "not-an-address", "--reason", "x"]).kind).toBe("error");
    expect(parseResetOpsArgs(["--email", "a@b.test"]).kind).toBe("error");
    expect(parseResetOpsArgs(["--email", "a@b.test", "--reason", "   "]).kind).toBe("error");
    expect(parseResetOpsArgs(["--email", "a@b.test", "--reason"]).kind).toBe("error");
    expect(parseResetOpsArgs(["--email", "--reason", "x"]).kind).toBe("error");
    expect(parseResetOpsArgs(["--email", "a@b.test", "--email", "c@d.test", "--reason", "x"]).kind).toBe("error");
  });
});

describe("the report", () => {
  const done: OpsResetOutcome = {
    ok: true,
    dryRun: false,
    userId: "u1",
    email: "ops@example.test",
    credential: "replaced",
    sessionsEnded: 2,
    challengesCancelled: 1,
    resetLinksRevoked: 0,
    secondFactorEnrolled: true,
  };

  it("says what ended, and that the password is also the app's", () => {
    const text = formatOpsResetOutcome(done).join("\n");
    expect(text).toContain("ops@example.test");
    expect(text).toMatch(/sessions ended \(console and app\):\s+2/);
    expect(text).toMatch(/sign-ins awaiting a code, ended:\s+1/);
    expect(text).toMatch(/reset links revoked:\s+0/);
    expect(text).toContain("/login");
    expect(text).not.toMatch(/NOT ENROLLED/);
  });

  it("tells the operator to enrol at once when there is no second factor", () => {
    const text = formatOpsResetOutcome({ ...done, secondFactorEnrolled: false }).join("\n");
    expect(text).toMatch(/NOT ENROLLED/);
    expect(text).toContain("/ops/login");
  });

  it("marks a dry run as having changed nothing", () => {
    const text = formatOpsResetOutcome({ ...done, dryRun: true, credential: "created" }).join("\n");
    expect(text).toMatch(/DRY RUN — nothing was changed/);
    expect(text).toMatch(/create one/);
  });

  it("explains a refusal", () => {
    expect(formatOpsResetOutcome({ ok: false, refusal: "not_superadmin" })).toEqual([
      `refused: ${OPS_RESET_REFUSAL_TEXT.not_superadmin}`,
    ]);
  });
});

// ── Source scans ────────────────────────────────────────────────────────────

const parse = (rel: string): ts.SourceFile =>
  ts.createSourceFile(rel, readFileSync(join(process.cwd(), rel), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

const nodesOf = (root: ts.Node): ts.Node[] => {
  const out: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    out.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return out;
};

const identifiersIn = (node: ts.Node): string[] =>
  nodesOf(node)
    .filter(ts.isIdentifier)
    .map((id) => id.text);

const calleeName = (call: ts.CallExpression): string => call.expression.getText();

describe("scripts/reset-ops-password.ts — the shape that keeps the password off the terminal", () => {
  const source = parse("scripts/reset-ops-password.ts");
  const nodes = nodesOf(source);
  const calls = nodes.filter(ts.isCallExpression);

  it("reads argv once, and only through the parser that refuses a password", () => {
    const argvReads = nodes.filter(
      (n) => ts.isPropertyAccessExpression(n) && n.expression.getText() === "process" && n.name.text === "argv",
    );
    expect(argvReads).toHaveLength(1);
    let up: ts.Node = argvReads[0]!;
    while (!(ts.isCallExpression(up) && calleeName(up) === "parseResetOpsArgs")) {
      expect(up.parent, "process.argv must be consumed by parseResetOpsArgs").toBeDefined();
      up = up.parent;
    }
    expect(up.getText()).toBe("parseResetOpsArgs(process.argv.slice(2))");
  });

  it("calls the job, imported dynamically after the environment is loaded", () => {
    const dynamic = calls.filter(
      (c) =>
        c.expression.kind === ts.SyntaxKind.ImportKeyword &&
        c.arguments[0] !== undefined &&
        ts.isStringLiteral(c.arguments[0]) &&
        c.arguments[0].text === "../src/jobs/reset-ops-password",
    );
    expect(dynamic).toHaveLength(1);
    const staticSpecifiers = source.statements
      .filter(ts.isImportDeclaration)
      .map((d) => (d.moduleSpecifier as ts.StringLiteral).text);
    expect(staticSpecifiers.filter((s) => /src\/db|reset-ops-password$/.test(s))).toEqual([]);
    expect(calls.filter((c) => calleeName(c) === "resetOpsPassword")).toHaveLength(1);
  });

  it("uses the password binding only to test it for null and to hand it to the job", () => {
    const refs = nodes.filter((n): n is ts.Identifier => ts.isIdentifier(n) && n.text === "newPassword");
    const kinds = refs.map((ref) => {
      const parent = ref.parent;
      if (ts.isVariableDeclaration(parent) && parent.name === ref) {
        return parent.initializer?.getText() === "await readNewPassword()" ? "declared" : "declared-elsewhere";
      }
      if (
        ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
        (parent.left.kind === ts.SyntaxKind.NullKeyword || parent.right.kind === ts.SyntaxKind.NullKeyword)
      ) {
        return "null-check";
      }
      if (
        ts.isPropertyAssignment(parent) &&
        parent.initializer === ref &&
        parent.name.getText() === "password" &&
        ts.isObjectLiteralExpression(parent.parent) &&
        ts.isCallExpression(parent.parent.parent) &&
        calleeName(parent.parent.parent) === "resetOpsPassword"
      ) {
        return "handed-to-job";
      }
      return `other: ${parent.getText()}`;
    });
    expect(kinds.sort()).toEqual(["declared", "handed-to-job", "null-check"]);
  });

  it("never passes anything password-shaped to console.* or a stream write", () => {
    const outputs = calls.filter((c) => {
      if (!ts.isPropertyAccessExpression(c.expression)) return false;
      return c.expression.expression.getText() === "console" || c.expression.name.text === "write";
    });
    expect(outputs.length).toBeGreaterThan(5);
    for (const call of outputs) {
      const suspicious = call.arguments.flatMap(identifiersIn).filter((id) => /password|entry|typed|hash|secret/i.test(id));
      expect(suspicious, call.getText()).toEqual([]);
    }
  });
});

describe("src/jobs/reset-ops-password.ts — what the job may touch", () => {
  const source = parse("src/jobs/reset-ops-password.ts");
  const nodes = nodesOf(source);

  it("goes through the seam, never the raw client", () => {
    const specifiers = source.statements
      .filter(ts.isImportDeclaration)
      .map((d) => (d.moduleSpecifier as ts.StringLiteral).text);
    expect(specifiers).toContain("@/db");
    expect(specifiers.some((s) => /db\/client/.test(s))).toBe(false);
  });

  it("never touches the second factor or a trusted device", () => {
    const accesses = nodes.filter(ts.isPropertyAccessExpression).map((n) => n.getText());
    expect(accesses.filter((a) => /^tx\.(twoFactor|user)\.(update|updateMany|upsert|delete|deleteMany|create)$/.test(a))).toEqual(
      [],
    );
    expect(accesses.some((a) => a.startsWith("tx.twoFactor"))).toBe(false);
    const strings = nodes.filter(ts.isStringLiteral).map((s) => s.text);
    expect(strings.some((s) => s.startsWith("trust-device"))).toBe(false);
  });

  it("audits counts and a channel — never an address or a secret", () => {
    const metadata = nodes.filter(
      (n): n is ts.PropertyAssignment => ts.isPropertyAssignment(n) && n.name.getText() === "metadata",
    );
    expect(metadata).toHaveLength(1);
    const literal = metadata[0]!.initializer;
    expect(ts.isObjectLiteralExpression(literal)).toBe(true);
    const keys = (literal as ts.ObjectLiteralExpression).properties.map((p) => p.name?.getText());
    expect(keys.sort()).toEqual(["challengesCancelled", "resetLinksRevoked", "sessionsEnded", "via"]);
  });

  it("returns no object that carries a password or a hash", () => {
    const outcomes = nodes.filter(
      (n): n is ts.ObjectLiteralExpression =>
        ts.isObjectLiteralExpression(n) && n.properties.some((p) => p.name?.getText() === "ok"),
    );
    expect(outcomes.length).toBeGreaterThanOrEqual(3);
    for (const outcome of outcomes) {
      expect(outcome.properties.map((p) => p.name?.getText() ?? "").filter((k) => /password|hash/i.test(k))).toEqual([]);
    }
  });
});

describe("scripts/create-test-member.ts — never a console principal's password", () => {
  it("refuses a platform role before anything writes", () => {
    const text = readFileSync(join(process.cwd(), "scripts/create-test-member.ts"), "utf8");
    const guard = text.indexOf("user?.platformRole && givenPassword");
    expect(guard).toBeGreaterThan(-1);
    for (const write of ["platform.user.create(", "platform.account.create(", "platform.account.update(", "platform.session.deleteMany("]) {
      const at = text.indexOf(write);
      expect(at, write).toBeGreaterThan(guard);
    }
    expect(text).toContain("scripts/reset-ops-password.ts");
  });
});

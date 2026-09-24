import { readFileSync } from "node:fs";
import { join } from "node:path";

import { APIError } from "better-auth/api";
import { describe, expect, it } from "vitest";

import {
  answerSignUpAlike,
  MAX_NAME_LENGTH,
  refuseUnsafeSignUp,
  SIGN_UP_ANSWER,
  SIGN_UP_REFUSED,
  signUpBodyProblem,
} from "./sign-up-answer";

/**
 * The pure halves of the sign-up answer. `plane-endpoints.dbtest.ts` drives
 * the real handler with a new and a registered address side by side; this
 * pins what the two functions decide, including every input the two review
 * rounds showed would have reached a throwing step on one branch only.
 */

const page = { name: "Robin Member", email: "robin@test.invalid", password: "a-long-password-58", callbackURL: "/" };

describe("which sign-up bodies are refused before the library branches", () => {
  it("passes what the sign-up page sends, and rememberMe", () => {
    expect(signUpBodyProblem(page)).toBe(false);
    expect(signUpBodyProblem({ ...page, rememberMe: true })).toBe(false);
    expect(signUpBodyProblem({ ...page, name: "Åsa Öberg-Ängström 李 😀" })).toBe(false);
    expect(signUpBodyProblem({ ...page, name: "x".repeat(MAX_NAME_LENGTH) })).toBe(false);
    expect(signUpBodyProblem({ ...page, callbackURL: "/invite/abc?x=1" })).toBe(false);
  });

  it.each([
    ["a NUL in the name — Postgres text cannot hold it", { ...page, name: "Robin\u0000" }],
    ["another control character", { ...page, name: "Robin\tMember" }],
    ["DEL", { ...page, name: "Robin\u007f" }],
    ["a name past the bound", { ...page, name: "x".repeat(MAX_NAME_LENGTH + 1) }],
    ["a lone surrogate in callbackURL — encodeURIComponent throws on it", { ...page, callbackURL: "https://example.test/\ud800" }],
    ["a lone low surrogate in callbackURL", { ...page, callbackURL: "/\udc00" }],
    ["a lone surrogate in the name", { ...page, name: "Robin\ud800" }],
    ["a lone surrogate in the email", { ...page, email: "robin\ud800@test.invalid" }],
    ["a lone surrogate in the password", { ...page, password: "a-long-password\ud800" }],
    ["an image, which reaches the INSERT untyped", { ...page, image: "x" }],
    ["a locale, which reaches the INSERT untyped", { ...page, locale: 1 }],
    ["any other field", { ...page, platformRole: "SUPERADMIN" }],
  ])("refuses %s", (_label, body) => {
    expect(signUpBodyProblem(body)).toBe(true);
    expect(() => refuseUnsafeSignUp({ path: "/sign-up/email", body })).toThrow(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it("leaves a non-object body, and a non-string name, to the library's schema, which refuses both branches alike", () => {
    expect(signUpBodyProblem(undefined)).toBe(false);
    expect(signUpBodyProblem("text")).toBe(false);
    expect(signUpBodyProblem({ ...page, name: 42 })).toBe(false);
  });

  it("looks only at sign-up", () => {
    expect(() => refuseUnsafeSignUp({ path: "/sign-in/email", body: { ...page, image: "x" } })).not.toThrow();
  });

  it("carries the code the sign-up page turns into its own words", () => {
    try {
      refuseUnsafeSignUp({ path: "/sign-up/email", body: { ...page, image: "x" } });
      expect.unreachable();
    } catch (error) {
      expect((error as APIError).body?.code).toBe(SIGN_UP_REFUSED);
    }
    // The page cannot import this module (it would pull better-auth's server
    // API into the client bundle), so it spells the code out; this is what
    // keeps the two from drifting.
    const source = readFileSync(join(process.cwd(), "src", "app", "(tenant)", "signup", "page.tsx"), "utf8");
    expect(source).toContain(`err.code === "${SIGN_UP_REFUSED}"`);
  });
});

describe("what every sign-up answers", () => {
  const ctx = (path: string, returned: unknown) => ({
    path,
    context: { returned },
    json: (body: { token: null; user: null }) => ({ replaced: body }),
  });

  it("replaces a successful sign-up — whoever it was for — with one constant", () => {
    expect(answerSignUpAlike(ctx("/sign-up/email", { token: null, user: { id: "real" } }))).toEqual({
      replaced: { token: null, user: null },
    });
    expect(answerSignUpAlike(ctx("/sign-up/email", { token: null, user: { id: "stand-in" } }))).toEqual({
      replaced: { token: null, user: null },
    });
  });

  it("hands out a fresh copy, so a caller that edits one cannot change the next", () => {
    const first = answerSignUpAlike(ctx("/sign-up/email", {}))!.replaced as { user: unknown };
    first.user = { id: "tampered" };
    expect(answerSignUpAlike(ctx("/sign-up/email", {}))!.replaced).toEqual({ token: null, user: null });
    expect(Object.isFrozen(SIGN_UP_ANSWER)).toBe(true);
  });

  it("leaves a refusal alone, and every other endpoint", () => {
    expect(answerSignUpAlike(ctx("/sign-up/email", new APIError("BAD_REQUEST")))).toBeUndefined();
    expect(answerSignUpAlike(ctx("/sign-in/email", { token: "t", user: { id: "u" } }))).toBeUndefined();
  });
});

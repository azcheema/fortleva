import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CLOSED_ENDPOINTS,
  isClosedEndpoint,
  isSignUpLink,
  refuseChangeEmailLink,
  refuseClosedEndpoint,
} from "./closed-endpoints";

/**
 * The list is the control, so both of its halves are pinned: what it
 * closes, and — the half a careless edit breaks the product with — what it
 * must leave open. The dbtests (`plane-endpoints.dbtest.ts`) prove the list
 * is WIRED into both instances; this proves it says what it should.
 */

describe("what the member plane does not serve", () => {
  it.each([
    "/request-password-reset",
    "/reset-password",
    "/reset-password/:token",
    "/send-verification-email",
    "/change-email",
  ])("%s", (path) => {
    expect(isClosedEndpoint("member", path)).toBe(true);
  });

  it.each([
    "/sign-in/email",
    "/sign-up/email",
    "/verify-email", // sign-up's link lands here
    "/sign-out",
    "/get-session",
    "/change-password",
    "/two-factor/enable",
    "/two-factor/verify-totp",
    "/two-factor/verify-backup-code",
    "/two-factor/generate-backup-codes",
  ])("still serves %s", (path) => {
    expect(isClosedEndpoint("member", path)).toBe(false);
  });
});

describe("what the platform plane does not serve", () => {
  it.each([
    "/request-password-reset",
    "/reset-password",
    "/reset-password/:token",
    "/send-verification-email",
    "/verify-email",
  ])("%s", (path) => {
    expect(isClosedEndpoint("platform", path)).toBe(true);
  });

  it.each([
    "/sign-in/email",
    "/sign-out",
    "/get-session",
    "/two-factor/enable",
    "/two-factor/verify-totp",
    "/two-factor/verify-backup-code",
  ])("still serves %s", (path) => {
    expect(isClosedEndpoint("platform", path)).toBe(false);
  });
});

describe("the refusal", () => {
  it("is a 404 for a closed endpoint, and nothing at all for an open one", () => {
    expect(() => refuseClosedEndpoint({ path: "/request-password-reset" }, "platform")).toThrow(
      expect.objectContaining({ statusCode: 404 }),
    );
    expect(() => refuseClosedEndpoint({ path: "/sign-in/email" }, "platform")).not.toThrow();
  });

  it("is keyed on the ENDPOINT's declared path — the token-bearing route by its pattern", () => {
    // `ctx.path` is `endpoint.path` (better-auth's dispatch), so a concrete
    // token never reaches this function; the pattern does.
    expect(CLOSED_ENDPOINTS.member.has("/reset-password/:token")).toBe(true);
    expect(isClosedEndpoint("member", "/reset-password/abc123")).toBe(false);
  });
});

/** A JWT-shaped string whose payload is these exact bytes; the signature is irrelevant to a decode. */
const jwtOf = (payload: Buffer | string): string =>
  [
    Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url"),
    Buffer.from(payload).toString("base64url"),
    "signature",
  ].join(".");
const jwt = (claims: unknown): string => jwtOf(JSON.stringify(claims));

describe("the member plane's /verify-email lets through only a sign-up link", () => {
  const now = Math.floor(Date.now() / 1000);
  const refused = (token: unknown) => () => refuseChangeEmailLink({ path: "/verify-email", query: { token } });

  it("lets sign-up's link through — {email, iat, exp} and nothing else", () => {
    const link = jwt({ email: "a@test.invalid", iat: now, exp: now + 3600 });
    expect(isSignUpLink(link)).toBe(true);
    expect(refused(link)).not.toThrow();
  });

  it.each([
    ["a change-email-verification link", { email: "a@test.invalid", updateTo: "b@test.invalid", requestType: "change-email-verification" }],
    ["a change-email-confirmation link", { email: "a@test.invalid", updateTo: "b@test.invalid", requestType: "change-email-confirmation" }],
    ["the legacy change-email shape (updateTo alone)", { email: "a@test.invalid", updateTo: "b@test.invalid" }],
    ["a requestType alone", { email: "a@test.invalid", requestType: "anything" }],
    ["an updateTo that is not even a string", { email: "a@test.invalid", updateTo: 1 }],
    ["claims that are an array", ["updateTo"]],
    ["claims that are null", null],
  ])("refuses %s with a 404", (_label, claims) => {
    expect(isSignUpLink(jwt(claims))).toBe(false);
    expect(refused(jwt(claims))).toThrow(expect.objectContaining({ statusCode: 404 }));
  });

  it("FAILS CLOSED: refuses what it cannot read — a byte-order mark first of all, which jose would read", () => {
    // The fix review's bypass: Node's decode keeps U+FEFF and JSON.parse throws
    // on it, while jose's TextDecoder strips it and reads the claims. The first
    // version let every unreadable token through to the library.
    const bom = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(JSON.stringify({ email: "a@test.invalid", updateTo: "b@test.invalid" })),
    ]);
    for (const token of [jwtOf(bom), "not-a-jwt", "a.%%%.c", "a.bm90IGpzb24.c", "a..c", "a.b", "a.b.c.d"]) {
      expect(isSignUpLink(token)).toBe(false);
      expect(refused(token)).toThrow(expect.objectContaining({ statusCode: 404 }));
    }
  });

  it("leaves a request with no token to the library, which refuses it anyway", () => {
    for (const token of [undefined, "", 42, ["a", "b"]]) expect(refused(token)).not.toThrow();
  });

  it("looks only at /verify-email", () => {
    const token = jwt({ email: "a@test.invalid", updateTo: "b@test.invalid" });
    expect(() => refuseChangeEmailLink({ path: "/sign-in/email", query: { token } })).not.toThrow();
  });
});


describe("both instances consult it, first", () => {
  /**
   * A source check, like `audit-hook-guard.test.ts`, because importing the
   * instances reaches the database. The dbtests drive the real handlers;
   * this is the cheap tripwire that fails in the unit job, before anything
   * is migrated, if either instance stops calling the refusal or calls it
   * after work that a closed endpoint should never cost.
   */
  it.each([
    ["member", "index.ts"],
    ["platform", "platform.ts"],
  ])("the %s instance refuses before its limiter", (plane, file) => {
    const source = readFileSync(join(process.cwd(), "src", "auth", file), "utf8");
    // The member instance also refuses change-email links in the same
    // breath; the platform instance closes /verify-email outright.
    const hook =
      /before:\s*createAuthMiddleware\(async \(ctx\) => \{\s*refuseClosedEndpoint\(ctx, "(\w+)"\);\s*(?:refuseChangeEmailLink\(ctx\);\s*)?await enforceAuthRateLimit\(ctx, "(\w+)"\);/.exec(
        source,
      );
    expect(hook?.[1]).toBe(plane);
    expect(hook?.[2]).toBe(plane);
  });

  it("the member instance refuses change-email links, checks sign-up input before the library branches, and answers every sign-up alike", () => {
    const source = readFileSync(join(process.cwd(), "src", "auth", "index.ts"), "utf8");
    expect(source).toMatch(/refuseClosedEndpoint\(ctx, "member"\);\s*refuseChangeEmailLink\(ctx\);/);
    expect(source).toMatch(/await enforceAuthRateLimit\(ctx, "member"\);\s*refuseUnsafeSignUp\(ctx\);/);
    expect(source).toMatch(/after:\s*createAuthMiddleware\(async \(ctx\) => answerSignUpAlike\(ctx\)\)/);
  });

  it("neither instance configures a reset mail any more", () => {
    for (const file of ["index.ts", "platform.ts"]) {
      const source = readFileSync(join(process.cwd(), "src", "auth", file), "utf8");
      expect(source).not.toMatch(/\bsendResetPassword\s*:/);
      expect(source).not.toMatch(/\bchangeEmail\s*:/);
    }
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * THE CONFIRMATION ACTION'S LIMITER, pinned (C30's fix review).
 *
 * `confirmEmailAction` is a public, cookie-less password check — the member
 * plane's only way to confirm an address — and the per-network floor in front
 * of it is the only bound on guessing there: `/login`'s own limiter fails open
 * until Upstash exists, while `allowStrict` keeps an in-process floor either
 * way. Nothing else would notice that line going, or moving below the check:
 * the dbtests call `confirmMemberEmail` directly, and the e2e presses the
 * button twice. A source check, like `closed-endpoints.test.ts`'s, because the
 * action module reaches the auth instance and the database.
 */
const ACTION = join(process.cwd(), "src", "app", "(tenant)", "confirm-email", "[token]", "actions.ts");

describe("the confirmation action limits attempts before it checks a password", () => {
  const source = readFileSync(ACTION, "utf8");

  it("refuses with `tooMany` when the strict sign-in budget is spent", () => {
    expect(source).toMatch(
      /if \(!\(await allowStrict\("auth\.sign_in", clientIp\(requestHeaders\)\)\)\) return \{ ok: false, reason: "tooMany" \};/,
    );
  });

  it("does so BEFORE the password is checked, and checks it in exactly one place", () => {
    const limit = source.indexOf('allowStrict("auth.sign_in"');
    const check = source.indexOf("confirmMemberEmail(token, password)");
    expect(limit).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(limit);
    expect(source.match(/confirmMemberEmail\(/g)).toHaveLength(1);
  });
});

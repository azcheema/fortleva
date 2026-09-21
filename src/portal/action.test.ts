import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { AuthzError, type DenialReason } from "@/authz/errors";
import { DomainError, type DomainErrorCode } from "@/lib/domain-error";

import { portalDisclosableCode } from "./action";

/**
 * THE PORTAL'S DISCLOSURE RULE FOR WRITES, enumerated rather than
 * sampled.
 *
 * `src/portal/render.ts` made every READ denial identical; `action.ts`
 * does the same for writes, and the part of it that could silently
 * widen is the DomainError allow-list: the code union is shared with
 * the whole product, so a service that grows a refusal tomorrow would
 * start explaining the agency's internals to a client with no diff on
 * that file at all. A test that checked two or three codes by hand
 * would not see that; this one walks every code the product has copy
 * for and asserts that exactly two get through.
 *
 * WHERE THE LIST OF CODES COMES FROM, and why it is `en.json` rather
 * than the type. `DomainErrorCode` is a union, which does not exist at
 * runtime, so there is nothing to iterate. The message catalogue is the
 * one place every code is written down as DATA — `messageForError`
 * looks each one up there, so a code with no key is already a bug — and
 * `messages.test.ts` pins en/sv parity, so the list cannot rot in one
 * locale. The same reasoning `kind-copy.test.ts` uses for notification
 * kinds. It contains three entries that are AuthzError reasons rather
 * than domain codes (NOT_FOUND / FORBIDDEN / NOT_ENTITLED); they are
 * left in deliberately, because the right answer for them is the same
 * "no" and asserting it costs nothing.
 */

const MESSAGES = join(__dirname, "..", "messages", "en.json");

const domainCodes = (): string[] => {
  const json = JSON.parse(readFileSync(MESSAGES, "utf8")) as {
    domainErrors: Record<string, string>;
  };
  return Object.keys(json.domainErrors).sort();
};

/** Exactly the codes `action.ts` may reveal. Changing this is a decision. */
const DISCLOSABLE = ["INVALID_INPUT", "REQUEST_RATE_LIMITED"];

describe("what a contact may be told about a failed write", () => {
  it("the catalogue is not empty, so the walk below cannot pass vacuously", () => {
    // The control. Without it, a rename of the `domainErrors` namespace
    // would turn the enumeration into a loop over nothing and every
    // assertion in this file into a tautology.
    const codes = domainCodes();
    expect(codes.length).toBeGreaterThan(40);
    for (const code of DISCLOSABLE) expect(codes).toContain(code);
  });

  it("exactly two codes are disclosable, over every code the product has", () => {
    const disclosed = domainCodes().filter((code) =>
      portalDisclosableCode(new DomainError(code as DomainErrorCode)),
    );
    expect(disclosed).toEqual(DISCLOSABLE);
  });

  it("the two are returned as themselves, so the message is the code's own", () => {
    for (const code of DISCLOSABLE) {
      expect(portalDisclosableCode(new DomainError(code as DomainErrorCode))).toBe(code);
    }
  });

  it("no authorization denial is ever disclosable, whatever the gate said", () => {
    // NOT_ENTITLED names the agency's plan, DISABLED_BY_TENANT names a
    // switch somebody at the agency threw, and FORBIDDEN against
    // NOT_FOUND maps which projects exist. All six collapse.
    const reasons: DenialReason[] = [
      "FEATURE_DISABLED",
      "NOT_ENTITLED",
      "DISABLED_BY_TENANT",
      "FORBIDDEN",
      "NOT_FOUND",
      "MFA_REQUIRED",
    ];
    for (const reason of reasons) {
      expect(portalDisclosableCode(new AuthzError(reason, "detail"))).toBeNull();
    }
  });

  it("anything that is not a DomainError is not disclosable either", () => {
    // These reach the error boundary rather than the form (`runPortalAction`
    // rethrows). What matters here is that none of them is mistaken for a
    // refusal with a message.
    for (const value of [new Error("boom"), new TypeError("x"), "REQUEST_RATE_LIMITED", null, undefined, {
      code: "REQUEST_RATE_LIMITED",
    }]) {
      expect(portalDisclosableCode(value)).toBeNull();
    }
  });
});

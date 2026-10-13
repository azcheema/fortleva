import { describe, expect, it } from "vitest";

import { orgDigitsOf } from "./org-digits";

/**
 * WHOSE BOOKS AN ENTRY BELONGS IN (slice 114b; the design review's R3, S6):
 * an org. number as ten digits, however it was typed — and nothing for
 * anything else, so two missing numbers are never one company. The database's
 * twin (`invoice_org_digits`) is held equal to this by `fortnox-send.dbtest.ts`.
 */
describe("orgDigitsOf", () => {
  it("reads an org. number however it was typed", () => {
    expect(orgDigitsOf("556677-8899")).toBe("5566778899");
    expect(orgDigitsOf("5566778899")).toBe("5566778899");
    expect(orgDigitsOf(" 556677 8899 ")).toBe("5566778899");
    expect(orgDigitsOf("16556677-8899")).toBe("5566778899");
    expect(orgDigitsOf("19800101-1234")).toBe("8001011234");
    expect(orgDigitsOf("20800101-1234")).toBe("8001011234");
    expect(orgDigitsOf("18800101-1234")).toBe("8001011234");
  });

  it("is nothing for no number, or not ten digits — never a match", () => {
    expect(orgDigitsOf(null)).toBeNull();
    expect(orgDigitsOf(undefined)).toBeNull();
    expect(orgDigitsOf("")).toBeNull();
    expect(orgDigitsOf("-")).toBeNull();
    expect(orgDigitsOf("556677-889")).toBeNull();
    expect(orgDigitsOf("17556677-8899")).toBeNull();
    expect(orgDigitsOf("SE556677889901")).toBeNull();
  });
});

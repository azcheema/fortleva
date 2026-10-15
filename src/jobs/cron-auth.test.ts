import { describe, expect, it } from "vitest";

import { cronAuthorized, secretMatches } from "./cron-auth";

describe("who may kick the jobs", () => {
  it("Vercel Cron's bearer header must name the configured secret exactly", () => {
    expect(cronAuthorized("Bearer s3cret-value", "s3cret-value")).toBe(true);
    expect(cronAuthorized("Bearer wrong", "s3cret-value")).toBe(false);
    expect(cronAuthorized("s3cret-value", "s3cret-value")).toBe(false);
    expect(cronAuthorized("bearer s3cret-value", "s3cret-value")).toBe(false);
    expect(cronAuthorized(null, "s3cret-value")).toBe(false);
  });

  it("a secret saved with a stray space still matches the header Vercel sends (headers are trimmed)", () => {
    expect(cronAuthorized("Bearer s3cret-value", "s3cret-value \n")).toBe(true);
  });

  it("no configured secret means no GET caller at all — never an open door", () => {
    expect(cronAuthorized("Bearer ", undefined)).toBe(false);
    expect(cronAuthorized("Bearer ", "")).toBe(false);
    expect(cronAuthorized("Bearer    ", "   ")).toBe(false);
  });

  it("the manual token compares whole values only", () => {
    expect(secretMatches("abc", "abc")).toBe(true);
    expect(secretMatches("abcd", "abc")).toBe(false);
    expect(secretMatches(null, "abc")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import { builtInPreset, parsePreset } from "./stage-preset";

describe("the workspace default's stored list", () => {
  it("parses a valid list, built-in entries kept unnamed", () => {
    const list = builtInPreset();
    expect(parsePreset(list)).toEqual(list);
    expect(list.every((s) => s.name === null && s.seedKey !== null)).toBe(true);
  });

  it("refuses anything that is not a valid set — the caller then uses the built-in one", () => {
    const list = builtInPreset();
    expect(parsePreset(null)).toBeNull();
    expect(parsePreset({})).toBeNull();
    // EACH CASE BREAKS ONE PROPERTY of an otherwise valid list, so it fails
    // for its own reason and no other (the code review's LOW: two cases also
    // broke the kinds' order and so proved nothing about their own rule).
    const at = (i: number, patch: Record<string, unknown>) => list.map((s, j) => (j === i ? { ...s, ...patch } : s));
    expect(parsePreset(at(0, { extra: true }))).toBeNull(); // strict shape
    expect(parsePreset(at(1, { key: list[0]!.key }))).toBeNull(); // duplicate keys
    expect(parsePreset(list.filter((s) => s.category !== "CANCELLED"))).toBeNull(); // a kind missing
    expect(parsePreset(at(5, { seedKey: "TRIAGE" }))).toBeNull(); // TRIAGE is never stored
    expect(parsePreset(at(1, { requiresApproval: true }))).toBeNull(); // the default gated
    // ...and the control: the same list, untouched, parses.
    expect(parsePreset(at(0, {}))).toEqual(list);
  });
});

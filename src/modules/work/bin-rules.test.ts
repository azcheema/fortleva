import { describe, expect, it } from "vitest";

import { BIN_DAYS, binBlock, binOpen, binSince } from "./bin-rules";

const DAY = 86_400_000;
const now = new Date("2026-10-17T12:00:00.000Z");
const ago = (days: number, ms = 0) => new Date(now.getTime() - days * DAY - ms);

describe("the bin's 30 days (C102 (a), (c))", () => {
  it("is thirty days", () => {
    expect(BIN_DAYS).toBe(30);
    expect(binSince(now).toISOString()).toBe("2026-09-17T12:00:00.000Z");
  });

  it("keeps a task deleted up to the instant thirty days ago, and not a millisecond more", () => {
    expect(binOpen(now, now)).toBe(true);
    expect(binOpen(ago(29), now)).toBe(true);
    expect(binOpen(ago(30), now)).toBe(true);
    expect(binOpen(ago(30, 1), now)).toBe(false);
    expect(binOpen(ago(31), now)).toBe(false);
  });
});

describe("a row's Bring back (the service's refusals, drawn before the press)", () => {
  it("can be pressed for a task with no parent, or a live one", () => {
    expect(binBlock({ parent: null, hasTwin: false }, false, now)).toBeNull();
    expect(binBlock({ parent: { number: 3, deletedAt: null, fromImport: false }, hasTwin: false }, false, now)).toBeNull();
  });

  it("names the parent to bring back first while it is in the bin", () => {
    expect(binBlock({ parent: { number: 3, deletedAt: ago(2), fromImport: false }, hasTwin: false }, false, now)).toEqual({
      reason: "parent_in_bin",
      parentNumber: 3,
    });
  });

  it("sends a parent an import's undo removed back to the import's own row", () => {
    expect(binBlock({ parent: { number: 3, deletedAt: ago(2), fromImport: true }, hasTwin: false }, false, now)).toEqual({
      reason: "parent_from_import",
    });
  });

  it("says the parent can no longer come back once it has left the bin", () => {
    expect(binBlock({ parent: { number: 3, deletedAt: ago(31), fromImport: false }, hasTwin: false }, false, now)).toEqual({ reason: "parent_gone" });
  });

  it("a task whose card was imported again waits — after its parent's answer", () => {
    expect(binBlock({ parent: null, hasTwin: true }, false, now)).toEqual({ reason: "source_twin" });
    expect(binBlock({ parent: { number: 3, deletedAt: ago(2), fromImport: false }, hasTwin: true }, false, now)).toEqual({
      reason: "parent_in_bin",
      parentNumber: 3,
    });
  });

  it("an archived project comes first — nothing in it can be brought back", () => {
    expect(binBlock({ parent: null, hasTwin: false }, true, now)).toEqual({ reason: "archived" });
    expect(binBlock({ parent: { number: 3, deletedAt: ago(2), fromImport: false }, hasTwin: false }, true, now)).toEqual({ reason: "archived" });
  });
});

import { describe, expect, it } from "vitest";

import { newId } from "./ids";

const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("newId (UUIDv7)", () => {
  it("has the v7 shape: version nibble 7, RFC 4122 variant", () => {
    for (let i = 0; i < 100; i++) expect(newId()).toMatch(V7);
  });

  it("embeds the current unix-ms timestamp in the first 48 bits", () => {
    const before = Date.now();
    const id = newId();
    const after = Date.now();
    const ms = parseInt(id.replace(/-/g, "").slice(0, 12), 16);
    expect(ms).toBeGreaterThanOrEqual(before);
    expect(ms).toBeLessThanOrEqual(after + 1);
  });

  it("is unique and lexicographically monotonic within a burst", () => {
    const ids = Array.from({ length: 10_000 }, () => newId());
    expect(new Set(ids).size).toBe(ids.length);
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]! > ids[i - 1]!, `#${i} not increasing`).toBe(true);
    }
  });
});

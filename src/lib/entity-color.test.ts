import { describe, expect, it } from "vitest";

import {
  ENTITY_COUNT,
  ENTITY_HUES,
  entityHash,
  entityIndex,
  entityInitials,
  entityStyle,
} from "./entity-color";

describe("entity colour (DESIGN SPEC §2.6)", () => {
  it("has twelve frozen hues, evenly ordered", () => {
    expect(ENTITY_COUNT).toBe(12);
    expect(ENTITY_HUES).toEqual([15, 45, 75, 105, 140, 168, 196, 225, 255, 285, 315, 345]);
    expect([...ENTITY_HUES].sort((a, b) => a - b)).toEqual([...ENTITY_HUES]);
  });

  it("is deterministic and in range", () => {
    for (const key of ["", "a", "acme", "01H8XGJWBWBAQ4T4T8Z2S1", "Åke & Söner AB"]) {
      const first = entityHash(key);
      expect(entityHash(key)).toBe(first);
      expect(first).toBeGreaterThanOrEqual(0);
      expect(first).toBeLessThan(ENTITY_COUNT);
      expect(Number.isInteger(first)).toBe(true);
    }
  });

  it("prefers the immutable id, so renaming never changes the dot", () => {
    expect(entityIndex("id-1", "Acme AB")).toBe(entityIndex("id-1", "Acme Aktiebolag"));
    expect(entityIndex(null, "Acme AB")).toBe(entityHash("Acme AB"));
    expect(entityIndex(undefined, "Acme AB")).toBe(entityHash("Acme AB"));
  });

  it("distributes 5000 synthetic keys without a modulo bias", () => {
    const bins = new Array<number>(ENTITY_COUNT).fill(0);
    for (let i = 0; i < 5000; i++) {
      const bin = entityHash(`cuid_${i}_${i * 7919}`);
      bins[bin] = (bins[bin] ?? 0) + 1;
    }
    const expected = 5000 / ENTITY_COUNT;
    for (const [index, count] of bins.entries()) {
      // +/-25% of the expected bin size: a modulo bias shows up as a
      // systematic short bin, not as sampling noise at this size.
      expect(count, `bin ${index}`).toBeGreaterThan(expected * 0.75);
      expect(count, `bin ${index}`).toBeLessThan(expected * 1.25);
    }
  });

  it("emits the custom property the chip reads", () => {
    const style = entityStyle("id-1", "Acme AB") as Record<string, string>;
    expect(style["--entity"]).toMatch(/^var\(--entity-([0-9]|1[01])\)$/);
  });

  it("derives at most two initials, upper-cased", () => {
    expect(entityInitials("Acme AB")).toBe("AA");
    expect(entityInitials("Acme")).toBe("AC");
    expect(entityInitials("  Nordiska  Kompaniet  Sverige ")).toBe("NS");
    expect(entityInitials("ö")).toBe("Ö");
    expect(entityInitials("   ")).toBe("?");
  });
});

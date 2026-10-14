import { describe, expect, it } from "vitest";

import { bandOf, speedValue } from "./speed-bands";

describe("Google's bands at their edges (slice 118)", () => {
  it("LCP: good to 2500 ms, poor from over 4000", () => {
    expect(bandOf("lcp", 2500)).toBe("GOOD");
    expect(bandOf("lcp", 2501)).toBe("NEEDS_WORK");
    expect(bandOf("lcp", 4000)).toBe("NEEDS_WORK");
    expect(bandOf("lcp", 4001)).toBe("POOR");
  });

  it("INP: good to 200 ms, poor from over 500", () => {
    expect(bandOf("inp", 200)).toBe("GOOD");
    expect(bandOf("inp", 201)).toBe("NEEDS_WORK");
    expect(bandOf("inp", 500)).toBe("NEEDS_WORK");
    expect(bandOf("inp", 501)).toBe("POOR");
  });

  it("CLS: good to 0.1, poor from over 0.25", () => {
    expect(bandOf("cls", 0.1)).toBe("GOOD");
    expect(bandOf("cls", 0.101)).toBe("NEEDS_WORK");
    expect(bandOf("cls", 0.25)).toBe("NEEDS_WORK");
    expect(bandOf("cls", 0.251)).toBe("POOR");
  });

  it("the values people read: seconds to a decimal, whole milliseconds, CLS to two decimals", () => {
    expect(speedValue("lcp", 2140)).toEqual({ value: 2.1, unit: "s", digits: 1 });
    expect(speedValue("lcp", 2150)).toEqual({ value: 2.2, unit: "s", digits: 1 });
    expect(speedValue("inp", 183.6)).toEqual({ value: 184, unit: "ms", digits: 0 });
    expect(speedValue("cls", 0.0549)).toEqual({ value: 0.05, unit: "none", digits: 2 });
  });
});

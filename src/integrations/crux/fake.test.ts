import { describe, expect, it } from "vitest";

import { bandOf } from "@/modules/reports/speed-bands";

import { fakeCrux, fakeHistory, lastSaturday } from "./fake";

/**
 * THE FAKE GOOGLE (Phase 6 slice 118): deterministic per origin and device
 * kind, 40 periods of 28 days a week apart ending on Saturdays, the planted
 * hosts answering as the live transport would.
 */
const NOW = new Date("2026-10-14T10:00:00Z"); // a Wednesday

describe("the fake Chrome UX Report", () => {
  it("the same origin and device kind give the same series; phones are slower than computers", () => {
    const a = fakeHistory("https://example.invalid", "PHONE", false, NOW);
    const b = fakeHistory("https://example.invalid", "PHONE", false, NOW);
    expect(a).toEqual(b);
    const desktop = fakeHistory("https://example.invalid", "DESKTOP", false, NOW);
    expect(desktop).not.toEqual(a);
    const avg = (h: typeof a) => h.periods.reduce((s, p) => s + p.lcp!.p75, 0) / h.periods.length;
    expect(avg(a)).toBeGreaterThan(avg(desktop));
    expect(fakeHistory("https://other.invalid", "PHONE", false, NOW)).not.toEqual(a);
  });

  it("40 periods of 28 days, a week apart, ending on the Saturdays before now", () => {
    const h = fakeHistory("https://example.invalid", "PHONE", false, NOW);
    expect(h.periods).toHaveLength(40);
    expect(h.periods.at(-1)!.end).toBe("2026-10-10"); // the Saturday before Wednesday the 14th
    expect(h.periods.at(-1)!.start).toBe("2026-09-13");
    expect(h.periods.at(-2)!.end).toBe("2026-10-03");
    expect(h.periods[0]!.end).toBe("2026-01-10");
    for (const p of h.periods) {
      expect(new Date(`${p.end}T00:00:00Z`).getUTCDay()).toBe(6);
      expect((new Date(`${p.end}T00:00:00Z`).getTime() - new Date(`${p.start}T00:00:00Z`).getTime()) / 86_400_000).toBe(27);
      for (const m of [p.lcp!, p.inp!, p.cls!]) {
        expect(m.p75).toBeGreaterThanOrEqual(0);
        expect(m.good + m.needsWork + m.poor).toBeLessThanOrEqual(1.0001);
        for (const s of [m.good, m.needsWork, m.poor]) expect(s).toBeGreaterThanOrEqual(0);
      }
    }
    expect(lastSaturday(new Date("2026-10-10T23:59:59Z")).toISOString().slice(0, 10)).toBe("2026-10-10");
    expect(lastSaturday(new Date("2026-10-11T00:00:00Z")).toISOString().slice(0, 10)).toBe("2026-10-10");
  });

  it("a slow. host is Poor on every metric; the planted hosts answer no data, an outage, a refusal", async () => {
    const slow = fakeHistory("https://slow.example.invalid", "PHONE", true, NOW);
    for (const p of slow.periods) {
      expect(bandOf("lcp", p.lcp!.p75)).toBe("POOR");
      expect(bandOf("inp", p.inp!.p75)).toBe("POOR");
      expect(bandOf("cls", p.cls!.p75)).toBe("POOR");
    }
    const deadline = Date.now() + 10_000;
    expect(await fakeCrux.history("https://nodata.example.invalid", "PHONE", deadline)).toBeNull();
    await expect(fakeCrux.history("https://down.example.invalid", "PHONE", deadline)).rejects.toMatchObject({ kind: "unknown" });
    await expect(fakeCrux.history("https://refused.example.invalid", "PHONE", deadline)).rejects.toMatchObject({ kind: "refused", status: 400 });
    await expect(fakeCrux.history("https://nokey.example.invalid", "PHONE", deadline)).rejects.toMatchObject({ kind: "refused", status: 403 });
    expect((await fakeCrux.history("https://rate.example.invalid", "PHONE", deadline))?.periods).toHaveLength(40);
    await expect(fakeCrux.history("https://rate.example.invalid", "DESKTOP", deadline)).rejects.toMatchObject({ kind: "rate", status: 429 });
    expect((await fakeCrux.history("https://slow.example.invalid", "DESKTOP", deadline))?.periods).toHaveLength(40);
  });
});

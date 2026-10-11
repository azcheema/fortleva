import { describe, expect, it } from "vitest";

import type { ExpirationEntry } from "@/modules/vault";

import { cueOf, expirationHref } from "./expiration-row";

const entry = (kind: ExpirationEntry["kind"], over: Partial<ExpirationEntry> = {}): ExpirationEntry => ({
  kind,
  id: "row-1",
  name: "Row",
  date: "2031-06-15",
  client: { id: "client-1", name: "Acme" },
  project: null,
  assetType: null,
  autoRenew: null,
  linkable: true,
  ...over,
});

describe("expirationHref — where a Renewals row leads", () => {
  it("each kind to where it is renewed or ended; nowhere when that page would refuse", () => {
    expect(expirationHref(entry("asset"))).toBe("/clients/client-1/assets#asset-row-1");
    expect(expirationHref(entry("agreementEnds"))).toBe("/clients/client-1/agreements");
    expect(expirationHref(entry("contractEnds"))).toBe("/contracts/row-1");
    expect(expirationHref(entry("agreementRenews", { linkable: false }))).toBeNull();
  });
});

describe("cueOf — the words and weight of a row's date", () => {
  it("a signed contract's end: caution once passed (C86 (e)) — never danger — and on the day; quiet beyond 30 days", () => {
    const c = entry("contractEnds");
    expect(cueOf(c, -30)).toEqual({ key: "ended", tone: "caution" });
    expect(cueOf(c, -1)).toEqual({ key: "ended", tone: "caution" });
    expect(cueOf(c, 0)).toEqual({ key: "endsToday", tone: "caution" });
    expect(cueOf(c, 30)).toEqual({ key: "endsIn", tone: "caution" });
    expect(cueOf(c, 31)).toEqual({ key: "endsIn", tone: "quiet" });
  });

  it("an agreement still running past its end is danger — the line contradicts itself, and End clears it", () => {
    expect(cueOf(entry("agreementEnds"), -1)).toEqual({ key: "endPassed", tone: "danger" });
    expect(cueOf(entry("agreementEnds"), 0)).toEqual({ key: "endsToday", tone: "caution" });
  });

  it("an asset: lapsed or lapsing today is danger; one that renews by itself is neutral", () => {
    expect(cueOf(entry("asset"), -1)).toEqual({ key: "expired", tone: "danger" });
    expect(cueOf(entry("asset"), 0)).toEqual({ key: "expiresToday", tone: "danger" });
    expect(cueOf(entry("asset", { autoRenew: true }), 0)).toEqual({ key: "renewsToday", tone: "neutral" });
    expect(cueOf(entry("agreementRenews"), 12)).toEqual({ key: "renewsIn", tone: "neutral" });
  });
});

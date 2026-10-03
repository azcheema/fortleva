import { describe, expect, it } from "vitest";

import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
// The pure file, not the index: the index reaches the database client, and
// a test is outside the boundary rule (`vault-boundary.test.ts`).
import { ASSET_FIELDS, ASSET_TYPES, EXPIRY_YEAR_MAX, EXPIRY_YEAR_MIN } from "@/modules/vault/asset-fields";

import {
  ASSET_FIELD_KEYS,
  assetFieldLabelKey,
  assetFieldText,
  DAY_MAX,
  DAY_MIN,
  daysBetween,
  expiryCue,
  SOON_DAYS,
} from "./asset-shape";

describe("the Assets tab's vocabulary", () => {
  it("its field names are exactly the module's per-type fields, each labelled in both languages", () => {
    const fromModule = [...new Set(Object.values(ASSET_FIELDS).flatMap((specs) => specs.map((s) => s.key)))].sort();
    expect([...ASSET_FIELD_KEYS].sort()).toEqual(fromModule);
    for (const key of ASSET_FIELD_KEYS) {
      expect(en.assets.fields[key], `en ${key}`).toBeTruthy();
      expect(sv.assets.fields[key], `sv ${key}`).toBeTruthy();
    }
    expect(assetFieldLabelKey("seats")).toBe("fields.seats");
    expect(assetFieldLabelKey("__proto__")).toBe("fields.plan");
  });

  it("every type has a label and a name hint in both languages", () => {
    for (const type of ASSET_TYPES) {
      for (const [lang, m] of [["en", en], ["sv", sv]] as const) {
        expect(m.assets.types[type], `${lang} ${type}`).toBeTruthy();
        expect(m.assets.add.nameHint[type], `${lang} hint ${type}`).toBeTruthy();
      }
    }
  });

  it("the date inputs offer exactly the years the service accepts", () => {
    expect(DAY_MIN).toBe(`${EXPIRY_YEAR_MIN}-01-01`);
    expect(DAY_MAX).toBe(`${EXPIRY_YEAR_MAX}-12-31`);
  });

  it("every type has an identifier hint in both languages", () => {
    for (const type of ASSET_TYPES) {
      expect(en.assets.add.identifierHint[type], `en ${type}`).toBeTruthy();
      expect(sv.assets.add.identifierHint[type], `sv ${type}`).toBeTruthy();
    }
  });

  it("a stored value reads as one line", () => {
    expect(assetFieldText(["ns1.x.se", "ns2.x.se"])).toBe("ns1.x.se, ns2.x.se");
    expect(assetFieldText(5)).toBe("5");
    expect(assetFieldText(undefined)).toBe("");
  });
});

describe("the renewal cue", () => {
  it("counts calendar days, whatever the zone", () => {
    expect(daysBetween("2026-10-03", "2026-10-03")).toBe(0);
    expect(daysBetween("2026-10-03", "2026-10-23")).toBe(20);
    expect(daysBetween("2026-10-03", "2026-10-01")).toBe(-2);
    // Across the end of summer time (Europe, 25 Oct 2026): still whole days.
    expect(daysBetween("2026-10-24", "2026-10-26")).toBe(2);
  });

  it("flags only an asset in use whose date has passed, is today, or is within the window", () => {
    expect(expiryCue("ACTIVE", -1)).toBe("expired");
    expect(expiryCue("ACTIVE", 0)).toBe("today");
    expect(expiryCue("ACTIVE", SOON_DAYS)).toBe("soon");
    expect(expiryCue("ACTIVE", SOON_DAYS + 1)).toBeNull();
    expect(expiryCue("ACTIVE", null)).toBeNull();
    expect(expiryCue("RETIRED", -5)).toBeNull();
  });
});

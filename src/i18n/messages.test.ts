import { describe, expect, it } from "vitest";

import en from "../messages/en.json";
import sv from "../messages/sv.json";
import { LOCALES, negotiateLocale } from "./config";

type Tree = { [key: string]: string | Tree };

const flatten = (tree: Tree, prefix = ""): Map<string, string> => {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.set(path, v);
    else for (const [ck, cv] of flatten(v, path)) out.set(ck, cv);
  }
  return out;
};

const CATALOGS: Record<(typeof LOCALES)[number], Tree> = { en, sv };

/** ICU argument names in a message ({name}, {count, plural, …}, <tag>). */
const icuArgs = (msg: string): string[] =>
  [...msg.matchAll(/\{\s*([A-Za-z0-9_]+)/g)].map((m) => m[1]!).sort();
const richTags = (msg: string): string[] =>
  [...msg.matchAll(/<([A-Za-z0-9_]+)>/g)].map((m) => m[1]!).sort();

describe("message catalogs (UI.md §8)", () => {
  it("every locale in LOCALES has a catalog", () => {
    for (const locale of LOCALES) expect(CATALOGS[locale]).toBeDefined();
  });

  it("en and sv have exactly the same keys", () => {
    const enKeys = [...flatten(en).keys()].sort();
    const svKeys = [...flatten(sv).keys()].sort();
    expect(svKeys).toEqual(enKeys);
  });

  it("no empty strings in any catalog", () => {
    for (const locale of LOCALES) {
      for (const [key, value] of flatten(CATALOGS[locale])) {
        expect(value.trim(), `${locale}:${key}`).not.toBe("");
      }
    }
  });

  it("ICU arguments and rich tags agree between locales", () => {
    const enFlat = flatten(en);
    const svFlat = flatten(sv);
    for (const [key, enMsg] of enFlat) {
      const svMsg = svFlat.get(key)!;
      expect(icuArgs(svMsg), key).toEqual(icuArgs(enMsg));
      expect(richTags(svMsg), key).toEqual(richTags(enMsg));
    }
  });
});

describe("negotiateLocale", () => {
  it("honours q-values and region subtags", () => {
    expect(negotiateLocale("sv-SE,sv;q=0.9,en;q=0.8")).toBe("sv");
    expect(negotiateLocale("en-GB,en;q=0.9,sv;q=0.8")).toBe("en");
    expect(negotiateLocale("de-DE,fr;q=0.9,sv;q=0.5")).toBe("sv");
    expect(negotiateLocale("de-DE,fr;q=0.9")).toBeNull();
    expect(negotiateLocale(null)).toBeNull();
    expect(negotiateLocale("")).toBeNull();
    expect(negotiateLocale("*")).toBeNull();
  });
});

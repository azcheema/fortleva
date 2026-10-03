import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DomainError } from "@/lib/domain-error";

import {
  applyAssetFieldsPatch,
  ASSET_FIELDS,
  ASSET_STATUSES,
  ASSET_TYPES,
  FIELDS_BYTES_MAX,
  normalizeAssetFields,
  normalizeAssetFieldsPatch,
  normalizeAutoRenew,
  normalizeCurrency,
  normalizeExpiryDay,
  normalizeRenewalCost,
  readAssetFields,
} from "./asset-fields";
import { normalizeUrl } from "./fields";

/**
 * The asset registry's pure rules (Phase 3V slice 87): the per-type facts
 * (`fields`, zod per type), the money pair, the renewal DATE convention,
 * and the url rule the database restates (`client_asset_url_http`).
 */

const code = (fn: () => unknown): string => {
  try {
    fn();
    return "ok";
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    throw e;
  }
};

describe("asset vocabulary", () => {
  it("the types and statuses are exactly the schema's enums, in its order (the list sorts by it)", () => {
    const schema = readFileSync(join(process.cwd(), "prisma", "schema.prisma"), "utf8");
    const values = (name: string) =>
      (new RegExp(`enum ${name} \\{([^}]*)\\}`).exec(schema)?.[1] ?? "")
        .split("\n")
        .map((l) => l.replace(/\/\/.*$/, "").trim())
        .filter((l) => /^[A-Z_]+$/.test(l));
    expect([...ASSET_TYPES]).toEqual(values("AssetType"));
    expect([...ASSET_STATUSES]).toEqual(values("AssetStatus"));
  });

  it("no per-type field is a place for a secret (a licence's seats, never its key)", () => {
    const keys = Object.values(ASSET_FIELDS).flatMap((specs) => specs.map((s) => s.key));
    for (const key of keys) expect(key, key).not.toMatch(/key|password|secret|token|pin|passphrase/i);
  });
});

describe("per-type fields (zod per type)", () => {
  it("a list is typed as one line and split on commas, spaces or new lines, de-duplicated", () => {
    expect(normalizeAssetFields("DOMAIN", { nameservers: "ns1.loopia.se, ns2.loopia.se\nns1.loopia.se" })).toEqual({
      nameservers: ["ns1.loopia.se", "ns2.loopia.se"],
    });
    expect(normalizeAssetFields("SSL_CERT", { domains: ["acme.se", " www.acme.se "] })).toEqual({ domains: ["acme.se", "www.acme.se"] });
  });

  it("a count is a whole number from a form's digits or a number; anything else is refused", () => {
    expect(normalizeAssetFields("LICENSE", { seats: " 5 " })).toEqual({ seats: 5 });
    expect(normalizeAssetFields("EMAIL", { mailboxes: 12, plan: "Business" })).toEqual({ plan: "Business", mailboxes: 12 });
    for (const bad of ["five", "2.5", -1, 1.5, "1e3"]) expect(code(() => normalizeAssetFields("LICENSE", { seats: bad })), String(bad)).toBe("INVALID_INPUT");
  });

  it("blanks are left out on create; in a patch they remove the field", () => {
    expect(normalizeAssetFields("HOSTING", { plan: "  ", server: "" })).toEqual({});
    expect(normalizeAssetFieldsPatch("HOSTING", { plan: "", server: null })).toEqual({ plan: null, server: null });
    expect(applyAssetFieldsPatch("HOSTING", { plan: "Pro", server: "web1" }, { plan: null })).toEqual({ server: "web1" });
  });

  it("a key the type does not have is refused, and the message never echoes it", () => {
    let message = "";
    try {
      normalizeAssetFields("DOMAIN", { "hunter2-secret": "x" });
    } catch (e) {
      message = String((e as Error).message);
    }
    expect(message).not.toContain("hunter2");
    expect(code(() => normalizeAssetFields("DOMAIN", { seats: 3 }))).toBe("INVALID_INPUT");
    expect(code(() => normalizeAssetFields("CUSTOM", { plan: "x" }))).toBe("INVALID_INPUT");
  });

  it("bounds: list length, item length, text length, and the whole object's bytes", () => {
    expect(code(() => normalizeAssetFields("DOMAIN", { nameservers: Array.from({ length: 21 }, (_, i) => `ns${i}.x.se`) }))).toBe("INVALID_INPUT");
    expect(code(() => normalizeAssetFields("DOMAIN", { nameservers: ["a".repeat(254)] }))).toBe("INVALID_INPUT");
    expect(code(() => normalizeAssetFields("HOSTING", { plan: "p".repeat(201) }))).toBe("INVALID_INPUT");
    // Twenty full-length ASCII hostnames fit; the same in three-byte characters does not.
    expect(code(() => normalizeAssetFields("DOMAIN", { nameservers: Array.from({ length: 20 }, (_, i) => `${i}`.padEnd(253, "a")) }))).toBe("ok");
    const wide = Array.from({ length: 20 }, (_, i) => `${i}`.padEnd(200, "€"));
    expect(new TextEncoder().encode(JSON.stringify({ nameservers: wide })).length).toBeGreaterThan(FIELDS_BYTES_MAX);
    expect(code(() => normalizeAssetFields("DOMAIN", { nameservers: wide }))).toBe("INVALID_INPUT");
  });

  it("a type change keeps only the new type's facts, in its display order", () => {
    expect(applyAssetFieldsPatch("DNS_ZONE", { nameservers: ["ns1.x.se"] }, {})).toEqual({ nameservers: ["ns1.x.se"] });
    expect(applyAssetFieldsPatch("LICENSE", { nameservers: ["ns1.x.se"] }, {})).toEqual({});
    expect(Object.keys(applyAssetFieldsPatch("EMAIL", {}, { mailboxes: 3, plan: "Basic" }))).toEqual(["plan", "mailboxes"]);
  });

  it("only CHANGED facts are measured, so an oversized stored row can still be edited from the tab", () => {
    const big = { nameservers: Array.from({ length: 20 }, (_, i) => `${i}`.padEnd(200, "€")) };
    expect(code(() => applyAssetFieldsPatch("DOMAIN", big, {}))).toBe("ok");
    // The tab re-posts the facts as they are on every save: not a change, not measured.
    expect(code(() => applyAssetFieldsPatch("DOMAIN", big, { nameservers: big.nameservers }))).toBe("ok");
    expect(code(() => applyAssetFieldsPatch("DOMAIN", big, { nameservers: [...big.nameservers.slice(1), "x"] }))).toBe("INVALID_INPUT");
  });

  it("a list given as an array is split like a typed line, so both store the same", () => {
    expect(normalizeAssetFields("DOMAIN", { nameservers: ["ns1.x.se, ns2.x.se", "ns3.x.se"] })).toEqual({
      nameservers: ["ns1.x.se", "ns2.x.se", "ns3.x.se"],
    });
  });

  it("reading is tolerant: odd stored values are dropped, never thrown", () => {
    expect(readAssetFields("LICENSE", { seats: "many", nameservers: ["x"] })).toEqual({});
    expect(readAssetFields("LICENSE", null)).toEqual({});
    expect(readAssetFields("LICENSE", ["x"])).toEqual({});
    expect(readAssetFields("LICENSE", { seats: 4 })).toEqual({ seats: 4 });
  });
});

describe("money, renewal day, auto-renew, url", () => {
  it("a cost reads '1 200,50' and '1200.50' alike; blank is none; bad shapes are refused", () => {
    expect(normalizeRenewalCost("1 200,50")).toBe("1200.50");
    expect(normalizeRenewalCost(99)).toBe("99.00");
    expect(normalizeRenewalCost("0149.5")).toBe("149.50");
    expect(normalizeRenewalCost("  ")).toBeNull();
    for (const bad of ["-5", "1.234", "abc", "12345678901"]) expect(code(() => normalizeRenewalCost(bad)), bad).toBe("INVALID_INPUT");
  });

  it("a currency is three capital letters (upper-cased); blank is none", () => {
    expect(normalizeCurrency("sek")).toBe("SEK");
    expect(normalizeCurrency("")).toBeNull();
    expect(code(() => normalizeCurrency("S3K"))).toBe("INVALID_INPUT");
    expect(code(() => normalizeCurrency("EURO"))).toBe("INVALID_INPUT");
  });

  it("a renewal date is kept as its UTC day at midnight; a typo year is refused, never shifted", () => {
    expect(normalizeExpiryDay(new Date("2027-03-01T00:00:00Z"))?.toISOString()).toBe("2027-03-01T00:00:00.000Z");
    expect(normalizeExpiryDay(new Date("2027-03-01T17:45:12Z"))?.toISOString()).toBe("2027-03-01T00:00:00.000Z");
    expect(normalizeExpiryDay(null)).toBeNull();
    expect(code(() => normalizeExpiryDay(new Date("0026-10-03T00:00:00Z")))).toBe("INVALID_INPUT");
    expect(code(() => normalizeExpiryDay(new Date(Date.UTC(20260, 9, 3))))).toBe("INVALID_INPUT");
    expect(code(() => normalizeExpiryDay(new Date("nope")))).toBe("INVALID_INPUT");
  });

  it("auto-renew is yes, no or not known", () => {
    expect(normalizeAutoRenew(true)).toBe(true);
    expect(normalizeAutoRenew(null)).toBeNull();
    expect(code(() => normalizeAutoRenew("yes"))).toBe("INVALID_INPUT");
  });

  it("a url never carries a user or password before the host — the pattern the database refuses too", () => {
    for (const bad of ["https://admin:pw@acme.se", "https://@acme.se", "https://a\\@acme.se", "https://www.acme@evil.test/"]) {
      expect(code(() => normalizeUrl(bad)), bad).toBe("INVALID_INPUT");
    }
    for (const good of ["https://medium.com/@acme", "https://acme.se/?mail=a@b.se", "https://acme.se/#a@b"]) {
      expect(normalizeUrl(good), good).toBe(good);
    }
  });
});

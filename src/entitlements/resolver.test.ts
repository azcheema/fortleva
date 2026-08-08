import { describe, expect, it } from "vitest";

import { MODULES } from "@/authz/catalog";

import { enforceLimit, entitlementsSchema, parseEntitlements } from "./resolver";
import { AuthzError } from "@/authz/errors";

describe("entitlements shape (DATA_MODEL.md §4)", () => {
  it("empty input resolves to everything-on, unlimited (Phase 1 default)", () => {
    const ents = parseEntitlements({});
    expect(Object.values(ents.modules).every(Boolean)).toBe(true);
    expect(Object.values(ents.limits).every((v) => v === null)).toBe(true);
    expect(ents.addons.bankidSigning).toBe(false);
  });

  it("garbage input falls back to defaults instead of crashing reads", () => {
    expect(parseEntitlements("not-json-shaped").planCode).toBe("dev-unlimited");
    expect(parseEntitlements(null).modules.invoicing).toBe(true);
  });

  it("module keys are exactly the Permission.module values minus core", () => {
    const entKeys = Object.keys(entitlementsSchema.parse({}).modules).sort();
    const expected = MODULES.filter((m) => m !== "core").sort();
    expect(entKeys).toEqual(expected);
  });

  it("bankidSigning is an addon, never an eighth module", () => {
    const ents = entitlementsSchema.parse({});
    expect("bankidSigning" in ents.modules).toBe(false);
    expect("bankidSigning" in ents.addons).toBe(true);
  });
});

describe("limits — read-only grandfathering", () => {
  it("blocks creation at the limit", () => {
    const ents = parseEntitlements({ limits: { maxClients: 5 } });
    expect(() => enforceLimit(ents, "maxClients", 5)).toThrow(AuthzError);
    expect(() => enforceLimit(ents, "maxClients", 7)).toThrow(/maxClients/);
  });

  it("allows creation under the limit and always when unlimited", () => {
    const ents = parseEntitlements({ limits: { maxClients: 5 } });
    expect(() => enforceLimit(ents, "maxClients", 4)).not.toThrow();
    const unlimited = parseEntitlements({});
    expect(() => enforceLimit(unlimited, "maxClients", 10_000)).not.toThrow();
  });
});

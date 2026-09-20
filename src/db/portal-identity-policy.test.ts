import { describe, expect, it } from "vitest";

import {
  assertWritable,
  collectKeys,
  keysOf,
  PortalIdentityRefused,
  WRITABLE_COLUMNS,
  type ContactAuthKeys,
} from "./portal-identity-policy";

/**
 * The fail-closed half of the portal identity seam, with no database.
 *
 * What these tests are really pinning is a DIRECTION. The dangerous
 * failure of `collectKeys` is not missing a key — that yields an empty
 * GUC, which matches no row — it is INVENTING one, or carrying a value
 * out of a clause that does not actually identify the row (a negation,
 * a prefix match), because the GUC it produces is what RLS then treats
 * as "the row this request already named".
 */

const keys = (where: unknown): ContactAuthKeys => {
  const out: ContactAuthKeys = {};
  collectKeys(where, out);
  return out;
};

describe("collectKeys: the shapes the adapter really emits", () => {
  it("reads the equals form used by every find", () => {
    expect(keys({ email: { equals: "casey@example.invalid" } })).toEqual({
      email: "casey@example.invalid",
    });
  });

  it("reads the bare-value form used by updates", () => {
    expect(keys({ id: "01a0bfae-0cc7-726b-a748-42d4e5fbb488" })).toEqual({
      id: "01a0bfae-0cc7-726b-a748-42d4e5fbb488",
    });
  });

  it("reads both keys out of one where, and out of AND / OR nesting", () => {
    expect(keys({ AND: [{ id: "i" }, { email: { equals: "e" } }] })).toEqual({
      id: "i",
      email: "e",
    });
    expect(keys({ OR: [{ email: "a" }, { id: "b" }] })).toEqual({ email: "a", id: "b" });
    // Nested one deeper than the adapter produces, which should still
    // resolve rather than silently drop.
    expect(keys({ AND: [{ OR: [{ id: "deep" }] }] })).toEqual({ id: "deep" });
  });

  it("carries the mode filter's sibling value, not the mode", () => {
    expect(keys({ email: { equals: "Casey@Example.invalid", mode: "insensitive" } })).toEqual({
      email: "Casey@Example.invalid",
    });
  });
});

describe("collectKeys: what it must NOT treat as an identity", () => {
  it("ignores other columns entirely", () => {
    expect(keys({ name: "Casey", tenantId: "t", clientId: "c" })).toEqual({});
  });

  it("ignores a NOT clause — a negation identifies no row", () => {
    // If this leaked, `{ NOT: { id: X } }` would set the GUC to X and
    // the policy would open X: the exact row the query excluded.
    expect(keys({ NOT: { id: "excluded" } })).toEqual({});
  });

  it("ignores non-equality operators", () => {
    expect(keys({ email: { startsWith: "casey" } })).toEqual({});
    expect(keys({ email: { not: { equals: "casey@example.invalid" } } })).toEqual({});
    expect(keys({ id: { in: ["a", "b"] } })).toEqual({});
  });

  it("ignores non-string values, so no object or array becomes a GUC", () => {
    expect(keys({ id: 42 })).toEqual({});
    expect(keys({ id: null })).toEqual({});
    expect(keys({ id: { equals: null } })).toEqual({});
    expect(keys({ email: ["a", "b"] })).toEqual({});
  });

  it("yields nothing for an absent, empty or malformed where", () => {
    expect(keysOf(undefined)).toEqual({});
    expect(keysOf({})).toEqual({});
    expect(keys({})).toEqual({});
    expect(keys(null)).toEqual({});
    expect(keys("not an object")).toEqual({});
  });

  it("stops recursing rather than hanging on a cyclic where", () => {
    const cyclic: Record<string, unknown> = { id: "top" };
    cyclic["AND"] = [cyclic];
    expect(() => keys(cyclic)).not.toThrow();
    expect(keys(cyclic)).toEqual({ id: "top" });
  });
});

describe("assertWritable: the column allow-list", () => {
  it("permits the identity columns Better Auth actually writes", () => {
    expect(() => assertWritable({ name: "Casey", emailVerified: true, updatedAt: new Date() })).not.toThrow();
  });

  it("refuses every column that decides what a login can reach", () => {
    for (const column of ["tenantId", "clientId", "portalStatus", "portalProfile", "id"]) {
      expect(() => assertWritable({ [column]: "x" }), column).toThrow(PortalIdentityRefused);
    }
  });

  it("refuses a mixed payload that hides a forbidden column among allowed ones", () => {
    expect(() => assertWritable({ name: "Casey", tenantId: "elsewhere" })).toThrow(
      PortalIdentityRefused,
    );
  });

  it("names the offending column, so a refusal is debuggable", () => {
    expect(() => assertWritable({ portalStatus: "ACTIVE" })).toThrow(/contact\.portalStatus/);
  });

  it("is pinned as a list, so widening it is a deliberate edit", () => {
    expect([...WRITABLE_COLUMNS].sort()).toEqual([
      "email",
      "emailVerified",
      "image",
      "locale",
      "name",
      "updatedAt",
    ]);
  });
});

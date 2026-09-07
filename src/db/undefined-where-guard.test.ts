import { describe, expect, it } from "vitest";

import { assertNoUndefinedWhere, GUARDED_BULK_OPS } from "./undefined-where-guard";

/**
 * The 2026-08-31 incident pin: Prisma silently drops `undefined` where
 * filters, so a cleanup hook whose beforeAll died before assigning its
 * tenantId ran `deleteMany({ where: { tenantId: undefined } })`
 * UNFILTERED and wiped every tenant's role / role_permission /
 * member_role rows on the shared dev database. The platform client now
 * refuses such a write loudly; this test pins the refusal shapes.
 */
describe("assertNoUndefinedWhere (the unfiltered-bulk-write belt)", () => {
  it("refuses a missing where and an explicitly-undefined filter at any depth", () => {
    expect(() => assertNoUndefinedWhere(undefined)).toThrow(/where is undefined/);
    expect(() => assertNoUndefinedWhere({ tenantId: undefined })).toThrow(/where\.tenantId is undefined/);
    expect(() => assertNoUndefinedWhere({ tenantId: { in: undefined } })).toThrow(
      /where\.tenantId\.in is undefined/,
    );
    expect(() => assertNoUndefinedWhere({ id: "x", nested: { or: [{ a: undefined }] } })).toThrow(
      /where\.nested\.or\.0\.a is undefined/,
    );
  });

  it("guards every bulk write that takes a where — an unlisted operation name is the whole failure mode", () => {
    // Prisma keys its hooks by operation NAME, so an operation nobody
    // listed is silently unguarded. `updateManyAndReturn` is a separate
    // name from `updateMany`, takes the same optional `where`, and does
    // the same unfiltered damage; it nearly shipped outside this belt.
    // The list is pinned here and the extension is built FROM it, so
    // adding a name is the only edit a future bulk operation needs.
    expect([...GUARDED_BULK_OPS].sort()).toEqual(
      ["deleteMany", "updateMany", "updateManyAndReturn"].sort(),
    );
  });

  it("passes every honest filter shape", () => {
    expect(() => assertNoUndefinedWhere({ tenantId: "t1" })).not.toThrow();
    expect(() => assertNoUndefinedWhere({ tenantId: "t1", deletedAt: null })).not.toThrow();
    expect(() => assertNoUndefinedWhere({ id: { in: [] } })).not.toThrow();
    expect(() => assertNoUndefinedWhere({ createdAt: { lt: new Date(0) } })).not.toThrow();
    expect(() => assertNoUndefinedWhere({ OR: [{ a: "1" }, { b: "2" }] })).not.toThrow();
  });
});

import { describe, expect, it } from "vitest";

import { DomainError } from "./domain-error";
import { dbErrorMapper } from "./db-error-map";

describe("dbErrorMapper", () => {
  const { mapDbError, guarded } = dbErrorMapper([
    ["WORK_TREE_NESTING", "CANNOT_NEST"],
    ["shift_one_open", "SHIFT_ALREADY_OPEN"],
  ]);

  it("maps a trigger's leading token in the message to its DomainError", () => {
    expect(() => mapDbError(new Error("WORK_TREE_NESTING: parent type must be strictly higher"))).toThrow(
      expect.objectContaining({ code: "CANNOT_NEST" }),
    );
  });

  it("finds a token that only the adapter's nested meta carries (Prisma 7 + pg, partial uniques)", () => {
    const e = Object.assign(new Error("Unique constraint failed on the (not available)"), {
      code: "P2002",
      meta: { driverAdapterError: { cause: { originalMessage: 'duplicate key value violates "shift_one_open"' } } },
    });
    expect(() => mapDbError(e)).toThrow(expect.objectContaining({ code: "SHIFT_ALREADY_OPEN" }));
  });

  it("rethrows anything unmatched untouched — a bug, not a business rule", () => {
    const e = new Error("RESTORE_PARENT_GONE: restore the parent work item first");
    expect(() => mapDbError(e)).toThrow(e);
  });

  it("guarded() passes results through and translates throws", async () => {
    await expect(guarded(async () => 42)).resolves.toBe(42);
    await expect(
      guarded(async () => {
        throw new Error("WORK_TREE_NESTING: too deep");
      }),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it("refuses a table where one token is a substring of another (the first match would shadow the second)", () => {
    expect(() =>
      dbErrorMapper([
        ["NESTING", "CANNOT_NEST"],
        ["WORK_TREE_NESTING", "CANNOT_NEST"],
      ]),
    ).toThrow(/substring/);
  });
});

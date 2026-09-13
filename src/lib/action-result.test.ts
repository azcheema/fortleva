import { describe, expect, it } from "vitest";

import { wroteSomething } from "./action-result";

describe("wroteSomething — the one toast policy of the backlog table", () => {
  it("a FormResult's success is a write", () => {
    expect(wroteSomething({ ok: true, message: "Saved" })).toBe(true);
  });

  it("a canonical row that says changed: false is NOT a write — a colleague already made the change", () => {
    expect(wroteSomething({ ok: true, value: { visibility: "CLIENT_VISIBLE", changed: false } })).toBe(false);
  });

  it("a canonical row that says changed: true is a write", () => {
    expect(wroteSomething({ ok: true, value: { visibility: "INTERNAL", changed: true } })).toBe(true);
  });

  it("a row without the flag, or no row at all, counts as a write (a move, a create)", () => {
    expect(wroteSomething({ ok: true, value: { id: "x", number: 3 } })).toBe(true);
    expect(wroteSomething({ ok: true, value: undefined })).toBe(true);
    expect(wroteSomething({ ok: true, value: null })).toBe(true);
    expect(wroteSomething({ ok: true, value: "not an object" })).toBe(true);
  });

  it("a failure never is", () => {
    expect(wroteSomething({ ok: false, message: "no" })).toBe(false);
  });
});

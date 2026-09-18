import { describe, expect, it } from "vitest";

import { isHere, isStale, isWho, type WorkspaceHere } from "./workspace-watch";

const here = (tenantId: string, at: number): WorkspaceHere => ({ kind: "here", tenantId, at });

describe("workspace watch — which tab is stale", () => {
  it("a newer tab in another workspace makes this one stale", () => {
    expect(isStale({ tenantId: "x", at: 100 }, here("y", 101))).toBe(true);
  });

  it("an OLDER tab in another workspace does not — that is a `who` being answered", () => {
    // The order the two mount messages arrive in is what this guards:
    // the tab that mounted second is the newer truth, and the answers to
    // its `who` are older by construction. Without the `at` half, a tab
    // that had just rendered the right workspace would mark itself wrong
    // the moment a stale tab said hello.
    expect(isStale({ tenantId: "y", at: 200 }, here("x", 100))).toBe(false);
  });

  it("the same workspace is never stale, whichever tab is newer", () => {
    expect(isStale({ tenantId: "x", at: 100 }, here("x", 500))).toBe(false);
    expect(isStale({ tenantId: "x", at: 500 }, here("x", 100))).toBe(false);
  });

  it("the same millisecond leaves both tabs alone rather than darkening both", () => {
    expect(isStale({ tenantId: "x", at: 100 }, here("y", 100))).toBe(false);
    expect(isStale({ tenantId: "y", at: 100 }, here("x", 100))).toBe(false);
  });

  it("recognises its own two messages", () => {
    expect(isWho({ kind: "who" })).toBe(true);
    expect(isHere(here("x", 1))).toBe(true);
    expect(isHere({ kind: "who" })).toBe(false);
    expect(isWho(here("x", 1))).toBe(false);
  });

  it("refuses anything else another deploy might post, without throwing", () => {
    // The channel is shared by whatever version of the app the member's
    // other tab happens to be running.
    for (const junk of [
      null,
      undefined,
      "here",
      42,
      {},
      { kind: "here" },
      { kind: "here", tenantId: "", at: 1 },
      { kind: "here", tenantId: "x" },
      { kind: "here", tenantId: "x", at: "1" },
      { kind: "here", tenantId: "x", at: Number.NaN },
      { kind: "hello", tenantId: "x", at: 1 },
    ]) {
      expect(isHere(junk)).toBe(false);
      expect(isWho(junk)).toBe(false);
    }
  });
});

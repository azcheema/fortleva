import { describe, expect, it } from "vitest";

import { NO_FILTERS } from "./model";
import { filtersOf, listHrefOf, peekHrefOf, workViewHref, workViewParsers } from "./params";

/**
 * The URL contract, pinned as a unit so a regression costs seconds
 * rather than a full browser run. `e2e/attachments.spec.ts` depends on a
 * view at rest being addressable as its bare path, and every peek link
 * on both work surfaces now depends on `workViewHref` putting exactly
 * one `?` in the URL.
 */

const parse = <K extends keyof typeof workViewParsers>(key: K, raw: string | null) =>
  workViewParsers[key].parse(raw as never);

describe("workViewParsers", () => {
  it("an absent param is its default, so a bare URL is the resting view", () => {
    expect(parse("group", null)).toBe(null);
    expect(workViewParsers.group.defaultValue).toBe("none");
    expect(workViewParsers.state.defaultValue).toEqual([]);
    expect(workViewParsers.assignee.defaultValue).toEqual([]);
    expect(workViewParsers.priority.defaultValue).toEqual([]);
    expect(workViewParsers.hideDone.defaultValue).toBe(false);
  });

  it("clearOnDefault is on, which is what keeps the resting view a bare path", () => {
    // nuqs v2 defaults it to true; assert it rather than trust it, since
    // a false here would put `?group=none` on every ungrouped board link.
    for (const parser of Object.values(workViewParsers)) {
      expect(parser.clearOnDefault).not.toBe(false);
    }
  });

  it("group accepts only the four groupings; anything else falls back", () => {
    expect(parse("group", "epic")).toBe("epic");
    expect(parse("group", "assignee")).toBe("assignee");
    expect(parse("group", "sideways")).toBe(null);
  });

  it("lists are comma-separated and round-trip", () => {
    expect(parse("state", "a,b")).toEqual(["a", "b"]);
    expect(workViewParsers.state.serialize(["a", "b"])).toBe("a,b");
    expect(parse("state", "")).toEqual([]);
  });

  it("priority accepts only real priorities — a junk value cannot enter the filter", () => {
    expect(parse("priority", "HIGH,LOW")).toEqual(["HIGH", "LOW"]);
    // parseAsArrayOf drops the members its item parser rejects.
    expect(parse("priority", "HIGH,NONSENSE")).toEqual(["HIGH"]);
  });

  it("filtersOf maps the parsed params onto the model's filter shape", () => {
    expect(
      filtersOf({ group: "none", state: ["s1"], assignee: ["m1"], priority: ["HIGH"], hideDone: true }),
    ).toEqual({ ...NO_FILTERS, stateIds: ["s1"], assigneeIds: ["m1"], priorities: ["HIGH"], hideDone: true });
  });
});

describe("workViewHref — one '?' per URL, always", () => {
  const base = "/projects/ACME/backlog";

  it("no params at all is the bare path — no trailing '?'", () => {
    expect(workViewHref(base, {})).toBe(base);
    expect(listHrefOf(base, {})).toBe(base);
    expect(listHrefOf(base, { item: "ACME-1" })).toBe(base);
  });

  it("preserves what the member had chosen and appends the peek correctly", () => {
    expect(peekHrefOf(base, { group: "epic" }, "ACME-3")).toBe(`${base}?group=epic&item=ACME-3`);
  });

  it("THE BUG THIS REPLACES: a second param used to produce two '?'", () => {
    // The old form was `${listHref}${includeArchived ? "&" : "?"}item=…`,
    // which emitted `?group=epic?item=…` the moment a filter joined the
    // archived toggle. One '?' and no duplicate keys, whatever the input.
    const href = peekHrefOf(base, { archived: "1", group: "epic", hideDone: "true" }, "ACME-3");
    expect(href.match(/\?/g)).toHaveLength(1);
    const query = new URLSearchParams(href.split("?")[1]);
    expect(query.getAll("item")).toEqual(["ACME-3"]);
    expect(query.get("archived")).toBe("1");
    expect(query.get("group")).toBe("epic");
  });

  it("a repeated param survives as a repeat, and a patch replaces rather than appends", () => {
    expect(workViewHref(base, { state: ["a", "b"] })).toBe(`${base}?state=a&state=b`);
    expect(workViewHref(base, { item: "ACME-1" }, { item: "ACME-2" })).toBe(`${base}?item=ACME-2`);
  });

  it("null deletes, and deleting the last param returns the bare path", () => {
    expect(workViewHref(base, { item: "ACME-1", error: "x" }, { item: null, error: null })).toBe(base);
  });

  it("the peek's return link drops a stale error token, so a reopened peek is not pre-failed", () => {
    expect(listHrefOf(base, { group: "epic", item: "ACME-1", error: "FORBIDDEN" })).toBe(`${base}?group=epic`);
  });

  it("encodes values rather than pasting them", () => {
    expect(workViewHref(base, {}, { item: "ACME-1&x=2" })).toBe(`${base}?item=ACME-1%26x%3D2`);
  });
});

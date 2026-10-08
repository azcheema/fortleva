import { describe, expect, it } from "vitest";

import { DomainError } from "@/lib/domain-error";

import { ALL_METRICS_INCLUDED, normalizeUpdateBody, type UpdateBody } from "./update-body";
import {
  bodyOfFrame,
  layoutFrame,
  parseLayoutMetrics,
  parseLayoutSections,
  readLayout,
  STANDARD_LAYOUT,
  type UpdateLayout,
} from "./update-layout";

/**
 * The layout rules (C73 (d), (g)) and the composer's frame: what a layout may
 * hold, and how a draft is laid out under it — never losing text when the
 * layout changes under a draft.
 */

const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
const refused = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof DomainError ? e.code : "other";
  }
  return null;
};

describe("parseLayoutSections", () => {
  it("keeps the order, the fixed keys and the workspace's own headings", () => {
    expect(
      parseLayoutSections([{ key: "DONE" }, { key: "CUSTOM", title: "  SEO this month " }, { key: "SUMMARY", title: "ignored" }]),
    ).toEqual([
      { key: "DONE", title: null },
      { key: "CUSTOM", title: "SEO this month" },
      { key: "SUMMARY", title: null },
    ]);
  });

  it("DONE is always in a layout (C73 (g))", () => {
    expect(refused(() => parseLayoutSections([{ key: "SUMMARY" }, { key: "NEXT" }]))).toBe("INVALID_INPUT");
  });

  it("refuses a fixed heading twice, an unknown one, and the same own heading twice whatever its case", () => {
    expect(refused(() => parseLayoutSections([{ key: "DONE" }, { key: "DONE" }]))).toBe("INVALID_INPUT");
    expect(refused(() => parseLayoutSections([{ key: "DONE" }, { key: "WHATEVER" }]))).toBe("INVALID_INPUT");
    expect(
      refused(() => parseLayoutSections([{ key: "DONE" }, { key: "CUSTOM", title: "Risks" }, { key: "CUSTOM", title: "RISKS" }])),
    ).toBe("INVALID_INPUT");
  });

  it("at most three of the workspace's own, eight in all, and a real title each", () => {
    const own = (n: number) => Array.from({ length: n }, (_, i) => ({ key: "CUSTOM", title: `Own ${i}` }));
    expect(parseLayoutSections([{ key: "DONE" }, ...own(3)])).toHaveLength(4);
    expect(refused(() => parseLayoutSections([{ key: "DONE" }, ...own(4)]))).toBe("INVALID_INPUT");
    const all = [{ key: "SUMMARY" }, { key: "DONE" }, { key: "NEXT" }, { key: "BLOCKERS" }, { key: "DECISIONS_NEEDED" }];
    expect(parseLayoutSections([...all, ...own(3)])).toHaveLength(8);
    expect(refused(() => parseLayoutSections([{ key: "DONE" }, { key: "CUSTOM", title: "   " }]))).toBe("INVALID_INPUT");
    expect(refused(() => parseLayoutSections([{ key: "DONE" }, { key: "CUSTOM", title: "a\nb" }]))).toBe("INVALID_INPUT");
    expect(refused(() => parseLayoutSections([{ key: "DONE" }, { key: "CUSTOM", title: "x".repeat(121) }]))).toBe("INVALID_INPUT");
    expect(refused(() => parseLayoutSections([]))).toBe("INVALID_INPUT");
    expect(refused(() => parseLayoutSections("DONE"))).toBe("INVALID_INPUT");
  });
});

describe("parseLayoutMetrics", () => {
  it("needs every group as a boolean", () => {
    expect(parseLayoutMetrics({ tasks: true, milestones: false, versions: true, requests: false, hours: false })).toEqual({
      tasks: true,
      milestones: false,
      versions: true,
      requests: false,
      hours: false,
    });
    expect(refused(() => parseLayoutMetrics({ tasks: true }))).toBe("INVALID_INPUT");
    expect(refused(() => parseLayoutMetrics({ ...ALL_METRICS_INCLUDED, hours: "yes" }))).toBe("INVALID_INPUT");
  });
});

describe("readLayout", () => {
  it("a stored value this build would not write reads as the standard layout", () => {
    expect(readLayout({ sections: [{ key: "SUMMARY" }], metricsIncluded: ALL_METRICS_INCLUDED })).toBe(STANDARD_LAYOUT);
    expect(readLayout({ sections: null, metricsIncluded: null })).toBe(STANDARD_LAYOUT);
  });
});

const layout: UpdateLayout = {
  sections: [
    { key: "SUMMARY", title: null },
    { key: "CUSTOM", title: "SEO this month" },
    { key: "DONE", title: null },
  ],
  metrics: { ...ALL_METRICS_INCLUDED, hours: false },
};
const empty: UpdateBody = { sections: [], metrics: { include: ALL_METRICS_INCLUDED } };

describe("layoutFrame", () => {
  it("a new update: the layout's headings in its order, DOM-safe ids", () => {
    const { slots, docs } = layoutFrame(layout, empty);
    expect(slots).toEqual([
      { id: "SUMMARY", key: "SUMMARY", title: null },
      { id: "custom-0", key: "CUSTOM", title: "SEO this month" },
      { id: "DONE", key: "DONE", title: null },
    ]);
    expect(docs).toEqual({});
  });

  it("a draft fills its headings, own ones matched by title whatever the case", () => {
    const body: UpdateBody = {
      sections: [
        { key: "DONE", title: null, body: doc("shipped") },
        { key: "CUSTOM", title: "seo THIS month", body: doc("ranked") },
      ],
      metrics: { include: ALL_METRICS_INCLUDED },
    };
    const { slots, docs } = layoutFrame(layout, body);
    expect(slots.map((s) => s.id)).toEqual(["SUMMARY", "custom-0", "DONE"]);
    expect(docs).toEqual({ "custom-0": doc("ranked"), DONE: doc("shipped") });
  });

  it("NEVER LOSES TEXT when the layout changed under a draft: what it no longer has comes after, in the draft's order", () => {
    const body: UpdateBody = {
      sections: [
        { key: "BLOCKERS", title: null, body: doc("waiting on DNS") },
        { key: "CUSTOM", title: "Risks", body: doc("budget") },
        { key: "SUMMARY", title: null, body: doc("fine") },
      ],
      metrics: { include: ALL_METRICS_INCLUDED },
    };
    const { slots, docs } = layoutFrame(layout, body);
    expect(slots).toEqual([
      { id: "SUMMARY", key: "SUMMARY", title: null },
      { id: "custom-0", key: "CUSTOM", title: "SEO this month" },
      { id: "DONE", key: "DONE", title: null },
      { id: "BLOCKERS", key: "BLOCKERS", title: null },
      { id: "custom-1", key: "CUSTOM", title: "Risks" },
    ]);
    expect(docs).toEqual({ BLOCKERS: doc("waiting on DNS"), "custom-1": doc("budget"), SUMMARY: doc("fine") });
  });

  it("two stored sections under one title keep both (each fills one heading)", () => {
    const body: UpdateBody = {
      sections: [
        { key: "CUSTOM", title: "SEO this month", body: doc("one") },
        { key: "CUSTOM", title: "SEO this month", body: doc("two") },
      ],
      metrics: { include: ALL_METRICS_INCLUDED },
    };
    const { slots, docs } = layoutFrame(layout, body);
    expect(slots.filter((s) => s.key === "CUSTOM")).toHaveLength(2);
    expect(Object.values(docs)).toEqual([doc("one"), doc("two")]);
  });
});

describe("bodyOfFrame", () => {
  it("saves only headings with text, in the frame's order, titled when they are the workspace's own", () => {
    const { slots } = layoutFrame(layout, empty);
    const body = bodyOfFrame(slots, { DONE: doc("shipped"), "custom-0": doc("ranked"), SUMMARY: null }, ALL_METRICS_INCLUDED);
    expect(body.sections).toEqual([
      { key: "CUSTOM", title: "SEO this month", body: doc("ranked") },
      { key: "DONE", title: null, body: doc("shipped") },
    ]);
  });

  it("round-trips through the server's own normaliser and back into the same frame", () => {
    const { slots } = layoutFrame(layout, empty);
    const sent = bodyOfFrame(slots, { SUMMARY: doc("fine"), "custom-0": doc("ranked") }, layout.metrics);
    const stored = normalizeUpdateBody(sent).body;
    const again = layoutFrame(layout, stored);
    expect(again.slots).toEqual(slots);
    expect(again.docs).toEqual({ SUMMARY: stored.sections[0]!.body, "custom-0": stored.sections[1]!.body });
  });
});

describe("normalizeUpdateBody", () => {
  it("refuses the same heading of the workspace's own twice, whatever its case (the design review's L6)", () => {
    expect(
      refused(() =>
        normalizeUpdateBody({
          sections: [
            { key: "CUSTOM", title: "Risks", body: doc("a") },
            { key: "CUSTOM", title: "risks", body: doc("b") },
          ],
        }),
      ),
    ).toBe("INVALID_INPUT");
  });
});

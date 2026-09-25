import { describe, expect, it } from "vitest";

import { DomainError } from "@/lib/domain-error";

import {
  ALL_METRICS_INCLUDED,
  UPDATE_SECTIONS_MAX,
  UPDATE_SECTION_KEYS,
  normalizeUpdateBody,
  readUpdateBody,
} from "./update-body";

const doc = (...content: unknown[]) => ({ type: "doc", content });
const para = (...content: unknown[]) => ({ type: "paragraph", content });
const text = (value: string) => ({ type: "text", text: value });
const section = (key: string, body: unknown, title?: string) => ({ key, body, ...(title !== undefined ? { title } : {}) });

const code = (fn: () => unknown): string => {
  try {
    fn();
    return "resolved";
  } catch (e) {
    return e instanceof DomainError ? e.code : String(e);
  }
};

describe("normalizeUpdateBody", () => {
  it("keeps the sections that say something, in the order sent, and joins their text", () => {
    const out = normalizeUpdateBody({
      sections: [
        section("SUMMARY", doc(para(text("Going well")))),
        section("DONE", doc(para())),
        section("NEXT", doc(para(text("Launch")))),
      ],
    });
    expect(out.body.sections.map((s) => s.key)).toEqual(["SUMMARY", "NEXT"]);
    expect(out.body.sections[0]).toMatchObject({ key: "SUMMARY", title: null });
    expect(out.text).toBe("Going well\n\nLaunch");
    expect(out.body.metrics.include).toEqual(ALL_METRICS_INCLUDED);
  });

  it("says nothing when every section is empty — the publish gate reads that as UPDATE_EMPTY", () => {
    const out = normalizeUpdateBody({ sections: [section("SUMMARY", doc(para()))] });
    expect(out.body.sections).toEqual([]);
    expect(out.text).toBeNull();
  });

  it("refuses a shape that is not a body, an unknown key, and a fixed key twice", () => {
    expect(code(() => normalizeUpdateBody(null))).toBe("INVALID_INPUT");
    expect(code(() => normalizeUpdateBody({ sections: "no" }))).toBe("INVALID_INPUT");
    expect(code(() => normalizeUpdateBody({ sections: [section("RISKS", doc(para(text("x"))))] }))).toBe("INVALID_INPUT");
    expect(
      code(() =>
        normalizeUpdateBody({
          sections: [section("DONE", doc(para(text("a")))), section("DONE", doc(para(text("b"))))],
        }),
      ),
    ).toBe("INVALID_INPUT");
    expect(
      code(() =>
        normalizeUpdateBody({
          sections: Array.from({ length: UPDATE_SECTIONS_MAX + 1 }, (_, i) => section("CUSTOM", doc(para(text("x"))), `S${i}`)),
        }),
      ),
    ).toBe("INVALID_INPUT");
  });

  it("a CUSTOM section needs a title; a fixed one never keeps one", () => {
    expect(code(() => normalizeUpdateBody({ sections: [section("CUSTOM", doc(para(text("x"))))] }))).toBe("INVALID_INPUT");
    expect(code(() => normalizeUpdateBody({ sections: [section("CUSTOM", doc(para(text("x"))), "   ")] }))).toBe("INVALID_INPUT");
    const out = normalizeUpdateBody({
      sections: [section("CUSTOM", doc(para(text("x"))), "  Budget  "), section("NEXT", doc(para(text("y"))), "ignored")],
    });
    expect(out.body.sections[0]).toMatchObject({ key: "CUSTOM", title: "Budget" });
    expect(out.body.sections[1]).toMatchObject({ key: "NEXT", title: null });
  });

  it("puts every section's document through the description normaliser — a crafted link does not survive", () => {
    const out = normalizeUpdateBody({
      sections: [
        section(
          "SUMMARY",
          doc(para({ type: "text", text: "click", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] })),
        ),
      ],
    });
    expect(JSON.stringify(out.body)).not.toContain("javascript:");
    expect(code(() => normalizeUpdateBody({ sections: [section("SUMMARY", { type: "paragraph" })] }))).toBe("INVALID_INPUT");
  });

  it("reads the metric toggles strictly: booleans only, absent groups default to included", () => {
    const out = normalizeUpdateBody({
      sections: [section("SUMMARY", doc(para(text("x"))))],
      metrics: { include: { hours: false } },
    });
    expect(out.body.metrics.include).toEqual({ ...ALL_METRICS_INCLUDED, hours: false });
    expect(
      code(() =>
        normalizeUpdateBody({ sections: [section("SUMMARY", doc(para(text("x"))))], metrics: { include: { hours: "no" } } }),
      ),
    ).toBe("INVALID_INPUT");
    expect(code(() => normalizeUpdateBody({ sections: [], metrics: 1 }))).toBe("INVALID_INPUT");
  });

  it("the fixed vocabulary is the five questions, in reading order", () => {
    expect([...UPDATE_SECTION_KEYS]).toEqual(["SUMMARY", "DONE", "NEXT", "BLOCKERS", "DECISIONS_NEEDED"]);
  });
});

describe("readUpdateBody", () => {
  it("is total: what the normaliser stores reads back, and anything else reads as empty", () => {
    const stored = normalizeUpdateBody({
      sections: [section("DONE", doc(para(text("shipped"))))],
      metrics: { include: { versions: false } },
    }).body;
    expect(readUpdateBody(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
    expect(readUpdateBody(null)).toEqual({ sections: [], metrics: { include: ALL_METRICS_INCLUDED } });
    expect(readUpdateBody({ sections: [{ key: "NOPE", body: {} }, { key: "NEXT", body: "text" }] })).toEqual({
      sections: [],
      metrics: { include: ALL_METRICS_INCLUDED },
    });
  });
});

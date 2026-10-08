import { describe, expect, it } from "vitest";

import { DomainError } from "@/lib/domain-error";

import {
  ALL_METRICS_INCLUDED,
  UPDATE_SECTIONS_MAX,
  UPDATE_PREFILL_MAX_TASKS,
  UPDATE_SECTION_KEYS,
  newUpdateBody,
  normalizeUpdateBody,
  readUpdateBody,
  sharedDoneLines,
} from "./update-body";
import type { ChangesSinceLast } from "./update-snapshot";

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

describe("a new update's pre-filled 'What got done' (founder decision C70 (d))", () => {
  const changes: ChangesSinceLast = {
    window: { from: "2026-10-02T00:00:00.000Z", to: "2026-10-09T00:00:00.000Z" },
    doneItems: [
      { id: "i1", key: "ACME-1", title: "Shared task", visibility: "CLIENT_VISIBLE" },
      { id: "i2", key: "ACME-2", title: "SECRET internal task", visibility: "INTERNAL" },
    ],
    milestonesHit: [
      { id: "m1", name: "Shared milestone", visibility: "CLIENT_VISIBLE" },
      { id: "m2", name: "SECRET internal milestone", visibility: "INTERNAL" },
    ],
    versionsShipped: [
      { id: "v1", version: "1.2", title: "Checkout" },
      { id: "v2", version: "1.3", title: null },
    ],
    requestsReceived: [{ id: "r1", key: "ACME-3", title: "SECRET request title" }],
  };
  const ALL = { tasks: true, milestones: true } as const;

  it("carries only what the client can already see — never an internal task or milestone, never a request, never a task number", () => {
    const lines = sharedDoneLines(changes, ALL);
    expect(lines).toEqual(["Shared task", "Shared milestone", "1.2 — Checkout", "1.3"]);
    expect(lines.join(" ")).not.toContain("ACME-");
    expect(JSON.stringify(newUpdateBody(changes, ALL))).not.toContain("SECRET");
  });

  it("leaves out a section the client's portal does not draw (C47's switches)", () => {
    expect(sharedDoneLines(changes, { tasks: false, milestones: true })).toEqual(["Shared milestone", "1.2 — Checkout", "1.3"]);
    expect(sharedDoneLines(changes, { tasks: true, milestones: false })).toEqual(["Shared task", "1.2 — Checkout", "1.3"]);
  });

  it("opens with one DONE section holding them as a bullet list, every metric included", () => {
    const body = newUpdateBody(changes, ALL);
    expect(body.metrics.include).toEqual(ALL_METRICS_INCLUDED);
    expect(body.sections).toHaveLength(1);
    expect(body.sections[0]!.key).toBe("DONE");
    // …in a shape the service's normaliser keeps, so a save keeps it too.
    const normalized = normalizeUpdateBody(body);
    expect(normalized.text).toContain("Shared task");
    expect(normalized.text).not.toContain("SECRET");
  });

  it("opens with at most the newest twenty TASKS, in the order they finished — and every milestone and version", () => {
    const many: ChangesSinceLast = {
      ...changes,
      doneItems: Array.from({ length: 30 }, (_, n) => ({
        id: `t${n}`,
        key: `ACME-${n}`,
        title: `Task ${n}`,
        visibility: "CLIENT_VISIBLE" as const,
      })),
    };
    expect(UPDATE_PREFILL_MAX_TASKS).toBe(20);
    const text = normalizeUpdateBody(newUpdateBody(many, ALL)).text ?? "";
    // The ten oldest are left out ("Task 9" is no substring of "Task 19" or "Task 29").
    expect(text).not.toContain("Task 0");
    expect(text).not.toContain("Task 9");
    expect(text).toContain("Task 10");
    expect(text.indexOf("Task 10")).toBeLessThan(text.indexOf("Task 29"));
    expect(text).toContain("Shared milestone");
    expect(text).toContain("1.2 — Checkout");
  });

  it("opens empty when nothing shared was finished", () => {
    const quiet: ChangesSinceLast = { ...changes, doneItems: [changes.doneItems[1]!], milestonesHit: [], versionsShipped: [] };
    expect(newUpdateBody(quiet, ALL)).toEqual({ sections: [], metrics: { include: ALL_METRICS_INCLUDED } });
  });
});

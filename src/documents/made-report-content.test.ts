import { describe, expect, it } from "vitest";

import { canonicalJson, contentFingerprint, namedIds, nextMonth, reportMonthWindow, type MadeReportContent } from "./made-report-shape";

/**
 * The pure half of the monthly report Fortleva makes (Phase 7 slice 119):
 * the fingerprint the publish check compares, and the month's window.
 */

const content = (over: Partial<MadeReportContent> = {}): MadeReportContent => ({
  month: "2026-09-01",
  projects: [
    {
      id: "p1",
      name: "Website",
      health: "ON_TRACK",
      tasks: [{ id: "t1", title: "Launch", completedOn: "2026-09-12" }],
      updates: [
        {
          id: "u1",
          seq: 4,
          health: "ON_TRACK",
          title: "Week 37",
          publishedOn: "2026-09-13",
          periodStart: null,
          periodEnd: null,
          editNote: null,
          sections: [{ key: "SUMMARY", title: null, body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hi" }] }] } }],
        },
      ],
    },
  ],
  ...over,
});

describe("the fingerprint", () => {
  it("does not depend on the order of an object's keys, at any depth — a jsonb body read back twice hashes the same", () => {
    const a = canonicalJson({ b: 1, a: { d: [{ y: 1, x: 2 }], c: null } });
    const b = canonicalJson({ a: { c: null, d: [{ x: 2, y: 1 }] }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":null,"d":[{"x":2,"y":1}]},"b":1}');
  });

  it("keeps an array's order — the ticked order and a list's order are content", () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  });

  it("drops undefined as JSON does", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it("is sha256 hex, the same for the same content and different for a changed title, a dropped task or an added update", () => {
    const base = contentFingerprint(content());
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(contentFingerprint(content())).toBe(base);
    const renamed = content();
    expect(contentFingerprint({ ...renamed, projects: [{ ...renamed.projects[0]!, name: "Website 2" }] })).not.toBe(base);
    expect(contentFingerprint({ ...renamed, projects: [{ ...renamed.projects[0]!, tasks: [] }] })).not.toBe(base);
    const p = renamed.projects[0]!;
    expect(contentFingerprint({ ...renamed, projects: [{ ...p, updates: [...p.updates, { ...p.updates[0]!, id: "u2", seq: 5 }] }] })).not.toBe(base);
  });

  it("names every task and update", () => {
    expect(namedIds(content())).toEqual({ taskIds: ["t1"], updateIds: ["u1"] });
  });
});

describe("the month's window", () => {
  it("steps to the next month, December to January", () => {
    expect(nextMonth("2026-09-01")).toBe("2026-10-01");
    expect(nextMonth("2026-12-01")).toBe("2027-01-01");
    expect(() => nextMonth("2026-09-15")).toThrow();
  });

  it("is the month in the WORKSPACE'S zone — Stockholm's September starts at 22:00 UTC on 31 August", () => {
    const w = reportMonthWindow("2026-09-01", "Europe/Stockholm");
    expect(w.from.toISOString()).toBe("2026-08-31T22:00:00.000Z");
    expect(w.to.toISOString()).toBe("2026-09-30T22:00:00.000Z");
    const utc = reportMonthWindow("2026-09-01", "UTC");
    expect(utc.from.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });
});

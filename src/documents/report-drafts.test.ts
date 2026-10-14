import { describe, expect, it } from "vitest";

import type { MadeReportContent } from "./made-report-shape";
import { DRAFT_CLIENT_CAP, DRAFT_MAX_ATTEMPTS, isEmptyContent } from "./report-drafts-rules";

/**
 * The drafter's pure parts (Phase 7 slice 120; founder decision C96 (a)):
 * "a month with nothing finished and no update published gets no draft".
 */

const project = (over: Partial<MadeReportContent["projects"][number]> = {}): MadeReportContent["projects"][number] => ({
  id: "p",
  name: "P",
  health: null,
  tasks: [],
  updates: [],
  ...over,
});

describe("isEmptyContent", () => {
  it("is empty with no projects, and when every project has neither a finished task nor a published update", () => {
    expect(isEmptyContent({ month: "2026-08-01", projects: [] })).toBe(true);
    expect(isEmptyContent({ month: "2026-08-01", projects: [project(), project({ id: "q" })] })).toBe(true);
  });

  it("is not empty when any project has a finished task, or any has a published update", () => {
    const task = { id: "t", title: "Done", completedOn: "2026-08-12" };
    expect(isEmptyContent({ month: "2026-08-01", projects: [project(), project({ id: "q", tasks: [task] })] })).toBe(false);
    const update = {
      id: "u",
      seq: 1,
      health: "ON_TRACK" as const,
      title: "Week 32",
      publishedOn: "2026-08-12",
      periodStart: null,
      periodEnd: null,
      editNote: null,
      sections: [],
    };
    expect(isEmptyContent({ month: "2026-08-01", projects: [project({ updates: [update] })] })).toBe(false);
  });

  it("keeps the bounds the ledger's CHECK and the design state", () => {
    expect(DRAFT_MAX_ATTEMPTS).toBe(3);
    expect(DRAFT_CLIENT_CAP).toBe(100);
  });
});

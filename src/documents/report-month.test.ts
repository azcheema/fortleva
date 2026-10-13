import { describe, expect, it } from "vitest";

import {
  defaultReportMonth,
  latestReportMonth,
  parseReportMonth,
  reportMonthDate,
  reportMonthFormValue,
  reportMonthOf,
} from "./report-month";

describe("a report's month (slice 115, C91 (d))", () => {
  it("parses a form's YYYY-MM into the month's first day", () => {
    expect(parseReportMonth("2026-09")).toBe("2026-09-01");
    expect(parseReportMonth(" 2026-12 ")).toBe("2026-12-01");
    expect(parseReportMonth("2000-01")).toBe("2000-01-01");
    expect(parseReportMonth("2099-12")).toBe("2099-12-01");
  });

  it("refuses anything else — the database's range included", () => {
    for (const bad of ["2026-13", "2026-00", "1999-12", "2100-01", "2026-9", "2026-09-01", "September", "", null, 202609]) {
      expect(parseReportMonth(bad), String(bad)).toBeNull();
    }
  });

  it("round-trips through the date column in UTC", () => {
    const d = reportMonthDate("2026-09-01");
    expect(d.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(reportMonthOf(d)).toBe("2026-09-01");
    expect(reportMonthFormValue("2026-09-01")).toBe("2026-09");
  });

  it("allows up to the current month and starts the form at the last one", () => {
    expect(latestReportMonth("2026-10-13")).toBe("2026-10-01");
    expect(defaultReportMonth("2026-10-13")).toBe("2026-09-01");
    expect(defaultReportMonth("2027-01-02")).toBe("2026-12-01");
  });
});

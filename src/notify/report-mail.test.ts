import { describe, expect, it } from "vitest";

import { renderReportMail, reportMailKey, reportMonthLabel, REPORT_PUBLISHED_MAIL } from "./report-mail";

describe("the report-published mail (slice 115, C91 (c))", () => {
  it("is a portal template key, one per person per report", () => {
    expect(REPORT_PUBLISHED_MAIL).toBe("portal.report_published");
    expect(reportMailKey("d1", "c1")).toBe("report:d1:CONTACT:c1");
  });

  it("labels a report month in each language, in UTC", () => {
    expect(reportMonthLabel("2026-09-01", "en")).toBe("September 2026");
    expect(reportMonthLabel("2026-09-01", "sv")).toBe("september 2026");
    // January stays January whatever the process zone: the 1st in UTC.
    expect(reportMonthLabel("2027-01-01", "en")).toBe("January 2027");
  });

  it("labels nothing that is not a month's first day", () => {
    for (const bad of ["2026-09-15", "2026-13-01", "2026-00-01", "September", "", null, undefined, 20260901]) {
      expect(reportMonthLabel(bad, "en"), String(bad)).toBeNull();
    }
  });

  it("names the month and links, and names nothing else", () => {
    const en = renderReportMail("en", "2026-09-01", "https://app.example/portal/reports");
    expect(en.subject).toBe("Your September 2026 report is ready");
    expect(en.text).toContain("your report for September 2026");
    expect(en.text).toContain("https://app.example/portal/reports");
    const sv = renderReportMail("sv", "2026-09-01", "https://app.example/portal/reports");
    expect(sv.subject).toBe("Din rapport för september 2026 är klar");
    expect(sv.text).toContain("din rapport för september 2026");
    expect(sv.text).toContain("https://app.example/portal/reports");
  });

  it("refuses to write the mail without a month checked at send — fail closed", () => {
    for (const bad of ["garbage", "2026-09-15", null, undefined]) {
      expect(() => renderReportMail("en", bad, "https://app.example/portal/reports"), String(bad)).toThrow();
    }
    // Any other locale reads English.
    expect(renderReportMail("de", "2026-09-01", "x").subject).toBe("Your September 2026 report is ready");
  });
});

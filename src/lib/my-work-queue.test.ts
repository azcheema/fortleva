import { describe, expect, it } from "vitest";

import { groupQueue, queueGroupOf } from "./my-work-queue";

describe("queueGroupOf", () => {
  const today = "2026-09-17";

  it("puts a day before today in overdue, today in today", () => {
    expect(queueGroupOf("2026-09-16", today)).toBe("overdue");
    expect(queueGroupOf("2025-12-31", today)).toBe("overdue");
    expect(queueGroupOf(today, today)).toBe("today");
  });

  it("counts tomorrow through today + 7 as soon, inclusive at both ends", () => {
    expect(queueGroupOf("2026-09-18", today)).toBe("soon");
    expect(queueGroupOf("2026-09-24", today)).toBe("soon");
    expect(queueGroupOf("2026-09-25", today)).toBe("later");
  });

  it("puts an undated task in later — the rule's three groups would hide it", () => {
    expect(queueGroupOf(null, today)).toBe("later");
  });

  it("crosses a month and a year boundary by the calendar, not by string length", () => {
    expect(queueGroupOf("2027-01-03", "2026-12-28")).toBe("soon");
    expect(queueGroupOf("2027-01-05", "2026-12-28")).toBe("later");
    expect(queueGroupOf("2026-12-31", "2027-01-01")).toBe("overdue");
  });
});

describe("groupQueue", () => {
  it("returns only non-empty groups, in the fixed order, keeping each row's arrival order", () => {
    const rows = [
      { id: "a", targetDate: "2026-09-10" },
      { id: "b", targetDate: "2026-09-12" },
      { id: "c", targetDate: "2026-09-20" },
      { id: "d", targetDate: "2026-10-30" },
      { id: "e", targetDate: null },
    ];
    expect(groupQueue(rows, "2026-09-17").map((g) => [g.group, g.rows.map((r) => r.id)])).toEqual([
      ["overdue", ["a", "b"]],
      ["soon", ["c"]],
      ["later", ["d", "e"]],
    ]);
  });

  it("orders groups by the fixed order even when rows arrive in another", () => {
    const rows = [
      { id: "later", targetDate: null },
      { id: "today", targetDate: "2026-09-17" },
      { id: "overdue", targetDate: "2026-09-01" },
    ];
    expect(groupQueue(rows, "2026-09-17").map((g) => g.group)).toEqual(["overdue", "today", "later"]);
  });

  it("is empty for no rows", () => {
    expect(groupQueue([], "2026-09-17")).toEqual([]);
  });
});

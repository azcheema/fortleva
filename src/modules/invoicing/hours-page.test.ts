import { describe, expect, it } from "vitest";

import {
  HoursPageUnreadable,
  hoursPagePrint,
  hoursPageSize,
  hoursPageTitles,
  PRINTED_TASK_MAX,
  printedTask,
  printHoursMinutes,
  readHoursPage,
} from "./hours-page";
import { mentionsPaymentDetails } from "./issue-check";

const LINE_A = "00000000-0000-7000-8000-00000000000a";
const LINE_B = "00000000-0000-7000-8000-00000000000b";
const ids = new Set([LINE_A, LINE_B]);

const page = (lines: unknown) => ({ version: 1, lines });
const row = (over: Record<string, unknown> = {}) => ({ date: "2026-09-02", task: "Startpage layout", seconds: 2_700, ...over });

describe("printing hours and minutes (C81 (b))", () => {
  it("writes whole minutes as h:mm, in both languages alike", () => {
    expect(printHoursMinutes(0, false)).toBe("0:00");
    expect(printHoursMinutes(600, false)).toBe("0:10");
    expect(printHoursMinutes(45_000, false)).toBe("12:30");
    expect(printHoursMinutes(360_000 + 300, false)).toBe("100:05");
  });

  it("writes seconds when the page has any, so it adds up exactly", () => {
    expect(printHoursMinutes(3_725, true)).toBe("1:02:05");
    expect(printHoursMinutes(45_000, true)).toBe("12:30:00");
  });

  it("rounds a stray remainder to the nearest minute rather than dropping it", () => {
    expect(printHoursMinutes(89, false)).toBe("0:01");
    expect(printHoursMinutes(90, false)).toBe("0:02");
  });

  it("refuses anything but whole, non-negative seconds", () => {
    expect(() => printHoursMinutes(-1, false)).toThrow();
    expect(() => printHoursMinutes(1.5, false)).toThrow();
  });
});

describe("reading the page the database wrote — strictly", () => {
  it("reads a page, null as null", () => {
    expect(readHoursPage(null, ids)).toBeNull();
    const read = readHoursPage(page([{ lineId: LINE_A, rows: [row(), row({ task: null, seconds: 600 })] }]), ids);
    expect(read).toEqual({ lines: [{ lineId: LINE_A, rows: [row(), { date: "2026-09-02", task: null, seconds: 600 }] }] });
  });

  it.each([
    ["not an object", "[]"],
    ["another version", JSON.stringify({ version: 2, lines: [{ lineId: LINE_A, rows: [row()] }] })],
    ["no lines", JSON.stringify(page([]))],
    ["a line of another invoice", JSON.stringify(page([{ lineId: "00000000-0000-7000-8000-0000000000ff", rows: [row()] }]))],
    ["a line twice", JSON.stringify(page([{ lineId: LINE_A, rows: [row()] }, { lineId: LINE_A, rows: [row()] }]))],
    ["a line without rows", JSON.stringify(page([{ lineId: LINE_A, rows: [] }]))],
    ["a date that is no day", JSON.stringify(page([{ lineId: LINE_A, rows: [row({ date: "2026-02-30" })] }]))],
    ["a date with a time", JSON.stringify(page([{ lineId: LINE_A, rows: [row({ date: "2026-09-02T00:00:00Z" })] }]))],
    ["a task that is not text", JSON.stringify(page([{ lineId: LINE_A, rows: [row({ task: 7 })] }]))],
    ["negative seconds", JSON.stringify(page([{ lineId: LINE_A, rows: [row({ seconds: -1 })] }]))],
    ["fractional seconds", JSON.stringify(page([{ lineId: LINE_A, rows: [row({ seconds: 1.5 })] }]))],
    ["seconds as text", JSON.stringify(page([{ lineId: LINE_A, rows: [row({ seconds: "60" })] }]))],
  ])("refuses %s", (_what, json) => {
    expect(() => readHoursPage(JSON.parse(json), ids)).toThrow(HoursPageUnreadable);
  });

  it("is never stricter than the database writes (the design review's M1): a title blank to JavaScript is “Other work”, a long one is kept", () => {
    const long = "🙂".repeat(400); // 400 code points — 800 UTF-16 units
    const ch = (...codes: number[]) => String.fromCharCode(...codes);
    // NBSP + ideographic space; a tab; a newline, quotes, a backslash and a right-to-left mark.
    const odd = `Line${ch(10)}break "quoted" ${ch(92)} ${ch(0x200f)}`;
    const read = readHoursPage(
      page([{ lineId: LINE_A, rows: [row({ task: ch(0xa0, 0x3000) }), row({ task: ch(9) }), row({ task: long }), row({ task: odd })] }]),
      ids,
    )!;
    expect(read.lines[0]!.rows.map((r) => r.task)).toEqual([null, null, long, odd]);
  });

  it("a preview leaves out a line it does not know (one added meanwhile); the record never does", () => {
    const other = { lineId: "00000000-0000-7000-8000-0000000000ff", rows: [row()] };
    expect(readHoursPage(page([{ lineId: LINE_A, rows: [row()] }, other]), ids, { dropUnknownLines: true })?.lines.map((l) => l.lineId)).toEqual([LINE_A]);
    expect(readHoursPage(page([other]), ids, { dropUnknownLines: true })).toBeNull();
    expect(() => readHoursPage(page([other]), ids)).toThrow(HoursPageUnreadable);
  });
});

describe("the page as printed", () => {
  it("joins each line's own text and totals its hours, with the decimal its line said", () => {
    const read = readHoursPage(
      page([
        { lineId: LINE_A, rows: [row({ seconds: 600 }), row({ date: "2026-09-03", seconds: 600 }), row({ date: "2026-09-04", seconds: 2_400 })] },
        { lineId: LINE_B, rows: [row({ task: null, seconds: 5_400 })] },
      ]),
      ids,
    )!;
    const printed = hoursPagePrint(read, [
      { id: LINE_A, description: "Website" },
      { id: LINE_B, description: "Support" },
    ]);
    expect(printed.withSeconds).toBe(false);
    expect(printed.lines.map((l) => [l.description, l.seconds, l.quantity])).toEqual([
      ["Website", 3_600, 1_000n],
      ["Support", 5_400, 1_500n],
    ]);
  });

  it("prints seconds throughout when any hour on the page is not whole minutes", () => {
    const read = readHoursPage(page([{ lineId: LINE_A, rows: [row({ seconds: 600 })] }, { lineId: LINE_B, rows: [row({ seconds: 61 })] }]), ids)!;
    expect(hoursPagePrint(read, [{ id: LINE_A, description: "A" }, { id: LINE_B, description: "B" }]).withSeconds).toBe(true);
  });

  it("counts a stored page for the issue's audit row, never what it says", () => {
    expect(hoursPageSize(null)).toBeNull();
    expect(hoursPageSize(page([{ lineId: LINE_A, rows: [row(), row()] }, { lineId: LINE_B, rows: [row()] }]))).toEqual({ lines: 2, rows: 3 });
  });
});

describe("a task title as the breakdown prints it (the code and security reviews' low)", () => {
  const ch = (...codes: number[]) => String.fromCharCode(...codes);

  it("makes every run of whitespace one space, line breaks included", () => {
    expect(printedTask(`  Startpage${ch(10, 10)}layout${ch(9)} v2 ${ch(0xa0)}`)).toBe("Startpage layout v2");
    expect(printedTask("Checkout redesign")).toBe("Checkout redesign");
  });

  it("cuts a long title to PRINTED_TASK_MAX characters with an ellipsis, never inside a character", () => {
    const long = "🙂".repeat(PRINTED_TASK_MAX + 30);
    const printed = printedTask(long);
    expect([...printed]).toHaveLength(PRINTED_TASK_MAX);
    expect(printed.endsWith("…")).toBe(true);
    expect([...printed.slice(0, -1)].every((c) => c === "🙂")).toBe(true);
    expect(printedTask("x".repeat(PRINTED_TASK_MAX))).toBe("x".repeat(PRINTED_TASK_MAX));
  });

  it("prints an account number the raw title only spells across a line break — so the caution scans both", () => {
    const title = `Betala SE45${ch(10)}  5000 0000 0583 9825 7466`;
    expect(mentionsPaymentDetails([title])).toBe(false);
    expect(mentionsPaymentDetails([printedTask(title)])).toBe(true);
  });

  it("collects a page's titles for the payment-text caution, nothing else", () => {
    expect(hoursPageTitles(null)).toEqual([]);
    expect(
      hoursPageTitles(page([{ lineId: LINE_A, rows: [row({ task: "Pay to bankgiro 5555-1234" }), row({ task: null })] }, { lineId: LINE_B, rows: [row()] }])),
    ).toEqual(["Pay to bankgiro 5555-1234", "Startpage layout"]);
  });
});

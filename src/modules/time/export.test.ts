import { describe, expect, it } from "vitest";

import type { EntriesExport, RollupExport, WorkingTimeStatement } from "./export";
import { entriesCsv, rollupCsv, statementCsv } from "./export-csv";

/**
 * The CSV builders as pure functions (the database-backed
 * export.dbtest.ts proves the gates and the numbers; this proves the
 * SHAPE): header arity per mode, machine numbers, a negative margin that
 * must stay a number, a day with two shifts (tracked time on the first
 * row only), a tracked-only day without a shift, a provisional shift, a
 * signed "over" day, and the TOTAL row's alignment with the header.
 */

const BOM = String.fromCharCode(0xfeff);
const lines = (csv: string): string[] => (csv.startsWith(BOM) ? csv.slice(1) : csv).trimEnd().split("\r\n");
const at = (s: string) => new Date(`${s}:00Z`);
const ZONE = "Europe/Stockholm";

const entry = (over: Partial<EntriesExport["rows"][number]> = {}): EntriesExport["rows"][number] => ({
  id: "e1",
  date: "2026-08-03",
  startedAt: "2026-08-03T06:00:00.000Z",
  stoppedAt: "2026-08-03T07:30:00.000Z",
  timezone: ZONE,
  seconds: 5400,
  memberId: "m1",
  memberName: "Åsa Öberg",
  clientName: "Acme",
  projectKey: "ACME",
  projectName: "Acme site",
  taskKey: "ACME-1",
  taskTitle: "Build, the thing",
  agreement: null,
  workType: "Development",
  billable: true,
  description: "=HYPERLINK(\"http://x\")",
  entryMode: "MANUAL",
  source: "MANUAL",
  needsReview: false,
  lockedReason: null,
  rate: null,
  currency: null,
  amount: null,
  ...over,
});

describe("entriesCsv", () => {
  it("22 columns without rates, 25 with; hours machine-formatted; a comma in a title quoted; a formula note neutralised", () => {
    const plain = lines(entriesCsv({ scope: "own", range: { from: "2026-08-01", to: "2026-08-31" }, includesRates: false, rows: [entry()] }));
    expect(plain[0]!.split(",")).toHaveLength(22);
    expect(plain[1]).toBe(
      `e1,2026-08-03,2026-08-03T06:00:00.000Z,2026-08-03T07:30:00.000Z,${ZONE},5400,1.5,m1,Åsa Öberg,Acme,ACME,Acme site,ACME-1,"Build, the thing",,Development,true,"'=HYPERLINK(""http://x"")",MANUAL,MANUAL,false,`,
    );
    const rated = lines(
      entriesCsv({
        scope: "team",
        range: { from: "2026-08-01", to: "2026-08-31" },
        includesRates: true,
        rows: [entry({ rate: "1000.00", currency: "SEK", amount: "1500.00" })],
      }),
    );
    expect(rated[0]!.endsWith(",locked_reason,rate,currency,amount")).toBe(true);
    expect(rated[0]!.split(",")).toHaveLength(25);
    expect(rated[1]!.endsWith(",1000.00,SEK,1500.00")).toBe(true);
  });
});

describe("rollupCsv", () => {
  const line = (over: Partial<RollupExport["lines"][number]>): RollupExport["lines"][number] => ({
    dimension: "member",
    key: "m1",
    label: "Åsa",
    seconds: 5400,
    billableSeconds: 3600,
    amount: "1000.00",
    cost: null,
    margin: null,
    marginPercent: null,
    ...over,
  });
  const base: RollupExport = { projectId: "p1", range: { from: "2026-08-01", to: "2026-08-31" }, currency: "SEK", includesAmounts: true, includesCost: false, lines: [line({})] };

  it("7 columns bare, +2 with amounts, +3 with cost; a NEGATIVE margin stays a number (the injection guard must not touch it)", () => {
    expect(lines(rollupCsv({ ...base, includesAmounts: false }))[0]).toBe("dimension,key,label,seconds,hours,billable_seconds,billable_hours");
    expect(lines(rollupCsv(base))[1]).toBe("member,m1,Åsa,5400,1.5,3600,1,1000.00,SEK");
    const withCost = rollupCsv({
      ...base,
      includesCost: true,
      lines: [line({ cost: "1500.00", margin: "-500.00", marginPercent: -50 }), line({ dimension: "total", key: "total", label: "", cost: "1500.00", margin: "-500.00", marginPercent: -50 })],
    });
    expect(lines(withCost)[0]).toBe("dimension,key,label,seconds,hours,billable_seconds,billable_hours,amount,currency,cost,margin,margin_percent");
    expect(lines(withCost)[1]).toBe("member,m1,Åsa,5400,1.5,3600,1,1000.00,SEK,1500.00,-500.00,-50");
    expect(lines(withCost)[2]).toBe("total,total,,5400,1.5,3600,1,1000.00,SEK,1500.00,-500.00,-50");
  });
});

describe("statementCsv", () => {
  const shift = (over: Partial<WorkingTimeStatement["days"][number]["shifts"][number]>): WorkingTimeStatement["days"][number]["shifts"][number] => ({
    id: "s",
    startedAt: at("2026-08-03T06:00"),
    stoppedAt: at("2026-08-03T10:00"),
    timezone: ZONE,
    breakSeconds: 0,
    workedSeconds: 4 * 3600,
    provisional: false,
    noBreak: false,
    note: null,
    ...over,
  });
  const statement = (own: boolean): WorkingTimeStatement => ({
    memberId: "m1",
    memberName: "Åsa Öberg",
    own,
    tenantName: "Naxdor",
    month: "2026-08",
    from: "2026-08-01",
    to: "2026-08-31",
    timezone: ZONE,
    hoursPerDay: 8,
    weekdays: 21,
    expectedSeconds: 21 * 8 * 3600,
    days: [
      // Mon 3: two shifts (08:00–12:00 and 13:00–17:00) — tracked 1 h counted once, on the first row only.
      {
        date: "2026-08-03",
        shifts: [shift({ id: "s1" }), shift({ id: "s2", startedAt: at("2026-08-03T11:00"), stoppedAt: at("2026-08-03T15:00"), note: own ? "afternoon" : null })],
        spanSeconds: 8 * 3600,
        breakSeconds: 0,
        workedSeconds: 8 * 3600,
        trackedSeconds: own ? 3600 : null,
        unallocatedSeconds: own ? 7 * 3600 : null,
      },
      // Tue 4: nothing at all — omitted from the file.
      { date: "2026-08-04", shifts: [], spanSeconds: 0, breakSeconds: 0, workedSeconds: 0, trackedSeconds: own ? 0 : null, unallocatedSeconds: own ? 0 : null },
      // Wed 5: tracked time without a shift — an own row with the shift columns empty; omitted on a team statement.
      { date: "2026-08-05", shifts: [], spanSeconds: 0, breakSeconds: 0, workedSeconds: 0, trackedSeconds: own ? 1800 : null, unallocatedSeconds: own ? -1800 : null },
      // Thu 6: a provisional 14 h auto-closed shift, no break → both flags; and more tracked than worked → signed "over".
      {
        date: "2026-08-06",
        shifts: [shift({ id: "s3", startedAt: at("2026-08-06T04:00"), stoppedAt: at("2026-08-06T18:00"), workedSeconds: 14 * 3600, provisional: true, noBreak: true })],
        spanSeconds: 14 * 3600,
        breakSeconds: 0,
        workedSeconds: 14 * 3600,
        trackedSeconds: own ? 15 * 3600 : null,
        unallocatedSeconds: own ? -3600 : null,
      },
    ],
    totals: {
      shifts: 3,
      spanSeconds: 22 * 3600,
      breakSeconds: 0,
      workedSeconds: 22 * 3600,
      trackedSeconds: own ? 16.5 * 3600 : null,
      unallocatedSeconds: own ? 5.5 * 3600 : null,
      provisional: 1,
      noBreak: 1,
    },
    generatedAt: at("2026-09-01T08:00"),
  });

  it("own: 16 columns; two-shift day carries tracked on the first row only; tracked-only day has empty shift columns; flags and signed over; TOTAL aligned with the header and its boolean columns empty", () => {
    const out = lines(statementCsv(statement(true)));
    expect(out[0]!.split(",")).toHaveLength(16);
    expect(out).toHaveLength(6); // header + 2 + 1 + 1 + TOTAL (the empty day is omitted)
    expect(out[1]).toBe(`2026-08-03,08:00,12:00,2026-08-03T06:00:00.000Z,2026-08-03T10:00:00.000Z,${ZONE},14400,0,14400,4,false,false,,3600,1,25200`);
    expect(out[2]).toBe(`2026-08-03,13:00,17:00,2026-08-03T11:00:00.000Z,2026-08-03T15:00:00.000Z,${ZONE},14400,0,14400,4,false,false,afternoon,,,`);
    expect(out[3]).toBe("2026-08-05,,,,,,,,,,,,,1800,0.5,-1800");
    expect(out[4]).toBe(`2026-08-06,06:00,20:00,2026-08-06T04:00:00.000Z,2026-08-06T18:00:00.000Z,${ZONE},50400,0,50400,14,true,true,,54000,15,-3600`);
    expect(out[5]).toBe("TOTAL,,,,,,79200,0,79200,22,,,,59400,16.5,19800");
    for (const row of out) expect(row.split(",")).toHaveLength(16);
  });

  it("team (not own): 13 columns, no tracked cells anywhere, no tracked-only rows, notes blank", () => {
    const out = lines(statementCsv(statement(false)));
    expect(out[0]!.split(",")).toHaveLength(13);
    expect(out[0]).not.toMatch(/tracked|unallocated/);
    expect(out).toHaveLength(5); // header + 2 + 1 + TOTAL
    expect(out[2]!.endsWith(",false,false,")).toBe(true);
    expect(out[4]).toBe("TOTAL,,,,,,79200,0,79200,22,,,");
    for (const row of out) expect(row.split(",")).toHaveLength(13);
  });
});

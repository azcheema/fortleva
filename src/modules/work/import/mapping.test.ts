import { describe, expect, it } from "vitest";

import { parseCsv } from "./csv-parse";
import {
  batchRows,
  buildCsvRows,
  buildTrelloRows,
  fold,
  guessColumns,
  guessDateFormat,
  guessMember,
  guessState,
  offeredStates,
  parseDateCell,
  splitLabels,
  type StateOption,
} from "./mapping";
import { IMPORT_BATCH_ROWS, IMPORT_TEXT_MAX } from "./rules";

const STATES: StateOption[] = [
  { id: "s-triage", name: "Triage", category: "TRIAGE", isDefault: false, requiresApproval: false },
  { id: "s-backlog", name: "Backlog", category: "BACKLOG", isDefault: false, requiresApproval: false },
  { id: "s-todo", name: "To do", category: "TODO", isDefault: true, requiresApproval: false },
  { id: "s-doing", name: "In progress", category: "IN_PROGRESS", isDefault: false, requiresApproval: false },
  { id: "s-review", name: "In review", category: "IN_PROGRESS", isDefault: false, requiresApproval: false },
  { id: "s-done", name: "Done", category: "DONE", isDefault: false, requiresApproval: true },
  { id: "s-cancel", name: "Cancelled", category: "CANCELLED", isDefault: false, requiresApproval: false },
];

describe("guessColumns", () => {
  it("maps English and Swedish headers, each header once", () => {
    expect(guessColumns(["Namn", "Beskrivning", "Status", "Förfallodatum", "Ansvarig", "Etiketter", "ID"])).toEqual({
      name: 0,
      description: 1,
      status: 2,
      due: 3,
      assignee: 4,
      assigneeEmail: null,
      labels: 5,
      id: 6,
    });
  });

  it("knows Asana's export", () => {
    const map = guessColumns(["Task ID", "Created At", "Name", "Section/Column", "Assignee", "Assignee Email", "Due Date", "Tags", "Notes"]);
    expect(map).toMatchObject({ id: 0, name: 2, status: 3, assignee: 4, assigneeEmail: 5, due: 6, labels: 7, description: 8 });
  });

  it("leaves a field unmapped when nothing matches", () => {
    expect(guessColumns(["Foo", "Bar"]).name).toBeNull();
  });
});

describe("dates", () => {
  it("reads ISO with or without a time, and day-first dotted dates always", () => {
    expect(parseDateCell("2026-10-15", "MDY")).toBe("2026-10-15");
    expect(parseDateCell("2026-10-15T13:00:00Z", "MDY")).toBe("2026-10-15");
    expect(parseDateCell("2026/10/15 09:00", "DMY")).toBe("2026-10-15");
    expect(parseDateCell("15.10.2026", "MDY")).toBe("2026-10-15");
  });

  it("reads slash dates in the format the member chose", () => {
    expect(parseDateCell("03/04/2026", "DMY")).toBe("2026-04-03");
    expect(parseDateCell("03/04/2026", "MDY")).toBe("2026-03-04");
  });

  it("reads written months in English and Swedish", () => {
    expect(parseDateCell("15 okt 2026", "DMY")).toBe("2026-10-15");
    expect(parseDateCell("Oct 15, 2026", "DMY")).toBe("2026-10-15");
    expect(parseDateCell("Wednesday, October 15th 2026", "DMY")).toBe("2026-10-15");
    expect(parseDateCell("15/Oct/26 2:30 PM", "DMY")).toBe("2026-10-15");
  });

  it("refuses an impossible or far-off date instead of guessing", () => {
    expect(parseDateCell("2026-02-30", "DMY")).toBeNull();
    expect(parseDateCell("31/31/2026", "DMY")).toBeNull();
    expect(parseDateCell("1899-01-01", "DMY")).toBeNull();
    expect(parseDateCell("soon", "DMY")).toBeNull();
  });

  it("tells day-first from month-first when a value says so, and asks otherwise", () => {
    expect(guessDateFormat(["03/04/2026", "25/04/2026"])).toEqual({ format: "DMY", ambiguous: false });
    expect(guessDateFormat(["03/04/2026", "04/25/2026"])).toEqual({ format: "MDY", ambiguous: false });
    expect(guessDateFormat(["03/04/2026", "05/06/2026"])).toEqual({ format: "DMY", ambiguous: true });
    expect(guessDateFormat(["2026-10-15", "15.10.2026"])).toEqual({ format: "DMY", ambiguous: false });
  });
});

describe("labels and people", () => {
  it("splits labels on commas and semicolons, de-duplicates case-insensitively", () => {
    expect(splitLabels("Design, SEO; design ,  ")).toEqual(["Design", "SEO"]);
    expect(splitLabels("x".repeat(60))).toEqual(["x".repeat(40)]);
  });

  it("matches a person by email first, then by exact folded name — never fuzzily", () => {
    const members = [
      { id: "m1", name: "Anna Bergström", email: "anna@naxdor.se" },
      { id: "m2", name: "Bo Ek", email: "bo@naxdor.se" },
    ];
    expect(guessMember({ name: "Someone", email: "ANNA@naxdor.se" }, members)).toBe("m1");
    expect(guessMember({ name: "anna bergstrom", email: null }, members)).toBe("m1");
    expect(guessMember({ name: "Anna", email: null }, members)).toBeNull();
    expect(guessMember({ name: "", email: null }, members)).toBeNull();
  });

  it("does not guess between two members with the same name", () => {
    const twins = [
      { id: "a", name: "Kim Lee", email: "a@x.se" },
      { id: "b", name: "Kim Lee", email: "b@x.se" },
    ];
    expect(guessMember({ name: "Kim Lee", email: null }, twins)).toBeNull();
  });
});

describe("states", () => {
  it("never offers triage, and offers a gated state only with the approve code", () => {
    expect(offeredStates(STATES, false).map((s) => s.id)).toEqual(["s-backlog", "s-todo", "s-doing", "s-review", "s-cancel"]);
    expect(offeredStates(STATES, true).map((s) => s.id)).toContain("s-done");
  });

  it("matches the state's own name, then a category's words, then the default", () => {
    const offered = offeredStates(STATES, true);
    expect(guessState("in review", offered)).toBe("s-review");
    expect(guessState("Klar", offered)).toBe("s-done");
    expect(guessState("Pågår", offered)).toBe("s-doing");
    expect(guessState("Done ✅", offered)).toBe("s-done");
    expect(guessState("Won't do", offered)).toBe("s-cancel");
    expect(guessState("Something else", offered)).toBe("s-todo");
    expect(guessState("", offered)).toBe("s-todo");
  });

  it("falls back to the default when the matching category is not offered", () => {
    expect(guessState("done", offeredStates(STATES, false))).toBe("s-todo");
  });
});

describe("buildCsvRows", () => {
  const csv = parseCsv(
    [
      "ID;Namn;Status;Förfallodatum;Ansvarig;Etiketter;Beskrivning",
      "A1;Ny startsida;Klar;15.10.2026;Anna Bergström;Design, SEO;Rad ett",
      "A2;;Klar;;;;",
      "A1;Dubblett;Att göra;not a date;;;",
      ";Utan id;;;;;",
    ].join("\n"),
  );
  const columns = guessColumns(csv.headers);

  it("builds rows, counts what the check step must say", () => {
    const { rows, stats } = buildCsvRows({
      csv,
      columns,
      dateFormat: "DMY",
      stateFor: new Map([[fold("Klar"), "s-done"]]),
      defaultStateId: "s-todo",
      memberFor: new Map([[fold("Anna Bergström"), "m1"]]),
      existingLabels: ["design"],
    });
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      sourceId: "A1",
      title: "Ny startsida",
      stateId: "s-done",
      targetDate: "2026-10-15",
      assigneeMemberId: "m1",
      labels: ["Design", "SEO"],
      text: "Rad ett",
    });
    // The repeated id is imported WITHOUT one; an unknown status is the default.
    expect(rows[1]).toMatchObject({ sourceId: null, title: "Dubblett", stateId: "s-todo", targetDate: null });
    expect(rows[2]).toMatchObject({ sourceId: null, title: "Utan id" });
    expect(stats).toMatchObject({ skippedNoName: 1, badDates: 1, duplicateIds: 1, shortened: 0, newLabels: ["SEO"] });
  });

  it("cuts an over-long description and counts it", () => {
    const long = parseCsv(`Name,Notes\nTask,${"x".repeat(IMPORT_TEXT_MAX + 10)}`);
    const { rows, stats } = buildCsvRows({
      csv: long,
      columns: guessColumns(long.headers),
      dateFormat: "DMY",
      stateFor: new Map(),
      defaultStateId: "s-todo",
      memberFor: new Map(),
      existingLabels: [],
    });
    expect(rows[0]!.text).toHaveLength(IMPORT_TEXT_MAX);
    expect(rows[0]!.text.endsWith("…")).toBe(true);
    expect(stats.shortened).toBe(1);
  });

  it("never cuts through an emoji (a lone surrogate would refuse the batch)", () => {
    const emoji = String.fromCodePoint(0x1f600);
    // The cut lands exactly between the emoji's two halves.
    const text = `${"x".repeat(IMPORT_TEXT_MAX - 2)}${emoji}tail`;
    const long = parseCsv(`Name,Notes\nTask,${text}`);
    const { rows } = buildCsvRows({
      csv: long,
      columns: guessColumns(long.headers),
      dateFormat: "DMY",
      stateFor: new Map(),
      defaultStateId: "s-todo",
      memberFor: new Map(),
      existingLabels: [],
    });
    const out = rows[0]!.text;
    const last = out.charCodeAt(out.length - 2);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("buildTrelloRows", () => {
  it("keeps the card id, list mapping, first member, checklists and link", () => {
    const { rows, stats } = buildTrelloRows({
      board: {
        lists: [{ id: "L1", name: "Doing" }],
        members: [{ id: "T1", name: "Anna Bergström" }],
        cards: [
          {
            id: "C1",
            name: "Card",
            desc: "Body",
            listId: "L1",
            due: "2026-10-20",
            memberId: "T1",
            labels: ["Bug"],
            checklists: [{ name: null, items: [{ text: "One", done: true }] }],
            link: "https://trello.com/c/abc",
          },
          { id: "C2", name: "  ", desc: "", listId: "L1", due: null, memberId: null, labels: [], checklists: [], link: null },
        ],
        archivedCards: 3,
      },
      stateFor: new Map([["L1", "s-doing"]]),
      defaultStateId: "s-todo",
      memberFor: new Map([["T1", "m1"]]),
      existingLabels: [],
    });
    expect(rows).toEqual([
      {
        sourceId: "C1",
        title: "Card",
        text: "Body",
        checklists: [{ name: null, items: [{ text: "One", done: true }] }],
        link: "https://trello.com/c/abc",
        stateId: "s-doing",
        targetDate: "2026-10-20",
        assigneeMemberId: "m1",
        labels: ["Bug"],
      },
    ]);
    expect(stats.skippedNoName).toBe(1);
  });
});

describe("batchRows", () => {
  it(`splits at ${IMPORT_BATCH_ROWS} rows`, () => {
    const row = { sourceId: null, title: "t", text: "", checklists: [], link: null, stateId: "s", targetDate: null, assigneeMemberId: null, labels: [] };
    const batches = batchRows(Array.from({ length: IMPORT_BATCH_ROWS * 2 + 1 }, () => row));
    expect(batches.map((b) => b.length)).toEqual([IMPORT_BATCH_ROWS, IMPORT_BATCH_ROWS, 1]);
  });

  it("splits by size before a batch could pass the server-action limit", () => {
    const big = { sourceId: null, title: "t", text: "x".repeat(30_000), checklists: [], link: null, stateId: "s", targetDate: null, assigneeMemberId: null, labels: [] };
    const batches = batchRows(Array.from({ length: 60 }, () => big));
    expect(batches.length).toBeGreaterThan(1);
    for (const b of batches) expect(new TextEncoder().encode(JSON.stringify(b)).length).toBeLessThan(1024 * 1024);
  });
});

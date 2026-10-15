import { describe, expect, it } from "vitest";

import {
  IMPORT_BATCH_ROWS,
  IMPORT_CHECKLIST_ITEMS_MAX,
  importBatchSchema,
  importRowSchema,
  isImportDay,
  isTrelloLink,
  restoreOpen,
  stampsOnBirth,
  startImportSchema,
  undoOpen,
} from "./rules";

const ROW = {
  sourceId: "A1",
  title: "Task",
  text: "",
  checklists: [],
  link: null,
  stateId: "0199f5a0-0000-7000-8000-000000000001",
  targetDate: null,
  assigneeMemberId: null,
  labels: [],
};

describe("importRowSchema", () => {
  it("accepts a plain row and trims", () => {
    expect(importRowSchema.parse({ ...ROW, title: "  Task  ", sourceId: " A1 " })).toMatchObject({ title: "Task", sourceId: "A1" });
  });

  it("refuses what the server must never trust", () => {
    expect(importRowSchema.safeParse({ ...ROW, title: "   " }).success).toBe(false);
    expect(importRowSchema.safeParse({ ...ROW, stateId: "not-a-uuid" }).success).toBe(false);
    expect(importRowSchema.safeParse({ ...ROW, link: "https://evil.test/c/x" }).success).toBe(false);
    expect(importRowSchema.safeParse({ ...ROW, targetDate: "2026-02-30" }).success).toBe(false);
    expect(importRowSchema.safeParse({ ...ROW, extra: 1 }).success).toBe(false);
    expect(importRowSchema.safeParse({ ...ROW, labels: ["x".repeat(41)] }).success).toBe(false);
    const many = Array.from({ length: IMPORT_CHECKLIST_ITEMS_MAX + 1 }, () => ({ text: "i", done: false }));
    expect(importRowSchema.safeParse({ ...ROW, checklists: [{ name: null, items: many }] }).success).toBe(false);
  });

  it("folds a label name to one clean line, and drops one with nothing visible in it (slice 123)", () => {
    const zwsp = String.fromCharCode(0x200b);
    const rlo = String.fromCharCode(0x202e);
    const row = importRowSchema.parse({
      ...ROW,
      labels: ["Bug\tfix", `Bug ${zwsp} fix`, `${rlo}Urgent`, `${zwsp}${zwsp}`, "   "],
    });
    // A tab is a space; a zero-width character leaves no double space (it
    // would look exactly like "Bug fix"); a bidi override is gone; a name
    // that was only invisible characters, or blank, is dropped — the batch
    // is not refused for one stray cell.
    expect(row.labels).toEqual(["Bug fix", "Bug fix", "Urgent"]);
  });

  it(`takes 1–${IMPORT_BATCH_ROWS} rows a batch`, () => {
    expect(importBatchSchema.safeParse([]).success).toBe(false);
    expect(importBatchSchema.safeParse(Array.from({ length: IMPORT_BATCH_ROWS + 1 }, () => ROW)).success).toBe(false);
  });

  it("checks the start", () => {
    const start = { projectId: ROW.stateId, source: "CSV", fileName: "tasks.csv", rowCount: 10 };
    expect(startImportSchema.safeParse(start).success).toBe(true);
    expect(startImportSchema.safeParse({ ...start, rowCount: 2001 }).success).toBe(false);
    expect(startImportSchema.safeParse({ ...start, source: "JIRA" }).success).toBe(false);
    expect(startImportSchema.safeParse({ ...start, fileName: " " }).success).toBe(false);
  });
});

describe("small rules", () => {
  it("a Trello link is https://trello.com only", () => {
    expect(isTrelloLink("https://trello.com/c/AbCd")).toBe(true);
    expect(isTrelloLink("http://trello.com/c/AbCd")).toBe(false);
    expect(isTrelloLink("https://trello.com.evil.test/c")).toBe(false);
    expect(isTrelloLink("https://u:p@trello.com/c")).toBe(false);
  });

  it("an import day is a real day in 1970–2100", () => {
    expect(isImportDay("2028-02-29")).toBe(true);
    expect(isImportDay("2026-02-29")).toBe(false);
    expect(isImportDay("2101-01-01")).toBe(false);
    expect(isImportDay("15.10.2026")).toBe(false);
  });

  it("the windows", () => {
    const t = new Date("2026-10-15T12:00:00Z");
    expect(undoOpen(t, new Date("2026-10-22T12:00:00Z"))).toBe(true);
    expect(undoOpen(t, new Date("2026-10-22T12:00:01Z"))).toBe(false);
    expect(restoreOpen(t, new Date("2026-11-14T12:00:00Z"))).toBe(true);
    expect(restoreOpen(t, new Date("2026-11-14T12:00:01Z"))).toBe(false);
  });

  it("strips what the database refuses from every text, and controls and bidi marks from a file name", () => {
    const lone = String.fromCharCode(0xd83d);
    const rlo = String.fromCharCode(0x202e);
    const bell = String.fromCharCode(7);
    const row = importRowSchema.parse({ ...ROW, title: `Task${lone}`, text: `Body${lone}`, labels: [`Tag${lone}`] });
    expect(row).toMatchObject({ title: "Task", text: "Body", labels: ["Tag"] });
    const start = startImportSchema.parse({ projectId: ROW.stateId, source: "CSV", fileName: `${rlo}evil${bell}.csv`, rowCount: 1 });
    expect(start.fileName).toBe("evil.csv");
  });

  it("a birth stamps what the state machine would", () => {
    const now = new Date();
    expect(stampsOnBirth("IN_PROGRESS", now)).toEqual({ startedAt: now, completedAt: null });
    expect(stampsOnBirth("DONE", now)).toEqual({ startedAt: null, completedAt: now });
    expect(stampsOnBirth("TODO", now)).toEqual({ startedAt: null, completedAt: null });
  });
});

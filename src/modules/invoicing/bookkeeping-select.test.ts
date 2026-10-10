import { describe, expect, it } from "vitest";

import { selectForFile } from "./bookkeeping-select";

type C = { key: string; dependsOn: string[]; group: string; companion?: string };
const c = (key: string, group: string, ...dependsOn: string[]): C => ({ key, group, dependsOn });
const mate = (x: C, companion: string): C => ({ ...x, companion });
const pick = (sorted: C[], max = 1000) => selectForFile(sorted, (x) => x.group, max).map((x) => x.key);

describe("selectForFile", () => {
  it("takes the earliest fileable event's group, and what it unblocks", () => {
    // y (last year) is fileable; x's payment (last year) waits on its reversal (this year).
    const sorted = [c("pay-x", "2025", "undo-x"), c("pay-y", "2025"), c("undo-x", "2026")];
    expect(pick(sorted)).toEqual(["pay-y"]);
    // Next file: only the reversal is fileable — its own year.
    expect(pick([c("pay-x", "2025", "undo-x"), c("undo-x", "2026")])).toEqual(["undo-x"]);
    // Then the payment, its reversal filed (no longer a dependency).
    expect(pick([c("pay-x", "2025")])).toEqual(["pay-x"]);
  });

  it("puts what an event waits on before it, in the same file when the group allows", () => {
    const sorted = [c("pay-x", "2026", "undo-x"), c("note-x", "2026", "undo-x", "pay-x"), c("undo-x", "2026")];
    expect(pick(sorted)).toEqual(["undo-x", "pay-x", "note-x"]);
  });

  it("never keeps an event without what it waits on when the cap cuts", () => {
    const sorted = [c("a", "2026"), c("pay-x", "2026", "undo-x"), c("undo-x", "2026")];
    expect(pick(sorted, 1)).toEqual(["a"]);
    expect(pick(sorted, 2)).toEqual(["a", "undo-x"]);
    expect(pick(sorted, 3)).toEqual(["a", "undo-x", "pay-x"]);
  });

  it("keeps one group per file — another seller or year waits", () => {
    expect(pick([c("a", "2026|Old AB"), c("b", "2026|New AB"), c("c", "2026|Old AB")])).toEqual(["a", "c"]);
  });

  it("files a late payment with its year end's withdrawal, and the reversal's withdrawal in the next year (slice 111b)", () => {
    // A payment on 2026-12-30 marked after the 2026 year end was booked and reversed.
    const sorted = [
      c("pay-x", "2026", "ye-undo-x"),
      mate(c("ye-undo-x", "2026"), "pay-x"),
      c("rev-undo-x", "2027", "ye-undo-x"),
      c("pay-y", "2027"),
    ];
    expect(pick(sorted)).toEqual(["ye-undo-x", "pay-x"]); // the old year: both, together — the withdrawal first
    expect(pick([c("rev-undo-x", "2027"), c("pay-y", "2027")])).toEqual(["rev-undo-x", "pay-y"]);
  });

  it("never files a withdrawal without its payment: a unit waits on what any member waits on (the review's M1 (a))", () => {
    // A January payment corrected to 30 December: its reversal (this year) first, then the withdrawal AND the payment.
    const sorted = [
      c("pay-x", "2026", "undo-x", "ye-undo-x"),
      mate(c("ye-undo-x", "2026"), "pay-x"),
      c("undo-x", "2027"),
      c("rev-undo-x", "2027", "ye-undo-x"),
    ];
    expect(pick(sorted)).toEqual(["undo-x"]); // the withdrawal alone would be fileable — but not without its payment
    expect(pick([c("pay-x", "2026", "ye-undo-x"), mate(c("ye-undo-x", "2026"), "pay-x"), c("rev-undo-x", "2027", "ye-undo-x")])).toEqual([
      "ye-undo-x",
      "pay-x",
    ]);
  });

  it("keeps a unit whole at the cap — the review's M1 (c)", () => {
    const sorted = [c("a", "2026"), c("pay-x", "2026", "ye-undo-x"), mate(c("ye-undo-x", "2026"), "pay-x"), c("b", "2026")];
    expect(pick(sorted, 2)).toEqual(["a", "b"]); // no room for both: neither
    expect(pick(sorted, 3)).toEqual(["a", "ye-undo-x", "pay-x"]);
  });

  it("chooses the year from a unit that can go — never one waiting on another year (the re-check's R1)", () => {
    // A January payment corrected to 30 December: the reversal (this year, today), then the unit, then the reversal's withdrawal.
    const all = [
      c("pay-x", "2026", "undo-x", "ye-undo-x"),
      mate(c("ye-undo-x", "2026"), "pay-x"),
      c("undo-x", "2027"),
      c("rev-undo-x", "2027", "ye-undo-x"),
    ];
    expect(pick(all)).toEqual(["undo-x"]);
    const after1 = [c("pay-x", "2026", "ye-undo-x"), mate(c("ye-undo-x", "2026"), "pay-x"), c("rev-undo-x", "2027", "ye-undo-x")];
    expect(pick(after1)).toEqual(["ye-undo-x", "pay-x"]);
    expect(pick([c("rev-undo-x", "2027")])).toEqual(["rev-undo-x"]);
  });

  it("joins three into one unit, and lets linked events of different years stand alone", () => {
    const three = [c("pay-x", "2026", "undo-x", "ye-undo-x"), mate(c("undo-x", "2026"), "pay-x"), mate(c("ye-undo-x", "2026"), "pay-x")];
    // An empty file takes a first unit whole, past the cap — never stranded.
    expect(pick(three, 2)).toEqual(["undo-x", "ye-undo-x", "pay-x"]);
    expect(pick([c("a", "2026"), ...three], 2)).toEqual(["a"]);
    expect(pick(three)).toEqual(["undo-x", "ye-undo-x", "pay-x"]);
    // A link across years is no unit: the dependency alone orders them.
    const apart = [c("pay-x", "2025", "ye-undo-x"), mate(c("ye-undo-x", "2026"), "pay-x")];
    expect(pick(apart)).toEqual(["ye-undo-x"]);
  });

  it("is empty when nothing is fileable", () => {
    expect(pick([])).toEqual([]);
    expect(pick([c("a", "2026", "gone")])).toEqual([]);
    expect(pick([c("a", "2026")], 0)).toEqual([]);
  });
});

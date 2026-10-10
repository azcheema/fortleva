import { describe, expect, it } from "vitest";

import { selectForFile } from "./bookkeeping-select";

type C = { key: string; dependsOn: string[]; group: string };
const c = (key: string, group: string, ...dependsOn: string[]): C => ({ key, group, dependsOn });
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

  it("is empty when nothing is fileable", () => {
    expect(pick([])).toEqual([]);
    expect(pick([c("a", "2026", "gone")])).toEqual([]);
    expect(pick([c("a", "2026")], 0)).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";

import { attentionRank, portfolioOrder, type OrderInput } from "./portfolio-order";

const row = (name: string, o: Partial<OrderInput> = {}): OrderInput & { name: string } => ({
  name,
  running: true,
  health: null,
  schedule: null,
  ...o,
});

describe("the project health table's order (slice 116, C92 (c))", () => {
  it("ranks Off track, then At risk, then a late update, then the rest", () => {
    const rows = [
      row("on track", { health: "ON_TRACK" }),
      row("late", { health: "ON_TRACK", schedule: { state: "late" } }),
      row("no update"),
      row("at risk", { health: "AT_RISK" }),
      row("off track", { health: "OFF_TRACK" }),
      row("due today", { schedule: { state: "due" } }),
    ];
    expect(portfolioOrder(rows).map((r) => r.name)).toEqual([
      "off track",
      "at risk",
      "late",
      "on track",
      "no update",
      "due today",
    ]);
  });

  it("puts a late project that is also Off track at the top, on its health", () => {
    expect(attentionRank(row("x", { health: "OFF_TRACK", schedule: { state: "late" } }))).toBe(0);
    expect(attentionRank(row("x", { health: "AT_RISK", schedule: { state: "late" } }))).toBe(1);
  });

  it("puts every finished project after every running one, worrying or not", () => {
    const rows = [
      row("finished, off track", { running: false, health: "OFF_TRACK" }),
      row("running, on track", { health: "ON_TRACK" }),
      row("finished, complete", { running: false, health: "COMPLETE" }),
      row("running, at risk", { health: "AT_RISK" }),
    ];
    expect(portfolioOrder(rows).map((r) => r.name)).toEqual([
      "running, at risk",
      "running, on track",
      "finished, off track",
      "finished, complete",
    ]);
  });

  it("keeps the incoming order (client, then name) within a rank, and never mutates its input", () => {
    const rows = [row("a"), row("b", { health: "ON_HOLD" }), row("c", { health: "COMPLETE" }), row("d")];
    const before = rows.map((r) => r.name);
    expect(portfolioOrder(rows).map((r) => r.name)).toEqual(["a", "b", "c", "d"]);
    expect(rows.map((r) => r.name)).toEqual(before);
  });
});

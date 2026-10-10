import { describe, expect, it } from "vitest";

import {
  billedSeconds,
  hoursLines,
  hoursQuantity,
  roundingRuleOf,
  type HourForLine,
  type RoundingRule,
} from "./hours-lines";

const min = (m: number) => m * 60;
const rule = (stepMinutes: RoundingRule["stepMinutes"], mode: RoundingRule["mode"], minimumMinutes: number | null = null): RoundingRule => ({
  stepMinutes,
  mode,
  minimumMinutes,
});

describe("billedSeconds — each entry rounded by its project's rule (C75 (b), C80 (c))", () => {
  it("off: the tracked seconds, unchanged", () => {
    expect(billedSeconds(83, null)).toBe(83);
    expect(billedSeconds(0, null)).toBe(0);
  });

  it("up, nearest and down to a 15-minute step", () => {
    expect(billedSeconds(min(5), rule(15, "UP"))).toBe(min(15));
    expect(billedSeconds(min(15), rule(15, "UP"))).toBe(min(15));
    expect(billedSeconds(min(15) + 1, rule(15, "UP"))).toBe(min(30));
    expect(billedSeconds(min(7), rule(15, "NEAREST"))).toBe(0);
    // A half rounds up, as every rounding here does.
    expect(billedSeconds(min(7) + 30, rule(15, "NEAREST"))).toBe(min(15));
    expect(billedSeconds(min(22), rule(15, "NEAREST"))).toBe(min(15));
    expect(billedSeconds(min(23), rule(15, "NEAREST"))).toBe(min(30));
    expect(billedSeconds(min(29), rule(15, "DOWN"))).toBe(min(15));
    expect(billedSeconds(min(14), rule(15, "DOWN"))).toBe(0);
  });

  it("three 5-minute calls at a 15-minute step up bill 45 minutes (the founder's example)", () => {
    const each = [min(5), min(5), min(5)].map((s) => billedSeconds(s, rule(15, "UP")));
    expect(each.reduce((a, b) => a + b, 0)).toBe(min(45));
  });

  it("every step the project may choose", () => {
    expect(billedSeconds(61, rule(1, "UP"))).toBe(120);
    expect(billedSeconds(min(7), rule(6, "UP"))).toBe(min(12));
    expect(billedSeconds(min(11), rule(10, "DOWN"))).toBe(min(10));
    expect(billedSeconds(min(31), rule(30, "NEAREST"))).toBe(min(30));
    expect(billedSeconds(min(61), rule(60, "UP"))).toBe(min(120));
  });

  it("a minimum lifts a short entry — after the step, whatever its direction", () => {
    expect(billedSeconds(min(5), rule(15, "UP", 30))).toBe(min(30));
    expect(billedSeconds(min(10), rule(15, "DOWN", 15))).toBe(min(15));
    expect(billedSeconds(min(50), rule(15, "UP", 30))).toBe(min(60));
  });

  it("an entry of nothing bills nothing, minimum or not", () => {
    expect(billedSeconds(0, rule(15, "UP", 30))).toBe(0);
  });

  it("refuses a fraction or a negative", () => {
    expect(() => billedSeconds(1.5, null)).toThrow();
    expect(() => billedSeconds(-1, rule(15, "UP"))).toThrow();
  });
});

describe("roundingRuleOf — the project's three columns", () => {
  it("is null while rounding is off", () => {
    expect(roundingRuleOf({ invoiceRoundingStep: null, invoiceRoundingMode: null, invoiceRoundingMinimum: null })).toBeNull();
  });
  it("reads a rule", () => {
    expect(roundingRuleOf({ invoiceRoundingStep: 15, invoiceRoundingMode: "UP", invoiceRoundingMinimum: 30 })).toEqual(rule(15, "UP", 30));
  });
  it("is null for a step or a direction it does not know", () => {
    expect(roundingRuleOf({ invoiceRoundingStep: 7, invoiceRoundingMode: "UP", invoiceRoundingMinimum: null })).toBeNull();
    expect(roundingRuleOf({ invoiceRoundingStep: 15, invoiceRoundingMode: "SIDEWAYS", invoiceRoundingMinimum: null })).toBeNull();
  });
});

describe("hoursQuantity — seconds to hours at three decimals, once", () => {
  it("converts and rounds half away from zero", () => {
    expect(hoursQuantity(3600)).toBe(1000n);
    expect(hoursQuantity(min(83))).toBe(1383n); // 1,3833… h
    expect(hoursQuantity(min(10))).toBe(167n); // 0,1666… h
    expect(hoursQuantity(9)).toBe(3n); // 0,0025 h — a half, up
    expect(hoursQuantity(0)).toBe(0n);
  });
  it("sums before it converts: six 10-minute entries are exactly one hour", () => {
    expect(hoursQuantity(6 * min(10))).toBe(1000n);
  });
});

const hour = (over: Partial<HourForLine> & { id: string }): HourForLine => ({
  projectId: "p1",
  projectName: "Webshop",
  workItemId: null,
  sharedTaskTitle: null,
  serviceId: null,
  visibleAgreementName: null,
  memberId: "m1",
  memberName: "Anna Berg",
  rate: 95_000n,
  billedSeconds: 3600,
  ...over,
});

const texts = { otherWork: "Other work" };

describe("hoursLines — the lines a set of hours makes (C80 (b))", () => {
  it("per project: one line, quantity × rate", () => {
    const lines = hoursLines([hour({ id: "a" }), hour({ id: "b", billedSeconds: 1800 })], "PROJECT", texts);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ description: "Webshop", quantity: 1500n, unitPrice: 95_000n, amount: 142_500n, noRate: false });
    expect(lines[0]!.entryIds).toEqual(["a", "b"]);
  });

  it("a different hourly rate is always its own line, the higher first; no rate last, at no price", () => {
    const lines = hoursLines(
      [hour({ id: "a", rate: 80_000n }), hour({ id: "b", rate: 120_000n }), hour({ id: "c", rate: null })],
      "PROJECT",
      texts,
    );
    expect(lines.map((l) => [l.unitPrice, l.noRate])).toEqual([
      [120_000n, false],
      [80_000n, false],
      [0n, true],
    ]);
    expect(lines[2]!.amount).toBe(0n);
  });

  it("per task: a task the client may see by its title, every other hour as Other work", () => {
    const lines = hoursLines(
      [
        hour({ id: "a", workItemId: "w1", sharedTaskTitle: "Checkout redesign" }),
        hour({ id: "b", workItemId: "w2", sharedTaskTitle: null }),
        hour({ id: "c", workItemId: null }),
      ],
      "TASK",
      texts,
    );
    expect(lines.map((l) => [l.description, l.entryIds])).toEqual([
      ["Checkout redesign", ["a"]],
      ["Other work", ["b", "c"]],
    ]);
  });

  it("per task: two shared tasks with the same title stay two lines", () => {
    const lines = hoursLines(
      [hour({ id: "a", workItemId: "w1", sharedTaskTitle: "Fixes" }), hour({ id: "b", workItemId: "w2", sharedTaskTitle: "Fixes" })],
      "TASK",
      texts,
    );
    expect(lines).toHaveLength(2);
  });

  it("per agreement: a visible agreement by its name, else the project's", () => {
    const lines = hoursLines(
      [
        hour({ id: "a", serviceId: "s1", visibleAgreementName: "Support plan" }),
        hour({ id: "b", serviceId: "s2", visibleAgreementName: null }),
        hour({ id: "c" }),
      ],
      "AGREEMENT",
      texts,
    );
    expect(lines.map((l) => [l.description, l.entryIds])).toEqual([
      ["Support plan", ["a"]],
      ["Webshop", ["b", "c"]],
    ]);
  });

  it("per person: the member's name", () => {
    const lines = hoursLines([hour({ id: "a" }), hour({ id: "b", memberId: "m2", memberName: "Bo Ek" })], "PERSON", texts);
    expect(lines.map((l) => l.description)).toEqual(["Anna Berg", "Bo Ek"]);
  });

  it("across projects every grouping splits by project and says which", () => {
    const two = [
      hour({ id: "a", workItemId: null }),
      hour({ id: "b", projectId: "p2", projectName: "App", workItemId: null }),
    ];
    expect(hoursLines(two, "TASK", texts).map((l) => l.description)).toEqual(["Other work — App", "Other work — Webshop"]);
    expect(hoursLines(two, "PERSON", texts).map((l) => l.description)).toEqual(["Anna Berg — App", "Anna Berg — Webshop"]);
    expect(hoursLines(two, "PROJECT", texts).map((l) => l.description)).toEqual(["App", "Webshop"]);
    expect(hoursLines(two, "AGREEMENT", texts).map((l) => l.description)).toEqual(["App", "Webshop"]);
  });

  it("a long title is cut to what a line holds", () => {
    const lines = hoursLines([hour({ id: "a", workItemId: "w1", sharedTaskTitle: "x".repeat(2500) })], "TASK", texts);
    expect(lines[0]!.description).toHaveLength(2000);
  });

  it("no hours, no lines", () => {
    expect(hoursLines([], "PROJECT", texts)).toEqual([]);
  });
});

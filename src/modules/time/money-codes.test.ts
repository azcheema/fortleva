import { describe, expect, it } from "vitest";

import { PERMISSIONS } from "@/authz/catalog";

import { BUDGET_ALERT_ENTITY, PROJECT_MONEY_CODES } from "./money-codes";

/**
 * THE MONEY PAGE'S GATE IS PINNED HERE, BECAUSE NOTHING ELSE CAN SEE IT
 * CHANGE. `projectMoney` asks `PROJECT_MONEY_CODES`, and the inbox asks the
 * same list before it links a budget alert to that page — so the inbox
 * dbtest, which holds the two to each other, stays green whatever the list
 * says. Dropping `time:view_team` from it would open the Money page to any
 * custom role holding `rate:view_bill` alone, and every test would pass.
 * Changing the list is allowed; doing it without looking at this is not.
 */
describe("the Money page's codes", () => {
  it("are exactly these two — a change here widens or narrows who reads a project's money", () => {
    expect([...PROJECT_MONEY_CODES]).toEqual(["time:view_team", "rate:view_bill"]);
  });

  it("are catalogue codes, and none is ✦ — the inbox would hide the link from a member the page only asks to step up", () => {
    const byCode = new Map(PERMISSIONS.map((p) => [p.code, p]));
    for (const code of PROJECT_MONEY_CODES) {
      expect(byCode.has(code), code).toBe(true);
      expect(byCode.get(code)?.requiresMfa, code).toBe(false);
    }
  });

  it("the budget alert's entity is the string stored rows already carry — renaming it would unlink every alert written so far", () => {
    expect(BUDGET_ALERT_ENTITY).toBe("ProjectBudget");
  });
});

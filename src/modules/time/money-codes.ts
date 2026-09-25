/**
 * The codes the project Money page (`/projects/[key]/money`) demands, on
 * all four gates: `projectMoney` asks each in turn, and the inbox asks the
 * same list before it links a budget alert there (founder decision C34,
 * 2026-09-25). One list, so the link can never promise a page that
 * refuses. The page ALSO needs `project:view` and the project in scope
 * (`loadProject` 404s otherwise); the inbox covers those through the
 * project NAME it resolves first, so they are not repeated here.
 * `money-codes.test.ts` pins the list, because a code dropped from it
 * would open the page wider and every other test would still pass.
 *
 * NEVER A ✦ CODE HERE. `accessibleCodes` reads a stale second factor as
 * "not held", so a step-up code in this list would hide the link from a
 * member the page would merely ask to step up.
 *
 * A module of its own, with no imports, so the notify layer depends on a
 * contract rather than on the time module's service code.
 */
export const PROJECT_MONEY_CODES = ["time:view_team", "rate:view_bill"] as const;

/**
 * The entity a budget alert names — `budgets.ts` emits it, and the inbox
 * links a row naming it to the Money page. One constant, so renaming it in
 * one place cannot silently strip every budget alert of its link.
 */
export const BUDGET_ALERT_ENTITY = "ProjectBudget";

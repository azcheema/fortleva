import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `listItems` resolves its caps ONCE (C29b) — a TRIPWIRE, not a proof.
 *
 * The caps' VALUES are pinned in `work.dbtest.ts`, which cannot see how
 * many queries produced them. What this catches is the regression the
 * refactor removed: the read's interactive-transaction batch held five
 * `isAuthorized` legs beside its three reads — eight concurrent
 * statements on one connection, the shape AGENTS.md's `Promise.all` trap
 * is about — and a revert to that passes every value test there is.
 * Reformatting can defeat a scan like this; it is a tripwire, and the
 * dbtest is the proof of what the caps say.
 */
describe("listItems resolves its caps in one read", () => {
  const source = readFileSync(join(process.cwd(), "src", "modules", "work", "items.ts"), "utf8");
  const start = source.indexOf("export async function listItems(");
  const end = source.indexOf("async function activeMembers(", start);
  const body = source.slice(start, end);

  it("finds the function it scans", () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
  });

  it("calls authorizedCodes, and no isAuthorized", () => {
    expect(body).toContain("authorizedCodes(tx, ctx.actor, [");
    expect(body).not.toMatch(/\bisAuthorized\(/);
  });
});

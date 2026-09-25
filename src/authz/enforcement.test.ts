import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PERMISSIONS } from "./catalog";

/**
 * EVERY PERMISSION CODE EITHER GUARDS SOMETHING OR SAYS WHY NOT.
 *
 * A code with no enforcement site is not automatically a bug — this
 * catalogue is deliberately ahead of the product. Codes are IMMUTABLE
 * `resource:verb` identifiers forever (AGENTS.md: deprecate, never
 * rename), so declaring a module's codes when the module is designed,
 * rather than when it ships, is what stops a later slice minting a
 * second spelling for the same capability. Four whole modules' worth of
 * the list below — contracts, invoicing, reports, continuity_box —
 * exist for exactly that reason, and a fifth group is deprecated.
 *
 * What IS a bug is the pair drifting silently, in either direction, and
 * the audit that found them was a hand-written script run once
 * (2026-09-20, PLAN §0 ordered item 3). PLAN §0 had recorded "four
 * permission codes with no enforcement site" from the §§2W/2T audit;
 * the real number across the whole catalogue was thirty-seven, which is
 * what a count scoped to two modules and then quoted as a total does.
 * This test is that script, kept.
 *
 * THE ASSERTION IS AN EQUALITY, not a subset, and that is the half that
 * earns its keep. A code added with no site and not declared here fails
 * — the obvious direction. But so does a declared code that GAINS a
 * site: the day someone builds the invoicing module, this test fails
 * until `invoice:issue` leaves the list, which is the precise moment a
 * reviewer should be asked whether the new guard is in the right place.
 * A subset assertion would have let that ship silently, and silently is
 * how an authorization gap gets old.
 *
 * WHAT COUNTS AS A SITE: the code's literal string appearing anywhere in
 * `src/` outside this catalogue, outside test files, and outside
 * `nav.ts`. Deliberately crude otherwise — it cannot tell
 * `requireAccess(…, "x:y")` from a mention in a comment, and a tighter
 * matcher would have to know every call shape (`requireAccess`,
 * `isAuthorized`, `effectivePermissions().has`, the template seeds, a
 * UI capability check). Crude and honest beats clever and wrong: the
 * failure that matters is a false NEGATIVE, a code that LOOKS enforced
 * and is not, and adding a code's string to a comment to silence this
 * is not something anyone does by accident.
 *
 * `nav.ts` IS EXCLUDED BECAUSE OF ONE, and it is worth naming. A nav
 * entry's `permission` hides a rail link; it is a visibility hint, never
 * a gate, and a page reached by typing its URL never consults it. On the
 * first run of this test `member:view` counted as enforced on the
 * strength of `nav.ts:123` alone — while `/members` ran on
 * `requireTenantContext()` and handed the full roster and every pending
 * invite's email to any member of a custom role that lacked the
 * permission. A REVIEW found that, not this test, which is exactly the
 * false negative the paragraph above admits to. The page has its guard
 * now (2026-09-20), and the one file that can make a link look like a
 * lock is out of the scan so the next one cannot hide the same way.
 */

/**
 * Declared ahead of the feature that will enforce them, by module, with
 * the reason. Remove a code from here in the same commit that gives it
 * a real guard — the test will tell you when that is.
 */
const DECLARED_AHEAD: Record<string, readonly string[]> = {
  // Phase 4 and beyond: no service, no route, no model writer in the
  // product yet. The codes exist so the modules' names are already
  // spoken for.
  contracts: ["contract:view", "contract:create", "contract:edit", "contract:send", "contract:delete"],
  invoicing: [
    "invoice:view",
    "invoice:create",
    "invoice:edit",
    "invoice:issue",
    "invoice:send",
    "invoice:record_payment",
    "invoice:credit",
    "invoice:delete",
    "invoice:manage_series",
  ],
  reports: ["report:view", "report:upload", "report:delete"],
  continuity_box: [
    "continuity_box:view",
    "continuity_box:edit",
    "continuity_box:configure",
    "continuity_box:veto",
  ],
  // DEPRECATED module (2026-08-16: absorbed by `work`). The codes stay
  // forever and seed nowhere from TEMPLATE_VERSION 2 — they will never
  // gain a site, which is the point of keeping them.
  issues: ["issue:view", "issue:create", "issue:edit", "issue:comment", "issue:delete"],
  core: [
    // Subscription billing is the platform plane's, and the tenant-side
    // screens do not exist.
    "billing:view",
    "billing:manage",
    // No audit VIEWER — no screen, no route, nothing that lists events
    // for a member to read. The log is not write-only, though, and the
    // first draft of this comment said it was: the tenant's own data
    // export dumps it (`EXPORT_MODELS` in `src/export/manifest.ts`,
    // through a dynamic delegate, which is why grepping for
    // `auditEvent.findMany` misses it). That path is gated by
    // `tenant:export`, deliberately — the export is all-or-nothing by
    // design — so `audit:view` still guards nothing.
    "audit:view",
  ],
  work: [
    // Triage SHIPPED on 2026-09-22 (Phase 3 slice 6b): `work_item:triage`
    // is enforced in `src/modules/work/triage.ts`, so it is no longer
    // declared here. It was the oldest name on this list.
    // The app CREATES a project's default states lazily
    // (`ensureProjectStates`) and reads them; it has never updated or
    // deleted one, so there is no "edit a project's workflow" to guard.
    "workflow:manage",
    // ProjectUpdate SHIPPED on 2026-09-25 (Phase 3 slice 67): all four
    // `project_update:*` codes are enforced in `src/modules/work/updates.ts`.
    // ProjectTemplate: the model is in the schema, no `templates.ts`.
    "project_template:manage",
  ],
  time: [
    // The LOCK is real at the database — a locked entry refuses every
    // edit (ENTRY_LOCKED) and the time week renders a `Locked` badge —
    // but nothing in the app ever WRITES `TimeEntry.lockedAt`. The
    // writer is invoicing's (`invoiceLineId` is marked Phase 4), so
    // there is no lock to manage yet. The UI is ready for a state that
    // cannot occur.
    "time:manage_locks",
  ],
};

/** Every `.ts`/`.tsx` under `src/` except generated code, tests and the catalogue itself. */
function sourceText(): string {
  const parts: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        if (entry !== "generated") walk(path);
        continue;
      }
      if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue;
      // The same pattern `src/db/import-boundary.test.ts` uses: a
      // `.test.tsx` is a test too, and scanning one as production source
      // would let it launder an unguarded code into the enforced set.
      if (/\.(test|dbtest)\.[cm]?[jt]sx?$/.test(entry)) continue;
      // And the test-only helpers that carry no such suffix —
      // `dbtest-fixture.ts`, `dbtest-locks.ts`. A fixture that grants a
      // role a literal code would otherwise mark it "enforced" from a
      // file no member ever runs, which is the same false negative
      // `nav.ts` produced (review).
      if (/^(test|dbtest)-/.test(entry)) continue;
      // THIS catalogue, by path — `entry === "catalog.ts"` also skipped
      // `src/audit/catalog.ts` and `src/notify/catalog.ts`, which are
      // ordinary source and could legitimately carry a code.
      if (path === join("src", "authz", "catalog.ts")) continue;
      // A nav entry hides a link; it is never a gate. See the header.
      if (path === join("src", "app", "(tenant)", "(authed)", "nav.ts")) continue;
      parts.push(readFileSync(path, "utf8"));
    }
  };
  walk("src");
  return parts.join("\n");
}

describe("permission enforcement", () => {
  const declared = Object.values(DECLARED_AHEAD).flat();

  it("every code with no enforcement site is declared ahead, and every declared one still has none", () => {
    const text = sourceText();
    const unenforced = PERMISSIONS.map((p) => p.code).filter((code) => !text.includes(`"${code}"`));

    // Sorted on both sides so a failure reads as a diff of names rather
    // than of orderings.
    expect([...unenforced].sort(), "the catalogue and DECLARED_AHEAD have drifted").toEqual(
      [...declared].sort(),
    );
  });

  it("DECLARED_AHEAD names only real codes, once each", () => {
    // A rename or a typo here would silently excuse nothing and hide a
    // real code forever, since the equality above would then fail on a
    // name nobody can find.
    const codes = new Set(PERMISSIONS.map((p) => p.code));
    expect(declared.filter((c) => !codes.has(c)), "DECLARED_AHEAD names no such code").toEqual([]);
    expect(declared.length, "a code is declared twice").toBe(new Set(declared).size);
  });

  it("every declared code is filed under its own module", () => {
    // The grouping is the reason-giving: a code filed under the wrong
    // module gets the wrong justification read over it.
    const moduleOf = new Map(PERMISSIONS.map((p) => [p.code, p.module as string]));
    const misfiled = Object.entries(DECLARED_AHEAD).flatMap(([group, codes]) =>
      codes.filter((c) => moduleOf.get(c) !== group).map((c) => `${c} filed under ${group}`),
    );
    expect(misfiled).toEqual([]);
  });
});

import { expect, test, type Page } from "@playwright/test";

import { offscreenRowActions, tableOverflow, type TableOverflow } from "./audit";
import { SLOW } from "./fixtures/keys";
import { driftFor, VOLATILE_STOPS } from "./fixtures/overflow";
import { settle } from "./fixtures/settle";
import { RUNG_WIDTHS, stops, VIEWPORTS } from "./fixtures/stops";
import { requireSeed } from "./fixtures/tenant";

/**
 * THE SWEDISH WIDTH WALK — PLAN §0's owed (c), and slice 17's owed (d)
 * before it: "the harness cannot see Swedish or a scrollbar at all".
 *
 * Swedish is this product's FIRST locale and the wider one in almost
 * every string a table shows ("Ingen prioritet", "Ingen ansvarig",
 * "Fakturerbart", "Överlappar"), yet every width this harness has ever
 * measured was English. The gap is not theoretical: the backlog is 0 px
 * over its box in English and ~30 px over at `lowest`'s narrow edge in
 * Swedish, measured by hand with a throwaway probe on 2026-09-18 and
 * recorded in UI.md §10.12 as a settled TRADE — a trade nothing could
 * check, and which therefore could not tell "as designed" from "worse
 * than we thought" on any later change.
 *
 * WHY THIS FILE IS CALLED `zz-`, and it is load-bearing rather than
 * lazy. Switching the language writes `User.locale` on the ONE member
 * every spec shares, through Better Auth so the session cache sees it
 * (`switchLocaleAction` — a direct database write would not be seen).
 * Playwright runs files alphabetically with `workers: 1`, so any spec
 * sorting after this one would read its English copy out of a Swedish
 * page if a restore ever failed. `work.spec.ts` is the one that would.
 * The prefix puts this last; the restore below is belt and braces.
 *
 * WHAT IT MEASURES, and what it deliberately does not. Tables only:
 * `tableOverflow` and `offscreenRowActions`, at 390 px and every rung
 * width. No screenshots and no craft audit — those are language-blind
 * (a contrast ratio and a row's height do not read Swedish), they are
 * the expensive half of the English walk, and doubling them would buy
 * nothing the eye does not already get from the English shots.
 */

/**
 * THE SWEDISH RATCHET, keyed `<stop>@<width>` exactly as
 * `KNOWN_OVERFLOW` is, and EMPTY on purpose until CI has spoken.
 *
 * Every number in a walk like this has to be CI's own. A local run
 * measures a different app — Windows font metrics against ubuntu's,
 * 2-8 px per string on the evidence this repo already has — and the
 * standing rule in `visual.spec.ts` says it in as many words:
 * re-calibrate from a CI log, never from a local visual-only run. So
 * this map lands empty, the walk PRINTS every number it finds
 * (`[swedish] …`, the shape that made the exempt stops legible in slice
 * 31), and the next commit pastes CI's own numbers in and turns the
 * assertion on. A first run that went red on Windows numbers would
 * teach nothing except that the two platforms differ, which is known.
 *
 * What belongs here when it is filled: the settled TRADES of UI.md
 * §10.12 — a rung may carry a little scroll at its very edge, since the
 * actions column is pinned and a row's verbs never scroll — labelled as
 * trades. A number that is NOT a trade is a defect and belongs in a fix.
 *
 * TWO CARVE-OUTS COME FROM THE ENGLISH WALK, shared rather than
 * re-invented (`fixtures/overflow.ts`), and this walk needs BOTH more
 * than that one does because it runs LAST — after `time.spec.ts` has
 * written every entry, split and shift it is going to write:
 *   • `VOLATILE_STOPS` is exempt, printed and never asserted. Those five
 *     stops' tables are sized by rows earlier specs leave behind, and
 *     the same `project-money` cell has measured 4, 9, 15, 16 and 21px
 *     across five runs.
 *   • `driftFor` gives every listed number the same proportional 1-4px
 *     of CI-to-CI slack the English ratchet gets. These are TEXT-metric
 *     numbers, the class this repo records as moving 2-8px between
 *     platforms, so zero tolerance would turn an unrelated change red.
 */
const KNOWN_OVERFLOW_SV: Record<string, number> = {};

/** Asserted from the first run: the pin is language-blind, so it must hold everywhere. */
const SV_WIDTHS = [VIEWPORTS.mobile.width, ...RUNG_WIDTHS] as const;

/**
 * Switch the shared member's UI language and WAIT FOR THE SERVER to
 * agree — `<html lang>` is rendered from the resolved locale (ARC-14),
 * so it is the one signal that cannot be the client's local state.
 *
 * The option labels are endonyms in both catalogues ("Svenska",
 * "English"), which is what makes one helper work in both directions.
 */
async function setLanguage(page: Page, name: "Svenska" | "English", lang: "sv" | "en") {
  await page.goto("/account");
  const trigger = page.locator("#locale");
  await expect(trigger).toBeVisible({ timeout: 30_000 * SLOW });
  await trigger.click();
  await page.getByRole("option", { name, exact: true }).click();
  await expect
    .poll(() => page.locator("html").getAttribute("lang"), { timeout: 30_000 * SLOW })
    .toBe(lang);
}

/**
 * Run a page probe, settling and retrying ONCE if the page moved under
 * it. A route that redirects from inside a streamed render destroys the
 * execution context mid-evaluate — the first version of this walk died
 * that way — and settling before every one of the 480 measurements cost
 * more than the whole walk's budget. This pays only where it happens.
 */
async function measure<T>(page: Page, probe: () => T): Promise<T> {
  try {
    return await page.evaluate(probe);
  } catch {
    await settle(page);
    return await page.evaluate(probe);
  }
}

/**
 * NAME ROT, the same guard `KNOWN_OVERFLOW` carries (review). A ratchet
 * entry keyed on a stop that has been renamed, or at a width this walk
 * never visits, is INERT — it asserts nothing and looks like coverage.
 * Empty today, which is the point: the guard has to exist before the
 * numbers do, or the commit that adds them is the one that gets it
 * wrong. Runs in-process, with no browser and no page.
 */
test("every KNOWN_OVERFLOW_SV key is a real stop at a width this walk measures", () => {
  const names = new Set(stops(requireSeed()).map((s) => s.name));
  const keys = Object.keys(KNOWN_OVERFLOW_SV);
  expect(
    keys.filter((k) => !names.has(k.slice(0, k.lastIndexOf("@")))),
    "KNOWN_OVERFLOW_SV keys naming no stop",
  ).toEqual([]);
  expect(
    keys.filter(
      (k) => !SV_WIDTHS.includes(Number(k.slice(k.lastIndexOf("@") + 1)) as (typeof SV_WIDTHS)[number]),
    ),
    "KNOWN_OVERFLOW_SV keys at a width this walk never visits",
  ).toEqual([]);
  // And that an exempt stop is never ALSO ratcheted — two answers to the
  // same question, of which the ratchet's would silently never be asked.
  expect(
    keys.filter((k) => VOLATILE_STOPS.has(k.slice(0, k.lastIndexOf("@")))),
    "KNOWN_OVERFLOW_SV keys on a stop that is exempt anyway",
  ).toEqual([]);
});

test.describe("swedish · widths", () => {
  test.use({ viewport: VIEWPORTS.desktop });

  test("every table fits its box in Swedish, and every row's verbs stay in view", async ({
    page,
  }) => {
    // 600 s on both, unlike the English walk's 600/300 split, and
    // measured rather than guessed: the first local run took 5.1 min and
    // was killed by a 300 s budget mid-walk — which then ran the restore
    // below against a page Playwright had already closed, turning one
    // timeout into two failures. This walk is longer than an English one
    // per stop (ten measurements against one screenshot) and shorter
    // overall (no shots, no craft audit).
    test.setTimeout(600_000);
    const seed = requireSeed();
    // Signed-out stops render no table and have no member whose language
    // could be switched, so they are not this walk's business.
    //
    // NOR IS `expectsFailure`, and the reason is worth stating because it
    // is the one place a shared stop list bites: `error-boundary` reaches
    // its state by clicking a button it names in ENGLISH ("Download"), so
    // in Swedish the click waits for a control that does not exist and
    // takes the whole walk's budget with it — measured, 600 s. It also
    // renders an error boundary, which has no table, so nothing is lost
    // by leaving it to the English walk. Every other `drive` in the list
    // is already locale-agnostic (a keystroke, a test id), and one that
    // is not can never be walked here.
    const all = stops(seed).filter((s) => !s.anon && !s.expectsFailure);

    const describe = (r: TableOverflow) => `"${r.label}" (${r.box}px box): ${r.px}px`;
    const findings: string[] = [];
    // The map is empty on the commit that introduces this walk, and an
    // empty map means "CI has not spoken yet", not "every number is 0".
    const ratcheting = Object.keys(KNOWN_OVERFLOW_SV).length > 0;

    // INSIDE the try, not before it: the switch writes `User.locale` and
    // then polls `<html lang>`, so a failure BETWEEN those two leaves the
    // member in Swedish with no restore — the one case the restore
    // exists for (review).
    try {
      await setLanguage(page, "Svenska", "sv");
      for (const stop of all) {
        await page.setViewportSize(VIEWPORTS.desktop);
        await page.goto(stop.path, { waitUntil: "domcontentloaded" });
        // The English walk's own `settle`, shared rather than copied: a
        // route that redirects from inside a streamed render destroys the
        // execution context mid-measurement, which is exactly how this
        // walk failed on its first run. The two walks must also agree on
        // what "settled" means, or their numbers are not comparable.
        await settle(page);
        // A stop that only exists after an interaction reaches it the
        // same way the English walk does — one list, one set of states.
        if (stop.drive) await stop.drive(page);
        await settle(page);

        // NINE RESIZES ARE NOT FREE, so a stop with no table at all skips
        // them: both probes below read `[data-slot=data-table]` and have
        // nothing to say without one. Asked at BOTH ENDS of the range
        // rather than at the desktop width alone — the first draft asked
        // only at 1440 and would have skipped a surface that renders a
        // table only on a phone (review). Column priority drops COLUMNS
        // and reads the table's own box, so a table is not expected to
        // come and go with width; two cheap probes are what makes that an
        // observation rather than an assumption.
        const hasTable = async () =>
          (await page.locator("[data-slot=data-table]").count()) > 0;
        if (!(await hasTable())) {
          await page.setViewportSize({ width: SV_WIDTHS[0], height: VIEWPORTS.desktop.height });
          if (!(await hasTable())) continue;
        }

        for (const width of SV_WIDTHS) {
          await page.setViewportSize({ width, height: VIEWPORTS.desktop.height });
          const at = `${stop.name} at ${width}px`;

          // THE PIN IS LANGUAGE-BLIND, so this is asserted from the very
          // first run: a row's verbs are `position: sticky` at the box's
          // right edge, and no amount of Swedish can push them out. If
          // this ever fails it is a real defect, not a calibration.
          expect
            .soft(await measure(page, offscreenRowActions), `${at}: row actions outside the box`)
            .toEqual([]);

          const over = await measure(page, tableOverflow);
          const volatile_ = VOLATILE_STOPS.has(stop.name);
          for (const row of over) {
            // EVERY number is printed, which is what the next commit
            // calibrates `KNOWN_OVERFLOW_SV` from — and, for the exempt
            // stops, all this walk will ever do with them.
            console.log(`[swedish]${volatile_ ? " [volatile]" : ""} ${at}: ${describe(row)}`);
            if (volatile_ || !ratcheting) continue;
            const known = KNOWN_OVERFLOW_SV[`${stop.name}@${width}`] ?? 0;
            const ceiling = known + driftFor(known);
            if (row.px > ceiling) {
              findings.push(
                `${at}: ${describe(row)} of scroll, allowed ${ceiling}px (known ${known}px)`,
              );
            }
          }
        }
      }
    } finally {
      // Belt and braces — this file sorts last and the throwaway tenant
      // is torn down after every run, so nothing downstream can actually
      // read a Swedish page. It runs anyway: the next person to add a
      // spec should not have to know why the name starts with `zz`.
      // Guarded AND swallowed. A timeout closes the page before this
      // runs — that is how the 300 s budget announced itself — and on a
      // page that is broken but still open the restore's own failure
      // would REPLACE the real one in the report, after spending up to
      // three minutes of budget on it. The tenant is torn down at the
      // end of every run and this file sorts last, so a missed restore
      // costs nothing; a lost diagnostic costs the next session.
      if (!page.isClosed()) {
        try {
          await page.setViewportSize(VIEWPORTS.desktop);
          await setLanguage(page, "English", "en");
        } catch {
          /* the real failure is the one worth reporting */
        }
      }
    }

    expect(findings, "a table overflows its box in Swedish beyond its ratchet").toEqual([]);
  });
});

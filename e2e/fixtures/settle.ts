import type { Page } from "@playwright/test";

/**
 * Shared by both width walks — `visual.spec.ts` in English and
 * `zz-swedish-widths.spec.ts` in Swedish. It lived in visual.spec.ts
 * until 2026-09-19, and the Swedish walk's first run is why it moved:
 * without it that walk measured a page mid-navigation and died on
 * "Execution context was destroyed", which is the exact failure the
 * retry below was written for. A second copy would have been a second
 * definition of "settled", and the two walks must agree on that or
 * their numbers cannot be compared.
 */

/**
 * Wait until the page has stopped becoming a different page. Retried,
 * because a route that redirects from inside a streamed render (the
 * step-up page does) destroys the execution context mid-measurement.
 */
export async function settle(page: Page): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await page.waitForLoadState("load");
      // Self-hosted fonts: a shot taken before they swap measures the
      // fallback's metrics, not the design's.
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      // Finish every FINITE animation before anything measures the page.
      // This used to happen BY ACCIDENT: visit() took a full-page shot
      // with `animations: "disabled"`, which finishes finite animations,
      // so the audit always ran against settled geometry. The shot is no
      // longer taken under CI, and the design system outlasts the wait
      // below — `--dur-slow` is 320 ms (globals.css) and the item-peek
      // stop mounts a Sheet that is full-width at 390 px, so one still
      // sliding in would be measured mid-flight and reported as
      // horizontal overflow. Explicit here, so BOTH paths settle the
      // same way and a CI-only red cannot appear from this.
      //
      // NOT identical to Playwright's `animations: "disabled"`, and the
      // difference is deliberate: that mode CANCELS infinite animations
      // and replays them afterwards, while finish() throws on them and
      // we leave them running. That matches what the audit always saw —
      // Playwright had already resumed them by the time it ran.
      await page.evaluate(() => {
        for (const animation of document.getAnimations()) {
          try {
            animation.finish();
          } catch {
            /* infinite animations cannot finish; leave them running */
          }
        }
      });
      await page.waitForTimeout(150);
      return;
    } catch (e) {
      if (attempt >= 3) throw e;
      await page.waitForTimeout(300);
    }
  }
}

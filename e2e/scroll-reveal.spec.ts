import { expect, test } from "@playwright/test";

import { REVEAL_FADE_PX, REVEAL_RING_PX } from "@/lib/scroll-reveal";

import { backlogRows, focusedBacklogRow, pressUntil, SLOW } from "./fixtures/keys";
import { requireSeed } from "./fixtures/tenant";

/**
 * THE FOCUS REVEAL UNDER THE PINNED COLUMN, in a real browser —
 * PLAN §0's owed (b), open since slice 18, and the half
 * `src/lib/scroll-reveal.test.ts` structurally cannot reach.
 *
 * Those unit tests pin the decision over every combination; the suite
 * runs in `node`, where there is no layout, so nothing there can say
 * whether `ScrollFade` reads the right nodes — whether "the row's pinned
 * cell" really is `:scope > [data-pinned]`, whether `:focus-visible`
 * answers what the comment claims, whether the handler is attached to a
 * box that scrolls. Reading the wrong node is the only bug left, and it
 * is exactly the class a headless browser has already disproved two
 * source-traced conclusions about (PLAN §0, cmdk's `aria-activedescendant`).
 *
 * THE OVERFLOW IS INJECTED, and that is not a shortcut. Slices 28-33
 * removed every table overflow the English seed produced — which was the
 * point — so the condition this behaviour needs no longer occurs on any
 * walked stop, and a test that waited for one would assert nothing. A
 * `min-width` on the `<table>` creates the scroll and touches nothing
 * `ScrollFade` reads: it measures the BOX, the pinned header cell and
 * the focused control, all of them the page's own. PLAN §0 named this
 * shape ("a DOM-injected e2e at a rung edge") before it was written.
 */
const EXTRA = 400;

// IMPORTED, not copied: a hand-written 32 here would keep asserting the
// old bound if `REVEAL_FADE_PX` ever shrank, and the spec would go on
// claiming to test a geometry it no longer tested (review).
const FADE = REVEAL_FADE_PX;
const RING = REVEAL_RING_PX;

/**
 * Where the active element sits relative to the fade, measured in the
 * page. `null` when focus is nowhere a reveal could apply.
 */
function focusGeometry() {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return null;
  const box = el.closest("[data-slot=data-table]");
  if (!(box instanceof HTMLElement)) return null;
  const pinned = el.closest("tr")?.querySelector(":scope > [data-pinned]");
  const rect = el.getBoundingClientRect();
  return {
    tag: el.tagName,
    testId: el.getAttribute("data-testid"),
    isRow: el.tagName === "TR",
    inPinnedCell: el.closest("[data-pinned]") !== null,
    focusVisible: el.matches(":focus-visible"),
    hasPinnedCell: pinned !== null && pinned !== undefined,
    right: Math.round(rect.right),
    width: Math.round(rect.width),
    pinnedLeft: pinned ? Math.round(pinned.getBoundingClientRect().left) : 0,
    boxContentLeft: Math.round(box.getBoundingClientRect().left + box.clientLeft),
    scrollLeft: Math.round(box.scrollLeft),
    /** No room left to scroll: the documented end of the reveal's reach. */
    atEnd: box.scrollWidth - box.clientWidth - box.scrollLeft <= 1,
  };
}

test.describe("the focus reveal under a pinned column", () => {
  test("a keyboard-focused control is brought out from under the column, and the exemptions are left alone", async ({
    page,
  }) => {
    const seed = requireSeed();
    // 1440: the backlog shows all ten columns at `lowest` here, so the
    // row has the most controls to walk (`keymap.spec.ts` picks the same
    // width for the same reason).
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/projects/${seed.projectKey}/backlog`);
    const row = backlogRows(page).first();
    await expect(row).toBeVisible({ timeout: 20_000 * SLOW });

    const box = page.locator("[data-slot=data-table]").first();
    const widen = async () =>
      box.evaluate((el, extra) => {
        const table = el.querySelector("table");
        if (table instanceof HTMLElement) table.style.minWidth = `${el.clientWidth + extra}px`;
        el.scrollLeft = 0;
      }, EXTRA);
    await widen();

    // The premise, asserted rather than assumed: without a scroll there
    // is nothing to reveal and every assertion below would pass vacuously.
    await expect
      .poll(() => box.evaluate((el) => el.scrollWidth - el.clientWidth), {
        timeout: 10_000 * SLOW,
      })
      .toBeGreaterThan(EXTRA / 2);
    // And that the fade itself noticed — its ResizeObserver is the same
    // effect that attaches the `focusin` handler, so a hidden fade would
    // mean a handler that never ran.
    await expect(page.locator("[data-slot=scroll-fade][data-more]").first()).toBeVisible();

    // ── the reveal ────────────────────────────────────────────────────
    // `J` is the backlog's roving focus (slice 15) and needs `pressUntil`:
    // `useScopeKeys` registers in an effect, so a press can land before
    // the binding exists — on CI that is the difference between green and
    // flaky, and it is the trap this session was told about twice.
    await pressUntil(page, "j", focusedBacklogRow(page));

    // THE ROW IS EXEMPT. It spans the table, so it is never under the
    // column, and scrolling on every `J` would fight the member for the
    // viewport. This is also the case that must cost no layout at all.
    const onRow = await page.evaluate(focusGeometry);
    expect(onRow?.isRow, "J focuses the row itself").toBe(true);
    expect(onRow?.scrollLeft, "focusing a row scrolls nothing").toBe(0);

    // Now walk the row's controls. The invariant is the one the reveal
    // exists for, asserted at EVERY stop rather than at a control picked
    // in advance — a picked one can drift out of the covered band when a
    // column moves, and pass for the wrong reason.
    let revealed = 0;
    let checked = 0;
    let pinnedSeen = 0;
    let lastScroll = 0;
    for (let i = 0; i < 14; i += 1) {
      await page.keyboard.press("Tab");
      const at = await page.evaluate(focusGeometry);
      if (!at) break; // Focus left the table: the walk is over.
      if (at.inPinnedCell) {
        // THE COLUMN'S OWN CONTROLS ARE EXEMPT — it cannot cover itself.
        // Measured against the scroll position the previous stop left, so
        // this says "did not move", not "is at zero".
        expect(at.scrollLeft, `the pinned cell's own control (${at.tag}) scrolled the box`).toBe(
          lastScroll,
        );
        pinnedSeen += 1;
        continue;
      }
      if (!at.hasPinnedCell || !at.focusVisible) {
        lastScroll = at.scrollLeft;
        continue;
      }
      const room = at.pinnedLeft - FADE - at.boxContentLeft;
      if (at.width + 2 * RING > room) {
        // The documented second no-op: a control wider than the room the
        // column and fade leave has no scroll position that reveals it,
        // and moving would only trade its right edge for its left.
        lastScroll = at.scrollLeft;
        continue;
      }
      if (at.scrollLeft > lastScroll) revealed += 1;
      const where = `${at.testId ?? at.tag} right ${at.right}, column at ${at.pinnedLeft}, scroll ${at.scrollLeft}${at.atEnd ? " (at end)" : ""}`;

      // THE HARD PROMISE, which holds at every scroll position: a focused
      // control is never under the OPAQUE pinned column.
      expect(at.right, `under the pinned column — ${where}`).toBeLessThanOrEqual(at.pinnedLeft + 1);

      // THE SOFT ONE, which the component states as "while the table can
      // still scroll right": clear of the 32px fade as well. At the
      // table's right end there is nowhere left to go, and the last
      // column's own controls sit against the pinned one by construction
      // — so this is asserted only while a scroll is still possible, and
      // the `revealed` count below is what stops that becoming an excuse.
      if (!at.atEnd) {
        expect(at.right + RING, `still under the fade — ${where}`).toBeLessThanOrEqual(
          at.pinnedLeft - FADE + 1,
        );
        checked += 1;
      }
      lastScroll = at.scrollLeft;
    }

    // The walk has to have DONE something, or the invariant above is a
    // statement about an empty set.
    expect(checked, "no eligible control was focused in the row").toBeGreaterThan(0);
    expect(pinnedSeen, "the row's pinned control was never reached").toBeGreaterThan(0);
    expect(revealed, "no control was ever actually scrolled out").toBeGreaterThan(0);
  });
});

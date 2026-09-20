/**
 * OVERFLOW POLICY, shared by both width walks. `visual.spec.ts` owned
 * all of this until 2026-09-19, when the Swedish walk needed the same
 * two answers and a second copy would have been a second policy: which
 * stops are DATA-DRIVEN does not depend on the language a page renders
 * in, and neither does how much CI-to-CI slack a measured number gets.
 * The English ratchet's own numbers (`KNOWN_OVERFLOW`) stay in
 * visual.spec.ts, and the Swedish ones in zz-swedish-widths.spec.ts,
 * because THOSE are per-walk.
 */

/**
 * Slack on a KNOWN number, for CI-to-CI variance only — PROPORTIONAL to
 * the number it rides on, which a flat tolerance could not be.
 *
 * NOT for the Windows ↔ ubuntu font-metric gap, though that is what
 * forced the recalibration: every number listed above is CI's OWN, so
 * that gap is already inside them and this tolerance never sees it. What
 * is left to guard is a listed number moving between two CI runs — which
 * should be nothing, since both attempts of run 35291774042 measured
 * identically — and the reverse case, a future key where a local run
 * measures WIDER than CI.
 *
 * WHY PROPORTIONAL (PLAN §0's owed (b), and the reason it was owed): a
 * flat allowance is worth least exactly where this ratchet is worth most.
 * At the 8px it started as, `project-files@390` could have TRIPLED (4 →
 * 12) and `files@390` more than doubled before the walk said a word; at
 * 4px the same key could still silently double.
 *
 * THOSE TWO KEYS ARE GONE (fixed 2026-09-20) and so is every other
 * English one, which changes what this function is currently FOR without
 * changing what it should be. The keys left are the Swedish backlog
 * trade at 27-29px, where `DRIFT_MAX_PX` caps the slack flat at 4 and
 * the proportional part never comes into play — so today this reads as a
 * flat tolerance. It is kept proportional for the small keys that come
 * back, which is the shape the argument above is about and not a
 * property of whichever keys happen to be listed this week.
 *
 * Three numbers, and the shape matters more than any of them. `FRACTION`
 * is what makes a big number's slack big and a small number's small.
 * `MIN` is one pixel, because `scrollWidth - clientWidth` is integer and
 * sub-pixel layout rounding lands on ±1 — below that the ratchet would
 * be pinning noise. `MAX` is the flat 4px this replaced, so the change
 * can only ever TIGHTEN: no key anywhere gets more slack than it had, and
 * a hypothetical 251px entry cannot quietly license 63px of regression
 * because a quarter of it sounded reasonable.
 *
 * THE TRADE THIS MAKES, consciously (review, 2026-09-18). Slice 28 fixed
 * every FLOOR-driven key, so the four that remain are TEXT-metric ones —
 * exactly the class this file records as moving 2-8px between platforms.
 * At 1px of slack a 2px font shift turns the walk red on an unrelated
 * change. That is accepted, and it is the same policy as the line below
 * rather than a new one: a runner-image change (ubuntu-latest moves to
 * Ubuntu 26 from 2026-10-19) is a RECALIBRATION, and a red walk is how a
 * session finds out it is due. Widening the floor to swallow it would
 * also swallow a real 2px regression on a 4px key, which is the one
 * thing these four entries exist to catch. Re-measure from the CI log
 * and edit the numbers; do not raise `DRIFT_MIN_PX` to make it quiet.
 */
export const DRIFT_FRACTION = 0.25;
export const DRIFT_MIN_PX = 1;
export const DRIFT_MAX_PX = 4;

/**
 * The slack allowed on one known number. Zero gets zero: an UNLISTED key
 * is held to the pixel, which is the whole point of the ratchet, and a
 * key listed at 0 would be a contradiction rather than a tolerance.
 */
export function driftFor(known: number): number {
  if (known <= 0) return 0;
  return Math.min(DRIFT_MAX_PX, Math.max(DRIFT_MIN_PX, Math.round(known * DRIFT_FRACTION)));
}

/**
 * Stops whose tables are DATA-DRIVEN, so their width depends on rows
 * earlier specs leave behind rather than on the layout: `time.spec.ts`
 * writes and deletes entries, and the visual walk runs after it. Measured
 * into the report, never asserted — an exact ratchet here would be
 * pinning noise, and the first CI run proved it: `time-team`'s "Shift day
 * totals" was 0px in a visual-only run and 251px over a 356px box in the
 * full suite.
 *
 * They are NOT exempt because their overflow is acceptable; several
 * overflow badly and are owed a pass of their own (PLAN §0). They are
 * exempt because this instrument cannot yet say so reproducibly. Making
 * the walk seed its own rows would let them be ratcheted like the rest.
 *
 * EXEMPT IS NOT SILENT (2026-09-18). Every measurement here is now
 * PRINTED, `[volatile] <stop> at <width>px: …`, because the report it
 * used to go to alone is written locally and uploaded only on failure —
 * so on a green run the worst overflow in the product was unobservable.
 * That is how `time-team`'s "Shift day totals" sat at 249px over a 356px
 * box, the worst number anywhere, until it was looked for on purpose.
 * Its seven day columns are `low` as of the same day, which is what the
 * project month grid's week columns already did, so that one is a
 * column-priority fix rather than a ratchet — and the remaining numbers
 * are now in every CI log for whoever takes the rest.
 *
 * WHAT WAS LEFT when these numbers were first printed (CI runs
 * 35380530578 and 35400146183) — all three are FIXED now, and the list
 * is kept because it is the record of what printing them bought:
 *   • `time` "Time entries" — 91px over a 356px box, 65px over 608px,
 *     76px over 736px. NOT a rung mistake: its What cell was a
 *     `flex-wrap` row of a truncating label plus up to four `shrink-0`
 *     badges, so the badges forced the column exactly as `/clients`'
 *     city span did. Fixed 2026-09-18 (`473cead`): a
 *     `contain-inline-size` wrapper over a `min-w-40` floor, no
 *     `flex-wrap`, and the three ADVISORY badges on the `medium` rung.
 *   • `project-money` "By epic" / "By task" — 16px, then 21px, over a
 *     356px box. Its `lineTable` label column was the only one without
 *     a width and labels a line "{key} {title}". Fixed 2026-09-19: the
 *     same wrapper over a `min-w-40` floor, in the one helper all four
 *     of that page's tables share.
 *   • `time-team` "Team hours" — 11px, then 13px, over a 356px box.
 *     Member AND project are both unbounded tenant text in a
 *     `whitespace-nowrap` cell, and a phone renders those two and Hours
 *     and nothing else. Fixed 2026-09-19: both cells contained, over
 *     6rem and 9rem floors — BOTH, because containing only the wider
 *     one would have fitted that day's data and left a longer member
 *     name to put the scroll back, which an exempt stop never reports.
 *   • `time-statement` — under the probe's 1px floor on CI.
 * THEY STAY EXEMPT REGARDLESS, and a fix does not earn a stop its way
 * out of this set: every one is DATA-driven and drifts run to run,
 * which two local runs showed plainly (`project-money` 4 → 9px, `time`
 * 87 → 90px) and CI then disagreed with again (that same cell measured
 * 15, 16 and 21px across three runs). That is why they are exempt
 * rather than merely unratcheted, and why a number here is a starting
 * point for a pass, never a key to paste into `KNOWN_OVERFLOW`. The
 * corollary, stated plainly: NONE of these three fixes has a regression
 * guard — if a number comes back the walk will print it and pass.
 * Seeding the walk's own rows (above) is what would let them be
 * ratcheted, and is still the way to earn one.
 *
 * THE SET IS CHOSEN BY WHAT IS DATA-DRIVEN, not by what CI happened to
 * flag — the first draft was the latter, and a review caught two stops
 * one run away from going red for the identical reason. `project-time`
 * grows a COLUMN PER ISO WEEK present in the month, so one entry landing
 * in a second week widens it; `time-statement` renders a day's shift
 * spans joined into one `whitespace-nowrap` cell with no priority, so a
 * second shift or a break that splits a day widens it. `time.spec.ts`
 * writes entries, splits, copy-last-week rows and shifts, and removes
 * only tasks. Two more stops carry lighter residue and are NOT exempt
 * (both at 0 today, both worth watching): `settings-time`, where
 * `settings.spec.ts` leaves a seventh work type behind, and
 * `project-backlog*`, whose seeded task the item specs retitle and
 * relabel.
 */
export const VOLATILE_STOPS = new Set([
  "time",
  "time-team",
  "time-statement",
  "project-money",
  "project-time",
]);

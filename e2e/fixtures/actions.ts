import type { Page, Request } from "@playwright/test";

import { SLOW } from "./keys";

/**
 * Waiting for a SERVER ACTION to answer, for the specs that then reload.
 *
 * Every optimistic surface in this app paints the member's change before
 * the server has stored it (UI.md §7.2), so a DOM assertion — including
 * an `expect.poll` over the DOM — can be satisfied by the optimistic
 * state alone while the write is still in flight. Reloading on the
 * strength of that assertion races the write and reads the server's
 * OLDER value: `work.spec.ts`'s backlog-reorder test failed in CI run
 * 35002303147 exactly that way, at the drag's post-reload assertion,
 * three lines after a poll on the same expression had passed.
 *
 * So: arm this BEFORE the interaction, await it BEFORE the reload. The
 * poll still earns its place — it proves the optimistic paint — and this
 * proves the write landed, which is what makes the reload a test of what
 * was stored rather than of a race.
 *
 * A Next server action is a POST carrying a `next-action` header, which
 * is what distinguishes it from the RSC GETs a refresh also makes.
 * `account.spec.ts`, `inline-edit.spec.ts` and `visibility.spec.ts` each
 * had their own copy of that predicate, `visual.spec.ts` had it inline,
 * and `item-properties.spec.ts` had it inside its own `isActionPostWith`;
 * all five import it now.
 */
export const isActionPost = (request: Request): boolean =>
  request.method() === "POST" && Boolean(request.headers()["next-action"]);

/**
 * The next server action's response, as a promise to await after the
 * interaction that causes it.
 *
 * ARM IT BEFORE THE INTERACTION. Playwright starts listening when this is
 * called, so a promise created afterwards can miss an action that has
 * already answered — and then wait out its whole timeout.
 *
 * PASS `contains`, and pass BOTH halves of what identifies the write:
 * the SUBJECT (the item's id) and the FIELD it writes (a key name from
 * the action's own argument — React serialises those keys into the body
 * literally). Every string given must appear, and a field name is passed
 * WITH its quotes, `'"targetDate"'`, as `item-properties.spec.ts` matches
 * one: a bare `targetDate` would also match a future `previousTargetDate`
 * and answer for the wrong write.
 *
 * The subject half is deliberately looser — the id is passed unquoted and
 * matches anywhere in the body, because all it has to exclude is an action
 * that does not mention this item at all. It therefore also matches this
 * item appearing as another row's move ANCHOR (`beforeId`/`afterId`), so a
 * test that moves a second row against this one would need the subject
 * key too (`"itemId":"<id>"`). No test does today.
 *
 * Both halves are needed for different reasons. Without the subject, the
 * wait takes ANY action POST, and the shell's timer pill posts one of its
 * own (`getTimerStateAction`) on window focus, on `visibilitychange` and
 * on its `flv:timer` event, so one of those landing between the arm and
 * the real answer would resolve the wait early and quietly restore the
 * race this helper exists to close. Without the field, every OTHER write
 * to the same item matches too — three edits to one row in sequence, as
 * the grooming test makes, and the wait can answer for the wrong one.
 * `item-properties.spec.ts` filters by field for that half.
 *
 * It resolves on ANY response, a 500 or a refusal included: it proves the
 * server answered, never that it agreed. What the action did is the
 * assertion after the reload.
 */
export function actionAnswered(
  page: Page,
  opts: { contains?: string | readonly string[]; timeout?: number } = {},
): Promise<unknown> {
  const { contains, timeout = 20_000 * SLOW } = opts;
  const needles = contains === undefined ? [] : typeof contains === "string" ? [contains] : contains;
  const answered = page.waitForResponse(
    (res) => {
      if (!isActionPost(res.request())) return false;
      const body = res.request().postData() ?? "";
      return needles.every((needle) => body.includes(needle));
    },
    { timeout },
  );
  // An assertion between the arm and the await can fail the test first,
  // leaving this promise to reject later with a timeout or "Target page
  // closed" — a second, confusing error on an already-failing test. The
  // handler marks it handled; awaiting it still rejects where it should.
  answered.catch(() => {});
  return answered;
}

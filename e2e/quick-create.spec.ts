import { expect, test, type Page } from "@playwright/test";

import { SLOW, deleteOwnTasks, pressUntil } from "./fixtures/keys";
import { requireSeed, type E2ESeed } from "./fixtures/tenant";

/**
 * THE GLOBAL `C` (UI.md rule 2, keymap `global · C`) — slice 30.
 *
 * What only a browser can see here is the WIRE: that one key registered
 * in the shell reaches a dialog from a page that knows nothing about it,
 * that the project comes from the ROUTE on a project page and from the
 * picker anywhere else, and that Enter and ⌘Enter are two different
 * verbs on the same field. The dispatcher's precedence is the unit
 * suite's (`decide()` is pure); the shadowing by the board's own `C` is
 * asserted here because only a real board can prove which one ran.
 *
 * Every task this file creates is removed in `afterEach`, pass or fail —
 * the visual sweep photographs the seeded ones and must not find these.
 */

let seed!: E2ESeed;
let created: string[] = [];

test.beforeAll(() => {
  seed = requireSeed();
});

test.afterEach(async ({ page }) => {
  const titles = created;
  created = [];
  await deleteOwnTasks(page, seed, titles);
});

const dialog = (page: Page) => page.getByTestId("quick-create");
const titleField = (page: Page) => page.getByTestId("quick-create-title");

/** A title no other spec's fixture could collide with. */
const own = (what: string): string => {
  const title = `QuickCreate ${what} ${Date.now()}`;
  created.push(title);
  return title;
};

test("`C` on a project page creates in THAT project, and Enter starts the next", async ({
  page,
}) => {
  await page.goto(`/projects/${seed.projectKey}/backlog`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  await page.keyboard.press("c");
  await expect(dialog(page)).toBeVisible();

  // The project came from the ROUTE: no picker, and the field is ready.
  await expect(page.getByTestId("quick-create-projects")).toHaveCount(0);
  await expect(titleField(page)).toBeFocused();

  const first = own("route");
  await titleField(page).fill(first);
  await titleField(page).press("Enter");

  // Enter creates and STARTS THE NEXT: the dialog stays, the field is
  // empty and still focused, and the project is unchanged — which is
  // what makes six tasks six Enters.
  await expect(titleField(page)).toHaveValue("", { timeout: 20_000 * SLOW });
  await expect(dialog(page)).toBeVisible();
  await expect(titleField(page)).toBeFocused();

  const second = own("second");
  await titleField(page).fill(second);
  await titleField(page).press("Enter");
  await expect(titleField(page)).toHaveValue("", { timeout: 20_000 * SLOW });

  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);

  // Both landed in the project the key was pressed on.
  await page.reload();
  for (const title of [first, second]) {
    await expect(page.locator('[data-slot="table-row"]', { hasText: title })).toBeVisible({
      timeout: 20_000 * SLOW,
    });
  }
});

test("`C` away from a project asks which one, and ⌘Enter opens what it created", async ({
  page,
}) => {
  await page.goto("/home");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  await page.keyboard.press("c");
  await expect(dialog(page)).toBeVisible();

  // No project in the route, so it asks first (UI.md rule 2).
  const picker = page.getByTestId("quick-create-projects");
  await expect(picker).toBeVisible({ timeout: 20_000 * SLOW });
  await expect(titleField(page)).toHaveCount(0);

  await picker.getByRole("option", { name: new RegExp(seed.projectKey) }).first().click();
  await expect(titleField(page)).toBeFocused();

  const title = own("open");
  await titleField(page).fill(title);
  // ⌘Enter is create-AND-OPEN: Control on this harness's platform, and
  // the handler takes either.
  await titleField(page).press("Control+Enter");

  // It lands on the task's OWN page — the one surface reachable from
  // anywhere, since a peek needs a list behind it.
  await page.waitForURL(new RegExp(`/projects/${seed.projectKey}/items/\\d+`), {
    timeout: 20_000 * SLOW,
  });
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByText(title)).toBeVisible();
});

test("the board's own `C` still wins, and a modal `C` does not reopen the dialog", async ({
  page,
}) => {
  await page.goto(`/projects/${seed.projectKey}/board`);
  await expect(page.getByTestId("board-card").first()).toBeVisible({ timeout: 20_000 * SLOW });

  // The `board` scope outranks `global`, so `C` is the column composer
  // and not this dialog. Scope order is what decides it once both
  // bindings are registered; the shell ALSO stands its binding down on
  // a board route, so the answer does not depend on which of the two
  // hydrated first (review).
  //
  // `pressUntil`, not a single press, and the reason IS the thing under
  // test: a board card being VISIBLE is server-rendered HTML, not a
  // mounted effect, so the board's binding may not exist yet — and the
  // shell's, standing down here, SWALLOWS the key rather than letting
  // it fall through. One press in that window therefore does nothing at
  // all, which is correct and is why `keymap.spec.ts` has always
  // retried this key. A single press passed on a fast local machine and
  // failed both CI attempts (run 35357881001).
  await pressUntil(page, "c", page.getByTestId("board-create-input"));
  await expect(page.getByTestId("board-create-input").first()).toBeFocused();

  // And the global dialog never opened behind it.
  await expect(dialog(page)).toHaveCount(0);

  // The second half of this test's name, which it did not used to
  // exercise (review): a `C` pressed while the composer holds focus is
  // a letter typed into it, not a key. Single keys are inert inside an
  // editable target, and the dialog this shell mounts on every page
  // must be no exception to that.
  await page.keyboard.press("c");
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByTestId("board-create-input").first()).toHaveValue("c");

  await page.keyboard.press("Escape");
});

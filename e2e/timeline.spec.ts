import { expect, test, type Locator, type Page } from "@playwright/test";

import { requireSeed, type E2ESeed } from "./fixtures/tenant";

/**
 * The milestone creation form's visibility select, proved coherent.
 *
 * What the code used to do: the select held its own `useState`, and the
 * success path called `form.reset()` — which restores the native
 * control to its SSR default without telling React. The DOM said
 * "Private to team" while the state (and the warm CLIENT_VISIBLE
 * styling derived from it) said otherwise, until the next render
 * flipped the DOM back. On a safety-critical control, either direction
 * of that lie is a data leak waiting to be believed.
 *
 * The form now owns the state and re-seeds it to INTERNAL — the safe
 * default, "INTERNAL everywhere" — in the same effect that resets the
 * uncontrolled fields. This spec pins all three faces at once: the
 * submitted value (the created row), the control's value after
 * success, and the styling attribute derived from the same state.
 *
 * It runs on the COMPLETED project's empty timeline, not the main
 * one: the visual sweep photographs the main project, and a fixture
 * must be photographed as it was provisioned.
 */

let seed!: E2ESeed;

test.beforeAll(() => {
  seed = requireSeed();
});

const visibilitySelect = (page: Page): Locator => page.locator("#ms-vis");

const rowFor = (page: Page, name: string): Locator =>
  page
    .locator("[data-slot=timeline-item]")
    .filter({ has: page.getByRole("button", { name: `Actions for ${name}` }) })
    .first();

async function addMilestone(page: Page, name: string): Promise<void> {
  await page.locator("#ms-name").fill(name);
  await page.getByRole("button", { name: "Add milestone" }).click();
  await expect(rowFor(page, name)).toBeVisible();
}

test("the visibility select submits the choice, then re-seeds to the safe default", async ({
  page,
}) => {
  await page.goto(`/projects/${seed.completedProjectKey}/timeline`);

  const select = visibilitySelect(page);
  await expect(select).toHaveValue("INTERNAL");

  // Choose CLIENT_VISIBLE: the value and the styling attribute move
  // together, because both derive from the same state.
  await select.selectOption("CLIENT_VISIBLE");
  await expect(select).toHaveAttribute("data-visibility", "CLIENT_VISIBLE");

  // The submitted milestone carries the choice…
  const shared = `Synlighetsprov ${Date.now()}`;
  await addMilestone(page, shared);
  await expect(rowFor(page, shared).locator("[data-slot=visibility-badge]")).toHaveAttribute(
    "data-visibility",
    "CLIENT_VISIBLE",
  );

  // …and the control is back at the safe default, value and styling
  // agreeing — not a DOM reset React never heard about.
  await expect(select).toHaveValue("INTERNAL");
  await expect(select).toHaveAttribute("data-visibility", "INTERNAL");

  // The next milestone, added without touching the select, is INTERNAL:
  // one member's share decision never leaks onto the next row.
  const internal = `Intern ${Date.now()}`;
  await addMilestone(page, internal);
  await expect(rowFor(page, internal).locator("[data-slot=visibility-badge]")).toHaveAttribute(
    "data-visibility",
    "INTERNAL",
  );
});

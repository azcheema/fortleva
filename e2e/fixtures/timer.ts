import { expect, type Locator, type Page } from "@playwright/test";

import { SLOW } from "./keys";

/**
 * The timer's fixed points in a browser, shared by the specs that start
 * or stop one (`time.spec.ts`, which owns the timer, and
 * `home-queue-verbs.spec.ts`, whose queue rows carry `T`): the header pill, its stop, the stop
 * confirm every explicit stop opens, and the staff notice on `/time`.
 */

// The pill is mounted twice (desktop header slot + mobile slot); the
// desktop one comes first in the DOM and is the visible one at this viewport.
export const pill = (page: Page): Locator => page.getByTestId("timer-pill").first();
export const idlePill = (page: Page): Locator => page.getByTestId("timer-pill-idle").first();
export const stopButton = (page: Page): Locator => page.getByTestId("timer-pill-stop").first();
export const elapsedClock = (page: Page): Locator => page.getByTestId("timer-pill-elapsed").first();

/** The stop confirm every explicit stop opens (UI.md rule 9 — no silent save). */
export const stopConfirm = (page: Page): Locator => page.getByTestId("stop-confirm");

/** The `/time` page's staff-notice gate, acknowledged if it is up. */
export async function acknowledgeNoticeIfShown(page: Page): Promise<void> {
  const ack = page.getByTestId("notice-acknowledge");
  if (await ack.isVisible().catch(() => false)) {
    await ack.click();
    await expect(ack).toHaveCount(0, { timeout: 15_000 * SLOW });
  }
}

/** Dismiss the stop confirm — by Escape, or by its close button — keeping the entry exactly as stopped. */
export async function keepAsStopped(page: Page, via: "escape" | "close" = "escape"): Promise<void> {
  await expect(stopConfirm(page)).toBeVisible({ timeout: 15_000 * SLOW });
  if (via === "escape") await page.keyboard.press("Escape");
  else await stopConfirm(page).locator('[data-slot="dialog-close"]').click();
  await expect(stopConfirm(page)).toHaveCount(0);
}

/** Stop the member's timer through the pill, if one runs, and keep the entry as stopped. */
export async function stopIfRunning(page: Page): Promise<void> {
  const stop = stopButton(page);
  if (await stop.isVisible().catch(() => false)) {
    await stop.click();
    await expect(idlePill(page)).toBeVisible({ timeout: 15_000 * SLOW });
    await keepAsStopped(page);
  }
}

/** Two animation frames: whatever a key's own commit mounts is in the DOM by then. */
export async function nextFrames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

/**
 * Nothing on the page is busy. A card's or a row's `T` ignores a press
 * while its own start or stop is in flight, and the board region, the
 * backlog and the home queue say so with `aria-busy` — the one outward
 * sign of it.
 */
export async function listIdle(page: Page): Promise<void> {
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 15_000 * SLOW });
}

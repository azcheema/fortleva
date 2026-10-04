import { createHmac } from "node:crypto";

import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";

import type { E2ESeed } from "./tenant";

/**
 * THE VAULT MANAGER'S SESSION, for every spec that opens the vault (3V
 * slices 85–90): the fixture's one member with an enrolled authenticator
 * (`E2ESeed.vaultEmail`). Moved out of `vault.spec.ts` when the share-link
 * spec became the second to need it (slice 90).
 *
 * The codes are computed the way Better Auth computes them — HMAC-SHA1
 * keyed by the secret's UTF-8 text, 30-second steps, six digits — so a
 * sign-in or a step-up here is exactly a person reading their app.
 */
export const totpNow = (secret: string): string => {
  const step = Buffer.alloc(8);
  step.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const h = createHmac("sha1", Buffer.from(secret, "utf8")).update(step).digest();
  const o = h[h.length - 1]! & 15;
  const n = ((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(n % 1_000_000).padStart(6, "0");
};

/** A fresh context signed in as the vault manager, with a factor stamped by the sign-in itself. */
export async function signInVaultManager(
  browser: Browser,
  seed: E2ESeed,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    storageState: { cookies: [], origins: [] },
    serviceWorkers: "block",
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  await expect(async () => {
    if (/\/home(?:$|[?#])/.test(page.url())) return;
    await page.goto("/login");
    await page.locator("#email").fill(seed.vaultEmail);
    await page.locator("#password").fill(seed.vaultPassword);
    await page.locator('form button[type="submit"]').click();
    await page.locator("#totp").waitFor({ timeout: 15_000 });
    await page.locator("#totp").fill(totpNow(seed.vaultTotpSecret));
    await page.locator('form button[type="submit"]').click();
    await page.waitForURL("**/home", { timeout: 15_000 });
  }).toPass({ timeout: 90_000, intervals: [2_000, 4_000, 6_000] });
  return { context, page };
}

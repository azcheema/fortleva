import { expect, type Page } from "@playwright/test";

/**
 * THE REGION VIEW-AS IS BYTE-COMPARED ON — `[data-portal-surface]`, marked
 * on the portal's own frame — as HTML, with the attributes React varies
 * per render stripped. Shared by `view-as.spec.ts`, whose docblock says
 * why the boundary is drawn in the markup, and `portal-sections.spec.ts`
 * (slice 80), which compares the pages as the section switches leave
 * them. One copy, so the two specs cannot come to compare different
 * things.
 */
export async function portalSurface(page: Page): Promise<string> {
  const surface = page.locator("[data-portal-surface]");
  await expect(surface).toBeVisible({ timeout: 30_000 });
  return surface.evaluate((el) => {
    const clone = el.cloneNode(true) as HTMLElement;
    // React 19 emits nothing per-render into this subtree today, so this
    // is a guard rather than a fix: if a future component adds an
    // `id`/`aria-controls` pair from `useId`, the comparison would start
    // failing on two documents that are otherwise identical, and the
    // failure would read as a leak. Stripped by NAME, so anything else
    // that differs still fails the test.
    for (const node of clone.querySelectorAll("*")) {
      for (const attr of ["id", "aria-controls", "aria-labelledby", "aria-describedby"]) {
        const v = node.getAttribute(attr);
        if (v && /:r[0-9a-z]+:|«r/i.test(v)) node.removeAttribute(attr);
      }
    }
    return clone.innerHTML;
  });
}

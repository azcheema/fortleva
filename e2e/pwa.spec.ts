import { expect, test } from "@playwright/test";

/**
 * Decision 15 / ARC-25 Stage A in a browser: the member app is installable
 * (a manifest with standalone display and /home as start URL, linked from
 * the authed layout) and registers a PASS-THROUGH service worker that
 * never caches a navigation or an /api/* response. The ops-host 404 is a
 * config-driven branch (planeForHost) — one host in the harness, so it
 * is covered by the unit test of the config seam, not here.
 */
test.describe("PWA shell", () => {
  test("the manifest is served with standalone display, /home start URL and maskable icons", async ({ request }) => {
    const res = await request.get("/manifest.webmanifest");
    expect(res.status()).toBe(200);
    const manifest = await res.json();
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("/home");
    expect(manifest.scope).toBe("/");
    expect(manifest.id).toBe("/app");
    expect(manifest.icons.some((i: { purpose?: string }) => i.purpose === "maskable")).toBe(true);
    for (const icon of manifest.icons as { src: string }[]) {
      const img = await request.get(icon.src);
      expect(img.status(), icon.src).toBe(200);
      expect(img.headers()["content-type"]).toContain("image/png");
    }
  });

  test("the worker is served as JavaScript, never cached, and is network-only for navigations and /api", async ({ request }) => {
    const res = await request.get("/sw.js");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("javascript");
    expect(res.headers()["cache-control"]).toContain("no-cache");
    const body = await res.text();
    // The only cacheable prefix is the immutable build-asset path: every other
    // GET returns before respondWith — navigations and /api/* never enter
    // Cache Storage (the comment in the worker says so in words; this pins the code).
    expect(body).toContain('if (url.origin !== self.location.origin || !url.pathname.startsWith("/_next/static/")) return;');
    expect(body).toContain('if (request.method !== "GET") return;');
    expect(body.split("event.respondWith(").length).toBe(2); // exactly one respondWith call, after both guards
  });

  test("an authed page links the manifest and registers the worker", async ({ page }) => {
    await page.goto("/home");
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", /manifest\.webmanifest/);
    await expect(page.locator('meta[name="apple-mobile-web-app-capable"], meta[name="mobile-web-app-capable"]').first()).toHaveCount(1);
    const registered = await page.evaluate(async () => {
      if (!("serviceWorker" in navigator)) return "unsupported";
      const reg = await navigator.serviceWorker.getRegistration("/");
      return reg ? "registered" : "missing";
    });
    expect(["registered", "unsupported"]).toContain(registered);
  });
});

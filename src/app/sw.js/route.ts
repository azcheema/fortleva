import { headers } from "next/headers";

import { planeForHost } from "@/config";

/**
 * The service worker (decision 15 / ARC-25, Stage A) — a PASS-THROUGH
 * worker, hand-written and owned: it exists so the app is installable
 * and so Phase 5 Web Push has something to land on. It never caches a
 * navigation or an /api/* response; the only thing it ever stores is
 * the immutable, content-hashed /_next/static/* asset it just fetched,
 * under a version key, and it drops older versions on activate. Nothing
 * that carried a session cookie ever enters Cache Storage, so revocation
 * and visibility changes take effect on the next request exactly as
 * without a worker. Served from a route (not /public) so the ops host
 * can refuse it: the platform plane is deliberately un-installable.
 */
const VERSION = process.env["VERCEL_GIT_COMMIT_SHA"]?.slice(0, 12) ?? process.env["NEXT_PUBLIC_APP_VERSION"] ?? "dev";

const WORKER = `/* Fortleva service worker — pass-through (ARC-25 Stage A). Version ${VERSION}. */
const CACHE = "flv-static-${VERSION}";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  // Only same-origin, immutable, content-hashed build assets are ever
  // stored. Navigations, /api/*, server actions and everything else go
  // straight to the network — the worker does not even respondWith.
  if (url.origin !== self.location.origin || !url.pathname.startsWith("/_next/static/")) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(request);
      if (hit) return hit;
      const response = await fetch(request);
      if (response.ok) cache.put(request, response.clone());
      return response;
    })(),
  );
});

// Clear-Site-Data is sent by the sign-out path where the browser honours
// it; a page can also ask the worker to drop its static cache.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "flv:clear-cache") {
    event.waitUntil(caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))));
  }
});
`;

export async function GET(): Promise<Response> {
  const host = (await headers()).get("host") ?? "";
  if (planeForHost(host) !== "app") return new Response("Not found", { status: 404 });
  return new Response(WORKER, {
    status: 200,
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      // The worker script itself is never cached by the browser beyond a
      // revalidation: a deploy must reach installed apps on the next visit.
      "Cache-Control": "no-cache, max-age=0, must-revalidate",
      "Service-Worker-Allowed": "/",
    },
  });
}

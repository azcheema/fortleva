/**
 * The service worker's SOURCE (decision 15 / ARC-25). Served by
 * `src/app/sw.js/route.ts`, which owns the host check and the headers; kept
 * here so a unit test can run it against a fake `self`
 * (`service-worker.test.ts`) — a route module may export only its handlers.
 *
 * Stage A — a PASS-THROUGH worker, hand-written and owned: it exists so the app
 * is installable. It never caches a navigation or an /api/* response; the only
 * thing it ever stores is the immutable, content-hashed /_next/static/* asset
 * it just fetched, under a version key, and it drops older versions on
 * activate. Nothing that carried a session cookie ever enters Cache Storage, so
 * revocation and visibility changes take effect on the next request exactly as
 * without a worker.
 *
 * Stage B — WEB PUSH (Phase 5 slice 106; founder decision C74). The worker
 * shows what a push says and opens it when tapped, and does nothing else:
 *   - `push`: the payload is our own JSON (`src/push/payload.ts`), decrypted by
 *     the browser. Every field is checked again here as if it were hostile —
 *     a title and a body of at most 200 characters, a tap target that is
 *     EXACTLY `/inbox/open/<uuid>` (anything else opens the inbox) — and an
 *     unreadable payload still shows a notification, because a push that shows
 *     none breaks the browser's `userVisibleOnly` promise (Chrome then shows
 *     its own "site updated in the background").
 *   - `notificationclick`: focus a window this worker controls and navigate it
 *     to the target, else open one. Same origin only, by construction: the
 *     target is a path resolved against the worker's own origin.
 *   - `pushsubscriptionchange` is deliberately NOT handled: a rotated
 *     subscription's old endpoint answers 410 and its row is deleted; the
 *     member sees "Turn on for this device" again on Settings → Notifications.
 */
export function serviceWorkerSource(version: string): string {
  return `/* Fortleva service worker — pass-through (ARC-25 Stage A) + push (Stage B). Version ${version}. */
const CACHE = "flv-static-${version}";

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

// ── Web Push (Stage B) ────────────────────────────────────────────────
const NOTIFICATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OPEN_PATH = /^\\/inbox\\/open\\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FALLBACK_TITLE = "Fortleva";
const MAX_TEXT = 200;

const textOf = (value) => (typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT ? value : null);
const targetOf = (value) => (typeof value === "string" && OPEN_PATH.test(value) ? value : "/inbox");

function notificationOf(data) {
  let payload = null;
  try {
    payload = data ? data.json() : null;
  } catch (_) {
    payload = null;
  }
  const p = payload !== null && typeof payload === "object" ? payload : {};
  const id = typeof p.id === "string" && NOTIFICATION_ID.test(p.id) ? p.id : null;
  const options = { body: textOf(p.body) || "", icon: "/icons/icon-192.png", data: { url: targetOf(p.url) } };
  if (id !== null) options.tag = id;
  return { title: textOf(p.title) || FALLBACK_TITLE, options };
}

self.addEventListener("push", (event) => {
  const { title, options } = notificationOf(event.data);
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data;
  const target = new URL(targetOf(data && data.url), self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window" });
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        try {
          const focused = await client.focus();
          await (focused || client).navigate(target);
          return;
        } catch (_) {
          // A window that cannot be navigated: open a new one below.
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
`;
}

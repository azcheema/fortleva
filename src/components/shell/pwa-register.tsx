"use client";

import { useEffect } from "react";

/**
 * Registers the pass-through service worker (decision 15 / ARC-25) on the
 * member plane. Idempotent, silent on failure (an older browser or a
 * private window simply has no install prompt), `updateViaCache: "none"`
 * so a deploy's new worker is fetched rather than served from the HTTP
 * cache. Nothing else: no prompts, no banners — the browser's own
 * install affordance is the UI (UI.md §3.3).
 */
export function PwaRegister() {
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    // Cache-first is only safe for content-hashed URLs; under `next dev`
    // chunk URLs are stable across edits and the worker would serve stale
    // code after a reload (and its version key is the constant "dev").
    if (process.env.NODE_ENV !== "production") return;
    navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => undefined);
  }, []);
  return null;
}

/** Sign-out hygiene: drop every Cache Storage entry this origin holds (only static assets live there). */
export async function clearPwaCaches(): Promise<void> {
  if (typeof window === "undefined" || !("caches" in window)) return;
  try {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  } catch {
    // best-effort
  }
}

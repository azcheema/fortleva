"use client";

import { useEffect, useRef } from "react";

import { madeWithKey } from "@/push/browser";

/**
 * Registers the service worker (decision 15 / ARC-25) on the member plane.
 * Idempotent, silent on failure (an older browser or a private window simply
 * has no install prompt), `updateViaCache: "none"` so a deploy's new worker is
 * fetched rather than served from the HTTP cache. No prompts, no banners — the
 * browser's own install affordance is the UI (UI.md §3.3).
 *
 * AND THE QUIET RE-LINK (Phase 5 slice 106; founder decision C74 (d)): on a
 * full page load, if this browser already has notifications allowed and a
 * subscription made with this server's key, the signed-in person's OWN device
 * row for it follows them to this sign-in (`onResume` — never creates one, so
 * someone else signing in on this browser turns nothing on). It asks nothing
 * and shows nothing; Settings → Notifications is the only place a device is
 * turned on (C74 (f)).
 *
 * ONCE PER SESSION, not once per render (the code review's low): `onResume` is
 * a server reference, and React builds a new one each time the layout's
 * payload is parsed — every `router.refresh()`, every revalidating action — so
 * it is read through a ref and kept out of the effect's dependencies. What the
 * effect does follow is the SESSION's id (the fix-pass review's low): enrolling
 * a second factor and a password change that signs out other devices both
 * rotate the session with only a refresh, and the device must follow the new
 * one — once.
 */
export function PwaRegister({
  vapidPublicKey,
  sessionId,
  onResume,
}: {
  /** This server's VAPID public key; null when push is not set up. */
  vapidPublicKey: string | null;
  /** The member-plane session's id (never its token): a new one re-links this browser's device once. */
  sessionId: string;
  onResume: (subscription: PushSubscriptionJSON) => Promise<void>;
}) {
  const resume = useRef(onResume);
  const resumedFor = useRef<string | null>(null);
  useEffect(() => {
    resume.current = onResume;
  });
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    // Cache-first is only safe for content-hashed URLs; under `next dev`
    // chunk URLs are stable across edits and the worker would serve stale
    // code after a reload (and its version key is the constant "dev").
    if (process.env.NODE_ENV !== "production") return;
    navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .then(async (registration) => {
        if (vapidPublicKey === null || !("PushManager" in window) || !("Notification" in window)) return;
        if (Notification.permission !== "granted") return;
        const subscription = await registration.pushManager.getSubscription();
        if (subscription === null || !madeWithKey(subscription, vapidPublicKey)) return;
        if (resumedFor.current === sessionId) return;
        resumedFor.current = sessionId;
        await resume.current(subscription.toJSON());
      })
      .catch(() => undefined);
  }, [vapidPublicKey, sessionId]);
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

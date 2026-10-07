"use client";

import { useEffect, useEffectEvent } from "react";

/** A second's grace keeps the expiry just past the server's own edge. */
const GRACE_MS = 1000;
/** How often an open vault re-checks its deadline: a sleeping laptop pauses timers. */
const CHECK_EVERY_MS = 15_000;

/**
 * Each window's deadline on THIS page's clock, kept for the life of the
 * page, so a REMOUNT — the router replaying a cached payload on Back, whose
 * `msLeft` is frozen at its first render — never starts a fresh count
 * (slice 85's reviews). See `tightestDeadline` for how a receipt updates it.
 */
const deadlines = new Map<string, number>();

/**
 * A window's deadline after one more receipt: the EARLIEST seen. Every
 * receipt's candidate — this clock's now plus the server's remaining ms,
 * measured before the bytes left — is at or after the real lock instant,
 * so the earliest is never early; a fresh receipt tightens it, and a
 * replayed payload (a later now, the same frozen msLeft) can never extend
 * it (slice 97's last review: "first receipt wins" let one late receipt —
 * an answer that landed after a laptop woke — govern every surface of
 * that window). A negative remainder counts as none left.
 */
export function tightestDeadline(existing: number | undefined, now: number, msLeft: number): number {
  return Math.min(existing ?? Number.POSITIVE_INFINITY, now + Math.max(0, msLeft));
}

/**
 * THE ONE RULE FOR "THE OPEN VAULT ENDS NOW" on a surface that shows
 * something only an open vault may (C52 (a)): `VaultLockTimer` on every
 * vault page, the portal's Logins page and `/search` over a login, and
 * ⌘K's login rows (slice 97's reviews — the palette first had a bare
 * timeout, which a sleeping laptop delays by however long it slept).
 *
 * `span` names one window: `key` identifies it — its LOCK INSTANT, the same
 * key on every surface, so one window has one deadline (the palette first
 * keyed its answers by a per-mount counter, and after a remount a new
 * answer inherited an old window's deadline) — and `msLeft` is measured on
 * the SERVER's clock and laid on this browser's at receipt
 * (`tightestDeadline`), so a browser clock that runs ahead cannot fire
 * early. Checked on mount (a replayed page), at the deadline, every 15 s
 * (timers pause while a laptop sleeps), and whenever the member comes back
 * — focus, a visible tab, a page restored from the back/forward cache —
 * and `onExpire(key)` runs once per ARMING, told which window ended; a
 * surface armed again for a window already past fires at once. `null`
 * arms nothing.
 */
export function useVaultDeadline(
  span: { key: string; msLeft: number } | null,
  onExpire: (key: string) => void,
): void {
  const expire = useEffectEvent(onExpire);
  const key = span?.key ?? null;
  const msLeft = span?.msLeft ?? 0;

  useEffect(() => {
    if (key === null) return;
    const deadline = tightestDeadline(deadlines.get(key), Date.now(), msLeft);
    deadlines.set(key, deadline);
    const at = deadline + GRACE_MS;
    let done = false;
    const check = () => {
      if (done || Date.now() < at) return;
      done = true;
      expire(key);
    };
    check();
    const timer = window.setTimeout(check, Math.max(0, at - Date.now()));
    const interval = window.setInterval(check, CHECK_EVERY_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    window.addEventListener("focus", check);
    window.addEventListener("pageshow", check);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(interval);
      window.removeEventListener("focus", check);
      window.removeEventListener("pageshow", check);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [key, msLeft]);
}

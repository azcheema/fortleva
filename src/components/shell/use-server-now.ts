"use client";

import { useEffect, useState } from "react";

/**
 * The server's "now" on the client, skew-corrected and ticking.
 *
 * Every live clock outside the header pill (the quick start's running
 * clock, the shift strip's reconciliation, the home strip) derives
 * elapsed time from SERVER instants: a laptop whose clock runs 40 s fast
 * would otherwise show every timer 40 s long. `serverNow` is the instant
 * the page was rendered at; the skew (browser − server) is measured from
 * it once — it is a property of this browser and this server, not of
 * the render — and a FRESH server instant (a `router.refresh()` after a
 * stop, a back/forward restore) re-seeds the clock to it at once, on the
 * render it arrives, never a tick later.
 *
 * Hydration-safe by construction: ONE `Date.now()` per measurement, so
 * the first render — on the server and at hydration alike — returns
 * `now − skew` = `serverNow` exactly. The 1 Hz tick runs only while
 * `live` (a stopped clock does not wake the tab); the returned instant
 * never moves backwards.
 */
type Clock = { serverNow: string; skew: number; now: number };

export function useServerNow(serverNow: string, live: boolean): number {
  const [clock, setClock] = useState<Clock>(() => {
    const at = Date.now();
    return { serverNow, skew: at - Date.parse(serverNow), now: at };
  });
  // A fresh server instant: re-seed during render (React's "adjusting state
  // on a prop change"), with the skew already measured — no browser clock
  // read in render, and the displayed instant can only move forward.
  if (clock.serverNow !== serverNow) {
    setClock({ serverNow, skew: clock.skew, now: Math.max(clock.now, Date.parse(serverNow) + clock.skew) });
  }
  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => setClock((c) => ({ ...c, now: Math.max(c.now, Date.now()) })), 1000);
    return () => window.clearInterval(id);
  }, [live]);
  return clock.now - clock.skew;
}

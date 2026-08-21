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
 * it — and measured AGAIN on the first tick after a fresh server instant
 * arrives (a `router.refresh()` after a stop, a back/forward restore), as
 * the pill does, so a clock mounted from a stale RSC payload does not
 * stay N seconds short for its lifetime.
 *
 * Hydration-safe by construction: ONE `Date.now()` per measurement, so
 * the first render — on the server and at hydration alike — returns
 * `now − skew` = `serverNow` exactly. The 1 Hz tick runs only while
 * `live` (a stopped clock does not wake the tab); `now` only ever moves
 * forward.
 */
type Clock = { serverNow: string; skew: number; now: number };

const measure = (serverNow: string): Clock => {
  const at = Date.now();
  return { serverNow, skew: at - Date.parse(serverNow), now: at };
};

export function useServerNow(serverNow: string, live: boolean): number {
  const [clock, setClock] = useState<Clock>(() => measure(serverNow));
  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => {
      setClock((c) => {
        const at = Date.now();
        // A fresh server instant ⇒ a fresh skew; otherwise keep the one measured for it.
        const skew = c.serverNow === serverNow ? c.skew : at - Date.parse(serverNow);
        return { serverNow, skew, now: Math.max(c.now, at) };
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [live, serverNow]);
  return clock.now - clock.skew;
}

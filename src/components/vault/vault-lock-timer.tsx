"use client";

import { LockOpenIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect } from "react";

/** A second's grace keeps the refresh just past the server's own edge. */
const GRACE_MS = 1000;
/** How often an open vault re-checks its deadline: a sleeping laptop pauses timers. */
const CHECK_EVERY_MS = 15_000;

/**
 * The deadline each lock instant was first received with, on THIS page's
 * clock: `Date.now()` at first receipt plus the server's `msLeft`. Kept for
 * the life of the page, so a REMOUNT — the router replaying a cached
 * payload on Back, whose `msLeft` is frozen at its first render — finds the
 * original deadline instead of starting a fresh count (slice 85's reviews).
 */
const deadlines = new Map<string, number>();

/**
 * "Open. Locks itself at 14:32" (C52 (a)), and the lock itself: when the
 * window ends the page refreshes, and the server — which is what decides —
 * draws the door. Nothing of the open vault stays on a screen nobody is
 * using.
 *
 * The deadline is measured on the SERVER's clock (`msLeft`, computed where
 * `locksAt` was), laid on this browser's at first receipt: a browser clock
 * that runs ahead would otherwise refresh early, be told the vault is
 * still open, and refresh again in a loop. It is checked on mount (a
 * replayed page), on a timer, every 15 s (timers pause while a laptop
 * sleeps), and whenever the member comes back — focus, a visible tab, a
 * page restored from the browser's back/forward cache — and refreshes once.
 * The time shown is formatted by next-intl in the member's zone (never the
 * process's — AGENTS.md's hydration trap).
 */
export function VaultLockTimer({ locksAt, msLeft }: { locksAt: string; msLeft: number }) {
  const t = useTranslations("vault.lock");
  const format = useFormatter();
  const router = useRouter();

  useEffect(() => {
    let deadline = deadlines.get(locksAt);
    if (deadline === undefined) {
      deadline = Date.now() + Math.max(0, msLeft);
      deadlines.set(locksAt, deadline);
    }
    const at = deadline + GRACE_MS;
    let done = false;
    const check = () => {
      if (done || Date.now() < at) return;
      done = true;
      router.refresh();
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
  }, [locksAt, msLeft, router]);

  return (
    <p role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="vault-lock">
      <LockOpenIcon aria-hidden="true" className="size-3.5" />
      {t("openUntil", { time: format.dateTime(new Date(locksAt), { hour: "numeric", minute: "2-digit" }) })}
    </p>
  );
}

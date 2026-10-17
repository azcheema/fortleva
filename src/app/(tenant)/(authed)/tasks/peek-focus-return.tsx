"use client";

import { useEffect, useRef } from "react";

/**
 * FOCUS BACK WHERE THE TASK PANEL WAS OPENED FROM (slice 130; design §3.5).
 * The peek is a sheet the server renders while `?item=` is set; closing it
 * navigates, and the sheet unmounts with no trigger to hand focus to — so
 * Radix focuses nothing and focus falls to <body>, where every single key
 * acts (the standing trap). When `openKey` goes away, the row whose link
 * carries that key takes focus — after Radix's own unmount timeout, and only
 * if nothing else has taken focus meanwhile.
 *
 * When that row is no longer drawn — the change made in the panel took the
 * task out of the filtered list, emptied it, or the peek was opened by a link
 * to a task the list does not hold — the list's own region takes focus instead
 * (the review's LOW: focus must never be left on <body>). The region wraps the
 * list AND its empty states, so it is always there; it is focusable by script
 * only (the calendar body's rule).
 *
 * The list itself stays a server component: it is passed in as children.
 */
export function PeekFocusReturn({
  openKey,
  label,
  children,
}: {
  openKey: string | null;
  /** From t(): the region's name. */
  label: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const previous = useRef<string | null>(openKey);
  useEffect(() => {
    const was = previous.current;
    previous.current = openKey;
    if (was === null || openKey !== null) return;
    const timer = window.setTimeout(() => {
      const active = document.activeElement;
      if (active !== null && active !== document.body) return;
      const region = ref.current;
      if (!region) return;
      const row = region.querySelector<HTMLElement>(`[data-task-key="${CSS.escape(was)}"]`);
      // The region never scrolls the page: the place is the member's to keep
      // (C107 (b)), and a partly visible region would be nudged into view.
      if (row) row.focus();
      else region.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [openKey]);
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="region"
      aria-label={label}
      data-testid="tasks-region"
      className="focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
    >
      {children}
    </div>
  );
}

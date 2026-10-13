"use client";

import { useEffect, useRef } from "react";

import { NEEDS_YOU_BODY_ID, NEWEST_FILE_LINK_ID, focusFirst } from "./ids";

/**
 * WHERE FOCUS GOES WHEN A DECIDED ENTRY'S ROW IS GONE (Phase 4 slice 114c;
 * the code review's L1). An act's own callback runs BEFORE the refreshed
 * page commits, so when the act removes the card's last entry — or a
 * hand-over removes its own button — the element it focused is taken away
 * with the card, and focus falls to `<body>` (AGENTS.md: every key then acts
 * behind any layer). This sits OUTSIDE the card, survives the refresh, and
 * runs after the commit: when the count of entries waiting has fallen and
 * nothing holds focus, the card's body — or, the card gone, the newest file's
 * link — takes it.
 */
export function NeedsFocus({ count }: { count: number }) {
  const was = useRef(count);
  useEffect(() => {
    const before = was.current;
    was.current = count;
    if (count >= before) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    // Without scrolling: a refresh the viewer did not cause must not jump the page (the re-check's nit).
    focusFirst([NEEDS_YOU_BODY_ID, NEWEST_FILE_LINK_ID], { preventScroll: true });
  }, [count]);
  return null;
}

"use client";

import { useCallback, useState, type FocusEvent } from "react";

import type { VisibilityValue } from "@/components/semantic";
import { afterCreatePick } from "@/lib/work-view";

/**
 * A top-level create field's pick (Phase 3 slice 73; founder decision
 * C39). It starts at "Private to team" and goes back there whenever the
 * field closes, its `scope` changes (a board column; quick create's
 * project — which also passes through the picker, closing the field), or
 * the choice stops or starts being `offered` (a refresh turning the
 * project's portal off, or the member's code away, under an open field:
 * a hidden "Client can see" must never come back as a share when the
 * choice is offered again — fix-round review, 2026-09-28) — adjusted
 * DURING RENDER, React's "adjusting state when a prop changes", never in
 * an effect.
 * `afterCreate` is C39's reset, applied through the functional updater
 * against the pick that was SENT (`afterCreatePick`: compare-and-set, and
 * it may only lower): the field stays live through the round trip, and a
 * pick the member changed meanwhile is theirs.
 */
export function useRootCreatePick({ open, scope, offered }: { open: boolean; scope: string; offered: boolean }): {
  pick: VisibilityValue;
  setPick: (next: VisibilityValue) => void;
  afterCreate: (sent: VisibilityValue, keep: boolean) => void;
} {
  const [pick, setPick] = useState<VisibilityValue>("INTERNAL");
  const [seen, setSeen] = useState({ open, scope, offered });
  if (seen.open !== open || seen.scope !== scope || seen.offered !== offered) {
    setSeen({ open, scope, offered });
    setPick("INTERNAL");
  }
  const afterCreate = useCallback((sent: VisibilityValue, keep: boolean) => {
    setPick((current) => afterCreatePick({ sent, current, keep }));
  }, []);
  return { pick, setPick, afterCreate };
}

/**
 * The Subtasks add row's lower-only switch (founder decision (8)): whether
 * the member chose "Private to team" under a shared parent. KEPT across
 * Enters — it is the safe side, and C39's point is that a forgotten switch
 * must never SHARE a run of tasks — and cleared when the field closes.
 */
export function useChildCreateLowered({ open }: { open: boolean }): {
  lowered: boolean;
  setLowered: (next: boolean) => void;
} {
  const [lowered, setLowered] = useState(false);
  const [seenOpen, setSeenOpen] = useState(open);
  if (seenOpen !== open) {
    setSeenOpen(open);
    setLowered(false);
  }
  return { lowered, setLowered };
}

/**
 * What a blur on a create field's GROUP means — pure, so the unit suite
 * pins it (the DOM half is `onCreateGroupBlur` below):
 *   · `stay`  — focus moved inside the group (title ⇄ select), the WINDOW
 *               lost focus (another app or tab: it comes back here), or
 *               the group's own SELECT blurred to nowhere with NO press
 *               outside the group: iOS Safari blurs a select to `<body>`
 *               when its picker's "Done" closes it — a control outside the
 *               page, so no page pointerdown — and closing an empty field
 *               then would throw away the pick just made; on the Subtasks
 *               add row, the one lever decision (8) gave an Employee (code
 *               review, 2026-09-28). A press outside the group (a desktop
 *               click on the page's background after a pick) is a member
 *               leaving, and defers as any other blur to nowhere does
 *               (fix-round review, 2026-09-28).
 *   · `leave` — focus went to a real target outside the group.
 *   · `defer` — the browser did not say where focus went (a press on the
 *               group's own words, or WebKit's untargeted blurs): read it
 *               on the next frame, once focus has landed.
 */
export function createGroupBlur(input: {
  relatedInside: boolean;
  relatedNull: boolean;
  windowFocused: boolean;
  fromSelect: boolean;
  /** A pointerdown landed OUTSIDE the group just before this blur. */
  pointerOutside: boolean;
}): "stay" | "leave" | "defer" {
  if (input.relatedInside) return "stay";
  if (!input.relatedNull) return "leave";
  if (!input.windowFocused || (input.fromSelect && !input.pointerOutside)) return "stay";
  return "defer";
}

/**
 * The page's last pointerdown, recorded in the CAPTURE phase so it is known
 * by the time the blur it causes fires. Installed once, in the browser
 * only (a server render and the unit suite have no `document`).
 */
let lastPointerDown: { target: EventTarget | null; at: number } | null = null;
if (typeof document !== "undefined") {
  document.addEventListener(
    "pointerdown",
    (e) => {
      lastPointerDown = { target: e.target, at: performance.now() };
    },
    { capture: true },
  );
}
/** How recent a press must be to have caused THIS blur (ms) — a tap's pointerdown → blur is well inside it. */
const PRESS_CAUSED_BLUR_MS = 1_000;
const pressedOutside = (group: HTMLElement): boolean =>
  lastPointerDown !== null &&
  performance.now() - lastPointerDown.at < PRESS_CAUSED_BLUR_MS &&
  !(lastPointerDown.target instanceof Node && group.contains(lastPointerDown.target));

/**
 * A create field's GROUP blur (the title field, its visibility control and
 * its hint): `onLeft` runs only when focus has LEFT the group
 * (`createGroupBlur`; `VisibilityQuestion`'s rules). A deferred answer is
 * dropped when the group has meanwhile left the DOM — the field closed or
 * moved, so there is nothing left to close, and a late close must never
 * reach a composer opened since (the board's shared "which column is
 * composing" state; code review, 2026-09-28).
 */
export function onCreateGroupBlur(e: FocusEvent<HTMLElement>, onLeft: () => void): void {
  const group = e.currentTarget;
  const next = e.relatedTarget as Node | null;
  const verdict = createGroupBlur({
    relatedInside: next !== null && group.contains(next),
    relatedNull: next === null,
    windowFocused: document.hasFocus(),
    fromSelect: e.target instanceof HTMLSelectElement && group.contains(e.target),
    pointerOutside: pressedOutside(group),
  });
  if (verdict === "stay") return;
  if (verdict === "leave") {
    onLeft();
    return;
  }
  requestAnimationFrame(() => {
    if (!group.isConnected) return;
    const active = document.activeElement;
    if (active && active !== document.body && group.contains(active)) return;
    onLeft();
  });
}

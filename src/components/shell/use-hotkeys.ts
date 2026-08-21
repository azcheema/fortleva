"use client";

import { useEffect, useRef } from "react";

/**
 * Global keyboard map for the member shell (UI.md §6, scope `global`):
 * ⌘K / Ctrl+K → palette, `?` → keymap overlay, `G` then a letter →
 * go to. Single keys are inert while an editable element has focus;
 * ⌘/Ctrl is never required for the go-to sequence. Kept dependency-free
 * for Phase 1b — a scoped registry (react-hotkeys-hook) can replace the
 * internals without touching callers.
 */
export type HotkeyHandlers = {
  onPalette: () => void;
  onOverlay: () => void;
  onGo: (key: string) => void;
  /** Uppercase letters that complete a `G` sequence. */
  goKeys: readonly string[];
};

const SEQUENCE_WINDOW_MS = 900;

/**
 * The armed `G` sequence is module state, not per-hook: another window
 * keydown listener (the timer pill's bare `T`) registers BEFORE the
 * shell's and therefore cannot see this hook's preventDefault — it asks
 * here instead, so `G T` navigates and never stops a running timer.
 */
let pendingGoTimer: number | null = null;
export const isGoSequencePending = (): boolean => pendingGoTimer !== null;

export const isEditableTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
};

/** ⌘ on macOS, Ctrl elsewhere — the overlay renders the right glyph. */
export const isApplePlatform = (): boolean =>
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform);

export function useGlobalHotkeys(handlers: HotkeyHandlers): void {
  const ref = useRef(handlers);

  useEffect(() => {
    ref.current = handlers;
  });

  useEffect(() => {
    const clearPending = () => {
      if (pendingGoTimer !== null) {
        window.clearTimeout(pendingGoTimer);
        pendingGoTimer = null;
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const h = ref.current;
      // Palette: ⌘K / Ctrl+K — works even inside inputs.
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        clearPending();
        h.onPalette();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditableTarget(e.target)) return;

      if (pendingGoTimer !== null) {
        clearPending();
        const key = e.key.toUpperCase();
        if (h.goKeys.includes(key)) {
          e.preventDefault();
          h.onGo(key);
        }
        return;
      }
      if (e.key === "?") {
        e.preventDefault();
        h.onOverlay();
        return;
      }
      if (e.key.toLowerCase() === "g") {
        pendingGoTimer = window.setTimeout(clearPending, SEQUENCE_WINDOW_MS);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      clearPending();
    };
  }, []);
}

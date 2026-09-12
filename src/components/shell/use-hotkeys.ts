"use client";

import { useEffect, useRef } from "react";

import {
  SCOPE_ORDER,
  decide,
  inMenuLayer,
  isEditableTarget,
  signatureOf,
  type KeyBinding,
  type KeyScope,
  type ScopeSnapshot,
} from "@/lib/keymap";

export { isEditableTarget } from "@/lib/keymap";

/**
 * THE keyboard registry for the member shell (UI.md §6): ONE `window`
 * keydown listener, a scope store any surface can push bindings into,
 * and the `?` overlay / ⌘K palette reading the same snapshot the
 * dispatcher acts on.
 *
 * It replaces three independent window listeners (this file's global
 * map, the timer pill's bare `T`, the board's capture-phase `C`) that
 * coordinated through module state and a deliberate phase choice. That
 * arrangement was the defect: the board had to register on CAPTURE so
 * it could see an armed `G` before this file's bubble listener cleared
 * it, and the pill had to guard on both `defaultPrevented` and
 * `isGoSequencePending()` because its position in the dispatch order
 * changed every time the timer started or stopped. With one dispatcher
 * the `G` sequence is consulted once, ahead of every scope, and all
 * three workarounds delete themselves.
 *
 * BUBBLE PHASE, no `capture`. Next's React root is `document`, so every
 * React `onKeyDown` and every Radix dismissable layer has already run
 * by the time an event reaches `window` — which is what makes
 * `e.defaultPrevented` a meaningful first question (it neutralises
 * cmdk, which preventDefaults the arrows and Enter but never
 * stopPropagations) and why a React-tree handler always wins.
 *
 * The decision itself lives in `@/lib/keymap` as a pure function: this
 * repo's vitest is `environment: "node"` with no jsdom, so a decision
 * inside this closure would be untestable.
 */
export type HotkeyHandlers = {
  onPalette: () => void;
  onOverlay: () => void;
  onGo: (key: string) => void;
  /** Uppercase letters that complete a `G` sequence. */
  goKeys: readonly string[];
  /** Translated label for the `?` row the shell registers. */
  overlayLabel: string;
};

const SEQUENCE_WINDOW_MS = 900;

/**
 * The armed `G` sequence is module state because the dispatcher is a
 * module singleton. It has exactly ONE reader outside this file:
 * `board.tsx`'s `onBoardKeyDown`, a React-tree handler that runs at
 * document-bubble — before the dispatcher — and therefore has no other
 * way to see that a `G` is already armed. Everything else that used to
 * ask now simply registers a binding.
 */
let pendingGoTimer: number | null = null;
export const isGoSequencePending = (): boolean => pendingGoTimer !== null;

type Entry = {
  id: number;
  scope: KeyScope;
  order: number;
  exclusive: boolean;
  /** Live bindings — dispatch reads through this, so closures are always fresh. */
  ref: { current: readonly KeyBinding[] };
  /** Last OVERLAY-VISIBLE shape, so a re-render with new closures emits nothing. */
  sig: string;
};

const EMPTY: readonly ScopeSnapshot[] = [];

let entries: Entry[] = [];
let seq = 0;
let version = 0;
const subs = new Set<() => void>();
let cached: readonly ScopeSnapshot[] = EMPTY;
let cachedAt = -1;

const emit = () => {
  version += 1;
  for (const cb of subs) cb();
};

export const subscribeScopes = (cb: () => void): (() => void) => {
  subs.add(cb);
  return () => {
    subs.delete(cb);
  };
};

/**
 * Version-cached, so the array identity is STABLE between real changes
 * — `useSyncExternalStore` re-renders forever if its snapshot is a new
 * object every call.
 */
export const scopeSnapshot = (): readonly ScopeSnapshot[] => {
  if (cachedAt !== version) {
    cached = entries.map((e) => ({
      scope: e.scope,
      order: e.order,
      exclusive: e.exclusive,
      bindings: e.ref.current,
    }));
    cachedAt = version;
  }
  return cached;
};

/** The server snapshot: stable, and empty because no scope has mounted. */
export const emptyScopes = (): readonly ScopeSnapshot[] => EMPTY;

/**
 * Run a binding by its registry coordinates, reading the LIVE closure.
 *
 * The ⌘K palette must go through this rather than invoking the `run` it
 * read from `scopeSnapshot()`: that snapshot is memoised by version, and
 * version deliberately ignores closure identity (`signatureOf`), so its
 * `run` can be a commit old. The keydown path has always re-read
 * `entries`; this is the same read, so both triggers do the same thing.
 */
export const runScopeBinding = (entry: number, index: number, e: KeyboardEvent): void => {
  try {
    entries[entry]?.ref.current[index]?.run?.(e);
  } catch (err) {
    console.error(err);
  }
};

/**
 * Register this component's keys for as long as it is mounted.
 *
 * Two effects on purpose, and the split is the subtle part of the whole
 * slice:
 *
 *  (a) registration is keyed on `(scope, exclusive)` ONLY, so a parent
 *      re-render does not unregister and re-register (which would
 *      reorder same-order peers and emit twice);
 *  (b) the live bindings refresh on EVERY commit — dispatch must call
 *      today's closure, not the one from mount — but subscribers are
 *      notified only when the overlay-visible SHAPE changed.
 *
 * The ref is written in an effect and NEVER during render: this project
 * sets `reactCompiler: true`, and a render-phase ref write is exactly
 * what it is entitled to move or repeat.
 */
export function useScopeKeys(
  scope: KeyScope,
  bindings: readonly KeyBinding[],
  opts?: { exclusive?: boolean },
): void {
  const bindingsRef = useRef(bindings);
  const entryRef = useRef<Entry | null>(null);
  const exclusive = opts?.exclusive ?? false;

  useEffect(() => {
    seq += 1;
    const entry: Entry = {
      id: seq,
      scope,
      order: SCOPE_ORDER[scope],
      exclusive,
      ref: bindingsRef,
      sig: signatureOf(bindingsRef.current),
    };
    entryRef.current = entry;
    // Ascending by order, ties by registration id — the dispatcher walks
    // it backwards. Precedence is the SCOPE_ORDER table and never mount
    // order: child effects run before parents', so a push-ordered stack
    // would put the shell's `global` above the panel's `item`.
    entries = [...entries, entry].sort((a, b) => a.order - b.order || a.id - b.id);
    emit();
    return () => {
      entries = entries.filter((x) => x !== entry);
      entryRef.current = null;
      emit();
    };
  }, [scope, exclusive]);

  // Deliberately dependency-free: it must run on every commit.
  useEffect(() => {
    bindingsRef.current = bindings;
    const entry = entryRef.current;
    if (!entry) return;
    // Comparing `bindings` by identity would emit on every render, and
    // with the overlay subscribed above a caller of this hook that is an
    // infinite loop. `signatureOf` deliberately cannot see a closure.
    const sig = signatureOf(bindings);
    if (entry.sig !== sig) {
      entry.sig = sig;
      emit();
    }
  });
}

export function useGlobalHotkeys(handlers: HotkeyHandlers): void {
  const ref = useRef(handlers);

  useEffect(() => {
    ref.current = handlers;
  });

  // `?` is an ordinary global binding now, so the overlay lists it the
  // same way it lists every other key — one mechanism, not a literal row
  // that has to be remembered.
  useScopeKeys("global", [
    {
      key: "?",
      label: handlers.overlayLabel,
      run: () => ref.current.onOverlay(),
      enabled: true,
      palette: false,
    },
  ]);

  useEffect(() => {
    const clearPending = () => {
      if (pendingGoTimer !== null) {
        window.clearTimeout(pendingGoTimer);
        pendingGoTimer = null;
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const d = decide(
        {
          key: e.key,
          metaKey: e.metaKey,
          ctrlKey: e.ctrlKey,
          altKey: e.altKey,
          defaultPrevented: e.defaultPrevented,
          inEditable: isEditableTarget(e.target),
          inMenuLayer: inMenuLayer(e.target),
        },
        scopeSnapshot(),
        ref.current.goKeys,
        pendingGoTimer !== null,
      );
      switch (d.kind) {
        case "palette":
          e.preventDefault();
          clearPending();
          ref.current.onPalette();
          return;
        case "go":
          e.preventDefault();
          clearPending();
          ref.current.onGo(d.key);
          return;
        // An armed `G` consumes exactly the next key either way, so a
        // mistyped `G Q` is a no-op rather than a stray `Q`.
        case "swallowGo":
          clearPending();
          return;
        case "swallow":
          e.preventDefault();
          return;
        case "arm":
          pendingGoTimer = window.setTimeout(clearPending, SEQUENCE_WINDOW_MS);
          return;
        case "binding": {
          e.preventDefault();
          // Read through `entries`, not the snapshot: the snapshot is
          // memoised by version and its closures can be one commit old.
          const binding = entries[d.entry]?.ref.current[d.binding];
          try {
            binding?.run?.(e);
          } catch (err) {
            // One throwing handler must not take the whole keyboard down.
            console.error(err);
          }
          return;
        }
        default:
          return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      clearPending();
    };
  }, []);
}

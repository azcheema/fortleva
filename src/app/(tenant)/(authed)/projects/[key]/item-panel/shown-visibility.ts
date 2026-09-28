import { useSyncExternalStore } from "react";

import type { VisibilityValue } from "@/components/semantic";

/**
 * WHAT THE RAIL SHOWS for a task's visibility, for the other islands of
 * the same panel (Phase 3 slice 73; the design review's one finding
 * that every lens reached).
 *
 * The rail's `V` adopts a share or a make-private the moment the action
 * answers, and the page's server props follow only when the refresh
 * commits — over two seconds on a task page (AGENTS.md). The Subtasks
 * add row and `⌘⇧O` decide what a new child is born with, so reading
 * the lagging prop there meant: share a task in the rail, add a subtask
 * at once, and it was quietly born PRIVATE under a parent the rail said
 * the client could see (founder decision (8): a child is born with its
 * parent's visibility). The standing rule — decide on what an island
 * SHOWS, never on a lagging prop — needs the value to cross islands,
 * and this is the smallest way: `VisibilityField` publishes what it
 * shows, keyed by the task; a reader takes it only while its OWN prop
 * still equals the prop the value was published against (`base`). So a
 * colleague's change arriving by refresh is never masked — the prop
 * moves, `base` no longer matches, the reader follows the prop — and
 * the moment the rail's own refresh lands the two agree anyway.
 *
 * A module store rather than a context: the rail and the sections are
 * separate client islands under server components, with no common
 * client parent to hold one.
 */
type Entry = { readonly base: VisibilityValue; readonly shown: VisibilityValue };

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** `VisibilityField`'s side: what it shows for `itemId`, against which prop — or `null` when it unmounts. */
export function publishShownVisibility(itemId: string, entry: Entry | null): void {
  const prev = entries.get(itemId);
  if (entry === null) {
    if (!prev) return;
    entries.delete(itemId);
  } else {
    if (prev && prev.base === entry.base && prev.shown === entry.shown) return;
    entries.set(itemId, entry);
  }
  for (const listener of listeners) listener();
}

/**
 * THE READ RULE, pure: the published value only while the reader's prop is
 * still the prop it was published against — a colleague's change arriving
 * by refresh moves the prop, and the prop wins at once.
 */
export const shownFrom = (entry: Entry | undefined, prop: VisibilityValue): VisibilityValue =>
  entry && entry.base === prop ? entry.shown : prop;

/** What a reader of `itemId` would see now — the hook's value, outside React (the unit suite's door). */
export const readShownVisibility = (itemId: string, prop: VisibilityValue): VisibilityValue =>
  shownFrom(entries.get(itemId), prop);

/** Subscribe to every publish — `useSyncExternalStore`'s side, exported for the unit suite. */
export { subscribe as subscribeShownVisibility };

/** A reader's side: the rail's value for `itemId` while it was published against `prop`, else `prop`. */
export function useShownVisibility(itemId: string, prop: VisibilityValue): VisibilityValue {
  // The entry object is replaced, never mutated, so the snapshot is stable
  // between publishes (`useSyncExternalStore`'s contract).
  const entry = useSyncExternalStore(
    subscribe,
    () => entries.get(itemId),
    () => undefined,
  );
  return shownFrom(entry, prop);
}

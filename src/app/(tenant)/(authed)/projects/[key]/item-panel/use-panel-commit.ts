"use client";

import { useRouter } from "next/navigation";
import { useOptimistic, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import type { ActionResult } from "@/lib/server-actions";

/**
 * The ONE commit path for the item rail's property islands (UI.md §5.2,
 * §7.2) — `S P E D` today, and the shape `A V M L` take. Each island
 * owns its trigger, its key and its action; this owns what happens
 * between the member's pick and the server's answer, so the four cannot
 * drift into four different ideas of "saved".
 *
 * · A TRANSITION, never a `<form action>`: React 19 resets a form action
 *   at the start of every action, so a control inside one shows stale
 *   server state (the standing trap).
 * · `useOptimistic` over the REQUIRED server props: the optimistic slice
 *   unwinds to them by itself when the transition ends, which is why a
 *   failure needs no hand-written revert.
 * · A pick equal to what is shown costs no round trip and tells no lie.
 *   The server would also write nothing and say `changed: false`, but
 *   claiming "saved" for a write that did not happen starts here.
 * · A failure is TOLD (the standing rule), and — unless a newer commit
 *   has superseded it (below) — refreshes: "the panel shows the current
 *   X" must be true after the toast, not merely the value this panel
 *   rendered from.
 * · `changed: false` does NOT mean "nothing to do" — it means the server
 *   disagreed with the props this panel rendered from, because someone
 *   else had already made the change. Returning early there once let the
 *   optimistic value unwind to the STALE prop: the member's pick appeared
 *   to revert with no toast and no refresh. So BOTH branches of the
 *   newest commit adopt the canonical row and refresh — which is also the
 *   only refresh the item page gets, its `revalidatePath` form matching
 *   nothing.
 * · A commit SUPERSEDED by a newer one adopts nothing, announces nothing
 *   and does not refresh when its answer lands. Next runs server actions
 *   one at a time, so an earlier pick's answer normally arrives while the
 *   later pick is still in flight — and a `setShown` after an `await`
 *   joins the optimistic queue BEHIND the later pick's. (Not always: a
 *   NAVIGATION dispatched while an action is pending makes Next discard
 *   it and start the next queued action while the first fetch still runs,
 *   so answers can then land out of order. The token still lets only the
 *   newest commit decide what is shown; `lastSaved` below may then name an
 *   older answer. A recorded residue, PLAN §0.) Adopting it once
 *   showed the member's correction reverting, and spoke a value they did
 *   not end on, for a whole round trip. The newest commit's own answer
 *   decides what is shown, and refreshes, in both branches. A superseded
 *   FAILURE is still told: that write did not happen, and nothing else
 *   will say so. And if the newest commit FAILS after a superseded one
 *   ANSWERED, the failure branch announces that answer's canonical value:
 *   changed or not, it is the newest stored value the panel has heard of,
 *   what the item ends on, and the refresh would otherwise show it
 *   without a word.
 *
 * `announced` feeds an ALWAYS-mounted live region the island renders
 * (a `role="status"` that appears together with its text is never
 * announced), and stays empty until a change has actually happened, so
 * no past-tense sentence stands in the tree of a task nobody touched.
 */
export function usePanelCommit<Shown, Committed extends { changed: boolean }>(opts: {
  /** REQUIRED server props — what the optimistic slice unwinds to. */
  canonical: Shown;
  /** The no-op guard: true when a pick would change nothing. */
  same: (a: Shown, b: Shown) => boolean;
  /** The canonical row the action returned → what the island shows. */
  adopt: (committed: Committed) => Shown;
  /** Translated past tense for the live region. */
  announce: (shown: Shown) => string;
  /** Toast text when the action itself throws. */
  failedMessage: string;
}): {
  shown: Shown;
  announced: string;
  commit: (next: Shown, call: () => Promise<ActionResult<Committed>>) => void;
} {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [announced, setAnnounced] = useState("");
  const [shown, setShown] = useOptimistic(opts.canonical, (_current: Shown, next: Shown) => next);
  // The newest commit's token. Written only in `commit` (never in render),
  // and read after the await to ask "has a newer pick started since?".
  const latest = useRef(0);
  // The canonical value of the last SUPERSEDED commit that answered —
  // boxed, because `Shown` may itself be nullable. Written and read only
  // after an await.
  const lastSaved = useRef<{ value: Shown } | null>(null);

  const commit = (next: Shown, call: () => Promise<ActionResult<Committed>>) => {
    if (opts.same(next, shown)) return;
    const token = ++latest.current;
    startTransition(async () => {
      setShown(next);
      const r = await call().catch(
        (): ActionResult<Committed> => ({ ok: false, message: opts.failedMessage }),
      );
      const superseded = latest.current !== token;
      if (!r.ok) {
        toast.error(r.message);
        if (superseded) return;
        // The newest pick failed. If an earlier pick of this burst was
        // answered, its canonical value is what the item ends on: say so.
        const saved = lastSaved.current;
        lastSaved.current = null;
        if (saved) setAnnounced(opts.announce(saved.value));
        router.refresh();
        return;
      }
      if (superseded) {
        // Whatever `changed` says, this canonical row is the newest stored
        // value the panel has heard of — the one a later failure must speak.
        lastSaved.current = { value: opts.adopt(r.value) };
        return;
      }
      lastSaved.current = null;
      const canonical = opts.adopt(r.value);
      setShown(canonical);
      setAnnounced(opts.announce(canonical));
      router.refresh();
    });
  };

  return { shown, announced, commit };
}

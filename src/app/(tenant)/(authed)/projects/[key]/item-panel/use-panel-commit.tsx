"use client";

import { useRouter } from "next/navigation";
import { useEffect, useOptimistic, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import type { ActionResult } from "@/lib/server-actions";

/**
 * The ONE commit path for the item rail's property islands (UI.md §5.2,
 * §7.2) — `S A P E D V M L`. Each island owns its trigger, its key and
 * its action; this owns what happens between the member's pick and the
 * server's answer, so the eight cannot drift into eight different ideas
 * of "saved".
 *
 * · A TRANSITION, never a `<form action>`: React 19 resets a form action
 *   at the start of every action, so a control inside one shows stale
 *   server state (the standing trap).
 * · `useOptimistic` over the REQUIRED server props: the optimistic slice
 *   unwinds to them by itself when the transition ends, which is why a
 *   failure needs no hand-written revert. `optimistic: false` (V alone,
 *   §10.4) skips the optimistic step: the shown value stays the canonical
 *   prop until the canonical row is adopted.
 * · A pick equal to what is IN FLIGHT, or — with nothing in flight — to
 *   what is shown, costs no round trip and tells no lie. The server would
 *   also write nothing and say `changed: false`, but claiming "saved" for
 *   a write that did not happen starts here. The basis is the newest
 *   pending pick, never merely `shown`: against `shown` the guard was
 *   right only by coincidence, in optimistic mode, where `shown` happens
 *   to BE the pending pick — under `optimistic: false` it stays the prop
 *   for the whole round trip, so a reversal back to it ("Client can
 *   see", then "Private to team" before the answer landed) was dropped
 *   as a no-op, the first pick landed, and the task stayed shared against
 *   the member's last word (review 2026-09-13). Once the newest answer
 *   has landed, `shown` is the adopted canonical row — or, when it
 *   failed with nothing else answered, the prop again: on an OPTIMISTIC
 *   island that is set back at once rather than left to the refresh,
 *   whose revert waits for its data, and until then a retry of the
 *   failed pick would compare equal to the value still on screen and be
 *   dropped; the value set back is the LIVE prop (a ref the render
 *   keeps current), never the closure's, which a refresh during the
 *   flight may have overtaken. A non-optimistic island needs no such
 *   step: nothing was ever shown that the row did not hold.
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
 *   ANSWERED, the failure branch shows AND announces that answer's
 *   canonical value: changed or not, it is the newest stored value the
 *   panel has heard of, what the item ends on — announced alone, a
 *   non-optimistic island kept the stale prop on screen for a whole
 *   refresh round trip while the row already held it.
 *
 * `status` is the island's ALWAYS-mounted live region (a `role="status"`
 * that appears together with its text is never announced), rendered
 * once by each island; it stays empty until a change has actually
 * happened, so no past-tense sentence stands in the tree of a task
 * nobody touched.
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
  /**
   * Show the pick before the server answers — the default, and the rule
   * for every property but one. `false` for Visibility (UI.md §10.4:
   * never optimistic): the shown value stays the canonical prop until
   * the canonical row is adopted, so a chip never says "Private to team"
   * over a task the database is about to refuse to make private, and
   * never "Client can see" before the client actually can.
   */
  optimistic?: boolean;
}): {
  shown: Shown;
  /** The always-mounted live region — render it once, anywhere in the island. */
  status: React.ReactNode;
  commit: (next: Shown, call: () => Promise<ActionResult<Committed>>) => void;
} {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [announced, setAnnounced] = useState("");
  const [shown, setShown] = useOptimistic(opts.canonical, (_current: Shown, next: Shown) => next);
  // The newest commit's token. Written only in `commit` (never in render),
  // and read after the await to ask "has a newer pick started since?".
  const latest = useRef(0);
  // The newest pick IN FLIGHT — the no-op guard's basis while a commit is
  // pending. Boxed, because `Shown` may itself be nullable. Set beside the
  // token, cleared only when the NEWEST answer lands (success or failure),
  // never by a superseded one.
  const inFlight = useRef<{ value: Shown } | null>(null);
  // The canonical value of the last SUPERSEDED commit that answered —
  // boxed, because `Shown` may itself be nullable. Written and read only
  // after an await.
  const lastSaved = useRef<{ value: Shown } | null>(null);
  // The LIVE prop, for the failure branch: `opts.canonical` in `commit`'s
  // closure is the prop as of the render that made it, and a refresh
  // during the flight — the board's poll, a colleague's edit — may have
  // delivered a newer one. Written from an effect, never during render.
  const canonicalNow = useRef(opts.canonical);
  useEffect(() => {
    canonicalNow.current = opts.canonical;
  });

  const commit = (next: Shown, call: () => Promise<ActionResult<Committed>>) => {
    if (opts.same(next, inFlight.current ? inFlight.current.value : shown)) return;
    const token = ++latest.current;
    inFlight.current = { value: next };
    startTransition(async () => {
      if (opts.optimistic !== false) setShown(next);
      const r = await call().catch(
        (): ActionResult<Committed> => ({ ok: false, message: opts.failedMessage }),
      );
      const superseded = latest.current !== token;
      if (!r.ok) {
        toast.error(r.message);
        if (superseded) return;
        inFlight.current = null;
        // The newest pick failed. If an earlier pick of this burst was
        // answered, its canonical value is what the item ends on: show it
        // and say so.
        const saved = lastSaved.current;
        lastSaved.current = null;
        if (saved) {
          setShown(saved.value);
          setAnnounced(opts.announce(saved.value));
        } else if (opts.optimistic !== false) {
          // Nothing was written: back to the LIVE prop now, not when the
          // refresh lands — an optimistic island would otherwise keep the
          // failed pick on screen for a whole round trip (or for as long
          // as the network stays down), and drop a retry of it as a
          // no-op. A non-optimistic island shows the prop already.
          setShown(canonicalNow.current);
        }
        router.refresh();
        return;
      }
      if (superseded) {
        // Whatever `changed` says, this canonical row is the newest stored
        // value the panel has heard of — the one a later failure must speak.
        lastSaved.current = { value: opts.adopt(r.value) };
        return;
      }
      inFlight.current = null;
      lastSaved.current = null;
      const canonical = opts.adopt(r.value);
      setShown(canonical);
      setAnnounced(opts.announce(canonical));
      router.refresh();
    });
  };

  const status = (
    <span role="status" aria-live="polite" className="sr-only">
      {announced}
    </span>
  );

  return { shown, status, commit };
}

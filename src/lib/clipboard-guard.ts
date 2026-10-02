/**
 * A COPY THAT CLEARS ITSELF (founder decision C52 (c), 2026-10-02).
 *
 * What a web page can and cannot do, stated once so nobody promises more:
 * it can WRITE the clipboard while it has focus — and, in Firefox and
 * Safari, only inside a click or a key press — and write it again later to
 * empty it. It cannot see a paste in another program, cannot make a
 * clipboard "paste once", and cannot keep a copy out of Windows clipboard
 * history (Win+V) or a phone's clipboard sync — so the product says
 * "clears itself", never "paste once".
 *
 * So, after a copy, a clear is OWED, and it becomes DUE at whichever comes
 * first:
 *   - **30 seconds** — tried at once if the page has focus;
 *   - **the person coming back** — the window's `focus`, or the tab
 *     becoming visible again: the moment after a paste in another program.
 * A due clear is tried then, and — because Firefox and Safari refuse a
 * write that no click or key asked for — tried again on the next CLICK in
 * the page (on iOS: the next tap on a control — WebKit synthesises no
 * click for plain text), until one write succeeds (slice 85's reviews: a
 * `click`, not a `pointerdown`, because a touch's pointerdown carries no
 * user activation in iOS WebKit, so a phone's clear would never land).
 * Never while a copy is in flight: that copy settles the clear itself.
 * Before it is due, a click clears nothing: a member who copies and keeps
 * working on the page is not second-guessed. And a copy or cut the member
 * makes IN this page that really replaces the clipboard — a trusted event
 * over a real selection, not of a revealed secret (the binding decides) —
 * supersedes the owed clear instead of being wiped by it.
 *
 * A newer copy replaces the owed clear of an older one, and an older
 * clear that lands after a newer copy began settles nothing of the newer
 * one's. It cannot tell whether the clipboard still holds OUR value
 * (reading it needs a permission prompt), so it empties whatever is there
 * — the price of clearing at all, and the same trade a password manager
 * makes.
 *
 * Pure, with the browser injected, so the unit suite drives it with fake
 * timers; `src/components/vault/vault-clipboard.ts` binds it to `window`
 * once per page load.
 */

export const CLIPBOARD_CLEAR_MS = 30_000;

export type ClipboardEnv = {
  /**
   * Write the clipboard; rejects without focus (or, in some browsers,
   * without a user gesture). Takes a PROMISE of the text too, and must
   * start the write synchronously: Safari honours a write only inside the
   * click that asked for it, and the vault's value arrives after a server
   * call — `vault-clipboard.ts` hands the browser a `ClipboardItem` holding
   * the promise, within the gesture.
   */
  readonly write: (text: string | Promise<string>) => Promise<void>;
  readonly hasFocus: () => boolean;
  /** Subscribe to the person coming back (window focus, tab visible); returns the unsubscribe. */
  readonly onReturn: (fn: () => void) => () => void;
  /** Subscribe to a click anywhere in the page — a user gesture in every engine; returns the unsubscribe. */
  readonly onActivation: (fn: () => void) => () => void;
  /** Subscribe to the member copying or cutting something else in this page; returns the unsubscribe. */
  readonly onSuperseded: (fn: () => void) => () => void;
  readonly setTimer: (fn: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
};

export type ClipboardGuard = {
  /**
   * Write `text`, then owe a clear (above). Rejects if the browser refuses
   * the write or the text's promise rejects (a vault refusal) — and then
   * nothing new is owed (an older copy's clear still is). Call it from the
   * click handler itself, without awaiting anything first.
   */
  readonly copy: (text: string | Promise<string>) => Promise<void>;
  /** Whether a clear is still owed. */
  readonly pending: () => boolean;
};

type Owed = {
  timer: unknown;
  offReturn: () => void;
  offActivation: () => void;
  offSuperseded: () => void;
  due: boolean;
};

export function createClipboardGuard(env: ClipboardEnv): ClipboardGuard {
  let owed: Owed | null = null;
  // Copies whose write has started and not settled. An emptying write
  // started meanwhile would abort them in Firefox and WebKit (a newer
  // write cancels a pending one) and spend an audited copy for nothing;
  // the copy's own success settles the older clear anyway (review round 3).
  let inFlight = 0;

  const settle = (which: Owed) => {
    if (owed !== which) return;
    env.clearTimer(which.timer);
    which.offReturn();
    which.offActivation();
    which.offSuperseded();
    owed = null;
  };

  // Clears THIS owed clear only: a newer copy that began while the write
  // was in flight owns its own. A refused write keeps it owed.
  const clear = async (which: Owed) => {
    if (owed !== which || inFlight > 0) return;
    try {
      await env.write("");
      settle(which);
    } catch {
      /* still owed — the next return or press tries again */
    }
  };

  return {
    copy: async (text) => {
      inFlight += 1;
      try {
        await env.write(text);
      } finally {
        inFlight -= 1;
      }
      if (owed) settle(owed);
      const which: Owed = {
        timer: null,
        offReturn: () => {},
        offActivation: () => {},
        offSuperseded: () => {},
        due: false,
      };
      which.timer = env.setTimer(() => {
        which.due = true;
        if (env.hasFocus()) void clear(which);
      }, CLIPBOARD_CLEAR_MS);
      which.offReturn = env.onReturn(() => {
        which.due = true;
        void clear(which);
      });
      which.offActivation = env.onActivation(() => {
        if (which.due) void clear(which);
      });
      which.offSuperseded = env.onSuperseded(() => settle(which));
      owed = which;
    },
    pending: () => owed !== null,
  };
}

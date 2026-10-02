import { describe, expect, it } from "vitest";

import { CLIPBOARD_CLEAR_MS, createClipboardGuard, type ClipboardEnv } from "./clipboard-guard";

/**
 * A browser stand-in: a clipboard, a focus flag, return and activation
 * listener sets, manual timers — and, with `needsGesture`, Firefox's and
 * Safari's rule that a write needs a click or key press in progress.
 */
function fakeBrowser({ needsGesture = false }: { needsGesture?: boolean } = {}) {
  let clipboard = "";
  let focused = true;
  let inGesture = false;
  /** Every write as it STARTED: a string, or "<promised>". */
  const started: string[] = [];
  const returns = new Set<() => void>();
  const activations = new Set<() => void>();
  const supersessions = new Set<() => void>();
  const timers = new Map<number, { fn: () => void; at: number }>();
  let now = 0;
  let nextId = 1;
  const env: ClipboardEnv = {
    write: (text) => {
      started.push(typeof text === "string" ? text : "<promised>");
      // The permission is decided when the write STARTS, as in a browser.
      if (!focused) return Promise.reject(new Error("NotAllowedError: Document is not focused."));
      if (needsGesture && !inGesture) return Promise.reject(new Error("NotAllowedError: no user activation."));
      return Promise.resolve(text).then((t) => {
        clipboard = t;
      });
    },
    hasFocus: () => focused,
    onReturn: (fn) => {
      returns.add(fn);
      return () => returns.delete(fn);
    },
    onActivation: (fn) => {
      activations.add(fn);
      return () => activations.delete(fn);
    },
    onSuperseded: (fn) => {
      supersessions.add(fn);
      return () => supersessions.delete(fn);
    },
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return {
    env,
    clipboard: () => clipboard,
    leave: () => {
      focused = false;
    },
    returnToTab: async () => {
      focused = true;
      for (const fn of [...returns]) fn();
      await flush();
    },
    started: () => [...started],
    /** Focus comes back without any return listener having run yet. */
    focusOnly: () => {
      focused = true;
    },
    fireReturn: async () => {
      for (const fn of [...returns]) fn();
      await flush();
    },
    /** Back, with the return's clear started but not yet landed. */
    returnWithoutWaiting: () => {
      focused = true;
      for (const fn of [...returns]) fn();
    },
    click: async () => {
      inGesture = true;
      for (const fn of [...activations]) fn();
      inGesture = false;
      await flush();
    },
    /** The member copies something else in this page (Ctrl+C on its text). */
    copyElseInPage: async (text: string) => {
      clipboard = text;
      for (const fn of [...supersessions]) fn();
      await flush();
    },
    /** A copy started inside a click, as the vault's buttons do. */
    copyInClick: async (g: ReturnType<typeof createClipboardGuard>, text: string | Promise<string>) => {
      inGesture = true;
      const p = g.copy(text);
      inGesture = false;
      await p;
    },
    advance: async (ms: number) => {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
      }
      await flush();
    },
    listeners: () => returns.size + activations.size + supersessions.size,
    timers: () => timers.size,
  };
}

describe("a copy that clears itself (C52 (c))", () => {
  it("clears after 30 seconds when the page still has focus", async () => {
    const b = fakeBrowser();
    const g = createClipboardGuard(b.env);
    await g.copy("hunter2");
    expect(b.clipboard()).toBe("hunter2");
    await b.advance(CLIPBOARD_CLEAR_MS - 1);
    expect(b.clipboard()).toBe("hunter2");
    await b.advance(1);
    expect(b.clipboard()).toBe("");
    expect(g.pending()).toBe(false);
    expect(b.listeners()).toBe(0);
  });

  it("clears the moment the person comes back from pasting elsewhere", async () => {
    const b = fakeBrowser();
    const g = createClipboardGuard(b.env);
    await g.copy("hunter2");
    b.leave();
    await b.advance(5_000);
    expect(b.clipboard()).toBe("hunter2");
    await b.returnToTab();
    expect(b.clipboard()).toBe("");
    expect(g.pending()).toBe(false);
    expect(b.timers()).toBe(0);
  });

  it("a timer that fires while the person is away does nothing — the return clears it", async () => {
    const b = fakeBrowser();
    const g = createClipboardGuard(b.env);
    await g.copy("hunter2");
    b.leave();
    await b.advance(CLIPBOARD_CLEAR_MS + 10_000);
    expect(b.clipboard()).toBe("hunter2");
    expect(g.pending()).toBe(true);
    await b.returnToTab();
    expect(b.clipboard()).toBe("");
    expect(g.pending()).toBe(false);
  });

  it("where a write needs a gesture (Firefox, Safari): the refused return-clear stays owed, and the next click clears", async () => {
    const b = fakeBrowser({ needsGesture: true });
    const g = createClipboardGuard(b.env);
    await b.copyInClick(g, "hunter2");
    expect(b.clipboard()).toBe("hunter2");
    b.leave();
    await b.returnToTab(); // refused: no gesture
    expect(b.clipboard()).toBe("hunter2");
    expect(g.pending()).toBe(true);
    await b.click();
    expect(b.clipboard()).toBe("");
    expect(g.pending()).toBe(false);
    expect(b.listeners()).toBe(0);
  });

  it("before the clear is due, a click on the page clears nothing", async () => {
    const b = fakeBrowser({ needsGesture: true });
    const g = createClipboardGuard(b.env);
    await b.copyInClick(g, "hunter2");
    await b.click();
    expect(b.clipboard()).toBe("hunter2");
    await b.advance(CLIPBOARD_CLEAR_MS); // due now, refused without a gesture
    expect(b.clipboard()).toBe("hunter2");
    await b.click();
    expect(b.clipboard()).toBe("");
  });

  it("a newer copy replaces the older one's clear — one timer, one set of listeners", async () => {
    const b = fakeBrowser();
    const g = createClipboardGuard(b.env);
    await g.copy("first");
    await b.advance(20_000);
    await g.copy("second");
    expect(b.timers()).toBe(1);
    expect(b.listeners()).toBe(3);
    await b.advance(10_000); // the first copy's 30 s have passed
    expect(b.clipboard()).toBe("second");
    await b.advance(20_000);
    expect(b.clipboard()).toBe("");
  });

  it("an older clear that lands after a newer copy began does not settle the newer one", async () => {
    const b = fakeBrowser();
    const g = createClipboardGuard(b.env);
    await g.copy("first");
    b.leave();
    await b.advance(CLIPBOARD_CLEAR_MS); // due, refused while away
    // Back — the first copy's clear starts — and straight into another
    // copy whose value is still on its way.
    b.returnWithoutWaiting();
    let resolve!: (v: string) => void;
    const second = g.copy(new Promise<string>((r) => (resolve = r)));
    resolve("second");
    await second;
    expect(b.clipboard()).toBe("second");
    expect(g.pending()).toBe(true);
    await b.advance(CLIPBOARD_CLEAR_MS);
    expect(b.clipboard()).toBe("");
  });

  it("the value may arrive later — the write starts at once, and a refused value owes nothing new", async () => {
    const b = fakeBrowser();
    const g = createClipboardGuard(b.env);
    let resolve!: (v: string) => void;
    const copied = g.copy(new Promise<string>((r) => (resolve = r)));
    resolve("from-the-server");
    await copied;
    expect(b.clipboard()).toBe("from-the-server");
    expect(g.pending()).toBe(true);
    await expect(g.copy(Promise.reject(new Error("REVEAL_BUDGET_EXCEEDED")))).rejects.toThrow("REVEAL_BUDGET_EXCEEDED");
    // The earlier copy's clear is still owed — a refused copy settles nothing.
    expect(g.pending()).toBe(true);
    await b.advance(CLIPBOARD_CLEAR_MS);
    expect(b.clipboard()).toBe("");
  });

  it("copying something else in the page supersedes the clear — the new clipboard is never wiped", async () => {
    const b = fakeBrowser();
    const g = createClipboardGuard(b.env);
    await g.copy("hunter2");
    await b.copyElseInPage("the member's own text");
    expect(g.pending()).toBe(false);
    expect(b.listeners()).toBe(0);
    await b.advance(CLIPBOARD_CLEAR_MS);
    expect(b.clipboard()).toBe("the member's own text");
  });

  it("no emptying write starts while a copy is in flight — it would abort that copy in Firefox and WebKit", async () => {
    const b = fakeBrowser();
    const g = createClipboardGuard(b.env);
    await g.copy("first");
    b.leave();
    await b.advance(CLIPBOARD_CLEAR_MS); // due; the timer found no focus
    b.focusOnly();
    let resolve!: (v: string) => void;
    const second = g.copy(new Promise<string>((r) => (resolve = r)));
    await b.fireReturn(); // the first copy's clear is due — and must wait
    expect(b.started()).toEqual(["first", "<promised>"]);
    resolve("second");
    await second;
    expect(b.clipboard()).toBe("second");
    expect(g.pending()).toBe(true); // the SECOND copy's clear, now owed
    await b.advance(CLIPBOARD_CLEAR_MS);
    expect(b.clipboard()).toBe("");
  });

  it("a refused write rejects the copy and owes nothing", async () => {
    const b = fakeBrowser();
    const g = createClipboardGuard(b.env);
    b.leave();
    await expect(g.copy("hunter2")).rejects.toThrow(/not focused/);
    expect(g.pending()).toBe(false);
    expect(b.timers()).toBe(0);
  });
});

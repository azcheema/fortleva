import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  SCOPE_ORDER,
  SUPPRESS_SELECTOR,
  decide,
  overlaySections,
  signatureOf,
  type KeyBinding,
  type KeyScope,
  type ScopeSnapshot,
} from "./keymap";

/**
 * The keyboard's ordering matrix (UI.md §6).
 *
 * This is the ONLY instrument that can see it. The repo's vitest runs
 * `environment: "node"` with no jsdom, so nothing here can press a key
 * — which is exactly why `decide()` is a pure function of an event
 * SHAPE: the browser proves layering and focus in `e2e/keymap.spec.ts`,
 * and the precedence table is proved here.
 */

const ev = (over: Partial<Parameters<typeof decide>[0]> = {}) => ({
  key: "s",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  defaultPrevented: false,
  inEditable: false,
  inMenuLayer: false,
  ...over,
});

const binding = (over: Partial<KeyBinding> = {}): KeyBinding => ({
  key: "s",
  label: "Do the thing",
  run: () => {},
  enabled: true,
  ...over,
});

/** Scopes as the store hands them over: ASCENDING by order, then id. */
const scopes = (...entries: { scope: KeyScope; bindings: KeyBinding[]; exclusive?: boolean }[]) =>
  entries
    .map((e) => ({
      scope: e.scope,
      order: SCOPE_ORDER[e.scope],
      exclusive: e.exclusive ?? false,
      bindings: e.bindings,
    }))
    .sort((a, b) => a.order - b.order) satisfies ScopeSnapshot[];

describe("decide — the guard order", () => {
  const board = scopes({ scope: "board", bindings: [binding({ key: "s" })] });

  it("defaultPrevented wins over everything, FIRST", () => {
    // cmdk preventDefaults the arrows and Enter but never
    // stopPropagations, so without this an arrow inside an open picker
    // would fall through to a scope binding.
    expect(decide(ev({ defaultPrevented: true }), board, [], false)).toEqual({ kind: "none" });
  });

  it("⌘K / Ctrl+K is answered INSIDE an input, before the modifier bail", () => {
    expect(decide(ev({ key: "k", metaKey: true, inEditable: true }), board, [], false)).toEqual({
      kind: "palette",
    });
    expect(decide(ev({ key: "k", ctrlKey: true }), board, [], false)).toEqual({ kind: "palette" });
  });

  it("⌘⌥K is not the palette", () => {
    expect(decide(ev({ key: "k", metaKey: true, altKey: true }), board, [], false)).toEqual({
      kind: "none",
    });
  });

  it("any other modifier chord is refused", () => {
    for (const mod of ["metaKey", "ctrlKey", "altKey"] as const) {
      expect(decide(ev({ [mod]: true }), board, [], false)).toEqual({ kind: "none" });
    }
  });

  it("single keys are inert in an editable target and inside a menu layer", () => {
    expect(decide(ev({ inEditable: true }), board, [], false)).toEqual({ kind: "none" });
    expect(decide(ev({ inMenuLayer: true }), board, [], false)).toEqual({ kind: "none" });
  });
});

describe("decide — the G sequence", () => {
  const withItemS = scopes({ scope: "item", bindings: [binding({ key: "s" })] });

  it("`g` arms LAST, after every scope has had its chance", () => {
    expect(decide(ev({ key: "g" }), withItemS, ["S"], false)).toEqual({ kind: "arm" });
    // A scope that claims `g` beats the arming.
    const claimsG = scopes({ scope: "item", bindings: [binding({ key: "g" })] });
    expect(decide(ev({ key: "g" }), claimsG, ["S"], false)).toEqual({
      kind: "binding",
      entry: 0,
      binding: 0,
    });
  });

  it("`G S` navigates even though the item scope binds bare `S` — the collision that is not one", () => {
    // THE regression this whole design exists for: two events in time,
    // not two meanings of one key.
    expect(decide(ev({ key: "s" }), withItemS, ["S"], true)).toEqual({ kind: "go", key: "S" });
  });

  it("an armed `G` consumes an unmatched second key rather than letting it act", () => {
    expect(decide(ev({ key: "q" }), withItemS, ["S"], true)).toEqual({ kind: "swallowGo" });
    // …including one a scope DOES bind: `G` then `S` is never a bare `S`.
    expect(decide(ev({ key: "s" }), withItemS, [], true)).toEqual({ kind: "swallowGo" });
  });
});

describe("decide — scope precedence", () => {
  it("the higher-order scope wins, whatever order the entries arrive in", () => {
    const both = scopes(
      { scope: "item", bindings: [binding({ key: "s", label: "item" })] },
      { scope: "board", bindings: [binding({ key: "s", label: "board" })] },
    );
    const d = decide(ev({ key: "s" }), both, [], false);
    expect(d.kind).toBe("binding");
    if (d.kind !== "binding") throw new Error("unreachable");
    expect(both[d.entry]!.scope).toBe("item");
  });

  it("a DISABLED binding swallows the key instead of letting a lower scope have it", () => {
    // A member without work_item:edit must get NOTHING from `S` in the
    // panel — never the board's "Move to…" underneath it.
    const both = scopes(
      { scope: "item", bindings: [binding({ key: "s", enabled: false })] },
      { scope: "board", bindings: [binding({ key: "s" })] },
    );
    expect(decide(ev({ key: "s" }), both, [], false)).toEqual({ kind: "swallow" });
  });

  it("a `run: null` binding is SKIPPED, so a lower scope still gets the key", () => {
    // Documentation-only rows must not preventDefault — the board's
    // roving-arrow row would otherwise eat page scroll.
    const both = scopes(
      { scope: "item", bindings: [binding({ key: "s", run: null })] },
      { scope: "board", bindings: [binding({ key: "s", label: "board" })] },
    );
    const d = decide(ev({ key: "s" }), both, [], false);
    expect(d.kind).toBe("binding");
    if (d.kind !== "binding") throw new Error("unreachable");
    expect(both[d.entry]!.scope).toBe("board");
  });

  it("a doc-only binding alone falls through to nothing at all", () => {
    const only = scopes({ scope: "board", bindings: [binding({ key: "s", run: null })] });
    expect(decide(ev({ key: "s" }), only, [], false)).toEqual({ kind: "none" });
  });

  it("an EXCLUSIVE scope stops the walk — nothing beneath a modal fires", () => {
    const overlayOpen = scopes(
      { scope: "global", bindings: [binding({ key: "t" })] },
      { scope: "modal", bindings: [binding({ key: "?" })], exclusive: true },
    );
    expect(decide(ev({ key: "t" }), overlayOpen, [], false)).toEqual({ kind: "none" });
    expect(decide(ev({ key: "?" }), overlayOpen, [], false).kind).toBe("binding");
  });

  it("an EXCLUSIVE scope blocks even when it binds NOTHING — the footgun", () => {
    // This shipped for one e2e run: the `?` overlay registered its modal
    // scope with `exclusive: true` unconditionally and an empty binding
    // list while closed. `modal` is the top of SCOPE_ORDER, so the walk
    // met it first, matched nothing, and took the exclusive break —
    // every key in the application was dead. The semantic is right (a
    // modal with no keys still owns the keyboard); the caller must gate
    // `exclusive` on being open.
    const alwaysExclusive = scopes(
      { scope: "global", bindings: [binding({ key: "t" })] },
      { scope: "modal", bindings: [], exclusive: true },
    );
    expect(decide(ev({ key: "t" }), alwaysExclusive, [], false)).toEqual({ kind: "none" });
    // …and a NON-exclusive empty scope is inert, which is what a closed
    // overlay must register.
    const closed = scopes(
      { scope: "global", bindings: [binding({ key: "t" })] },
      { scope: "modal", bindings: [] },
    );
    expect(decide(ev({ key: "t" }), closed, [], false).kind).toBe("binding");
  });

  it("keys match case-insensitively", () => {
    const s = scopes({ scope: "item", bindings: [binding({ key: "s" })] });
    expect(decide(ev({ key: "S" }), s, [], false).kind).toBe("binding");
  });

  it("no scope, no binding, no crash", () => {
    expect(decide(ev({ key: "s" }), [], [], false)).toEqual({ kind: "none" });
  });
});

describe("signatureOf", () => {
  it("ignores the run CLOSURE's identity but not whether there is one", () => {
    // The single most fragile line in the registry: a closure is a new
    // identity every render, so including one makes the store emit on
    // every render — and with the overlay subscribed above a
    // `useScopeKeys` caller, that is an infinite loop.
    const a = [binding({ run: () => {} })];
    const b = [binding({ run: () => {} })];
    expect(signatureOf(a)).toBe(signatureOf(b));
    expect(signatureOf(a)).not.toBe(signatureOf([binding({ run: null })]));
  });

  it("changes when anything the overlay renders changes", () => {
    const base = signatureOf([binding()]);
    expect(signatureOf([binding({ enabled: false })])).not.toBe(base);
    expect(signatureOf([binding({ label: "Другое" })])).not.toBe(base);
    expect(signatureOf([binding({ key: "p" })])).not.toBe(base);
    expect(signatureOf([binding({ hint: ["J", "K"] })])).not.toBe(base);
    expect(signatureOf([binding({ palette: false })])).not.toBe(base);
  });
});

describe("overlaySections", () => {
  it("lists the highest scope first and shadows a key a higher scope already claimed", () => {
    const both = scopes(
      { scope: "item", bindings: [binding({ key: "s", label: "Change state" })] },
      { scope: "board", bindings: [binding({ key: "s", label: "Move to…" }), binding({ key: "c", label: "New task" })] },
    );
    expect(overlaySections(both)).toEqual([
      { scope: "item", bindings: [expect.objectContaining({ label: "Change state" })] },
      { scope: "board", bindings: [expect.objectContaining({ label: "New task" })] },
    ]);
  });

  it("drops a disabled row — advertising a key that refuses itself is a lie", () => {
    const s = scopes({ scope: "board", bindings: [binding({ key: "c", enabled: false })] });
    expect(overlaySections(s)).toEqual([]);
  });

  it("KEEPS a doc-only row: it is handled elsewhere, not absent", () => {
    const s = scopes({ scope: "board", bindings: [binding({ key: "s", run: null })] });
    expect(overlaySections(s)).toHaveLength(1);
  });

  it("skips `modal` scopes entirely — rows AND the exclusive break", () => {
    // The overlay IS the modal scope while it is open. Counting it
    // would blank out every section it was opened to show.
    const overlayOpen = scopes(
      { scope: "global", bindings: [binding({ key: "t", label: "Timer" })] },
      { scope: "board", bindings: [binding({ key: "c", label: "New task" })] },
      { scope: "modal", bindings: [binding({ key: "?" })], exclusive: true },
    );
    expect(overlaySections(overlayOpen).map((s) => s.scope)).toEqual(["board", "global"]);
  });

  it("merges entries that share a scope name into ONE section", () => {
    // Slice 6's `P E D` are three separate one-binding islands.
    const panel = scopes(
      { scope: "item", bindings: [binding({ key: "s", label: "State" })] },
      { scope: "item", bindings: [binding({ key: "p", label: "Priority" })] },
    );
    const sections = overlaySections(panel);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.bindings.map((b) => b.key)).toEqual(["s", "p"]);
  });
});

describe("Escape is structurally unbindable", () => {
  it("a binding that claims Escape can never match, in any scope", () => {
    // The rule used to live in a hand-written `DECLARED` constant that
    // nothing tied to a call site, so it could not fail when broken. It
    // is enforced in `decide()` now: registering Escape is not an error
    // anyone has to notice, it simply does nothing. Radix owns Escape at
    // `ownerDocument` capture, and `e2e/work.spec.ts` pins the peek-close
    // contract that a capture-phase registry handler would break.
    const rogue = scopes({
      scope: "item",
      bindings: [binding({ key: "Escape", label: "Close the thing" })],
    });
    expect(decide(ev({ key: "Escape" }), rogue, [], false)).toEqual({ kind: "none" });
    // …and it does not shadow a lower scope's real binding either.
    const both = scopes(
      { scope: "item", bindings: [binding({ key: "Escape" })] },
      { scope: "board", bindings: [binding({ key: "c", label: "New task" })] },
    );
    expect(decide(ev({ key: "c" }), both, [], false).kind).toBe("binding");
  });
});

describe("the suppression selector", () => {
  /**
   * The one thing here that can silently rot: `SUPPRESS_SELECTOR` names
   * `data-slot` values that live in other files. A slot renamed — or a
   * selector written for a component this repo does not have — fails
   * open, and the leak (a key firing behind an open menu) is invisible
   * until someone reports the timer stopping by itself.
   */
  const uiDir = join(process.cwd(), "src/components/ui");
  const uiSource = readdirSync(uiDir)
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => readFileSync(join(uiDir, f), "utf8"))
    .join("\n");

  it("every data-slot it names is one the ui components actually emit", () => {
    const slots = [...SUPPRESS_SELECTOR.matchAll(/\[data-slot="([^"]+)"\]/g)].map((m) => m[1]!);
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      expect(uiSource, `no component emits data-slot="${slot}"`).toContain(`data-slot="${slot}"`);
    }
  });

  it("does NOT suppress a dialog or a sheet — the item peek is one, and it must keep its keys", () => {
    expect(SUPPRESS_SELECTOR).not.toContain("dialog-content");
    expect(SUPPRESS_SELECTOR).not.toContain("sheet-content");
  });
});

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { NAV, type NavEntry } from "@/app/(tenant)/(authed)/nav";

import {
  SCOPE_ORDER,
  SUPPRESS_SELECTOR,
  decide,
  overlaySections,
  paletteOffersPageRows,
  signatureOf,
  type KeyBinding,
  type KeyScope,
  type PaletteOrigin,
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

  it("tells a sequence from alternatives — `J K` is not `J or K`", () => {
    expect(signatureOf([binding({ key: "j", hint: ["J", "or", "K"] })])).not.toBe(
      signatureOf([binding({ key: "j", hint: ["J", "K"] })]),
    );
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

describe("paletteOffersPageRows — decided where ⌘K was pressed", () => {
  const rail = scopes(
    { scope: "item", bindings: [binding({ key: "s", label: "Change state" })] },
    { scope: "item", bindings: [binding({ key: "p", label: "Change priority" })] },
  );
  const cmdK = (over: Partial<Parameters<typeof decide>[0]> = {}) =>
    ev({ key: "k", metaKey: true, ...over });
  /** A keystroke's shape as the dispatcher hands it over: no dialog is leaving unless a case says so. */
  const at = (
    shape: ReturnType<typeof cmdK>,
    leaving: PaletteOrigin["leaving"] = null,
  ): PaletteOrigin => ({ ...shape, leaving });

  it("offers the rows from the page, and from an editable field on it", () => {
    expect(paletteOffersPageRows(at(cmdK()), rail)).toBe(true);
    // The description editor: single keys are inert there because they
    // TYPE, not because a layer is open. Nothing can stack.
    expect(paletteOffersPageRows(at(cmdK({ inEditable: true })), rail)).toBe(true);
  });

  it("offers none from inside a menu layer, where ⌘K still opens the palette", () => {
    // From inside the open due-date picker, "Change priority" opened a
    // second modal picker on top of the first. ⌘K itself must keep
    // working there; only the rows go.
    const inPicker = cmdK({ inMenuLayer: true });
    expect(decide(inPicker, rail, [], false)).toEqual({ kind: "palette" });
    expect(paletteOffersPageRows(at(inPicker), rail)).toBe(false);
  });

  it("offers none under an exclusive scope, and a closed overlay's inert scope changes nothing", () => {
    const overlayOpen = scopes(
      { scope: "item", bindings: [binding({ key: "p", label: "Change priority" })] },
      { scope: "modal", bindings: [binding({ key: "?" })], exclusive: true },
    );
    expect(paletteOffersPageRows(at(cmdK()), overlayOpen)).toBe(false);
    const overlayClosed = scopes(
      { scope: "item", bindings: [binding({ key: "p", label: "Change priority" })] },
      { scope: "modal", bindings: [] },
    );
    expect(paletteOffersPageRows(at(cmdK()), overlayClosed)).toBe(true);
  });

  it("a ⌘K that lands in a dialog still fading out is judged by where that dialog hands focus back", () => {
    // Radix keeps a closed dialog mounted, and its input focused, through
    // the exit animation. A ⌘K double-tap landed in the closing palette's
    // own list, a menu layer, and reopened the palette with no rows.
    const inClosingPalette = cmdK({ inMenuLayer: true });
    expect(decide(inClosingPalette, rail, [], false)).toEqual({ kind: "palette" });
    // Opened from the page: nothing is left open, so the rows come back.
    expect(
      paletteOffersPageRows(at(inClosingPalette, { returnsIntoMenuLayer: false }), rail),
    ).toBe(true);
    // Opened from inside the due-date picker, which is STILL open. "The
    // closing dialog is no layer" would offer "Change priority" here and
    // stack a second picker on the first.
    expect(
      paletteOffersPageRows(at(inClosingPalette, { returnsIntoMenuLayer: true }), rail),
    ).toBe(false);
    // The `?` overlay's body is no menu layer, but closing over that
    // picker it hands focus back into it all the same.
    expect(paletteOffersPageRows(at(cmdK(), { returnsIntoMenuLayer: true }), rail)).toBe(false);
    // …and a leaving dialog never outranks an exclusive scope still open.
    const overlayOpen = scopes(
      { scope: "item", bindings: [binding({ key: "p", label: "Change priority" })] },
      { scope: "modal", bindings: [binding({ key: "?" })], exclusive: true },
    );
    expect(
      paletteOffersPageRows(at(inClosingPalette, { returnsIntoMenuLayer: false }), overlayOpen),
    ).toBe(false);
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

describe("the rail's S P E D beside the board and the G sequence (slice 6)", () => {
  /** Every live `G` target, read from the nav itself rather than restated here. */
  const flat = (entries: readonly NavEntry[]): NavEntry[] =>
    entries.flatMap((e) => (e.children ? flat(e.children) : [e]));
  const GO_KEYS = flat(NAV)
    .map((e) => e.goKey)
    .filter((k): k is string => Boolean(k));

  /** Four one-binding islands, registered in rail order — as the panel mounts them. */
  const railEntries = (priorityEnabled = true) => [
    { scope: "item" as const, bindings: [binding({ key: "s", label: "Change state" })] },
    { scope: "item" as const, bindings: [binding({ key: "p", label: "Change priority", enabled: priorityEnabled })] },
    { scope: "item" as const, bindings: [binding({ key: "e", label: "Set estimate" })] },
    { scope: "item" as const, bindings: [binding({ key: "d", label: "Set due date" })] },
  ];

  it("the nav really has a `G P`, and no `G E` or `G D`", () => {
    // The two cases below mean something only while this holds.
    expect(GO_KEYS).toContain("P");
    expect(GO_KEYS).not.toContain("E");
    expect(GO_KEYS).not.toContain("D");
  });

  it("`G P` navigates with the item's bare `P` mounted", () => {
    expect(decide(ev({ key: "p" }), scopes(...railEntries()), GO_KEYS, true)).toEqual({
      kind: "go",
      key: "P",
    });
  });

  it("`G E` and `G D` are swallowed — never a bare `E` or `D`", () => {
    const rail = scopes(...railEntries());
    expect(decide(ev({ key: "e" }), rail, GO_KEYS, true)).toEqual({ kind: "swallowGo" });
    expect(decide(ev({ key: "d" }), rail, GO_KEYS, true)).toEqual({ kind: "swallowGo" });
    // Un-armed, they are the rail's own bindings.
    expect(decide(ev({ key: "e" }), rail, GO_KEYS, false).kind).toBe("binding");
    expect(decide(ev({ key: "d" }), rail, GO_KEYS, false).kind).toBe("binding");
  });

  it("a disabled item `P` swallows the key rather than letting a lower scope have it", () => {
    const rail = scopes(
      ...railEntries(false),
      { scope: "global", bindings: [binding({ key: "p", label: "Lower" })] },
    );
    expect(decide(ev({ key: "p" }), rail, GO_KEYS, false)).toEqual({ kind: "swallow" });
  });

  it("the overlay lists the Task section S P E D, and the board keeps only the key the item did not shadow", () => {
    const peek = scopes(
      {
        scope: "board",
        bindings: [
          binding({ key: "s", label: "Move to…", run: null }),
          binding({ key: "j", label: "Move between cards", run: null, hint: ["J", "or", "K"] }),
        ],
      },
      ...railEntries(),
    );
    const sections = overlaySections(peek);
    expect(sections.map((s) => s.scope)).toEqual(["item", "board"]);
    expect(sections[0]!.bindings.map((b) => b.key)).toEqual(["s", "p", "e", "d"]);
    expect(sections[1]!.bindings.map((b) => b.key)).toEqual(["j"]);
  });
});

describe("cmdk's vim bindings are off by construction", () => {
  /**
   * cmdk defaults `vimBindings` to TRUE, and its Ctrl+K ("previous
   * item") shadows the global ⌘K on Windows and Linux inside any list.
   * The fix is one default in the one wrapper, which holds only while
   * the wrapper IS the only way in. A scan of `<Command` tags would
   * match the wrapper's own comments; the import is the real seam.
   *
   * Both patterns are written so this file's own source cannot match.
   */
  const root = process.cwd();
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "generated" ? [] : walk(path);
      return /\.tsx?$/.test(entry.name) ? [path] : [];
    });
  const files = walk(join(root, "src")).map((path) => ({
    path: path.slice(root.length + 1).replaceAll("\\", "/"),
    text: readFileSync(path, "utf8"),
  }));
  const IMPORTS_CMDK = /(?:from|import)\s*\(?\s*["']cmdk(?:\/[^"']*)?["']/;
  const VIM_ON = /vimBindings\s*=\s*\{\s*true\s*\}/;
  const WRAPPER = "src/components/ui/command.tsx";

  it("only the ui wrapper imports cmdk", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.filter((f) => IMPORTS_CMDK.test(f.text)).map((f) => f.path)).toEqual([WRAPPER]);
  });

  it("the wrapper declares the false default", () => {
    expect(files.find((f) => f.path === WRAPPER)?.text).toContain("vimBindings = false");
  });

  it("no caller turns them back on", () => {
    expect(files.filter((f) => VIM_ON.test(f.text)).map((f) => f.path)).toEqual([]);
  });

  /**
   * The command dialog wrapper puts focus back where it was opened from.
   * It records that origin in Radix's `onOpenAutoFocus`, which is
   * dispatched only while focus is still outside the content. React
   * focuses an `autoFocus` child during commit, before that event, so it
   * is never sent. Then nothing is recorded, closing drops focus on
   * <body>, and every single key acts behind the layer still open
   * underneath.
   *
   * Comments are stripped first, since the reason is worth writing down
   * beside the element. The JSX pattern is written so this file's own
   * source cannot match.
   */
  // A command dialog, or any dialog returning focus through the shared
  // hook (the `?` overlay, the shell's More sheet) — the same
  // `onOpenAutoFocus` capture either way.
  const RENDERS_DIALOG = /<Command[D]ialog\b|\buse[F]ocusReturn\(/;
  const AUTO_FOCUS = /\bauto[F]ocus\b/;
  const code = (text: string) =>
    text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("no file that renders a focus-returning dialog uses autoFocus", () => {
    const users = files.filter((f) => RENDERS_DIALOG.test(f.text));
    expect(users.length).toBeGreaterThan(0);
    expect(users.filter((f) => AUTO_FOCUS.test(code(f.text))).map((f) => f.path)).toEqual([]);
  });
});

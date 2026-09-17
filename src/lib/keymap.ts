/**
 * THE keyboard map's pure core (UI.md §6): which binding — if any — a
 * keystroke means, given the scopes mounted right now.
 *
 * No React, no `"use client"`, no module-level DOM access. Two reasons,
 * both load-bearing:
 *
 *  1. `vitest` runs `environment: "node"` over every `*.test.ts` under
 *     `src/`, and this repo has no jsdom — a `.tsx` test would not even
 *     be collected. A decision buried in a listener closure
 *     is a decision nothing can test; `decide()` is a pure function of
 *     an event SHAPE so the whole ordering matrix is a table test.
 *  2. A directive-free module may be imported by a server component
 *     without minting a throwing client reference — the standing trap,
 *     and the same reason `src/lib/work-view/params.ts` carries no
 *     directive.
 *
 * TWO HARD RULES, stated here because every future slice will be
 * tempted to break one:
 *
 *  · **The registry never binds `Escape`, in any phase.** Radix's
 *    dismissable layers handle it on `ownerDocument` with
 *    `{capture: true}`, while `defaultPrevented` is still false — a
 *    hand-written bubble handler cannot beat one (that is the live
 *    `inline-edit.tsx` defect), and a capture-phase registry handler
 *    would break the pinned peek-close contract in `e2e/work.spec.ts`.
 *    If you want Escape, you want an `exclusive` scope or a Radix layer.
 *  · **`signatureOf` must never see a `run` closure.** Closures are new
 *    identities every render; including one makes the store emit on
 *    every render, and with the overlay subscribed above a
 *    `useScopeKeys` caller that is an infinite loop.
 */

/**
 * The scope set is the UNION of UI.md §6 (global/item/inbox/triage) and
 * ARC-24 (global/item/board), plus `modal` — the honest name for a
 * layer that owns the keyboard while it is open.
 *
 * `backlog` arrived with that surface's first region key, `X` (panel
 * slice 14, 2026-09-15) — until then it was absent, because an unused
 * scope name is dead weight. `inbox` and `triage` are declared and empty
 * on purpose, so the slices that fill them are a registration rather
 * than a redesign.
 */
export type KeyScope = "global" | "board" | "backlog" | "home" | "inbox" | "triage" | "item" | "modal";

/**
 * Precedence is THIS TABLE, never mount order. React runs child effects
 * before parents', so a push-ordered stack would register the shell's
 * `global` scope ABOVE the panel's `item` scope and invert shadowing —
 * a thing that would work only by luck.
 *
 * `board`/`backlog`/`home`/`inbox`/`triage` are peers: they are region
 * scopes on different surfaces and never mount together. `home` arrived
 * with the queue's row verbs (slice 24, 2026-09-17), the `backlog` way.
 */
export const SCOPE_ORDER: Record<KeyScope, number> = {
  global: 0,
  board: 10,
  backlog: 10,
  home: 10,
  inbox: 10,
  triage: 10,
  item: 20,
  modal: 100,
};

export type KeyBinding = {
  /** ONE physical key, compared case-insensitively against `e.key`. Never `"Escape"`. */
  key: string;
  /**
   * ALREADY TRANSLATED by the registrant. The registry has no locale and
   * must never resolve a foreign namespace — and a workflow state's name
   * is tenant text, which must never round-trip through next-intl.
   */
  label: string;
  /**
   * REQUIRED, and `null` is a real value: "advertised here, handled
   * elsewhere in the React tree". The board's `S` and its roving
   * `↑↓←→ J K` need the FOCUSED CARD, which only a React-tree handler
   * on the event target can know. Dispatch SKIPS a `run: null` binding
   * — it must not `preventDefault`, or the roving-arrow row would eat
   * page scroll — while the overlay still renders it.
   */
  run: ((e: KeyboardEvent) => void) | null;
  /**
   * REQUIRED. On a binding with a `run`, `false` REFUSES the key —
   * swallowing it rather than letting it fall through to a lower scope —
   * and hides the row. On a `run: null` binding it only hides the row:
   * dispatch skips that binding before it reads `enabled`, so the key goes
   * on to a lower scope either way (the board's `T` on an archived
   * project leaves the key to the global `T`).
   *
   * Swallowing is the point: a member without `work_item:edit` pressing
   * `S` in the item scope must get nothing, not the board's "Move to…".
   * It is also the mechanism that will let 2T's item-scope `T` shadow
   * the global timer `T` with no second guard.
   */
  enabled: boolean;
  /** `<kbd>` sequence for the overlay. Defaults to `[key.toUpperCase()]`. */
  hint?: readonly string[];
  /** Offer as a ⌘K "On this page" row. Defaults to true for run-bearing bindings. */
  palette?: boolean;
};

export type ScopeSnapshot = {
  scope: KeyScope;
  order: number;
  exclusive: boolean;
  bindings: readonly KeyBinding[];
};

/**
 * The parts of a `KeyboardEvent` the decision depends on, plus the two
 * DOM questions answered by the caller (`isEditableTarget`,
 * `inMenuLayer`). Passing a shape rather than the event is what keeps
 * `decide()` testable in a node environment.
 */
export type KeyEventShape = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
  inEditable: boolean;
  inMenuLayer: boolean;
};

export type Decision =
  | { kind: "none" }
  | { kind: "palette" }
  | { kind: "go"; key: string }
  | { kind: "arm" }
  | { kind: "swallowGo" }
  | { kind: "swallow" }
  | { kind: "binding"; entry: number; binding: number };

/**
 * The whole keyboard map, in order. `scopes` arrives ASCENDING by
 * `order` then registration id, so the loop walks it backwards —
 * highest scope first.
 *
 * The order of the guards is the design:
 *
 *  0. `defaultPrevented` FIRST. cmdk preventDefaults the arrows and
 *     Enter but never stopPropagations, so without this an arrow inside
 *     an open picker would fall through to a scope binding. It is also
 *     what makes every React-tree handler's `preventDefault`
 *     authoritative over the registry — which is legal precisely
 *     because Next's React root is `document`, so React's bubble phase
 *     has already run by the time the event reaches `window`.
 *  1. ⌘K before the modifier bail, so the palette works INSIDE inputs.
 *  5. An armed `G` consumes EXACTLY the next key, matched or not. `G S`,
 *     `G C` and `G T` are therefore not collisions with bare `S`/`C`/`T`
 *     but two events in time — which is what lets the board delete its
 *     capture-phase workaround and the timer pill its double guard.
 *  7. `g` arms LAST, so a scope that ever claims `g` beats it.
 */
export function decide(
  e: KeyEventShape,
  scopes: readonly ScopeSnapshot[],
  goKeys: readonly string[],
  goPending: boolean,
): Decision {
  if (e.defaultPrevented) return { kind: "none" };
  if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
    return { kind: "palette" };
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return { kind: "none" };
  if (e.inEditable) return { kind: "none" };
  if (e.inMenuLayer) return { kind: "none" };

  if (goPending) {
    const key = e.key.toUpperCase();
    return goKeys.includes(key) ? { kind: "go", key } : { kind: "swallowGo" };
  }

  for (let i = scopes.length - 1; i >= 0; i--) {
    const scope = scopes[i]!;
    for (let b = 0; b < scope.bindings.length; b++) {
      const binding = scope.bindings[b]!;
      if (binding.run === null) continue; // documentation-only
      // The registry NEVER binds Escape, and this is where that is made
      // true rather than merely asked for: a caller that registers one
      // gets a binding that can never match. Radix owns Escape at
      // `ownerDocument` capture while `defaultPrevented` is still false,
      // so a registry binding could not win anyway — and a capture-phase
      // one would break the pinned peek-close contract.
      if (binding.key.toLowerCase() === "escape") continue;
      if (binding.key.toLowerCase() !== e.key.toLowerCase()) continue;
      return binding.enabled ? { kind: "binding", entry: i, binding: b } : { kind: "swallow" };
    }
    if (scope.exclusive) return { kind: "none" };
  }

  if (e.key.toLowerCase() === "g") return { kind: "arm" };
  return { kind: "none" };
}

/**
 * Focus is inside a layer that owns its own keys. Radix autofocuses menu
 * content on open, so the event TARGET is the menu item — which closes
 * the leak where `t` behind an open `RowActions` menu stopped the
 * running timer (a menu item is not an editable target).
 *
 * `dialog-content` and `sheet-content` are DELIBERATELY absent: the item
 * peek IS a dialog, and suppressing dialogs would kill `S` on the very
 * surface this exists to give it. A modal that really should own the
 * keyboard pushes an `exclusive` scope instead.
 *
 * A tooltip and a hovercard take no focus, so they need no entry — and
 * must not get one, or they would deaden the keyboard on hover. There is
 * no `alert-dialog.tsx` and no `context-menu.tsx` in `src/components/ui`;
 * do not add selectors for files that do not exist (the unit test pins
 * that every selector here matches a slot the components actually emit).
 */
export const SUPPRESS_SELECTOR = [
  '[data-slot="dropdown-menu-content"]',
  '[data-slot="dropdown-menu-sub-content"]',
  '[data-slot="select-content"]',
  '[data-slot="popover-content"]',
  '[data-slot="command"]',
  '[role="menu"]',
  '[role="listbox"]',
].join(",");

/**
 * Whether a React-tree handler should act on `key` for the element that
 * holds focus — the backlog's `X` on its focused row.
 *
 * Such a key is registered `run: null` and handled on the event target,
 * because only the target knows WHICH row (the board's `S` reason). That
 * handler runs at document-bubble, BEFORE the window dispatcher, so none
 * of `decide()`'s guards have run for it yet. This is those guards, in
 * that order. A unit test pins it to `decide()` over every combination
 * of the flags both read, which catches a change to one of THOSE guards;
 * a guard `decide()` gains on a new event field or on scope state is not
 * exercised there and must be mirrored here by hand. `exclusive` scopes
 * are ignored on purpose: each one is a modal dialog that traps focus
 * (the `?` overlay; a task timer's staff-notice dialog), so no row's
 * handler receives a key beneath it —
 *
 *  · `defaultPrevented`: something nearer the target already owns it;
 *  · a ⌘/Ctrl/Alt chord is not the bare key (Shift is not a chord, as
 *    in `decide()`);
 *  · an editable target types the letter, and a menu layer owns its
 *    keys — React bubbles a PORTALLED row menu's events through the
 *    handler's tree, so the handler really does receive them;
 *  · an armed `G` consumes exactly the next key, so `G X` is never `X`.
 *
 * Plus one guard `decide()` never needed: AUTO-REPEAT. A held key that
 * TOGGLES flips on every repeat and lands wherever the member let go.
 */
export function focusedKeyApplies(
  e: KeyEventShape & { repeat: boolean },
  key: string,
  goPending: boolean,
  policy: FocusedKeyPolicy = REFUSE_REPEAT,
): boolean {
  return focusedKeyGuards(e, goPending, policy) && e.key.toLowerCase() === key.toLowerCase();
}

/**
 * Whether a held key's auto-repeat events count. `"refuse"` is the
 * default and right for a TOGGLE (`X`); a MOVE declares `"allow"` — one
 * row per event whatever the member holds, so a held `J` walks the list.
 * A policy, so the exception is declared at the call site rather than
 * smuggled in by lying about `e.repeat`.
 */
export type FocusedKeyPolicy = { repeat: "refuse" | "allow" };
const REFUSE_REPEAT: FocusedKeyPolicy = { repeat: "refuse" };

/**
 * The guard half of `focusedKeyApplies` without the "which key" half —
 * for a handler that has already matched the key (the backlog's step
 * table) and only needs to know whether ANY focused key may act now.
 */
export function focusedKeyGuards(
  e: KeyEventShape & { repeat: boolean },
  goPending: boolean,
  policy: FocusedKeyPolicy = REFUSE_REPEAT,
): boolean {
  if (e.defaultPrevented) return false;
  if (e.repeat && policy.repeat === "refuse") return false;
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  if (e.inEditable || e.inMenuLayer) return false;
  if (goPending) return false;
  return true;
}

/**
 * The roving-focus keys of a list (UI.md §6), by `e.key` compared
 * case-insensitively (a shifted letter is the letter, as `decide()`
 * reads it). The arrows carry `arrow: true` so a handler can refuse them
 * where a control owns them (`ownsArrows`) and with Shift, which lists
 * keep for range selection. ONE table, so the lists that read it cannot
 * drift on which keys are a one-row move: the backlog today; the board
 * when its handler migrates to these guards (PLAN §0 records that as
 * owed — it still keeps its own `switch`); the inbox and triage lists to
 * come.
 */
export type RovingStep = { delta: 1 | -1; arrow: boolean };
const ROVING_STEPS: Record<string, RovingStep> = {
  j: { delta: 1, arrow: false },
  k: { delta: -1, arrow: false },
  arrowdown: { delta: 1, arrow: true },
  arrowup: { delta: -1, arrow: true },
};
export const rovingStep = (key: string): RovingStep | undefined => ROVING_STEPS[key.toLowerCase()];

/**
 * Whether the focused element uses ArrowUp/ArrowDown itself, so a
 * list's roving arrows must leave them alone. An editable target and an
 * open menu layer are refused before this is asked (`focusedKeyGuards`);
 * what remains is a CLOSED control that opens or changes on an arrow:
 * a select or combobox trigger, a spin button, a slider, a radio group.
 * Named once here so the next such control is added in one place.
 */
export const ownsArrows = (target: EventTarget | null): boolean =>
  target instanceof Element &&
  target.closest(
    '[role="combobox"],[role="spinbutton"],[role="slider"],[role="radio"],[role="radiogroup"],[data-slot="select-trigger"]',
  ) !== null;

/** Single keys are inert while an editable element has focus (UI.md §6). */
export const isEditableTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
};

/** …and while focus is inside a menu, listbox, select, popover or command list. */
export const inMenuLayer = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest(SUPPRESS_SELECTOR) !== null;

/**
 * The `KeyEventShape` of a keyboard event — DOM or React, which agree on
 * these six fields. The ONE place the two DOM questions are asked, so a
 * guard `KeyEventShape` gains from a new DOM question is added here and
 * reaches the dispatcher and every React-tree handler
 * (`focusedKeyApplies`) at once.
 */
export const keyEventShape = (
  e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "defaultPrevented" | "target">,
): KeyEventShape => ({
  key: e.key,
  metaKey: e.metaKey,
  ctrlKey: e.ctrlKey,
  altKey: e.altKey,
  defaultPrevented: e.defaultPrevented,
  inEditable: isEditableTarget(e.target),
  inMenuLayer: inMenuLayer(e.target),
});

/**
 * Where ⌘K was pressed, as `paletteOffersPageRows` needs it: the
 * menu-layer answer `decide()` also reads, plus the one fact a dialog
 * on its way out adds.
 */
export type PaletteOrigin = Pick<KeyEventShape, "inMenuLayer"> & {
  /**
   * `null` unless the target is inside a dialog still playing its exit
   * animation. Radix keeps that content mounted, and its input focused,
   * until that animation ends (`--dur-fast` for the palette). A ⌘K
   * double-tap therefore landed in
   * the closing palette's own list, which is a menu layer, and reopened
   * it without its rows. Such a keystroke is judged by where that dialog
   * hands focus BACK. `returnsIntoMenuLayer` is whether that element sits
   * in a menu layer, and it is false when the dialog hands focus nowhere
   * known.
   *
   * REQUIRED, and `null` is a real value. A dispatcher that forgot it
   * would silently judge every such keystroke by the dialog that is
   * leaving.
   */
  leaving: { returnsIntoMenuLayer: boolean } | null;
};

/**
 * Whether ⌘K pressed HERE may offer the palette's "On this page" rows.
 * It is decided once, when the palette opens, from the menu-layer answer
 * `decide()` also reads (`PaletteOrigin`).
 *
 * Each such row runs a single key's binding, so it is offered only where
 * that key could act. `decide()` answers ⌘K BEFORE the menu-layer guard,
 * on purpose, so the palette works from inside a picker. That means it
 * opens from places where every single key is deliberately inert, and a
 * row there did what the key could not. "Change priority" chosen from
 * inside the open due-date picker stacked a second modal picker on the
 * first, and after one Escape focus sat on a rail trigger the first
 * picker was still hiding.
 *
 * · Inside a menu layer (a picker, a menu, MovePicker's list): no rows.
 * · Under an EXCLUSIVE scope: no rows. The `?` overlay owns the keyboard
 *   while it is open, every key beneath it is dead, and a row would open
 *   a picker over the overlay.
 * · An editable target is NOT a reason. ⌘K from the description editor
 *   is exactly where "Change state" should work, because no layer is
 *   open there.
 * · Inside a dialog on its way out, the menu-layer question is asked of
 *   where that dialog hands focus back, not of the dialog itself. A
 *   closing palette's list is about to be gone, so it cannot count as a
 *   layer. The picker the palette was opened from is still open, so it
 *   must count. Treating every closing dialog as "no layer" would bring
 *   the rows back over that picker on a ⌘K double-tap.
 */
export const paletteOffersPageRows = (
  from: PaletteOrigin,
  scopes: readonly ScopeSnapshot[],
): boolean => {
  const inMenuLayer = from.leaving === null ? from.inMenuLayer : from.leaving.returnsIntoMenuLayer;
  return !inMenuLayer && !scopes.some((s) => s.exclusive);
};

/**
 * The OVERLAY-VISIBLE shape of a binding list, as a comparable string.
 *
 * Built ONLY from render-stable, serialisable values. A `run` closure is
 * a new identity every render: including one would make the store emit
 * on every render, and with the overlay subscribed above a
 * `useScopeKeys` caller that is an infinite loop. Whether a binding HAS
 * a run is part of the shape (it decides dispatch and the palette row);
 * WHICH function it is, is not.
 */
export const signatureOf = (bindings: readonly KeyBinding[]): string =>
  bindings
    .map(
      (b) =>
        `${b.key}|${b.enabled ? 1 : 0}|${b.run === null ? 0 : 1}|${
          b.palette === false ? 0 : 1
        }|${(b.hint ?? []).join("+")}|${b.label}`,
    )
    .join(" ");

/**
 * A scope the `?` overlay can show. `modal` is excluded at the TYPE
 * level, not merely skipped at runtime: the overlay is itself the modal
 * scope while it is open, so a section for one could only ever be the
 * overlay describing itself. Narrowing it here is what makes "there is
 * no `shell.shortcuts.scopes.modal` message" a compile error rather
 * than a missing-key crash in front of a member.
 */
export type OverlayScope = Exclude<KeyScope, "modal">;

/**
 * A binding plus WHERE it lives in the registry, so a caller that wants
 * to RUN it (the ⌘K palette) can re-read the live closure the way the
 * dispatcher does, instead of invoking the one captured in the
 * version-cached snapshot — which is deliberately allowed to be a
 * commit old, because `signatureOf` cannot see a closure.
 */
export type PlacedBinding = KeyBinding & { entry: number; index: number };

export type KeymapSection = { scope: OverlayScope; bindings: readonly PlacedBinding[] };

/**
 * What the `?` overlay and the palette's "On this page" group render:
 * the live map, highest scope first, as it would actually behave.
 *
 * · `modal` scopes are SKIPPED ENTIRELY — their rows AND their exclusive
 *   break. The overlay IS the modal scope while it is open, so counting
 *   it would either list a duplicate `?` row or blank out every section
 *   the overlay was opened to show.
 * · A disabled binding is dropped: it refuses the key, so advertising it
 *   would be a lie.
 * · A key already claimed by a HIGHER scope is shadowed out, because the
 *   overlay states what would happen if you pressed it right now — with
 *   the peek open that is the item's `S`, not the board's.
 * · …but only a RUN-BEARING binding claims. A `run: null` row is handled
 *   on a focused element (a card, a row), and wherever no such element
 *   holds focus the key goes on to a lower scope — which is what the
 *   dispatcher does, skipping it. So the board's `T` on a focused card
 *   is listed AND the global `T` beneath it, and the palette keeps the
 *   global row; a claiming row would have hidden the only `T` that works
 *   from anywhere else on the page. A `run: null` row is still shadowed
 *   by a higher claim, like any other.
 * · Entries sharing a scope name are merged into one section, so a
 *   surface may mount one small island per picker (slice 6's `P E D`)
 *   without the overlay growing a heading each.
 */
export function overlaySections(scopes: readonly ScopeSnapshot[]): KeymapSection[] {
  const rows: (PlacedBinding & { scope: OverlayScope })[] = [];
  const claimed = new Set<string>();

  // BACKWARDS, because shadowing is a precedence question: the highest
  // scope claims a key and every lower one loses it.
  for (let i = scopes.length - 1; i >= 0; i--) {
    const scope = scopes[i]!;
    if (scope.scope === "modal") continue;
    const name: OverlayScope = scope.scope;
    for (let b = 0; b < scope.bindings.length; b++) {
      const binding = scope.bindings[b]!;
      if (!binding.enabled) continue;
      const key = binding.key.toLowerCase();
      if (claimed.has(key)) continue;
      if (binding.run !== null) claimed.add(key);
      rows.push({ ...binding, scope: name, entry: i, index: b });
    }
  }

  // …but READING order is not precedence order. Section order follows
  // the walk (highest scope first), while the rows INSIDE a section go
  // back into the order the surface declared them — a scope split
  // across several islands (slice 6's `P E D`) would otherwise list its
  // keys backwards.
  const byScope = new Map<OverlayScope, (PlacedBinding & { scope: OverlayScope })[]>();
  const order: OverlayScope[] = [];
  for (const row of rows) {
    let list = byScope.get(row.scope);
    if (!list) {
      list = [];
      byScope.set(row.scope, list);
      order.push(row.scope);
    }
    list.push(row);
  }

  return order.map((scope) => ({
    scope,
    bindings: byScope.get(scope)!.sort((a, b) => a.entry - b.entry || a.index - b.index),
  }));
}

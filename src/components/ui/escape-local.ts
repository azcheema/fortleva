/**
 * The layer wrappers' Escape contract (`SheetContent`, `DialogContent`).
 *
 * A hand-written Escape handler can never beat a Radix layer (the
 * standing trap, AGENTS.md): the layer listens on the document in the
 * capture phase, before any React handler runs, and closes. The layer's
 * own hook is the one honest way through — so a field inside a sheet
 * or dialog that owns its Escape (the item panel's subtask add row;
 * any inline field a later slice puts inside a layer) marks itself
 * `data-escape-local`, and the wrapper's `onEscapeKeyDown` prevents the
 * dismissal for a key pressed inside such an element. The field's own
 * handler then runs as the only handler of that key. A caller's own
 * `onEscapeKeyDown` still runs first and may prevent default itself.
 *
 * NOT FOR A PROSEMIRROR EDITOR (slice 125, measured in a browser): the
 * contract works by PREVENTING the Escape, and ProseMirror ignores every
 * bubbling event that is already prevented (`eventBelongsToView`), so no
 * binding inside the editor — its keymap, a plugin's `handleKeyDown` —
 * ever sees the key. An editor that owns Escape takes it at the WINDOW's
 * capture phase, before this layer, and prevents it there
 * (`comment-editor.tsx`).
 */
export const ESCAPE_LOCAL_ATTR = "data-escape-local";

export function letEscapeThrough(
  own?: (event: KeyboardEvent) => void,
): (event: KeyboardEvent) => void {
  return (event) => {
    own?.(event);
    if (event.target instanceof Element && event.target.closest(`[${ESCAPE_LOCAL_ATTR}]`)) {
      event.preventDefault();
    }
  };
}

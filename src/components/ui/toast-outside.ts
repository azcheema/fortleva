/**
 * A toast is never "outside" a layer (`SheetContent`, `DialogContent`).
 *
 * Sonner mounts its toaster once, at the document root, outside every
 * Radix layer's tree. A MODAL layer — the item peek, every dialog — does
 * two things to anything outside it: it sets `pointer-events: none` on
 * <body>, so a toast cannot be clicked at all (measured 2026-09-16: the
 * Undo of a timer started from the peek was unclickable, the peek
 * "intercepting pointer events"), and it treats a pointer-down outside as
 * a dismissal, so a toast that COULD be clicked would close the layer
 * under the member's hand. The `Toaster` wrapper opts its toasts back
 * into pointer events; this handler wrapper, which both layer wrappers pass
 * as Radix's `onInteractOutside`, keeps the layer open for an interaction
 * that starts inside the toaster. A caller's own handler still runs
 * first and may prevent default itself.
 */
export const TOASTER_SELECTOR = "[data-sonner-toaster]"

export function keepOpenForToasts<E extends Event>(own?: (event: E) => void): (event: E) => void {
  return (event) => {
    own?.(event)
    if (event.target instanceof Element && event.target.closest(TOASTER_SELECTOR)) {
      event.preventDefault()
    }
  }
}

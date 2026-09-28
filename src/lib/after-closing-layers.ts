/**
 * Run `fn` once the popover or menu a choice was just made in has GONE —
 * then one task later, after Radix has handed focus back to its trigger.
 *
 * WHY (Phase 3 slice 72, measured in a browser — twice): the sharing UI
 * opens an in-place question right after a choice made in a picker or a
 * menu. Both layers are MODAL, and a layer keeps its focus trap (and its
 * scroll lock and focus guards) until it has unmounted, exit animation
 * included. A question that took focus while the layer was still there
 * had it pulled straight back into the layer; the question's own blur
 * then cancelled it, and the e2e saw the bar's confirm button "inactive",
 * then detached. The first cut of this helper looked only for a layer
 * already CLOSING and looked synchronously — inside the menu item's
 * `onSelect`, before Radix had even switched the menu to "closed" — so it
 * saw an OPEN menu, found nothing closing, and fired at once (a debug run
 * caught `<body data-scroll-locked>` under the cancel). So it waits a
 * frame first, and then until no popover or menu content is in the DOM.
 *
 * Bounded (60 frames, about a second): a layer that stays open — the
 * member opened another picker meanwhile — cannot hold the question back
 * for ever; the caller's own "is focus still here" check then declines to
 * take focus from it.
 */
const LAYER = '[data-slot="popover-content"], [data-slot="dropdown-menu-content"]';

export function afterClosingLayers(fn: () => void, maxFrames = 60): void {
  let frames = 0;
  const tick = () => {
    if (document.querySelector(LAYER) !== null && frames++ < maxFrames) {
      requestAnimationFrame(tick);
      return;
    }
    // Radix hands focus back in a timeout scheduled at unmount; this runs
    // after it.
    setTimeout(fn, 0);
  };
  requestAnimationFrame(tick);
}

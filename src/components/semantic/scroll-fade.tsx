"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The right-edge fade on a horizontally scrollable table.
 *
 * A table that hides 45% of itself behind an unadvertised scroll is a
 * table that has silently deleted its own action column on a phone.
 * Column priority (`TableHead priority`) removes what can be removed;
 * this says that what is left continues.
 *
 * With a PINNED actions column (`TableHead pinned`) the content does not
 * continue at the box's edge but under that column, so the fade sits just
 * left of it — measured off the pinned header cell on every resize — and
 * loses the box's rounded corner, which the pinned column now owns.
 * `inset-y-px` keeps a bordered table's top and bottom hairline whole
 * across the fade (a flush table has none, and loses nothing).
 *
 * KEYBOARD FOCUS UNDER THE PINNED COLUMN is this island's other job, because
 * the browser does not see a sticky cell cover anything: a control inside
 * the box but under the column counts as visible and stays where it is
 * (measured: the time week's duration editor, focused at a 526px box, sat
 * 36px under the column — `scroll-padding-inline-end` did not move it, and
 * was dropped, because it would also have counted every control IN the
 * pinned column as hidden). A `focusin` handler scrolls such a control out,
 * and runs before the browser's own focus scroll, which then has nothing to
 * do. It acts only where the browser shows a focus ring (`:focus-visible`):
 * keyboard focus, and a TEXT field however it was focused, because every
 * engine rings those — so a mouse-opened `<InlineEdit>` field is revealed
 * after the click has landed, where its caret would otherwise sit under the
 * column, while a click on a resting control never moves it between press
 * and release (no pinned row has a text field at rest; one that did would be
 * scrolled on mousedown). It acts only in a row that HAS a pinned cell,
 * measured against that cell (the backlog's create row spans the column and
 * nothing covers it), never for a row itself (the backlog's `J K`) or the
 * pinned cell's own controls, and it stops the control a fade's width short
 * of the column while the table can still scroll right — the fade covers
 * those 32px.
 *
 * It is a separate client island so `<DataTable>` — which every server
 * component renders — stays a server component. The measurement runs in
 * a ResizeObserver callback rather than in the effect body, because the
 * React Compiler lint bans setState inside an effect and the observer
 * fires once on `observe()` anyway.
 */
export function ScrollFade() {
  const ref = useRef<HTMLSpanElement>(null);
  const [more, setMore] = useState(false);
  const [pinnedWidth, setPinnedWidth] = useState(0);

  useEffect(() => {
    const box = ref.current?.previousElementSibling;
    if (!(box instanceof HTMLElement)) return;
    const measure = () => {
      setMore(box.scrollWidth - box.clientWidth - box.scrollLeft > 1);
      const pinned = box.querySelector("thead [data-pinned]");
      setPinnedWidth(pinned ? Math.round(pinned.getBoundingClientRect().width) : 0);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    const table = box.firstElementChild;
    if (table instanceof HTMLElement) observer.observe(table);
    box.addEventListener("scroll", measure, { passive: true });
    // The focus ring sits 2px outside a control and is 2px wide; the fade
    // below is `w-8`.
    const RING = 4;
    const FADE = 32;
    const reveal = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || target === box) return;
      if (target instanceof HTMLTableRowElement || target.closest("[data-pinned]")) return;
      if (!target.matches(":focus-visible")) return;
      const pinned = target.closest("tr")?.querySelector(":scope > [data-pinned]");
      if (!pinned) return;
      const edge = pinned.getBoundingClientRect().left - FADE;
      const rect = target.getBoundingClientRect();
      const room = edge - (box.getBoundingClientRect().left + box.clientLeft);
      // Nothing to do if it and its ring end left of the fade, and nothing
      // sensible if they are wider than the room the column and fade leave.
      // At the table's right end the scroll clamps, and the fade is gone.
      if (rect.right + RING <= edge || rect.width + 2 * RING > room) return;
      box.scrollLeft += rect.right + RING - edge;
    };
    box.addEventListener("focusin", reveal);
    return () => {
      observer.disconnect();
      box.removeEventListener("scroll", measure);
      box.removeEventListener("focusin", reveal);
    };
  }, []);

  return (
    <span
      ref={ref}
      aria-hidden="true"
      data-slot="scroll-fade"
      data-more={more || undefined}
      style={pinnedWidth > 0 ? { right: pinnedWidth } : undefined}
      className={
        more
          ? pinnedWidth > 0
            ? "pointer-events-none absolute inset-y-px w-8 bg-linear-to-l from-card to-transparent"
            : "pointer-events-none absolute inset-y-0 right-0 w-8 rounded-r-card bg-linear-to-l from-card to-transparent"
          : "hidden"
      }
    />
  );
}

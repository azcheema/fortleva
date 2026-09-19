"use client";

import { useEffect, useRef, useState } from "react";

import { revealExempt, revealScrollDelta } from "@/lib/scroll-reveal";

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
    // The TABLE, not `box.firstElementChild` — which is `<Table>`'s
    // `table-container` div, `relative w-full`, so its width is the box's
    // by definition and observing it could never report anything the box
    // had not already reported. The intent was always the table (it is
    // what grows with content, past the box, and makes the box scroll);
    // the bug was invisible because `measure()` also runs once on
    // `observe()`, so a table that ALREADY overflowed at first paint got
    // its fade anyway. What went missing was later growth — a label chip
    // added, a long title committed inline — after which the content
    // continued past the edge with nothing saying so, since the other
    // trigger is a scroll the member has no cue to perform. Found by
    // `e2e/scroll-reveal.spec.ts` on its first run, widening a table and
    // waiting for a fade that never came.
    const table = box.querySelector("table");
    if (table instanceof HTMLElement) observer.observe(table);
    box.addEventListener("scroll", measure, { passive: true });
    // READS the DOM; `scroll-reveal.ts` decides. Every exemption and both
    // geometric no-ops live there, pinned over every combination by
    // `scroll-reveal.test.ts` — this half stays as thin as it can be,
    // because a `node` test suite has no layout and cannot check it.
    //
    // THE TWO FREE FACTS GATE EVERYTHING ELSE, and that ordering is
    // load-bearing rather than tidy. `focusin` fires on every focus
    // change in the table and the backlog's `J K` focuses a ROW on every
    // press, down a list seeded four thousand rows long — so the row path
    // must not pay for the two `closest()` ancestor walks below (one of
    // which runs to `<html>` when it matches nothing) or for the three
    // `getBoundingClientRect()` calls, which force layout. An identity
    // check and an `instanceof` decide it instead. `matches()` stays
    // eager: it is a selector test on ONE element, with no tree to walk.
    // The first draft of this refactor built all five inputs eagerly and
    // made the hot path slower than the handler it replaced (review).
    const reveal = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const isBox = target === box;
      const isRow = target instanceof HTMLTableRowElement;
      const free = isBox || isRow;
      const pinned = free
        ? null
        : (target.closest("tr")?.querySelector(":scope > [data-pinned]") ?? null);
      const exempt = revealExempt({
        isBox,
        isRow,
        inPinnedCell: !free && target.closest("[data-pinned]") !== null,
        hasPinnedCell: pinned !== null,
        focusVisible: target.matches(":focus-visible"),
      });
      // `pinned` is named again only so TypeScript narrows it — a row
      // without one is already exempt, and the alternative is a `!` this
      // directory otherwise does not contain.
      if (exempt || pinned === null) return;
      const rect = target.getBoundingClientRect();
      const delta = revealScrollDelta({
        targetRight: rect.right,
        targetWidth: rect.width,
        pinnedLeft: pinned.getBoundingClientRect().left,
        boxContentLeft: box.getBoundingClientRect().left + box.clientLeft,
      });
      if (delta !== 0) box.scrollLeft += delta;
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

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
 * It is a separate client island so `<DataTable>` — which every server
 * component renders — stays a server component. The measurement runs in
 * a ResizeObserver callback rather than in the effect body, because the
 * React Compiler lint bans setState inside an effect and the observer
 * fires once on `observe()` anyway.
 */
export function ScrollFade() {
  const ref = useRef<HTMLSpanElement>(null);
  const [more, setMore] = useState(false);

  useEffect(() => {
    const box = ref.current?.previousElementSibling;
    if (!(box instanceof HTMLElement)) return;
    const measure = () => setMore(box.scrollWidth - box.clientWidth - box.scrollLeft > 1);
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    const table = box.firstElementChild;
    if (table instanceof HTMLElement) observer.observe(table);
    box.addEventListener("scroll", measure, { passive: true });
    return () => {
      observer.disconnect();
      box.removeEventListener("scroll", measure);
    };
  }, []);

  return (
    <span
      ref={ref}
      aria-hidden="true"
      data-slot="scroll-fade"
      data-more={more || undefined}
      className={
        more
          ? "pointer-events-none absolute inset-y-0 right-0 w-8 rounded-r-card bg-linear-to-l from-card to-transparent"
          : "hidden"
      }
    />
  );
}

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";

import { cn } from "@/lib/utils";

export type TabLink = {
  href: string;
  label: string;
  exact?: boolean;
  /** Sibling routes this tab also owns (a sub-view living outside its path prefix). */
  also?: string[];
  /**
   * Overrides the pathname comparison. Tabs that differ only by a query
   * param (`/inbox?filter=archived`) all share one pathname, so the
   * server — which already parsed the param to build the page — says
   * which one is current instead of this component guessing. Omitted,
   * the pathname rules above decide, exactly as before.
   */
  active?: boolean;
};

/**
 * URL-addressable tabs (UI.md §3.1: every view is a link). Rendered as
 * links with aria-current, so back/forward and deep links work and no
 * client state is needed. Scrolls horizontally on narrow screens.
 *
 * The landmark is named: a page can carry the rail's nav and this one
 * at the same time, and two unnamed navs in the landmark list are
 * indistinguishable to a screen-reader user.
 *
 * The strip scrolls ITSELF so the current tab is visible on arrival —
 * on a project's Team tab at 390px the active tab was measurably off
 * screen, which reads as "this page has no tabs". Only the strip
 * scrolls, never the page. Arrival and `prefers-reduced-motion` get the
 * jump; only a move between tabs of the same layout glides. Links are
 * 44px below `md` (a thumb target) and 32px from `md` up (the control
 * scale, §10.8).
 */
export function TabNav({ tabs, className }: { tabs: TabLink[]; className?: string }) {
  const pathname = usePathname();
  const t = useTranslations("common");
  const stripRef = useRef<HTMLElement>(null);
  const activeRef = useRef<HTMLAnchorElement>(null);
  // The strip's first placement on a page is where it IS, not somewhere
  // it travels to: arriving on the Portal tab at 390px glided the strip
  // from Overview across the whole row on every load. It also raced the
  // visual walk — a smooth `scrollTo` is not a Web Animation, so
  // `settle()` cannot finish it, and a long glide outlasted its wait and
  // was measured mid-flight ("current tab is outside the tab strip", on a
  // different far-right tab each time, 2026-09-29). The glide is kept for
  // what it is for: moving between tabs of the same layout.
  const placed = useRef(false);

  useEffect(() => {
    const strip = stripRef.current;
    const active = activeRef.current;
    if (!strip || !active) return;
    const first = !placed.current;
    placed.current = true;
    const target = active.offsetLeft - (strip.clientWidth - active.clientWidth) / 2;
    const left = Math.max(0, target);
    if (Math.abs(strip.scrollLeft - left) < 1) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // "instant", not "auto": `auto` defers to the element's CSS
    // `scroll-behavior`, so a host passing `scroll-smooth` in `className`
    // would quietly turn the jump back into a glide.
    strip.scrollTo({ left, behavior: reduced || first ? "instant" : "smooth" });
  }, [pathname]);

  return (
    <nav
      ref={stripRef}
      data-slot="tab-strip"
      aria-label={t("sections")}
      className={cn("-mb-px flex gap-1 overflow-x-auto border-b border-border", className)}
    >
      {tabs.map((tab) => {
        const owns = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
        const active =
          tab.active ??
          (tab.exact ? pathname === tab.href : owns(tab.href) || (tab.also ?? []).some(owns));
        return (
          <Link
            key={tab.href}
            href={tab.href}
            ref={active ? activeRef : undefined}
            aria-current={active ? "page" : undefined}
            className={cn(
              // 32px tab from md up, 44px below it. Hairline underline.
              // The focus ring is an outline with a NEGATIVE offset: this
              // nav scrolls horizontally, and a positive offset would be
              // clipped by the scroll container.
              "inline-flex h-11 shrink-0 items-center border-b-2 border-transparent px-2.5 text-sm text-muted-foreground transition-[color,border-color] duration-(--dur-instant) ease-out hover:text-foreground focus-visible:rounded-sm focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring md:h-8",
              active && "border-primary font-medium text-foreground",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

export type TabLink = { href: string; label: string; exact?: boolean };

/**
 * URL-addressable tabs (UI.md §3.1: every view is a link). Rendered as
 * links with aria-current, so back/forward and deep links work and no
 * client state is needed. Scrolls horizontally on narrow screens.
 */
export function TabNav({ tabs, className }: { tabs: TabLink[]; className?: string }) {
  const pathname = usePathname();
  return (
    <nav className={cn("-mb-px flex gap-1 overflow-x-auto border-b border-border", className)}>
      {tabs.map((tab) => {
        const active = tab.exact ? pathname === tab.href : pathname === tab.href || pathname.startsWith(`${tab.href}/`);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "shrink-0 border-b-2 border-transparent px-2.5 py-1.5 text-sm text-muted-foreground hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
              active && "border-foreground font-medium text-foreground",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}

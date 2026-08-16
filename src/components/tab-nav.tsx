"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";

export type TabLink = { href: string; label: string; exact?: boolean };

/**
 * URL-addressable tabs (UI.md §3.1: every view is a link). Rendered as
 * links with aria-current, so back/forward and deep links work and no
 * client state is needed. Scrolls horizontally on narrow screens.
 *
 * The landmark is named: a page can carry the rail's nav and this one
 * at the same time, and two unnamed navs in the landmark list are
 * indistinguishable to a screen-reader user.
 */
export function TabNav({ tabs, className }: { tabs: TabLink[]; className?: string }) {
  const pathname = usePathname();
  const t = useTranslations("common");
  return (
    <nav aria-label={t("sections")} className={cn("-mb-px flex gap-1 overflow-x-auto border-b border-border", className)}>
      {tabs.map((tab) => {
        const active = tab.exact ? pathname === tab.href : pathname === tab.href || pathname.startsWith(`${tab.href}/`);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              // 32px tab, hairline underline. The focus ring is an outline
              // with a NEGATIVE offset: this nav scrolls horizontally, and a
              // positive offset would be clipped by the scroll container.
              "inline-flex h-8 shrink-0 items-center border-b-2 border-transparent px-2.5 text-sm text-muted-foreground transition-[color,border-color] duration-(--dur-instant) ease-out hover:text-foreground focus-visible:rounded-sm focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
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

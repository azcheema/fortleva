"use client";

import {
  ChevronDownIcon,
  ChevronLeftIcon,
  CircleHelpIcon,
  LogOutIcon,
  MenuIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  SearchIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useSyncExternalStore, useTransition } from "react";

import type { NavEntry } from "@/app/(tenant)/(authed)/nav";
import { authClient } from "@/auth/client";
import { KeyboardHint } from "@/components/semantic/keyboard-hint";
import { ThemeToggle } from "@/components/semantic/theme-toggle";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ThemePreference } from "@/lib/theme";
import { cn } from "@/lib/utils";

import { CommandPalette, flatNav } from "./command-palette";
import { NavIcon } from "./nav-icon";
import { ShortcutsOverlay } from "./shortcuts-overlay";
import { TimerPillSlot } from "./timer-pill-slot";
import { useGlobalHotkeys } from "./use-hotkeys";

const RAIL_KEY = "flv.rail.collapsed";
const RAIL_EVENT = "flv:rail";

const readRail = (): boolean => window.localStorage.getItem(RAIL_KEY) === "1";
const writeRail = (collapsed: boolean): void => {
  window.localStorage.setItem(RAIL_KEY, collapsed ? "1" : "0");
  window.dispatchEvent(new Event(RAIL_EVENT));
};
const subscribeRail = (cb: () => void): (() => void) => {
  window.addEventListener(RAIL_EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(RAIL_EVENT, cb);
    window.removeEventListener("storage", cb);
  };
};

type ShellUser = { name: string; email: string };

/**
 * The mobile tab. The current-tab indicator sits INSIDE the bar's
 * padding box (`top-1`): drawn on the bar's own top hairline it read as
 * a stray 2px segment floating over the content above it.
 */
const TAB =
  "relative flex flex-1 flex-col items-center justify-center gap-0.5 text-2xs text-muted-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring";
const TAB_CURRENT =
  "font-semibold text-foreground before:absolute before:inset-x-4 before:top-1 before:h-0.5 before:rounded-full before:bg-primary";

const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");

const isActive = (pathname: string, href: string): boolean =>
  pathname === href || pathname.startsWith(`${href}/`);

/**
 * Member-plane app shell (UI.md §3, ARC-15). The rail RECEDES — it is
 * darker than the canvas in both themes — and it is collapsible at
 * every breakpoint from 768px up, not only above 1280px, so the
 * 768-1280 band is no longer permanently icon-only with no escape.
 *
 * The active nav item carries three channels at once: aria-current, a
 * 2px indicator bar and a colour change.
 */
export function AppShell({
  nav,
  tenantName,
  breadcrumb,
  user,
  theme,
  onSwitchLocale,
  children,
}: {
  nav: readonly NavEntry[];
  tenantName: string | null;
  /**
   * The route trail — "Clients › ACME" — fed from the route segment.
   * The header says WHERE YOU ARE; a constant tenant string on all 25
   * routes says nothing. Falls back to the deepest matching nav entry,
   * so the header is never a constant even before a route feeds it.
   */
  breadcrumb?: React.ReactNode;
  user: ShellUser;
  /** Preference the server rendered <html> with (src/lib/theme-server). */
  theme: ThemePreference;
  onSwitchLocale: (locale: string) => Promise<void>;
  children: React.ReactNode;
}) {
  const t = useTranslations("nav");
  const tShell = useTranslations("shell");
  const tCommon = useTranslations("common");
  const pathname = usePathname();
  const router = useRouter();
  const [, startTransition] = useTransition();

  // Rail state lives in localStorage; read via useSyncExternalStore so the
  // server render (no storage) and the client agree without an effect.
  const collapsed = useSyncExternalStore(subscribeRail, readRail, () => false);
  const toggleRail = () => writeRail(!collapsed);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  const flat = flatNav(nav);
  const goTargets = new Map(flat.filter((e) => e.goKey).map((e) => [e.goKey!, e.href]));

  useGlobalHotkeys({
    goKeys: [...goTargets.keys()],
    onPalette: () => setPaletteOpen((o) => !o),
    onOverlay: () => setOverlayOpen(true),
    onGo: (key) => {
      const href = goTargets.get(key);
      if (href) startTransition(() => router.push(href));
    },
  });

  const signOut = async () => {
    await authClient.signOut();
    router.push("/login");
    router.refresh();
  };
  const switchLocale = (locale: string) => {
    startTransition(async () => {
      await onSwitchLocale(locale);
      router.refresh();
    });
  };

  const tabs = nav.filter((e) => e.mobileTab);
  const labelClass = collapsed ? "hidden" : "hidden md:inline";

  // The deepest nav entry that owns this route: the header's fallback
  // trail and, on a phone, the section title that replaces the tenant.
  const activeEntry = flat
    .filter((e) => isActive(pathname, e.href))
    .sort((a, b) => b.href.length - a.href.length)[0];
  const sectionLabel = activeEntry ? t(activeEntry.labelKey) : (tenantName ?? tCommon("appName"));
  const trail = breadcrumb ?? (activeEntry ? t(activeEntry.labelKey) : null);
  // "More" owns every route none of the four tabs does (UI.md §3.3).
  const tabOwnsRoute = tabs.some((e) => isActive(pathname, e.href));

  const railLink = (entry: NavEntry, depth = 0) => {
    const active = isActive(pathname, entry.href);
    const label = t(entry.labelKey);
    const link = (
      <Link
        href={entry.href}
        aria-current={active ? "page" : undefined}
        className={cn(
          "relative flex h-8 items-center gap-2 rounded-md px-2 text-sm text-sidebar-foreground transition-colors duration-(--dur-instant) ease-out hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          active &&
            "bg-sidebar-accent font-medium text-sidebar-accent-foreground before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded-full before:bg-sidebar-primary",
          depth > 0 && "h-7 text-xs",
        )}
      >
        <NavIcon
          name={entry.icon}
          className={cn(
            "size-4 shrink-0",
            depth > 0 && "size-3.5",
            active && "text-sidebar-primary",
          )}
        />
        <span className={cn("truncate", labelClass)}>{label}</span>
      </Link>
    );
    return (
      <li key={entry.id}>
        <Tooltip>
          <TooltipTrigger asChild>{link}</TooltipTrigger>
          <TooltipContent side="right" className={cn(!collapsed && "md:hidden")}>
            {label}
          </TooltipContent>
        </Tooltip>
        {entry.children ? (
          <ul className={cn("mt-0.5 flex flex-col gap-0.5", collapsed ? "pl-0" : "md:pl-4")}>
            {entry.children.map((c) => railLink(c, depth + 1))}
          </ul>
        ) : null}
      </li>
    );
  };

  const sheetLink = (entry: NavEntry, depth = 0) => (
    <li key={entry.id}>
      <Link
        href={entry.href}
        onClick={() => setSheetOpen(false)}
        aria-current={isActive(pathname, entry.href) ? "page" : undefined}
        className={cn(
          "flex h-10 items-center gap-3 rounded-md px-3 text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          isActive(pathname, entry.href) && "bg-accent font-medium",
          depth > 0 && "h-9 pl-9 text-xs",
        )}
      >
        <NavIcon name={entry.icon} className="size-4" />
        {t(entry.labelKey)}
      </Link>
      {entry.children ? (
        <ul className="flex flex-col gap-0.5">{entry.children.map((c) => sheetLink(c, depth + 1))}</ul>
      ) : null}
    </li>
  );

  return (
    <div className="flex min-h-screen">
      {/* Desktop rail */}
      <aside
        className={cn(
          "sticky top-0 hidden h-screen shrink-0 flex-col border-r border-sidebar-border bg-sidebar px-2 py-3 text-sidebar-foreground md:flex",
          collapsed ? "w-(--rail-w-collapsed)" : "w-(--rail-w-collapsed) md:w-(--rail-w)",
        )}
      >
        <div className={cn("flex items-center px-1", collapsed ? "justify-center" : "md:justify-between")}>
          <Link
            href="/home"
            className={cn(
              "truncate rounded-sm text-sm font-semibold text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
              labelClass,
            )}
          >
            {tCommon("appName")}
          </Link>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={toggleRail}
                aria-label={collapsed ? t("expand") : t("collapse")}
              >
                {collapsed ? <PanelLeftOpenIcon /> : <PanelLeftCloseIcon />}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">{collapsed ? t("expand") : t("collapse")}</TooltipContent>
          </Tooltip>
        </div>
        <nav aria-label={t("menu")} className="mt-3 flex-1 overflow-y-auto">
          <ul className="flex flex-col gap-0.5">{nav.map((e) => railLink(e))}</ul>
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Header */}
        <header className="sticky top-0 z-30 flex h-12 items-center gap-2 border-b border-border bg-background/95 px-3 backdrop-blur md:px-4">
          {/* No hamburger here: §3.3 names `More` as the single sheet
              entry, and the same navigation offered at two opposite
              corners of a phone is duplication, not redundancy. */}
          <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
            <SheetContent side="left" className="w-72 p-4">
              <SheetHeader className="p-0">
                <SheetTitle>{tenantName ?? tCommon("appName")}</SheetTitle>
                <SheetDescription>{t("signedInAs", { email: user.email })}</SheetDescription>
              </SheetHeader>
              <nav aria-label={t("menu")} className="mt-2">
                <ul className="flex flex-col gap-0.5">{nav.map((e) => sheetLink(e))}</ul>
              </nav>
              <Separator className="my-2" />
              <Button variant="ghost" className="justify-start" onClick={signOut}>
                <LogOutIcon />
                {tCommon("signOut")}
              </Button>
            </SheetContent>
          </Sheet>

          {/* Phone: back + the section you are in. Desktop: the
              workspace, then the route trail. */}
          <div className="flex min-w-0 items-center gap-1 md:hidden">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={tCommon("back")}
              onClick={() => router.back()}
            >
              <ChevronLeftIcon />
            </Button>
            <span className="truncate text-sm font-semibold">{sectionLabel}</span>
          </div>
          <div className="hidden min-w-0 items-center gap-2 md:flex">
            <span className="truncate text-sm font-semibold">{tenantName ?? tCommon("appName")}</span>
            {trail ? (
              <span className="min-w-0 truncate text-xs text-muted-foreground">{trail}</span>
            ) : null}
          </div>

          <TimerPillSlot className="ml-2 hidden md:block" />

          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              className="hidden gap-2 text-muted-foreground md:inline-flex"
              onClick={() => setPaletteOpen(true)}
              aria-label={tShell("palette.open")}
            >
              <SearchIcon />
              <span>{tShell("palette.title")}</span>
              <KeyboardHint keys={["mod", "K"]} />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              className="md:hidden"
              onClick={() => setPaletteOpen(true)}
              aria-label={tShell("palette.open")}
            >
              <SearchIcon />
            </Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setOverlayOpen(true)}
                  aria-label={tShell("shortcuts.open")}
                >
                  <CircleHelpIcon />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{tShell("shortcuts.open")}</TooltipContent>
            </Tooltip>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" className="gap-1.5 px-1.5">
                  <Avatar className="size-6">
                    <AvatarFallback>{initials(user.name)}</AvatarFallback>
                  </Avatar>
                  <ChevronDownIcon className="size-3.5 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-60">
                <DropdownMenuLabel className="flex flex-col gap-0.5 normal-case tracking-normal">
                  <span className="truncate text-sm font-medium text-foreground">{user.name}</span>
                  <span className="truncate text-xs font-normal text-muted-foreground">
                    {user.email}
                  </span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href="/account">
                    <NavIcon name="account" />
                    {t("account")}
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/dashboard">{t("switchWorkspace")}</Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <div className="px-2 py-1.5">
                  <ThemeToggle value={theme} className="w-full" />
                </div>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={signOut}>
                  <LogOutIcon />
                  {tCommon("signOut")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        <TimerPillSlot className="md:hidden" />

        {/* 64px clears the 56px bar; the safe-area inset clears the home
            indicator underneath it on a notched phone. */}
        <main className="flex-1 pb-[calc(--spacing(16)+env(safe-area-inset-bottom))] md:pb-0">
          {children}
        </main>
      </div>

      {/* Mobile bottom tabs: Home / Projects / Clients / More (UI.md §3.3; Board/Timer/Inbox arrive with their modules) */}
      <nav
        data-slot="tab-bar"
        aria-label={t("menu")}
        className="fixed inset-x-0 bottom-0 z-30 flex h-14 items-stretch border-t border-border bg-background pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        {tabs.map((e) => (
          <Link
            key={e.id}
            href={e.href}
            aria-current={isActive(pathname, e.href) ? "page" : undefined}
            className={cn(
              TAB,
              isActive(pathname, e.href) && TAB_CURRENT,
            )}
          >
            <NavIcon name={e.icon} className="size-5" />
            {t(e.labelKey)}
          </Link>
        ))}
        <button
          type="button"
          onClick={() => setSheetOpen(true)}
          aria-current={tabOwnsRoute ? undefined : "page"}
          className={cn(TAB, !tabOwnsRoute && TAB_CURRENT)}
        >
          <MenuIcon className="size-5" />
          {t("more")}
        </button>
      </nav>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        nav={nav}
        onSignOut={signOut}
        onSwitchLocale={switchLocale}
        onShowShortcuts={() => setOverlayOpen(true)}
      />
      <ShortcutsOverlay open={overlayOpen} onOpenChange={setOverlayOpen} nav={nav} />
    </div>
  );
}

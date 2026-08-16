"use client";

import {
  ChevronDownIcon,
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
import { cn } from "@/lib/utils";

import { CommandPalette, flatNav } from "./command-palette";
import { NavIcon } from "./nav-icon";
import { ShortcutsOverlay } from "./shortcuts-overlay";
import { TimerPillSlot } from "./timer-pill-slot";
import { isApplePlatform, useGlobalHotkeys } from "./use-hotkeys";

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
 * Member-plane app shell (UI.md §3, ARC-15): collapsible left rail
 * (icons only < 1280 px or when collapsed), header with tenant name +
 * timer-pill slot + palette/keymap/user menu, mobile bottom tabs
 * (Home / Files / More), ⌘K palette and `?` overlay. Data-driven from
 * the nav registry — the layout has already filtered it by permission.
 */
export function AppShell({
  nav,
  tenantName,
  user,
  onSwitchLocale,
  children,
}: {
  nav: readonly NavEntry[];
  tenantName: string | null;
  user: ShellUser;
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

  const modKey = isApplePlatform() ? "⌘K" : "Ctrl K";
  const tabs = nav.filter((e) => e.mobileTab);

  const railLink = (entry: NavEntry, depth = 0) => {
    const active = isActive(pathname, entry.href);
    const label = t(entry.labelKey);
    const link = (
      <Link
        href={entry.href}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex h-8 items-center gap-2 rounded-md px-2 text-sm text-foreground/80 hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
          active && "bg-muted font-medium text-foreground",
          depth > 0 && "h-7 text-[0.8rem]",
        )}
      >
        <NavIcon name={entry.icon} className={cn("size-4 shrink-0", depth > 0 && "size-3.5")} />
        <span className={cn("truncate", collapsed ? "hidden" : "hidden xl:inline")}>{label}</span>
      </Link>
    );
    return (
      <li key={entry.id}>
        <Tooltip>
          <TooltipTrigger asChild>{link}</TooltipTrigger>
          <TooltipContent side="right" className={cn(!collapsed && "xl:hidden")}>
            {label}
          </TooltipContent>
        </Tooltip>
        {entry.children ? (
          <ul className={cn("mt-0.5 flex flex-col gap-0.5", collapsed ? "pl-0" : "xl:pl-4")}>
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
          "flex h-10 items-center gap-3 rounded-md px-3 text-sm hover:bg-muted",
          isActive(pathname, entry.href) && "bg-muted font-medium",
          depth > 0 && "h-9 pl-9 text-[0.8rem]",
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
          "sticky top-0 hidden h-screen shrink-0 flex-col border-r border-border bg-sidebar px-2 py-3 md:flex",
          collapsed ? "w-12" : "w-12 xl:w-56",
        )}
      >
        <div className={cn("flex items-center px-1", collapsed ? "justify-center" : "xl:justify-between")}>
          <Link
            href="/home"
            className={cn("truncate text-sm font-semibold", collapsed ? "hidden" : "hidden xl:inline")}
          >
            {tCommon("appName")}
          </Link>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={toggleRail} aria-label={collapsed ? t("expand") : t("collapse")}>
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
          <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
            <Button
              variant="ghost"
              size="icon-sm"
              className="md:hidden"
              onClick={() => setSheetOpen(true)}
              aria-label={t("menu")}
            >
              <MenuIcon />
            </Button>
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

          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-semibold">{tenantName ?? tCommon("appName")}</span>
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
              <kbd className="rounded border border-border bg-muted px-1 font-mono text-[10px]">{modKey}</kbd>
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
                    <AvatarFallback className="text-[10px]">{initials(user.name)}</AvatarFallback>
                  </Avatar>
                  <ChevronDownIcon className="size-3.5 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel className="flex flex-col">
                  <span className="truncate font-medium">{user.name}</span>
                  <span className="truncate text-xs font-normal text-muted-foreground">{user.email}</span>
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
                <DropdownMenuItem onSelect={signOut}>
                  <LogOutIcon />
                  {tCommon("signOut")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        <TimerPillSlot className="md:hidden" />

        <main className="flex-1 pb-16 md:pb-0">{children}</main>
      </div>

      {/* Mobile bottom tabs: Home / Files / More (UI.md §3.3) */}
      <nav
        aria-label={t("menu")}
        className="fixed inset-x-0 bottom-0 z-30 flex h-14 items-stretch border-t border-border bg-background md:hidden"
      >
        {tabs.map((e) => (
          <Link
            key={e.id}
            href={e.href}
            aria-current={isActive(pathname, e.href) ? "page" : undefined}
            className={cn(
              "flex flex-1 flex-col items-center justify-center gap-0.5 text-[11px] text-muted-foreground",
              isActive(pathname, e.href) && "text-foreground",
            )}
          >
            <NavIcon name={e.icon} className="size-5" />
            {t(e.labelKey)}
          </Link>
        ))}
        <button
          type="button"
          onClick={() => setSheetOpen(true)}
          className="flex flex-1 flex-col items-center justify-center gap-0.5 text-[11px] text-muted-foreground"
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

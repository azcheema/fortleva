"use client";

import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useLayoutEffect, useSyncExternalStore } from "react";

import {
  THEMES,
  applyTheme,
  storedThemeOrSystem,
  subscribeStoredTheme,
  writeThemeCookie,
  type ThemePreference,
} from "@/lib/theme";
import { cn } from "@/lib/utils";

const ICONS = { system: MonitorIcon, light: SunIcon, dark: MoonIcon } as const;

/**
 * Three-segment control: system / light / dark. Writing is optimistic —
 * <html> flips immediately and the mirror cookie is written in the same
 * tick — because a theme switch that waits for a round trip reads as a
 * broken button.
 *
 * The control has NO state of its own: it renders the STORED preference,
 * read through useSyncExternalStore so the server render (no cookie
 * access) and the client agree without an effect. `value` — the
 * preference the server resolved for this request, and therefore the
 * one <html> was rendered with — is the server snapshot and is
 * REQUIRED: every render site must thread it.
 *
 * That shape is the fix for a real bug. This control is mounted far
 * more often than the page is rendered (it lives inside the user menu,
 * which re-creates it every time the menu opens), and it used to seed
 * itself from a default of "system" and re-apply that on mount —
 * silently overwriting an explicit Light on a machine set to dark. A
 * control's default must never outrank a stored choice; the rule lives
 * in clientTheme() and is unit-tested in src/lib/theme.test.ts.
 */
export function ThemeToggle({
  value,
  className,
}: {
  value: ThemePreference;
  className?: string;
}) {
  const t = useTranslations("theme");
  // Client snapshot reads the cookie and nothing else, so it cannot go
  // stale. `value` is used ONLY as the server snapshot, where it is
  // fresh by construction — it comes from the very request being
  // rendered — and React uses it for SSR and hydration only.
  const current = useSyncExternalStore(subscribeStoredTheme, storedThemeOrSystem, () => value);

  // Sync the DOM to the preference we render. Idempotent in the normal
  // case — the cookie is exactly what the server rendered <html> from —
  // and it re-asserts the choice after a client navigation re-renders
  // <html> from a request that predates it.
  useLayoutEffect(() => {
    applyTheme(current);
  }, [current]);

  const choose = (next: ThemePreference) => {
    writeThemeCookie(next); // notifies every mounted control
    applyTheme(next);
  };

  return (
    <div
      data-slot="theme-toggle"
      role="radiogroup"
      aria-label={t("label")}
      className={cn(
        "inline-flex items-center gap-0.5 rounded-md border border-border bg-muted p-0.5",
        className,
      )}
    >
      {THEMES.map((theme) => {
        const Icon = ICONS[theme];
        const active = current === theme;
        return (
          <button
            key={theme}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => choose(theme)}
            className={cn(
              "inline-flex h-6 flex-1 items-center justify-center gap-1.5 rounded-sm px-2 text-2xs transition-colors duration-(--dur-instant) ease-out focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
              active
                ? "bg-card font-semibold text-foreground shadow-(--shadow-1)"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon aria-hidden="true" className="size-3.5" />
            <span>{t(theme)}</span>
          </button>
        );
      })}
    </div>
  );
}

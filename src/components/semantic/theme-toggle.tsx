"use client";

import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useLayoutEffect, useState } from "react";

import { THEMES, applyTheme, writeThemeCookie, type ThemePreference } from "@/lib/theme";
import { cn } from "@/lib/utils";

const ICONS = { system: MonitorIcon, light: SunIcon, dark: MoonIcon } as const;

/**
 * Three-segment control: system / light / dark. Writing is optimistic —
 * <html> flips immediately and the mirror cookie is written in the same
 * tick — because a theme switch that waits for a round trip reads as a
 * broken button.
 *
 * The useLayoutEffect re-applies the stored preference on mount. In
 * production the pre-paint script in <head> has already done it; in
 * development React Strict Mode remounts once and resets the
 * attributes <html> got outside JSX, so without this the toggle would
 * appear to lose its setting on every refresh.
 */
export function ThemeToggle({
  value = "system",
  className,
}: {
  value?: ThemePreference;
  className?: string;
}) {
  const t = useTranslations("theme");
  const [current, setCurrent] = useState<ThemePreference>(value);

  useLayoutEffect(() => {
    applyTheme(current);
  }, [current]);

  const choose = (next: ThemePreference) => {
    setCurrent(next);
    writeThemeCookie(next);
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

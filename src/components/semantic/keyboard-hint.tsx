"use client";

import { useTranslations } from "next-intl";
import { useSyncExternalStore } from "react";

import { cn } from "@/lib/utils";

/**
 * Renders a shortcut as real <kbd> keys. The platform is detected once
 * and the modifier is printed the way THAT platform writes it — never
 * "⌘K / Ctrl+K", which forces every reader to parse a keyboard they do
 * not own.
 *
 * useSyncExternalStore keeps the server render ("Ctrl") and the client
 * agreeing without an effect and without a hydration warning.
 *
 * Two words are SEPARATORS, not keys: "then" (a sequence, `G then P`)
 * and "or" (alternatives, `J or K`). Each renders an `aria-hidden` glyph
 * for the eye and a translated sr-only word for the ear — a bare "·" or
 * "/" reads as nothing (or as "slash"), and without the word `J K` and
 * `J or K` would sound identical. One pattern for both, because `then`
 * already had a glyph.
 */
const subscribe = () => () => {};
const isApple = (): boolean =>
  typeof navigator !== "undefined" &&
  /mac|iphone|ipad|ipod/i.test(navigator.userAgent + " " + (navigator.platform ?? ""));

const MOD_KEYS = new Set(["mod", "meta", "cmd", "ctrl", "control"]);

export function KeyboardHint({
  keys,
  className,
}: {
  /** e.g. ["mod", "K"], ["G", "then", "P"] or ["J", "or", "K"] — "then" and "or" render as separators. */
  keys: readonly string[];
  className?: string;
}) {
  const t = useTranslations("shell.shortcuts");
  const apple = useSyncExternalStore(subscribe, isApple, () => false);

  return (
    <span data-slot="keyboard-hint" className={cn("inline-flex items-center gap-1", className)}>
      {keys.map((key, index) => {
        const lower = key.toLowerCase();
        if (lower === "then") {
          return (
            <span key={index} className="text-2xs text-muted-foreground">
              <span aria-hidden="true">{"·"}</span>
              <span className="sr-only">{t("then")}</span>
            </span>
          );
        }
        if (lower === "or") {
          return (
            <span key={index} className="text-2xs text-muted-foreground">
              <span aria-hidden="true">{"/"}</span>
              <span className="sr-only">{t("or")}</span>
            </span>
          );
        }
        const label = MOD_KEYS.has(lower) ? (apple ? "⌘" : "Ctrl") : key;
        return (
          <kbd
            key={index}
            data-slot="kbd"
            className="num-id inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-sm border border-input bg-muted px-1 font-mono text-2xs font-medium text-foreground shadow-[0_1px_0_var(--input)]"
          >
            {label}
          </kbd>
        );
      })}
    </span>
  );
}

"use client";

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
  /** e.g. ["mod", "K"] or ["G", "then", "P"] — "then" renders as a separator. */
  keys: readonly string[];
  className?: string;
}) {
  const apple = useSyncExternalStore(subscribe, isApple, () => false);

  return (
    <span data-slot="keyboard-hint" className={cn("inline-flex items-center gap-1", className)}>
      {keys.map((key, index) => {
        const lower = key.toLowerCase();
        if (lower === "then") {
          return (
            <span key={index} aria-hidden="true" className="text-2xs text-muted-foreground">
              {"·"}
            </span>
          );
        }
        const label = MOD_KEYS.has(lower) ? (apple ? "⌘" : "Ctrl") : key;
        return (
          <kbd
            key={index}
            data-slot="kbd"
            className="num inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-sm border border-input bg-muted px-1 font-mono text-2xs font-medium text-foreground shadow-[0_1px_0_var(--input)]"
          >
            {label}
          </kbd>
        );
      })}
    </span>
  );
}

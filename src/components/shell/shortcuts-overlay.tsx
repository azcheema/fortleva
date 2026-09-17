"use client";

import { useTranslations } from "next-intl";
import { useSyncExternalStore } from "react";

import type { NavEntry } from "@/app/(tenant)/(authed)/nav";
import { KeyboardHint } from "@/components/semantic/keyboard-hint";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useFocusReturn } from "@/components/ui/use-focus-return";
import { overlaySections } from "@/lib/keymap";

import { flatNav } from "./command-palette";
import { emptyScopes, scopeSnapshot, subscribeScopes, useScopeKeys } from "./use-hotkeys";

function Row({ keys, label }: { keys: readonly string[]; label: string }) {
  return (
    <li className="flex items-center justify-between gap-4 py-1.5">
      <span className="text-sm">{label}</span>
      <KeyboardHint keys={keys} />
    </li>
  );
}

/**
 * `?` overlay (UI.md §3.2/§6): the keymap filtered to the current scope.
 *
 * It is now a PROJECTION of the live registry rather than a hand-kept
 * table — which is what closes the rule-7 gap it used to embody. The old
 * version listed three keys and omitted three that actually shipped
 * (the board's `C` and `S`, the global `T`), because every new key had
 * to be remembered here by hand. A key that registers a binding now
 * appears automatically, and one that is disabled for this member
 * disappears just as automatically, because `overlaySections` reads the
 * same snapshot the dispatcher acts on.
 *
 * Only two rows stay literal, because the mechanisms behind them are
 * literal: ⌘K is answered before any scope is consulted (so it works
 * inside inputs), and `Esc` belongs to Radix's dismissable layers and is
 * deliberately never a registry binding. They get their OWN heading —
 * they are not the `global` scope, and heading both "Global" put the
 * same word on two different sections.
 *
 * Nothing opens it from a `DialogTrigger` (`?`, or the palette's
 * "Keyboard shortcuts" row — which is offered even when the palette was
 * opened from inside a picker), so it returns focus through
 * `useFocusReturn`: without it, closing the overlay over an open picker
 * left focus on <body> and every single key acted behind the picker.
 */
export function ShortcutsOverlay({
  open,
  onOpenChange,
  nav,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  nav: readonly NavEntry[];
}) {
  const t = useTranslations("shell.shortcuts");
  const tNav = useTranslations("nav");
  const goEntries = flatNav(nav).filter((e) => e.goKey);
  const sections = overlaySections(
    useSyncExternalStore(subscribeScopes, scopeSnapshot, emptyScopes),
  );
  const focusReturn = useFocusReturn();

  // While the overlay is open it OWNS the keyboard: `?` closes it, and
  // nothing beneath it fires. Both halves are needed — its DialogContent
  // is deliberately not in `SUPPRESS_SELECTOR` (that list is for menus
  // and pickers; the item peek is a dialog and must keep its keys), so
  // without `exclusive` a `c` or a `t` would still act behind the scrim.
  // `overlaySections` skips `modal` scopes, so this registration can
  // never blank out the sections it was opened to show.
  //
  // `exclusive` FOLLOWS `open`, and that is not a tidiness choice: an
  // exclusive scope stops the dispatcher's walk whether or not it binds
  // anything, so a permanently-exclusive scope with an empty list would
  // silently kill every key in the application — `modal` sits at the
  // top of SCOPE_ORDER, so it is the first thing the walk meets.
  useScopeKeys(
    "modal",
    open
      ? [
          {
            key: "?",
            label: t("overlay"),
            enabled: true,
            run: () => onOpenChange(false),
            palette: false,
          },
        ]
      : [],
    { exclusive: open },
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" {...focusReturn}>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <section>
          <h3 className="eyebrow text-muted-foreground">{t("always")}</h3>
          <ul className="mt-1 divide-y divide-border">
            <Row keys={["mod", "K"]} label={t("palette")} />
            <Row keys={["Esc"]} label={t("close")} />
          </ul>
        </section>
        {goEntries.length > 0 ? (
          <section>
            <h3 className="eyebrow text-muted-foreground">{t("navigation")}</h3>
            <ul className="mt-1 divide-y divide-border">
              {goEntries.map((e) => (
                <Row key={e.id} keys={["G", "then", e.goKey!]} label={tNav(e.labelKey)} />
              ))}
            </ul>
          </section>
        ) : null}
        {sections.map((section) => (
          <section key={section.scope}>
            <h3 className="eyebrow text-muted-foreground">{t(`scopes.${section.scope}`)}</h3>
            <ul className="mt-1 divide-y divide-border">
              {section.bindings.map((b) => (
                // The label arrives ALREADY TRANSLATED from the
                // registrant: the registry has no locale, and a state
                // name is tenant text that must never round-trip
                // through next-intl.
                <Row
                  key={`${b.entry}:${b.index}`}
                  keys={b.hint ?? [b.key.toUpperCase()]}
                  label={b.label}
                />
              ))}
            </ul>
          </section>
        ))}
      </DialogContent>
    </Dialog>
  );
}

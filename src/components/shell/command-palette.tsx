"use client";

import { KeyboardIcon, LanguagesIcon, LogOutIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useTransition } from "react";

import type { NavEntry } from "@/app/(tenant)/(authed)/nav";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { LOCALES } from "@/i18n/config";

import { NavIcon } from "./nav-icon";

/** Flatten the visible nav (parents with children contribute their children). */
export const flatNav = (entries: readonly NavEntry[]): NavEntry[] =>
  entries.flatMap((e) => (e.children ? flatNav(e.children) : [e]));

/**
 * ⌘K palette (UI.md §3.2, rule 7): every action reachable from here.
 * Phase 1b rows: navigation, switch language, keyboard shortcuts, sign
 * out. Entity search arrives with the search module.
 */
export function CommandPalette({
  open,
  onOpenChange,
  nav,
  onSignOut,
  onSwitchLocale,
  onShowShortcuts,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  nav: readonly NavEntry[];
  onSignOut: () => void;
  onSwitchLocale: (locale: string) => void;
  onShowShortcuts: () => void;
}) {
  const t = useTranslations("shell.palette");
  const tNav = useTranslations("nav");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();
  const [, startTransition] = useTransition();

  const run = (fn: () => void) => {
    onOpenChange(false);
    fn();
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("title")}
      description={t("description")}
    >
      <CommandInput placeholder={t("placeholder")} autoFocus />
      <CommandList>
        <CommandEmpty>{t("empty")}</CommandEmpty>
        <CommandGroup heading={t("navigate")}>
          {flatNav(nav).map((entry) => {
            const goLabel = entry.goKey ? `G ${entry.goKey}` : null;
            return (
            <CommandItem
              key={entry.id}
              value={`${tNav(entry.labelKey)} ${entry.href}`}
              onSelect={() => run(() => startTransition(() => router.push(entry.href)))}
            >
              <NavIcon name={entry.icon} />
              <span>{tNav(entry.labelKey)}</span>
              {goLabel ? <CommandShortcut>{goLabel}</CommandShortcut> : null}
            </CommandItem>
            );
          })}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading={t("actions")}>
          {LOCALES.filter((l) => l !== locale).map((l) => (
            <CommandItem
              key={l}
              value={`${t("switchLanguage")} ${tCommon(`languageName.${l}`)}`}
              onSelect={() => run(() => onSwitchLocale(l))}
            >
              <LanguagesIcon />
              <span>
                {t("switchLanguage")}
                {": "}
                {tCommon(`languageName.${l}`)}
              </span>
            </CommandItem>
          ))}
          <CommandItem value={t("shortcuts")} onSelect={() => run(onShowShortcuts)}>
            <KeyboardIcon />
            <span>{t("shortcuts")}</span>
            <CommandShortcut>{"?"}</CommandShortcut>
          </CommandItem>
          <CommandItem value={t("signOut")} onSelect={() => run(onSignOut)}>
            <LogOutIcon />
            <span>{t("signOut")}</span>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

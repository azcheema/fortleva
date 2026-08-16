"use client";

import { useTranslations } from "next-intl";

import type { NavEntry } from "@/app/(tenant)/(authed)/nav";
import { KeyboardHint } from "@/components/semantic/keyboard-hint";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import { flatNav } from "./command-palette";

function Row({ keys, label }: { keys: readonly string[]; label: string }) {
  return (
    <li className="flex items-center justify-between gap-4 py-1.5">
      <span className="text-sm">{label}</span>
      <KeyboardHint keys={keys} />
    </li>
  );
}

/**
 * `?` overlay (UI.md §3.2/§6): the keymap filtered to the current
 * scope. Phase 1b has only the global scope; the go-to rows are derived
 * from the same nav registry the rail uses, so a new module entry with
 * a `goKey` appears here automatically.
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <section>
          <h3 className="eyebrow text-muted-foreground">
            {t("global")}
          </h3>
          <ul className="mt-1 divide-y divide-border">
            <Row keys={["mod", "K"]} label={t("palette")} />
            <Row keys={["?"]} label={t("overlay")} />
            <Row keys={["Esc"]} label={t("close")} />
          </ul>
        </section>
        {goEntries.length > 0 ? (
          <section>
            <h3 className="eyebrow text-muted-foreground">
              {t("navigation")}
            </h3>
            <ul className="mt-1 divide-y divide-border">
              {goEntries.map((e) => (
                <Row key={e.id} keys={["G", "then", e.goKey!]} label={tNav(e.labelKey)} />
              ))}
            </ul>
          </section>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

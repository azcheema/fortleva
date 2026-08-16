"use client";

import { useTranslations } from "next-intl";

import type { NavEntry } from "@/app/(tenant)/(authed)/nav";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import { flatNav } from "./command-palette";
import { isApplePlatform } from "./use-hotkeys";

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-border bg-muted px-1.5 font-mono text-[11px] text-foreground">
      {children}
    </kbd>
  );
}

function Row({ keys, label, join }: { keys: readonly string[]; label: string; join?: string }) {
  return (
    <li className="flex items-center justify-between gap-4 py-1.5">
      <span className="text-sm">{label}</span>
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        {keys.map((k, i) => (
          <span key={`${k}-${i}`} className="flex items-center gap-1">
            {i > 0 && join ? <span>{join}</span> : null}
            <Kbd>{k}</Kbd>
          </span>
        ))}
      </span>
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
  const mod = isApplePlatform() ? "⌘" : "Ctrl";
  const goEntries = flatNav(nav).filter((e) => e.goKey);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <section>
          <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {t("global")}
          </h3>
          <ul className="mt-1 divide-y divide-border">
            <Row keys={[mod, "K"]} label={t("palette")} join="+" />
            <Row keys={["?"]} label={t("overlay")} />
            <Row keys={["Esc"]} label={t("close")} />
          </ul>
        </section>
        {goEntries.length > 0 ? (
          <section>
            <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              {t("navigation")}
            </h3>
            <ul className="mt-1 divide-y divide-border">
              {goEntries.map((e) => (
                <Row key={e.id} keys={["G", e.goKey!]} label={tNav(e.labelKey)} join={t("then")} />
              ))}
            </ul>
          </section>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

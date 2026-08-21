"use client";

import { ArrowDownToLineIcon, ArrowUpToLineIcon } from "lucide-react";
import { useTranslations } from "next-intl";

import { StatusIcon } from "@/components/semantic";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { STATUS_MAP, type StatusValue } from "@/lib/enum-map";

import type { BoardState } from "./board-model";

/**
 * "Move to…" — the keyboard and mobile twin of the drag (UI.md §7.1,
 * §5.2 `S`): a type-ahead picker of state + position ("Top of To do",
 * "Bottom of Done"). Enter/click commits; Esc closes without change. It
 * is the same control from the card's menu, the `S` key on a focused
 * card and a phone tap — one path, the drag is the shortcut.
 */
export type MoveChoice = { stateId: string; edge: "top" | "bottom" };

export function MovePicker({
  open,
  onOpenChange,
  itemKey,
  states,
  currentStateId,
  onChoose,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Human key of the item being moved (ACME-12). */
  itemKey: string;
  states: readonly BoardState[];
  currentStateId: string;
  onChoose: (choice: MoveChoice) => void;
}) {
  const t = useTranslations("projects.board.movePicker");
  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("title", { key: itemKey })}
      description={t("search")}
    >
      <Command>
        <CommandInput placeholder={t("search")} />
        <CommandList>
          <CommandEmpty>{t("empty")}</CommandEmpty>
          {states.map((state) => {
            const spec = STATUS_MAP.stateCategory[state.category as StatusValue<"stateCategory">];
            const isCurrent = state.id === currentStateId;
            return (
              <CommandGroup
                key={state.id}
                heading={
                  <span className="inline-flex items-center gap-1.5">
                    <StatusIcon name={spec.icon} className="size-3 shrink-0" aria-hidden="true" />
                    {state.name}
                  </span>
                }
              >
                <CommandItem
                  value={`${state.name} ${t("top", { state: state.name })}`}
                  data-testid={`move-top-${state.category}`}
                  data-current={isCurrent ? "true" : undefined}
                  onSelect={() => {
                    onChoose({ stateId: state.id, edge: "top" });
                    onOpenChange(false);
                  }}
                >
                  <ArrowUpToLineIcon aria-hidden="true" />
                  <span>{t("top", { state: state.name })}</span>
                </CommandItem>
                <CommandItem
                  value={`${state.name} ${t("bottom", { state: state.name })}`}
                  data-testid={`move-bottom-${state.category}`}
                  data-current={isCurrent ? "true" : undefined}
                  onSelect={() => {
                    onChoose({ stateId: state.id, edge: "bottom" });
                    onOpenChange(false);
                  }}
                >
                  <ArrowDownToLineIcon aria-hidden="true" />
                  <span>{t("bottom", { state: state.name })}</span>
                </CommandItem>
              </CommandGroup>
            );
          })}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}

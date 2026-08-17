"use client";

import { MoreHorizontalIcon, type LucideProps } from "lucide-react";
import { useRef, useState, useTransition } from "react";

import { InlineConfirm } from "@/components/inline-confirm";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  hasEnabledAction,
  rowActionFormData,
  rowActionNeedsConfirm,
  rowActionVariant,
  type RowActionSpec,
} from "@/lib/row-actions";
import { cn } from "@/lib/utils";

/**
 * THE ROW'S ACTIONS (FOUNDER MANDATE 2; UI.md §5.9, §9).
 *
 * A solid `--destructive` button repeated on every row of every table
 * is the highest-chroma object on most pages of this product, and it
 * outranks the row it is meant to serve. The weight moves into a menu:
 * the row keeps at most one quiet 28px ghost icon for its everyday verb
 * (download, open) plus a `⋯` trigger, and destructive items are danger
 * TEXT inside the menu — never a fill.
 *
 * The single solid `--destructive` fill left in the product's resting
 * UI is the "Yes" of the confirmation, which replaces the trailing slot
 * in place (§5.9) rather than opening a modal. `tone: "danger"` cannot
 * be expressed without a `confirm` question: the type refuses it.
 *
 * Everything is reachable by keyboard alone — Radix gives the menu
 * roving focus, type-ahead, Esc and `aria-haspopup`; the trigger is a
 * real button in tab order whose accessible name names the ROW, not
 * merely "Actions".
 */

export type RowAction = RowActionSpec & {
  icon?: React.ComponentType<LucideProps>;
};

export type RowActionsProps = {
  /** Trigger's accessible name, e.g. t("common.actionsFor", {name}). */
  label: string;
  /**
   * At most ONE ghost `size="icon-sm"` icon button — the row's everyday
   * verb. Pass the whole node (a `<form action={…}>` for a server
   * action that redirects, such as download).
   */
  primary?: React.ReactNode;
  items: readonly RowAction[];
  className?: string;
};

export function RowActions({ label, primary, items, className }: RowActionsProps) {
  const [askingKey, setAskingKey] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const returnFocus = useRef(false);

  const setTrigger = (el: HTMLButtonElement | null) => {
    if (el && returnFocus.current) {
      returnFocus.current = false;
      el.focus();
    }
  };

  const run = (item: RowAction) => {
    item.onSelect?.();
    const action = item.formAction;
    if (!action) return;
    const fd = rowActionFormData(item.hidden);
    startTransition(async () => {
      await action(fd);
    });
  };

  const asking = items.find((item) => item.key === askingKey) ?? null;

  if (asking) {
    return (
      <div
        data-slot="row-actions"
        data-asking={asking.key}
        className={cn("flex items-center justify-end gap-1", className)}
      >
        <InlineConfirm
          trigger="none"
          asking
          onAskingChange={(open) => {
            if (open) return;
            returnFocus.current = true;
            setAskingKey(null);
          }}
          tone={asking.tone === "danger" ? "danger" : "neutral"}
          label={asking.label}
          question={asking.confirm ?? asking.label}
          pending={pending}
          onConfirm={() => {
            returnFocus.current = true;
            setAskingKey(null);
            run(asking);
          }}
        />
      </div>
    );
  }

  return (
    <div
      data-slot="row-actions"
      className={cn("flex items-center justify-end gap-1", className)}
    >
      {primary}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            ref={setTrigger}
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            disabled={!hasEnabledAction(items) || pending}
          >
            <MoreHorizontalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <DropdownMenuItem
                key={item.key}
                variant={rowActionVariant(item)}
                disabled={item.disabled}
                className={item.disabled && item.disabledReason ? "h-auto py-1" : undefined}
                onSelect={() => {
                  if (rowActionNeedsConfirm(item)) {
                    setAskingKey(item.key);
                    return;
                  }
                  run(item);
                }}
              >
                {Icon ? <Icon aria-hidden="true" /> : null}
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{item.label}</span>
                  {item.disabled && item.disabledReason ? (
                    <span className="truncate text-2xs text-muted-foreground">
                      {item.disabledReason}
                    </span>
                  ) : null}
                </span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

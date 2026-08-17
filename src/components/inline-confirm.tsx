"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { Pending } from "@/components/semantic/field";
import { Button } from "@/components/ui/button";

/**
 * Inline confirm (UI.md §5.9): the button becomes "Question? Yes / No"
 * in place — no modal. Esc or focus leaving the group cancels.
 * `onConfirm` runs the (server) action; `pending` disables while it runs.
 *
 * RESTING WEIGHT AND CONFIRM WEIGHT ARE SEPARATE. `variant` styles the
 * button at rest and defaults to `outline`; `tone` decides the weight of
 * "Yes". A destructive action therefore sits quietly in the page — as an
 * outline button or, in a table row, as a `<RowActions>` menu item — and
 * spends the product's only solid `--destructive` fill on the moment the
 * question is actually asked.
 *
 * `asking` / `onAskingChange` make it controllable, and `trigger="none"`
 * renders only the asking UI, so `<RowActions>` can drive the question
 * from a menu selection while the confirmation still appears in the row.
 */
export function InlineConfirm({
  label,
  question,
  onConfirm,
  pending = false,
  variant = "outline",
  size = "sm",
  disabled,
  asking: askingProp,
  onAskingChange,
  trigger = "button",
  tone,
}: {
  label: React.ReactNode;
  question: string;
  onConfirm: () => void;
  pending?: boolean;
  variant?: "outline" | "destructive" | "ghost" | "default" | "secondary";
  size?: "xs" | "sm" | "default";
  disabled?: boolean;
  /** Controlled: when given, the parent drives the state. */
  asking?: boolean;
  onAskingChange?: (asking: boolean) => void;
  /** "none" renders only the asking UI — the parent owns the trigger. */
  trigger?: "button" | "none";
  /** The weight of "Yes". Defaults from `variant` so old call sites are unchanged. */
  tone?: "neutral" | "danger";
}) {
  const t = useTranslations("common");
  const [uncontrolled, setUncontrolled] = useState(false);
  const yesRef = useRef<HTMLButtonElement>(null);

  const asking = askingProp ?? uncontrolled;
  const setAsking = (next: boolean) => {
    if (askingProp === undefined) setUncontrolled(next);
    onAskingChange?.(next);
  };
  const resolvedTone = tone ?? (variant === "destructive" ? "danger" : "neutral");

  useEffect(() => {
    if (asking) yesRef.current?.focus();
  }, [asking]);

  if (!asking) {
    if (trigger === "none") return null;
    return (
      <Button type="button" variant={variant} size={size} disabled={disabled || pending} onClick={() => setAsking(true)}>
        {pending ? <Pending label={t("loading")} /> : label}
      </Button>
    );
  }
  return (
    <span
      role="group"
      className="inline-flex items-center gap-1 text-xs"
      onKeyDown={(e) => {
        if (e.key === "Escape") setAsking(false);
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setAsking(false);
      }}
    >
      <span className="text-muted-foreground">{question}</span>
      <Button
        ref={yesRef}
        type="button"
        variant={resolvedTone === "danger" ? "destructive" : "default"}
        size="sm"
        disabled={pending}
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
      >
        {pending ? <Pending label={t("loading")} /> : t("yes")}
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={() => setAsking(false)}>
        {t("no")}
      </Button>
    </span>
  );
}

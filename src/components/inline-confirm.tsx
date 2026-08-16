"use client";

import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";

/**
 * Inline confirm (UI.md §5.9): the button becomes "Question? Yes / No"
 * in place — no modal. Esc or focus leaving the group cancels. `onConfirm`
 * runs the (server) action; `pending` disables while it runs.
 */
export function InlineConfirm({
  label,
  question,
  onConfirm,
  pending = false,
  variant = "outline",
  size = "xs",
  disabled,
}: {
  label: React.ReactNode;
  question: string;
  onConfirm: () => void;
  pending?: boolean;
  variant?: "outline" | "destructive" | "ghost" | "default" | "secondary";
  size?: "xs" | "sm" | "default";
  disabled?: boolean;
}) {
  const t = useTranslations("common");
  const [asking, setAsking] = useState(false);
  const yesRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (asking) yesRef.current?.focus();
  }, [asking]);

  if (!asking) {
    return (
      <Button type="button" variant={variant} size={size} disabled={disabled || pending} onClick={() => setAsking(true)}>
        {pending ? "…" : label}
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
        variant={variant === "destructive" ? "destructive" : "default"}
        size="xs"
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
      >
        {t("yes")}
      </Button>
      <Button type="button" variant="ghost" size="xs" onClick={() => setAsking(false)}>
        {t("no")}
      </Button>
    </span>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";

export type AutoFormResult = { ok: boolean; message: string };

const isTextField = (el: Element): el is HTMLInputElement | HTMLTextAreaElement =>
  (el instanceof HTMLInputElement &&
    !["checkbox", "radio", "hidden", "submit", "button", "file"].includes(el.type)) ||
  el instanceof HTMLTextAreaElement;

/**
 * No-Save-button form (UI.md §5.10, rule 3): every field commits on
 * blur (text) or change (select/checkbox); Enter commits a text input,
 * ⌘/Ctrl+Enter a textarea. The whole FormData is posted — the server
 * action writes only what changed and returns {ok, message}; errors
 * toast, success shows a quiet "Saved" tick and refreshes the route.
 */
export function AutoForm({
  action,
  children,
  className,
  onSaved,
}: {
  action: (formData: FormData) => Promise<AutoFormResult>;
  children: React.ReactNode;
  className?: string;
  onSaved?: (result: AutoFormResult) => void;
}) {
  const t = useTranslations("common");
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const focusValues = useRef(new Map<string, string>());
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);

  const submit = useCallback(() => {
    const form = formRef.current;
    if (!form) return;
    const fd = new FormData(form);
    // Snapshot so a blur right after Enter does not re-post the same value.
    for (const el of Array.from(form.elements)) {
      if (isTextField(el) && el.name) focusValues.current.set(el.name, el.value);
    }
    startTransition(async () => {
      const result = await action(fd);
      if (!result.ok) {
        toast.error(result.message);
        setSaved(false);
        return;
      }
      setSaved(true);
      onSaved?.(result);
      router.refresh();
    });
  }, [action, onSaved, router]);

  return (
    <form
      ref={formRef}
      className={cn("relative", className)}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onFocusCapture={(e) => {
        const el = e.target;
        if (isTextField(el) && el.name) focusValues.current.set(el.name, el.value);
      }}
      onBlurCapture={(e) => {
        const el = e.target;
        if (isTextField(el) && el.name && focusValues.current.get(el.name) !== el.value) submit();
      }}
      onChangeCapture={(e) => {
        const el = e.target as Element;
        if (el instanceof HTMLSelectElement || (el instanceof HTMLInputElement && el.type === "checkbox")) submit();
      }}
      onKeyDownCapture={(e) => {
        const el = e.target as Element;
        if (e.key !== "Enter") return;
        if (el instanceof HTMLTextAreaElement) {
          if (e.metaKey || e.ctrlKey) {
            e.preventDefault();
            el.blur();
          }
          return;
        }
        if (el instanceof HTMLInputElement && isTextField(el)) {
          e.preventDefault();
          el.blur();
        }
      }}
      aria-busy={pending || undefined}
    >
      {children}
      <span aria-live="polite" className="pointer-events-none absolute top-0 right-0 text-xs text-muted-foreground">
        {pending ? "…" : saved ? t("saved") : null}
      </span>
    </form>
  );
}

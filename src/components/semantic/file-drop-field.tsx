"use client";

import { UploadIcon, XIcon } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import { Field } from "@/components/semantic/field";
import { Button, buttonVariants } from "@/components/ui/button";
import { describeChosenFile, type ChosenFile } from "@/lib/file-field";
import { cn } from "@/lib/utils";

/**
 * THE FILE FIELD (FOUNDER MANDATE 3).
 *
 * `<input type="file">` renders an OS widget — "Choose File / No file
 * chosen" — that no design system can restyle; in dark it is the
 * brightest object on the page and the only control in the product
 * outside the system. It is hidden here with `sr-only`, NEVER `hidden`
 * or `display:none`, so it keeps its place in the tab order and in the
 * accessibility tree, and the dashed region becomes the affordance.
 *
 * Construction detail that matters: the region is a `<label htmlFor>`
 * and the "Choose file" affordance inside it is a `<span>` wearing
 * `buttonVariants()`, not a `<button>` — a nested button swallows the
 * label's click and does nothing. The label shows the sr-only input's
 * focus ring through `has-[input:focus-visible]`, so a keyboard user
 * sees where they are; Space or Enter then opens the OS picker natively.
 */
export type FileDropFieldProps = {
  id: string;
  name: string;
  /** From t(). Names the field and the hidden input. */
  label: string;
  /** "Drop a file here, or choose one". */
  hint: string;
  /** Shown while a file is over the target; defaults to `hint`. */
  draggingHint?: string;
  /** "Choose file". */
  chooseLabel: string;
  chosen: ChosenFile | null;
  onChange: (files: FileList | null) => void;
  inputRef: React.Ref<HTMLInputElement>;
  /** Clears the picker; the field resets the input element itself. */
  onClear?: () => void;
  accept?: string;
  disabled?: boolean;
  required?: boolean;
  /** Field-level failure, announced. */
  error?: string;
  /** The labelled phase bar; the caller owns the phases. */
  progress?: { value: number; max: number; label: string; valueText?: string };
  className?: string;
};

/**
 * The input is found through the DOM, not through `inputRef`: the React
 * Compiler forbids mutating anything reachable from a prop, and both a
 * drop and a clear must write to the element (`.files`, `.value`). The
 * ref stays a pure forward, so the call site keeps its handle for submit.
 */
const inputIn = (node: Element | null): HTMLInputElement | null =>
  node?.closest("[data-slot=file-drop]")?.querySelector<HTMLInputElement>('input[type="file"]') ??
  null;

export function FileDropField({
  id,
  name,
  label,
  hint,
  draggingHint,
  chooseLabel,
  chosen,
  onChange,
  inputRef,
  onClear,
  accept,
  disabled = false,
  required = false,
  error,
  progress,
  className,
}: FileDropFieldProps) {
  const t = useTranslations("common");
  const locale = useLocale();
  const [dragging, setDragging] = useState(false);

  const clear = (e: React.MouseEvent<HTMLButtonElement>) => {
    // Inside the <label>: without this the click re-opens the picker.
    e.preventDefault();
    e.stopPropagation();
    const el = inputIn(e.currentTarget);
    if (el) el.value = "";
    onChange(null);
    onClear?.();
  };

  return (
    <Field label={label} htmlFor={id} required={required} className={className}>
      <div className="flex flex-col gap-2">
        <label
          htmlFor={id}
          data-slot="file-drop"
          data-dragging={dragging || undefined}
          onDragOver={(e) => {
            if (disabled) return;
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={(e) => {
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
            setDragging(false);
          }}
          onDrop={(e) => {
            if (disabled) return;
            e.preventDefault();
            setDragging(false);
            const el = inputIn(e.currentTarget);
            if (!el || e.dataTransfer.files.length === 0) return;
            el.files = e.dataTransfer.files;
            onChange(el.files);
          }}
          className={cn(
            "flex flex-col items-start gap-3 rounded-card border border-dashed border-input p-4 transition-[background-color,border-color] duration-(--dur-instant) ease-out",
            "has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-ring",
            disabled ? "cursor-not-allowed bg-bg-disabled text-fg-disabled" : "cursor-pointer",
            dragging && "border-solid border-foreground bg-accent",
          )}
        >
          <span className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
            <UploadIcon aria-hidden="true" className="size-4 shrink-0" />
            {chosen && !dragging ? (
              <span className="num min-w-0 truncate text-xs" title={chosen.name}>
                {describeChosenFile(locale, chosen)}
              </span>
            ) : (
              <span className="min-w-0">{dragging ? (draggingHint ?? hint) : hint}</span>
            )}
            {chosen && !dragging ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={t("file.clear", { name: chosen.name })}
                onClick={clear}
                disabled={disabled}
              >
                <XIcon />
              </Button>
            ) : null}
          </span>

          {/* sr-only, never hidden: it stays focusable and in the AT tree. */}
          <input
            id={id}
            ref={inputRef}
            type="file"
            name={name}
            accept={accept}
            required={required}
            disabled={disabled}
            aria-label={label}
            aria-invalid={error ? true : undefined}
            className="sr-only"
            onChange={(e) => onChange(e.target.files)}
          />

          {/* A <span>, not a <button>: a nested button swallows the label's click. */}
          <span aria-hidden="true" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
            {chosen ? t("file.replace") : chooseLabel}
          </span>
        </label>

        {progress ? (
          <div
            role="progressbar"
            aria-label={progress.label}
            aria-valuemin={0}
            aria-valuemax={progress.max}
            aria-valuenow={progress.value}
            aria-valuetext={progress.valueText}
            className="h-1 w-full overflow-hidden rounded-full bg-muted"
          >
            <span
              className="block h-full rounded-full bg-(--tone-neutral-line)"
              style={{ inlineSize: `${(progress.value / progress.max) * 100}%` }}
            />
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="text-xs text-(--tone-danger-fg)">
            {error}
          </p>
        ) : null}
      </div>
    </Field>
  );
}

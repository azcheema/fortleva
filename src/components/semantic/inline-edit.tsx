"use client";

import { ChevronDownIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useReducer, useRef } from "react";

import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { VisibilityBadge, type VisibilityValue } from "@/components/visibility-badge";
import {
  inlineEditInitial,
  inlineEditReducer,
  isActivationKey,
  optionLabel,
  returnsFocus,
  selectsOnFocus,
  type InlineEditKind,
  type InlineEditOption,
} from "@/lib/inline-edit";
import { cn } from "@/lib/utils";

/**
 * READ-FIRST EDITABLE VALUE (FOUNDER MANDATE 1; UI.md rule 3, §5.10).
 *
 * A page of labelled properties is content, not a form. So a value
 * renders as TEXT, in a box that is geometrically identical to the
 * control it becomes — same height, same padding, same radius — with a
 * transparent border that only appears on hover. Click, Enter, Space or
 * F2 swaps the text for the real control; Escape restores; blur (or
 * `change`, for a select) commits.
 *
 * It adds NO save path. `<AutoForm>` already posts on exactly those two
 * events, and this component mounts the same `<Input>` / `<Textarea>` /
 * `<NativeSelect>` those handlers already see. What it must therefore
 * guarantee is that the FormData is unchanged when nothing is being
 * edited — several server actions read an absent field as an erase
 * (WORKLIST hazard H1) — so at rest it renders
 * `<input type="hidden" name value>` carrying the same value the real
 * control would have carried. The hidden input and the real control are
 * NEVER mounted together: `FormData.get()` returns the first entry, and
 * a stale hidden value would win.
 *
 * Failure is not silent and not lossy: `invalid` keeps the control open
 * with `aria-invalid` and the user's text intact. Reverting to the
 * server value while the edit is still on screen is the exact bug this
 * product shipped once already.
 */

export type InlineEditProps = {
  kind: InlineEditKind;
  /** MUST equal the field name the server action reads. */
  name: string;
  /** The canonical value from the server render. */
  value: string;
  /** Accessible name, from t(). Required — a nameless control is not one. */
  label: string;
  /** Rest-mode node (a formatted date, a badge). Defaults to the value text. */
  display?: React.ReactNode;
  /** Rest-mode node when the value is empty, e.g. t("addDate"). */
  placeholder: string;
  options?: readonly InlineEditOption[];
  /** Renders `display` only: no affordance, no hidden input, no tab stop. */
  readOnly?: boolean;
  /** "table" = 28px control inside a 36px row; "default" = 32px. */
  density?: "default" | "table";
  align?: "start" | "end";
  /** The last save failed: stay open, mark the control invalid. */
  invalid?: boolean;
  /** False outside an `<AutoForm>` — there is no FormData to preserve. */
  hiddenInput?: boolean;
  /** Extra hook after a commit that changed the value (standalone use). */
  onCommit?: (next: string) => void;
  /** required / maxLength / pattern / inputMode. Applied to `kind` text and date. */
  inputProps?: Omit<React.ComponentProps<"input">, "name" | "defaultValue" | "type" | "ref">;
  /** Classes for the mounted control only (e.g. the warm visibility fill). */
  controlClassName?: string;
  /** data-* the mounted control must emit (e.g. data-visibility). */
  controlData?: Record<`data-${string}`, string>;
  className?: string;
};

/**
 * A server re-render is authoritative, so the local machine is keyed on
 * the value it was seeded from. This is the `reseed` event, expressed
 * as a remount — which also re-seeds the uncontrolled control for free.
 */
export function InlineEdit(props: InlineEditProps) {
  return <InlineEditControl key={props.value} {...props} />;
}

function InlineEditControl({
  kind,
  name,
  value,
  label,
  display,
  placeholder,
  options,
  readOnly = false,
  density = "default",
  align = "start",
  invalid = false,
  hiddenInput = true,
  onCommit,
  inputProps,
  controlClassName,
  controlData,
  className,
}: InlineEditProps) {
  const t = useTranslations("common.inlineEdit");
  const [state, dispatch] = useReducer(inlineEditReducer, value, inlineEditInitial);

  // Refs, not state: none of these three change what is rendered.
  const returnFocus = useRef(false);
  const cancelling = useRef(false);
  const focused = useRef(false);

  const editing = invalid || state.mode === "editing";
  const text = kind === "select" ? optionLabel(options, state.value) : state.value;
  const filled = state.value !== "";

  /**
   * The trigger focuses itself when it comes back after a commit or a
   * cancel — a callback ref rather than an effect, because the node is
   * exactly what we are waiting for.
   */
  const setTrigger = (el: HTMLButtonElement | null) => {
    if (el && returnFocus.current) {
      returnFocus.current = false;
      el.focus();
    }
  };

  const setControl = (el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null) => {
    if (!el || focused.current) return;
    focused.current = true;
    el.focus();
    if (selectsOnFocus(kind) && "select" in el) el.select();
  };

  const leave = () => {
    focused.current = false;
  };

  const commit = (next: string) => {
    leave();
    dispatch({ type: "commit", value: next });
    if (next !== state.value) onCommit?.(next);
  };

  const onControlKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>,
  ) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    // Do not also close a dialog, a menu or the command palette.
    e.stopPropagation();
    const el = e.currentTarget;
    cancelling.current = true;
    returnFocus.current = true;
    // Restore BEFORE blurring: AutoForm compares the value it snapshotted
    // on focus with the value on blur, so an identical value posts nothing.
    el.value = state.value;
    el.blur();
  };

  const onControlBlur = (
    e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>,
  ) => {
    if (returnsFocus(e.relatedTarget)) returnFocus.current = true;
    if (cancelling.current) {
      cancelling.current = false;
      leave();
      dispatch({ type: "cancel" });
      return;
    }
    // A select has already saved on `change`; its blur is not a commit.
    if (kind === "select") {
      leave();
      dispatch({ type: "cancel" });
      return;
    }
    commit(e.currentTarget.value);
  };

  if (readOnly) {
    return (
      <span data-slot="inline-edit-readonly" className={cn("flex min-w-0 items-center", className)}>
        {filled ? (display ?? text) : <span className="text-muted-foreground">{placeholder}</span>}
      </span>
    );
  }

  const box = cn(
    "flex w-full min-w-0 items-center gap-1.5 rounded-md border bg-clip-padding px-2.5 text-sm",
    density === "table" ? "h-7" : "h-8",
    align === "end" && "justify-end text-right",
  );

  const control =
    kind === "multiline" ? (
      <Textarea
        name={name}
        defaultValue={state.value}
        aria-label={label}
        aria-invalid={invalid || undefined}
        ref={setControl}
        onKeyDown={onControlKeyDown}
        onBlur={onControlBlur}
        className={cn("min-h-16", controlClassName)}
        {...controlData}
      />
    ) : kind === "select" ? (
      <NativeSelect
        name={name}
        defaultValue={state.value}
        aria-label={label}
        aria-invalid={invalid || undefined}
        ref={setControl}
        onKeyDown={onControlKeyDown}
        onBlur={onControlBlur}
        onChange={(e) => {
          const next = e.currentTarget.value;
          returnFocus.current = true;
          commit(next);
        }}
        className={cn(density === "table" ? "h-7 w-auto text-xs" : "h-8", controlClassName)}
        {...controlData}
      >
        {(options ?? []).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </NativeSelect>
    ) : (
      <Input
        {...inputProps}
        type={kind === "date" ? "date" : "text"}
        name={name}
        defaultValue={state.value}
        aria-label={label}
        aria-invalid={invalid || undefined}
        ref={setControl}
        onKeyDown={onControlKeyDown}
        onBlur={onControlBlur}
        className={cn(
          density === "table" ? "h-7" : "h-8",
          kind === "date" && "num",
          align === "end" && "text-right",
          inputProps?.className,
          controlClassName,
        )}
        {...controlData}
      />
    );

  return (
    <span
      data-slot="inline-edit-field"
      data-editing={editing || undefined}
      className={cn("flex w-full min-w-0 items-center", className)}
    >
      {/* The mode change is announced; the region is always mounted so
          the first transition is not swallowed. */}
      <span role="status" aria-live="polite" className="sr-only">
        {editing ? t("editing", { label }) : null}
      </span>

      {editing ? (
        control
      ) : (
        <>
          <button
            type="button"
            ref={setTrigger}
            data-slot="inline-edit"
            data-kind={kind}
            data-empty={filled ? undefined : "true"}
            aria-label={filled ? t("trigger", { label, value: text }) : t("triggerEmpty", { label })}
            title={filled ? text : placeholder}
            onClick={() => dispatch({ type: "activate" })}
            onKeyDown={(e) => {
              if (!isActivationKey(e.key)) return;
              e.preventDefault();
              dispatch({ type: "activate" });
            }}
            className={cn(
              "group/inline-edit border-transparent bg-transparent text-left text-foreground transition-[background-color,border-color] duration-(--dur-instant) ease-out hover:border-input hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
              box,
            )}
          >
            <span className={cn("min-w-0 truncate", !filled && "text-muted-foreground")}>
              {filled ? (display ?? text) : placeholder}
            </span>
            {kind === "select" ? (
              <ChevronDownIcon
                aria-hidden="true"
                className="invisible ml-auto size-3 shrink-0 text-muted-foreground group-hover/inline-edit:visible group-focus-visible/inline-edit:visible"
              />
            ) : null}
          </button>
          {hiddenInput ? <input type="hidden" name={name} value={state.value} readOnly /> : null}
        </>
      )}
    </span>
  );
}

const VISIBILITY_WARM =
  "border-vis-client-border bg-vis-client font-semibold text-vis-client-fg";

/**
 * SAFETY-CRITICAL (UI.md §10.4). The resting state of an editable
 * visibility IS the `<VisibilityBadge>`, so it carries all five
 * channels — fill, icon, shape, weight, border — that a 28px filled
 * `<select>` drops two of. The picker wears the same warm fill while
 * it is set to CLIENT_VISIBLE, so an editable row is never less
 * legible than a read-only one, and `data-visibility` is emitted by the
 * badge at rest and by the select while it is mounted.
 */
export function VisibilityInlineEdit({
  value,
  name = "visibility",
  density = "table",
  readOnly,
  hiddenInput,
  invalid,
  onCommit,
  className,
}: {
  value: VisibilityValue;
  name?: string;
  density?: "default" | "table";
  readOnly?: boolean;
  hiddenInput?: boolean;
  invalid?: boolean;
  onCommit?: (next: VisibilityValue) => void;
  className?: string;
}) {
  const t = useTranslations("visibility");
  const options: InlineEditOption[] = [
    { value: "INTERNAL", label: t("internal") },
    { value: "CLIENT_VISIBLE", label: t("clientVisible") },
  ];

  return (
    <InlineEdit
      kind="select"
      name={name}
      value={value}
      label={t("label")}
      display={<VisibilityBadge value={value} />}
      placeholder={t("internal")}
      options={options}
      readOnly={readOnly}
      density={density}
      hiddenInput={hiddenInput}
      invalid={invalid}
      onCommit={(next) => onCommit?.(next === "CLIENT_VISIBLE" ? "CLIENT_VISIBLE" : "INTERNAL")}
      controlClassName={value === "CLIENT_VISIBLE" ? VISIBILITY_WARM : undefined}
      controlData={{ "data-visibility": value }}
      className={className}
    />
  );
}

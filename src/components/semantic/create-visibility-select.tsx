"use client";

import { useTranslations } from "next-intl";

import { NativeSelect } from "@/components/ui/native-select";
import { cn } from "@/lib/utils";

import { VISIBILITY_VALUES, visibilityLabelKey, type VisibilityValue } from "../visibility-badge";

/**
 * WHO WILL SEE A TASK BEFORE IT EXISTS — the create fields' visibility
 * control (Phase 3 slice 73; UI.md rule 10, §5.4, §10.4; founder
 * decisions (8), C38, C39). Quick create, the backlog's create row, the
 * board column's "+" and the Subtasks add row all draw THIS, beside the
 * one required field; it never stops anyone to ask, and "Private to team"
 * is where a top-level task starts.
 *
 * A NATIVE `<select>`, deliberately, and not the comment composer's
 * `role="radio"` buttons:
 *   · `isEditableTarget` (keymap.ts) counts a SELECT, so no single-key
 *     shortcut of the app acts while it holds focus — on a focused button
 *     `T` stops the running timer, `G …` navigates away with the typed
 *     title, and in the peek `V`/`S`/`A`/… act on the PARENT. The keys
 *     are not inert, though: they go to the select's own type-ahead and
 *     arrows (`c`, Swedish `k`, ArrowDown all pick "Client can see") —
 *     which is exactly why THIS CONTROL OWNS NO SUBMIT KEY. Only the title
 *     field creates; a stray letter followed by Enter here opens the list
 *     (Windows, Linux) or does nothing, and never publishes a task nobody
 *     decided to share (design review, 2026-09-28).
 *   · WebKit focuses a select on click (not a button, checkbox or radio),
 *     so the composer's group-level blur check sees focus stay inside —
 *     and when iOS blurs it to `<body>` as its picker closes, the group
 *     treats that as staying (`createGroupBlur`), not as leaving.
 *   · It is the kind of control §10.4 lists for writing visibility (a
 *     select in the warm fill — `VisibilitySelect`, the upload form; §10.4
 *     now names this one too).
 *
 * It wears the read chip's warm fill while it says "Client can see"
 * (§10.4: the write control is never less legible than the read chip —
 * the choice is legible BEFORE Enter, not only after the row renders)
 * and only ever the two tokens (§5.5: never a third wording).
 */
export function CreateVisibilitySelect({
  value,
  onChange,
  testId,
  describedBy,
  density,
  className,
}: {
  value: VisibilityValue;
  onChange: (next: VisibilityValue) => void;
  testId: string;
  /** The id of the sentence that says who will see it — the title field names it too. */
  describedBy?: string | undefined;
  /** `row` fits a 32px table row (the backlog's create row); `field` sits beside a default Input. */
  density: "row" | "field";
  className?: string;
}) {
  const t = useTranslations("visibility");
  return (
    <NativeSelect
      value={value}
      onChange={(e) => onChange(e.target.value === "CLIENT_VISIBLE" ? "CLIENT_VISIBLE" : "INTERNAL")}
      aria-label={t("label")}
      aria-describedby={describedBy}
      data-visibility={value}
      data-testid={testId}
      className={cn(
        "w-auto shrink-0",
        density === "row" ? "h-7 py-0 text-xs" : "h-8",
        value === "CLIENT_VISIBLE" && "border-vis-client-border bg-vis-client font-semibold text-vis-client-fg",
        className,
      )}
    >
      {VISIBILITY_VALUES.map((v) => (
        <option key={v} value={v}>
          {t(visibilityLabelKey(v))}
        </option>
      ))}
    </NativeSelect>
  );
}

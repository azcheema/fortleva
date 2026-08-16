import { useTranslations } from "next-intl";

import type { Priority } from "@/lib/enum-map";
import { cn } from "@/lib/utils";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Priority is deliberately NOT hue-coded across levels: a five-step
 * red-to-green ramp is unreadable to 8% of men and, worse, tempts every
 * row to shout. The signal is GEOMETRY — how many bars are lit — and
 * only URGENT adds a hue.
 *
 * NONE      three flat dashes
 * LOW       one bar
 * MEDIUM    two bars
 * HIGH      three bars
 * URGENT    filled block + exclamation, danger tone
 */
const BARS: Record<Priority, number> = { NONE: 0, LOW: 1, MEDIUM: 2, HIGH: 3, URGENT: 3 };

export function PriorityIndicator({
  value,
  showLabel = false,
  className,
}: {
  value: Priority;
  showLabel?: boolean;
  className?: string;
}) {
  const t = useTranslations("states.priority");
  const label = t(value);
  const lit = BARS[value];
  const urgent = value === "URGENT";

  const glyph = (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex h-3 w-3 shrink-0 items-end justify-between gap-px",
        urgent ? "text-(--tone-danger-line)" : "text-muted-foreground",
      )}
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className={cn(
            "w-[3px] rounded-[1px]",
            value === "NONE" ? "h-px bg-current opacity-45" : i < lit ? "bg-current" : "bg-current opacity-25",
            value !== "NONE" && (i === 0 ? "h-1.5" : i === 1 ? "h-2.5" : "h-3"),
          )}
        />
      ))}
    </span>
  );

  const body = (
    <span
      data-slot="priority-indicator"
      data-value={value}
      aria-label={showLabel ? undefined : label}
      role={showLabel ? undefined : "img"}
      className={cn("inline-flex items-center gap-1.5 text-sm", className)}
    >
      {glyph}
      {urgent ? (
        <span aria-hidden="true" className="text-2xs font-semibold text-(--tone-danger-line)">
          {"!"}
        </span>
      ) : null}
      {showLabel ? <span>{label}</span> : null}
    </span>
  );

  if (showLabel) return body;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{body}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

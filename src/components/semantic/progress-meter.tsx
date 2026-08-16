import { cn } from "@/lib/utils";

/**
 * Done-of-total, as a bar plus the count. The bar is aria-hidden
 * decoration: the "3/8" beside it is the accessible value and carries
 * the meaning on its own, so the meter survives greyscale and needs no
 * hue of its own. Complete switches to the success line — a second
 * channel on top of a count that already reads 8/8, never the only one.
 *
 * Figures are tabular so a column of meters keeps its digits on one
 * vertical rail.
 */
export function ProgressMeter({
  value,
  total,
  label,
  className,
}: {
  value: number;
  total: number;
  /** Already formatted by the caller, e.g. t("milestonesProgress", …) — "3/8". */
  label: string;
  className?: string;
}) {
  const ratio = total > 0 ? Math.min(1, Math.max(0, value / total)) : 0;
  const complete = total > 0 && value >= total;

  return (
    <span
      data-slot="progress-meter"
      className={cn("inline-flex items-center justify-end gap-2", className)}
    >
      <span aria-hidden="true" className="h-1 w-14 shrink-0 overflow-hidden rounded-full bg-muted">
        <span
          className={cn(
            "block h-full rounded-full",
            complete ? "bg-(--tone-success-line)" : "bg-(--tone-neutral-line)",
          )}
          style={{ inlineSize: `${Math.round(ratio * 100)}%` }}
        />
      </span>
      <span className="num shrink-0 text-sm">{label}</span>
    </span>
  );
}

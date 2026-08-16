import Link from "next/link";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * One number, said once. Label is an 11px uppercase eyebrow, the value
 * is 24px/600 with tabular figures so a row of tiles has its digits on
 * the same vertical rails, and a delta always carries a sign AND an
 * arrow — never colour alone.
 */
export function MetricTile({
  label,
  value,
  unit,
  delta,
  deltaTone = "neutral",
  href,
  className,
}: {
  label: string;
  value: React.ReactNode;
  unit?: string;
  /** Already formatted and signed by the caller, e.g. "+12%". */
  delta?: string;
  deltaTone?: "up" | "down" | "neutral";
  href?: string;
  className?: string;
}) {
  const body = (
    <>
      <span className="eyebrow text-muted-foreground">
        {label}
      </span>
      <span className="flex items-baseline gap-1.5">
        <span className="num text-2xl font-semibold text-foreground">{value}</span>
        {unit ? <span className="text-sm text-muted-foreground">{unit}</span> : null}
      </span>
      {delta ? (
        <span
          className={cn(
            "num inline-flex items-center gap-1 text-xs",
            deltaTone === "up" && "text-(--tone-success-fg)",
            deltaTone === "down" && "text-(--tone-danger-fg)",
            deltaTone === "neutral" && "text-muted-foreground",
          )}
        >
          {deltaTone === "up" ? (
            <ArrowUpIcon aria-hidden="true" className="size-3" />
          ) : deltaTone === "down" ? (
            <ArrowDownIcon aria-hidden="true" className="size-3" />
          ) : null}
          {delta}
        </span>
      ) : null}
    </>
  );

  const classes = cn(
    "flex flex-col gap-1 rounded-card border border-border bg-card p-4",
    href &&
      "transition-colors duration-(--dur-instant) ease-out hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
    className,
  );

  if (href) {
    return (
      <Link href={href} data-slot="metric-tile" className={classes}>
        {body}
      </Link>
    );
  }
  return (
    <div data-slot="metric-tile" className={classes}>
      {body}
    </div>
  );
}

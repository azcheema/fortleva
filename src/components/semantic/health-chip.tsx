import { useTranslations } from "next-intl";

import { STATUS_MAP, type ProjectHealth } from "@/lib/enum-map";
import { TONE_CHIP } from "@/lib/tones";
import { cn } from "@/lib/utils";

import { StatusIcon } from "./status-icon";

/**
 * Health keeps red/amber/green, because that is how stakeholders read a
 * portfolio — but it never relies on it: each value carries a distinct
 * icon silhouette (tick / triangle / octagon / pause / flag) and ALWAYS
 * renders its text. There is no icon-only mode.
 */
export function HealthChip({ value, className }: { value: ProjectHealth; className?: string }) {
  const t = useTranslations("states.projectHealth");
  const spec = STATUS_MAP.projectHealth[value];

  return (
    <span
      data-slot="health-chip"
      data-value={value}
      className={cn(
        "inline-flex h-5 w-fit shrink-0 items-center gap-1 rounded-full px-2 text-2xs font-medium whitespace-nowrap",
        TONE_CHIP[spec.tone],
        className,
      )}
    >
      <StatusIcon name={spec.icon} className="size-3 shrink-0" />
      <span>{t(value)}</span>
    </span>
  );
}

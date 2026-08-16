import { useTranslations } from "next-intl";

import { STATUS_MAP, type StatusDomain, type StatusSpec, type StatusValue } from "@/lib/enum-map";
import { TONE_CHIP, TONE_OUTLINE } from "@/lib/tones";
import { cn } from "@/lib/utils";

import { StatusIcon } from "./status-icon";

/**
 * The one badge every enum goes through. It replaces the ad-hoc
 * `<Badge variant={x === "ACTIVE" ? … : …}>` sites, so a value can
 * never mean one colour on one screen and another colour on the next.
 *
 * Tone, icon and shape come from src/lib/enum-map.ts; the label comes
 * from t("states.<domain>.<value>") and is never passed in — a caller
 * that could pass its own label could pass a different word for the
 * same state.
 */
export function StatusBadge<D extends StatusDomain>({
  domain,
  value,
  className,
}: {
  domain: D;
  value: StatusValue<D>;
  className?: string;
}) {
  const t = useTranslations("states");
  // One lookup, widened: the generic props already made the caller
  // prove that this domain and this value belong together.
  const table = STATUS_MAP as unknown as Record<string, Record<string, StatusSpec>>;
  const spec = table[domain]![value]!;
  const label = t(`${domain}.${value}` as Parameters<typeof t>[0]);

  return (
    <span
      data-slot="status-badge"
      data-domain={domain}
      data-value={value}
      className={cn(
        "inline-flex h-5 w-fit shrink-0 items-center gap-1 rounded-full border border-transparent px-2 text-2xs whitespace-nowrap",
        spec.shape === "tinted" && TONE_CHIP[spec.tone],
        spec.shape === "outline" && cn("bg-transparent", TONE_OUTLINE[spec.tone]),
        spec.shape === "text" && "border-transparent bg-transparent px-0 text-foreground",
        className,
      )}
    >
      <StatusIcon name={spec.icon} className="size-3 shrink-0" />
      <span>{label}</span>
    </span>
  );
}

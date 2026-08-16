import { EyeIcon, LockIcon } from "lucide-react";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";

export type VisibilityValue = "INTERNAL" | "CLIENT_VISIBLE";

/**
 * SAFETY-CRITICAL (DESIGN SPEC §2.4). The worst bug this product can
 * ship is a client seeing internal data, so the two states are pulled
 * as far apart as the medium allows and differ on FIVE channels at
 * once, not on hue:
 *
 *   fill    transparent            vs  SOLID warm (identical in both themes)
 *   icon    lock, outline          vs  eye, filled
 *   shape   4px radius             vs  full pill
 *   weight  500                    vs  600
 *   border  1px --input (3:1)      vs  1px amber-600
 *
 * Measured separation solid-vs-outline: dE_OK 0.26 normal / 0.25
 * deutan / 0.29 protan / 0.25 tritan (asserted in src/lib/contrast.test.ts).
 * The previous pale-tint pair measured 1.001:1 and is gone.
 *
 * Both states ALWAYS render a chip: absence is not a state, because
 * absence is indistinguishable from a bug. There is no icon-only mode
 * at any density, and the mutation is never optimistic.
 */
export function VisibilityBadge({
  value,
  visibility,
  size = "default",
  className,
}: {
  value?: VisibilityValue;
  /** Legacy prop name kept so existing call sites keep working. */
  visibility?: VisibilityValue;
  size?: "sm" | "default";
  className?: string;
}) {
  const t = useTranslations("visibility");
  const resolved: VisibilityValue = value ?? visibility ?? "INTERNAL";
  const isClientVisible = resolved === "CLIENT_VISIBLE";
  const label = isClientVisible ? t("clientVisible") : t("internal");

  return (
    <span
      data-slot="visibility-badge"
      data-visibility={resolved}
      aria-label={label}
      className={cn(
        "inline-flex w-fit shrink-0 items-center gap-1 border whitespace-nowrap",
        size === "sm" ? "h-4.5 px-1.5 text-2xs" : "h-5 px-2 text-2xs",
        isClientVisible
          ? "rounded-full border-vis-client-border bg-vis-client font-semibold text-vis-client-fg"
          : "rounded-sm border-vis-internal-border bg-transparent font-medium text-vis-internal-fg",
        className,
      )}
    >
      {isClientVisible ? (
        <EyeIcon aria-hidden="true" className="size-3" fill="currentColor" fillOpacity={0.28} />
      ) : (
        <LockIcon aria-hidden="true" className="size-3" />
      )}
      <span>{label}</span>
    </span>
  );
}

/**
 * The row cue that goes WITH the chip, never instead of it: a 2px left
 * border in the client-visible colour on any row or card that a client
 * can see. Apply to the row element, not to a cell.
 *
 * The cue is --vis-client-cue, not --vis-client. The chip's FILL is
 * identical in both themes because that is the pair the CVD gate
 * measures; a 2px EDGE has to clear 3:1 against the surface it is drawn
 * on, and the warm fill measures 2.10:1 on a white row. Light therefore
 * draws the edge in the darker warm and dark keeps the fill; both clear
 * 4:1 on card, canvas, muted and the row-hover surface.
 *
 * Both branches emit the 2px border so the cue costs no layout shift:
 * an internal row reserves the same 2px, transparent.
 */
export const visibilityRowCue = (value: VisibilityValue): string =>
  value === "CLIENT_VISIBLE"
    ? "border-l-2 border-l-vis-client-cue"
    : "border-l-2 border-l-transparent";

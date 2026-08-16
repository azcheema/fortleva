import { InfoIcon, OctagonAlertIcon, CircleCheckIcon, TriangleAlertIcon } from "lucide-react";

import type { Tone } from "@/lib/tones";
import { TONE_BORDER_L, TONE_CALLOUT, TONE_LINE } from "@/lib/tones";
import { cn } from "@/lib/utils";

/**
 * A block-level notice: tinted surface, 1px hairline in the tone, a 2px
 * leading bar and a 16px icon. It replaces the copy-pasted amber
 * hand-rolled amber notice blocks.
 *
 * It is never a filled pill — that shape is reserved product-wide for
 * "Client can see" and must not be borrowed by a warning.
 */
export type CalloutTone = "info" | "caution" | "danger" | "success";

const TONE_OF: Record<CalloutTone, Tone> = {
  info: "brand",
  caution: "caution",
  danger: "danger",
  success: "success",
};

const ICON_OF = {
  info: InfoIcon,
  caution: TriangleAlertIcon,
  danger: OctagonAlertIcon,
  success: CircleCheckIcon,
} as const;

export function Callout({
  tone = "info",
  title,
  role,
  className,
  children,
}: {
  tone?: CalloutTone;
  title?: React.ReactNode;
  /** "alert" for errors, "status" for results; omitted for static prose. */
  role?: "alert" | "status";
  className?: string;
  children?: React.ReactNode;
}) {
  const key = TONE_OF[tone];
  const Icon = ICON_OF[tone];

  return (
    <div
      data-slot="callout"
      data-tone={tone}
      role={role}
      className={cn(
        "flex items-start gap-2.5 rounded-md border border-l-2 p-4 text-sm",
        TONE_CALLOUT[key],
        TONE_BORDER_L[key],
        className,
      )}
    >
      <Icon aria-hidden="true" className={cn("mt-px size-4 shrink-0", TONE_LINE[key])} />
      <div className="min-w-0 flex-1">
        {title ? <p className="font-medium">{title}</p> : null}
        {children ? <div className={cn(title && "mt-1")}>{children}</div> : null}
      </div>
    </div>
  );
}

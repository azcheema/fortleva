import { CircleCheckIcon, OctagonAlertIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The inline result of a server action. Success is role="status", a
 * failure is role="alert" — the state is announced, not merely tinted,
 * and both carry a distinct glyph so the pair survives greyscale and
 * every colour-vision type.
 */
export function FormMessage({
  state,
  className,
}: {
  state: { ok: boolean; message: string } | null | undefined;
  className?: string;
}) {
  if (!state) return null;
  const Icon = state.ok ? CircleCheckIcon : OctagonAlertIcon;
  return (
    <p
      role={state.ok ? "status" : "alert"}
      className={cn(
        "inline-flex items-start gap-1.5 text-sm",
        // Danger as TEXT is --tone-danger-fg, never --destructive: the
        // latter is a FILL colour (white label at 4.6:1) and measures
        // 3.90:1 as text on a dark card, i.e. it fails SC 1.4.3.
        state.ok ? "text-(--tone-success-fg)" : "text-(--tone-danger-fg)",
        className,
      )}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span>{state.message}</span>
    </p>
  );
}

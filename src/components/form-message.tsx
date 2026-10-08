import { CircleCheckIcon, OctagonAlertIcon, TriangleAlertIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * The inline result of a server action. Success is role="status", a
 * failure is role="alert" — the state is announced, not merely tinted,
 * and both carry a distinct glyph so the pair survives greyscale and
 * every colour-vision type.
 *
 * A third state, `caution` on a success (slice 103): the action did what it
 * said, but something the reader should know did not follow — an invitation
 * saved whose email did not go. Still role="status" (nothing failed), in the
 * caution tone with the triangle, so it never reads as a plain tick.
 */
export function FormMessage({
  state,
  className,
}: {
  state: { ok: boolean; message: string; caution?: boolean } | null | undefined;
  className?: string;
}) {
  if (!state) return null;
  const caution = state.ok && state.caution === true;
  const Icon = caution ? TriangleAlertIcon : state.ok ? CircleCheckIcon : OctagonAlertIcon;
  return (
    <p
      role={state.ok ? "status" : "alert"}
      className={cn(
        "inline-flex items-start gap-1.5 text-sm",
        // Danger as TEXT is --tone-danger-fg, never --destructive: the
        // latter is a FILL colour (white label at 4.6:1) and measures
        // 3.90:1 as text on a dark card, i.e. it fails SC 1.4.3.
        caution ? "text-(--tone-caution-fg)" : state.ok ? "text-(--tone-success-fg)" : "text-(--tone-danger-fg)",
        className,
      )}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span>{state.message}</span>
    </p>
  );
}

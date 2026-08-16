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
        state.ok ? "text-(--tone-success-fg)" : "text-destructive",
        className,
      )}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span>{state.message}</span>
    </p>
  );
}

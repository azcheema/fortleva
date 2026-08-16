import { cn } from "@/lib/utils";

/** Inline result line under a form (server-action state). */
export function FormMessage({
  state,
  className,
}: {
  state: { ok: boolean; message: string } | null | undefined;
  className?: string;
}) {
  if (!state) return null;
  return (
    <p
      role={state.ok ? "status" : "alert"}
      className={cn("text-sm", state.ok ? "text-green-700" : "text-destructive", className)}
    >
      {state.message}
    </p>
  );
}

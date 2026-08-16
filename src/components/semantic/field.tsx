import { cn } from "@/lib/utils";

import { Label } from "@/components/ui/label";

/**
 * Label + control + hint, on the 4px grid. Extracted so the three
 * copies that had drifted apart (client overview, project overview,
 * preferences) become one shape: 6px between label and control, hint
 * 12px muted under it, error text in --destructive with role="alert" so
 * it is announced rather than merely coloured.
 */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  required,
  className,
  children,
}: {
  label: React.ReactNode;
  htmlFor?: string;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const hintId = htmlFor ? `${htmlFor}-hint` : undefined;
  const errorId = htmlFor ? `${htmlFor}-error` : undefined;

  return (
    <div data-slot="field" className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <Label htmlFor={htmlFor} className="text-sm">
        {label}
        {required ? (
          <span aria-hidden="true" className="text-muted-foreground">
            {"*"}
          </span>
        ) : null}
      </Label>
      {children}
      {hint ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The pending indicator. Four screens had their own "…" span; this is
 * the one, and it is announced politely rather than silently appearing.
 */
export function Pending({ className, label }: { className?: string; label: string }) {
  return (
    <span
      role="status"
      aria-label={label}
      className={cn("inline-block text-xs text-muted-foreground", className)}
    >
      {"…"}
    </span>
  );
}

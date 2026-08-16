import { FolderOpenIcon, SearchXIcon, ShieldOffIcon, type LucideProps } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Three variants, never conflated — because they need three different
 * next actions:
 *   empty      nothing exists yet          -> create the first one
 *   filtered   things exist, none match    -> clear the filter
 *   forbidden  things exist, not for you   -> ask someone
 *
 * No illustration. A 20px muted glyph in a 40px square, a 14px/600
 * title, one sentence under 42 characters-per-line, and at most one
 * primary action. Left-aligned in the content column, 48px of vertical
 * air — an empty state is a signpost, not a billboard.
 */
const ICONS: Record<EmptyStateVariant, React.ComponentType<LucideProps>> = {
  empty: FolderOpenIcon,
  filtered: SearchXIcon,
  forbidden: ShieldOffIcon,
};

export type EmptyStateVariant = "empty" | "filtered" | "forbidden";

export function EmptyState({
  variant = "empty",
  icon: Icon,
  title,
  description,
  body,
  actions,
  action,
  secondary,
  className,
}: {
  variant?: EmptyStateVariant;
  icon?: React.ComponentType<LucideProps>;
  title: React.ReactNode;
  /** Legacy prop name kept so existing call sites keep working. */
  description?: React.ReactNode;
  body?: React.ReactNode;
  actions?: React.ReactNode;
  action?: React.ReactNode;
  secondary?: React.ReactNode;
  className?: string;
}) {
  const Glyph = Icon ?? ICONS[variant];
  const text = body ?? description;

  return (
    <div
      data-slot="empty-state"
      data-variant={variant}
      className={cn("flex max-w-[340px] flex-col items-start gap-3 py-12", className)}
    >
      <span className="inline-flex size-10 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <Glyph aria-hidden="true" className="size-5" />
      </span>
      <div>
        <p className="text-base font-semibold text-foreground">{title}</p>
        {text ? <p className="mt-1 text-sm text-muted-foreground">{text}</p> : null}
      </div>
      {action || secondary || actions ? (
        <div className="flex flex-wrap items-center gap-2">
          {action}
          {secondary}
          {actions}
        </div>
      ) : null}
    </div>
  );
}

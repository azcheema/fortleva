import { cn } from "@/lib/utils";

/**
 * The one boxed surface in the product. It replaces both the raw <Card>
 * uses and the hand-rolled `rounded-md border border-border` wrappers,
 * so every screen has exactly one surface language: --card fill, 1px
 * hairline, 10px radius, 16px rhythm (12px at size="sm"), no shadow.
 */
export function SectionCard({
  title,
  description,
  actions,
  size = "default",
  contentClassName,
  className,
  children,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  size?: "default" | "sm";
  contentClassName?: string;
  className?: string;
  children?: React.ReactNode;
}) {
  const pad = size === "sm" ? "p-3" : "p-4";
  return (
    <section
      data-slot="section-card"
      data-size={size}
      className={cn("overflow-hidden rounded-card border border-border bg-card text-card-foreground", className)}
    >
      {title || description || actions ? (
        <header
          className={cn(
            "flex flex-wrap items-start justify-between gap-2 border-b border-border",
            pad,
          )}
        >
          <div className="min-w-0">
            {title ? (
              <h2
                className={cn(
                  "font-semibold text-foreground",
                  size === "sm" ? "text-base" : "text-lg",
                )}
              >
                {title}
              </h2>
            ) : null}
            {description ? (
              <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </header>
      ) : null}
      <div className={cn(pad, contentClassName)}>{children}</div>
    </section>
  );
}

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
 *
 * CONTRACT for `variant="empty"`: pass a real `icon` and a real
 * `action`. The `FolderOpenIcon` default below is a fallback, not a
 * design — an open folder on a Team tab ("No one assigned yet") and on
 * a Board tab ("Tasks arrive with the Work module") says nothing about
 * either. `StrictEmptyStateProps` states that requirement in the type
 * system; swap it into the signature once every `empty` call site
 * passes both (the audit asserts the runtime half via `data-variant` +
 * a focusable descendant).
 */
const ICONS: Record<EmptyStateVariant, React.ComponentType<LucideProps>> = {
  empty: FolderOpenIcon,
  filtered: SearchXIcon,
  forbidden: ShieldOffIcon,
};

export type EmptyStateVariant = "empty" | "filtered" | "forbidden";

type EmptyStateBase = {
  icon?: React.ComponentType<LucideProps>;
  title: React.ReactNode;
  titleAs?: "p" | "h1";
  description?: React.ReactNode;
  body?: React.ReactNode;
  actions?: React.ReactNode;
  action?: React.ReactNode;
  secondary?: React.ReactNode;
  className?: string;
};

/**
 * The contract §10.15 pattern 6 asks for: nothing-yet REQUIRES the icon
 * that says what is missing and the verb that creates it; the other two
 * variants keep their defaults, because "no matches" and "not for you"
 * have exactly one sensible glyph each.
 */
export type StrictEmptyStateProps =
  | (EmptyStateBase & {
      variant: "empty";
      icon: React.ComponentType<LucideProps>;
      action: React.ReactNode;
    })
  | (EmptyStateBase & { variant?: "filtered" | "forbidden" });

export function EmptyState({
  variant = "empty",
  icon: Icon,
  title,
  titleAs: TitleTag = "p",
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
  /**
   * "h1" when the empty state IS the page — the 404 and the error
   * boundary replace a whole route, PageHeader and all, and a page with
   * no h1 has no heading outline for anyone navigating by headings.
   * Inside a card it stays a paragraph: the card's title is the heading.
   */
  titleAs?: "p" | "h1";
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
      data-has-action={action || secondary || actions ? "true" : undefined}
      className={cn("flex max-w-[340px] flex-col items-start gap-3 py-12", className)}
    >
      <span className="inline-flex size-10 items-center justify-center rounded-md bg-muted text-muted-foreground">
        <Glyph aria-hidden="true" className="size-5" />
      </span>
      <div>
        {/* When the empty state IS the page, its title is the page
            title and takes the page-title size (§10.7). The same string
            at 22px on one route and 14px on another is the defect this
            removes. */}
        <TitleTag
          className={cn(
            "font-semibold text-foreground",
            TitleTag === "h1" ? "text-xl" : "text-base",
          )}
        >
          {title}
        </TitleTag>
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

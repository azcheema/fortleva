import { cn } from "@/lib/utils";

/**
 * Page title block: h1, optional description, badges inline, actions right.
 *
 * Below `md` it STACKS — title block on its own row, actions on a second
 * full-width row — and the h1 wraps rather than truncating. §9 forbids
 * truncating a chip or a button and requires both locales to pass at the
 * longest Swedish string; at 390px "Visa arkiverade" + "Ny klient" alone
 * is most of the line.
 */
export function PageHeader({
  title,
  description,
  badges,
  actions,
  breadcrumb,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  badges?: React.ReactNode;
  actions?: React.ReactNode;
  breadcrumb?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="page-header"
      className={cn(
        "flex flex-col gap-3 md:flex-row md:flex-wrap md:items-start md:justify-between",
        className,
      )}
    >
      <div className="min-w-0">
        {breadcrumb ? <div className="mb-1 text-xs text-muted-foreground">{breadcrumb}</div> : null}
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h1 className="min-w-0 text-xl font-semibold text-balance text-foreground">{title}</h1>
          {badges}
        </div>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? (
        <div className="flex w-full flex-wrap items-center gap-2 md:w-auto md:shrink-0">{actions}</div>
      ) : null}
    </div>
  );
}

/**
 * The content column. Three widths, chosen by what is inside:
 *   form     720px  settings, account, auth, single-column forms
 *   default 1080px  list and detail pages
 *   wide    1440px  tables, board, backlog
 *
 * Page padding is 16px on mobile and 24px from 768px up; 24px vertical.
 */
const WIDTHS = {
  form: "max-w-(--content-form)",
  default: "max-w-(--content-default)",
  wide: "max-w-(--content-wide)",
} as const;

export type PageWidth = keyof typeof WIDTHS;

export function Page({
  width = "default",
  children,
  className,
}: {
  width?: PageWidth;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mx-auto w-full px-4 py-6 md:px-6", WIDTHS[width], className)}>{children}</div>
  );
}

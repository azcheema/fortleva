import { GlobeIcon, ShieldIcon } from "lucide-react";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";

/**
 * The unauthenticated surfaces — /login, /signup, /invite/[token],
 * /ops/login, /portal — are the product's first impression, so they
 * share one lockup instead of drifting apart. It lives beside /login
 * because that is the canonical entry point.
 *
 * DESIGN SPEC §7: a centred max-w-sm column on --background, no card,
 * a 32px wordmark lockup at the top, controls at lg height and exactly
 * ONE --primary element on the page (the submit button). The three
 * planes must never be confused with one another, so each carries its
 * own mark and the platform plane additionally carries an eyebrow.
 */
export type AuthPlane = "member" | "platform" | "portal";

/** lg control geometry (40px) for the auth forms — DESIGN SPEC §4. */
export const AUTH_CONTROL = "h-10 md:text-base";

function Mark({ plane }: { plane: AuthPlane }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground"
    >
      {plane === "platform" ? (
        <ShieldIcon className="size-4.5" />
      ) : plane === "portal" ? (
        <GlobeIcon className="size-4.5" />
      ) : (
        // The letterform, drawn rather than set: one shape, currentColor,
        // no second asset and no <picture> across themes (§8.7).
        <svg viewBox="0 0 16 16" className="size-4.5 fill-current">
          <rect x="4" y="3" width="8" height="2.4" rx="1.2" />
          <rect x="4" y="3" width="2.4" height="10" rx="1.2" />
          <rect x="4" y="7.3" width="6" height="2.4" rx="1.2" />
        </svg>
      )}
    </span>
  );
}

export function AuthShell({
  plane = "member",
  eyebrow,
  title,
  description,
  footer,
  children,
}: {
  plane?: AuthPlane;
  eyebrow?: React.ReactNode;
  /**
   * Optional, because a whole-page state brings its OWN h1 inside a
   * `<PageState chrome="bare">` card and a page may have exactly one.
   * When it is absent the lockup stands alone above the card.
   */
  title?: React.ReactNode;
  description?: React.ReactNode;
  footer?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const t = useTranslations("common");
  return (
    // The lockup holds ONE baseline across the whole flow. Centring it
    // vertically drifted the wordmark by ~180px between /signup, /login,
    // /invite and the unavailable state — the four pages this component
    // exists to make look like one product.
    <main
      data-plane={plane}
      className="flex min-h-svh flex-col items-center justify-start bg-background px-4 pt-24 pb-12 md:pt-32"
    >
      <div className="flex w-full max-w-sm flex-col gap-8">
        <div className="flex items-center gap-3">
          <Mark plane={plane} />
          <span className="text-3xl font-semibold text-foreground">{t("appName")}</span>
        </div>

        <div className="flex flex-col gap-6">
          {eyebrow || title || description ? (
            <header className="flex flex-col gap-1.5">
              {eyebrow ? <p className="eyebrow text-muted-foreground">{eyebrow}</p> : null}
              {title ? (
                <h1 className="text-xl font-semibold text-balance text-foreground">{title}</h1>
              ) : null}
              {description ? (
                <div className="text-sm text-muted-foreground">{description}</div>
              ) : null}
            </header>
          ) : null}
          {children}
        </div>

        {footer ? (
          <div className="border-t border-border pt-4 text-sm text-muted-foreground">{footer}</div>
        ) : null}
      </div>
    </main>
  );
}

/**
 * A secondary link on an auth page. Deliberately NOT --primary: the
 * page is allowed exactly one primary element, and that is the submit
 * button.
 */
export const authLinkClass = cn(
  "rounded-sm font-medium text-foreground underline underline-offset-4",
  "hover:decoration-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
);

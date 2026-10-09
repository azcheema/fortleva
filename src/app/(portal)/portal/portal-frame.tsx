import { GlobeIcon } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { cn } from "@/lib/utils";
import type { PortalPrincipal } from "@/portal";

import { invoicesShown } from "./invoices-shown";
import { loginsShown } from "./logins-shown";

/**
 * THE PORTAL'S CHROME, and UI.md §11 makes it a short list: tenant
 * name/logo, project switcher, profile menu — "no ⌘K, no keymap, no
 * timer". This ships the product's mark, the "signed in as" line and,
 * since the files-and-services slice, a three-entry nav — the portal
 * has three top-level pages now (`/portal`, `/portal/files`,
 * `/portal/company`) and a page a client cannot reach from another is
 * a page that does not exist for them.
 *
 * NO TENANT NAME YET, AND THE REASON IS A POLICY, NOT A TO-DO. `tenant`
 * carries `portal_deny`, so a contact-principal read of it returns zero
 * rows (`module-gates.ts` is the load-bearing note on exactly this), and
 * putting the agency's name up there needs a second system-principal
 * read with its own safety argument — the shape `resolvePortalModuleGates`
 * had to earn. The Portal tab slice owns the branding and is where that
 * argument belongs. Until then the bar carries the product's mark, which
 * is honest rather than blank.
 *
 * It is a component and not a `layout.tsx` because `/portal/login` lives
 * under the same path and must render for someone with NO session: a
 * layout calling `requirePortalContext()` would redirect the sign-in
 * page to itself.
 *
 * `data-portal-surface` (slice 5) marks the region the byte comparison
 * is drawn around — everything a contact sees, and nothing else. The
 * chrome is deliberately INSIDE it: the bar and the "signed in as" line
 * are part of what the client gets, so a View-as page that rendered a
 * different header would be a different page. The red View-as banner
 * sits outside it, being the one thing on that route no contact ever
 * sees. The attribute is `""` rather than a value because nothing reads
 * a value: `e2e/view-as.spec.ts` selects on the attribute's presence.
 *
 * WHICH ENTRY IS CURRENT IS A PROP, NEVER READ OFF THE URL. This frame
 * renders on the member plane too, at `/view-as/…`, where the pathname
 * differs from the contact's `/portal/…` — so `usePathname` would draw
 * two different navs for one page and break byte-identity. The page
 * knows which one it is (AGENTS.md: state a shared component must
 * reflect is a required prop, never a default). The links point at the
 * PORTAL plane on both planes, as every link inside the surface does;
 * on the member plane they sit under `inert` and go nowhere, which is
 * what look-don't-touch means. No prefetch, for the reason every portal
 * link gives: on the member plane a prefetch of a portal-gated route
 * carries a member cookie and is answered with a redirect to the client
 * sign-in page on every render.
 */
export type PortalNav = "home" | "files" | "company" | "logins" | "invoices";

const NAV: readonly { readonly key: PortalNav; readonly href: string }[] = [
  { key: "home", href: "/portal" },
  { key: "files", href: "/portal/files" },
  { key: "company", href: "/portal/company" },
];

/**
 * THE FOURTH ENTRY, "Logins" (Phase 3V slice 91; C52 (d), C59 (a)), is
 * drawn only when there is something behind it for THIS contact: the
 * capability (main contacts only, the vault and portal modules open) and at
 * least one login shown — a count under the contact's own principal, where
 * the database's gate and switch decide (`portalLoginsShown`, once per
 * request through `./logins-shown`). So the frame takes the PRINCIPAL and
 * asks. On the member plane View-as hands it the
 * synthesised principal of the contact being looked through, which answers
 * the same — the byte comparison holds — while the logins page itself
 * never renders there.
 */
const LOGINS = { key: "logins", href: "/portal/logins" } as const;

/**
 * "Invoices" (Phase 4 slice 109; C79 (b)) — drawn, like Logins, only when there
 * is something behind it for THIS contact: a main contact whose client has at
 * least one SENT invoice or credit note (`./invoices-shown`). Under View-as the
 * entry is drawn for the byte comparison; its page never renders there (View-as
 * is open to members who hold no `invoice:view`).
 */
const INVOICES = { key: "invoices", href: "/portal/invoices" } as const;

export async function PortalFrame({
  name,
  nav,
  principal,
  children,
}: {
  name: string;
  /** The page's own entry — required, so a page cannot forget to say. */
  nav: PortalNav;
  /** Whose portal this is — for the entries that depend on it ("Logins"). */
  principal: PortalPrincipal;
  children: React.ReactNode;
}) {
  const t = await getTranslations("portal");
  const tCommon = await getTranslations("common");
  // In sequence — each ask is its own contact transaction.
  const entries = [
    ...NAV,
    ...((await invoicesShown(principal)) ? [INVOICES] : []),
    ...((await loginsShown(principal)) ? [LOGINS] : []),
  ];
  return (
    <div data-portal-surface="" className="flex min-h-svh flex-col bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex w-full max-w-(--content-default) flex-col gap-2 px-4 pt-3 md:px-6">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <span
                aria-hidden="true"
                className="inline-flex size-6 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground"
              >
                <GlobeIcon className="size-3.5" />
              </span>
              <span className="truncate text-sm font-semibold text-foreground">{tCommon("appName")}</span>
            </div>
            {/* A profile MENU needs a sign-out action, which needs the
                portal's own auth client on a client component — the invite
                slice's work. The identity itself is worth showing now: a
                contact who is looking at the wrong client's portal should
                be able to tell at a glance. */}
            <span className="truncate text-xs text-muted-foreground">{t("signedInAs", { name })}</span>
          </div>
          {/* No overflow scroller: four short entries fit a phone, and
              a scroll region needs a name and a tab stop the craft audit
              would otherwise flag (`e2e/audit.ts`). */}
          <nav aria-label={t("nav.label")} data-slot="portal-nav" className="-mb-px flex flex-wrap gap-x-4">
            {entries.map((entry) => {
              const current = entry.key === nav;
              return (
                <Link
                  key={entry.key}
                  href={entry.href}
                  prefetch={false}
                  aria-current={current ? "page" : undefined}
                  className={cn(
                    "border-b-2 px-0.5 pb-2 text-sm whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                    current
                      ? "border-primary font-medium text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t(`nav.${entry.key}`)}
                </Link>
              );
            })}
          </nav>
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}

import { GlobeIcon } from "lucide-react";
import { useTranslations } from "next-intl";

/**
 * THE PORTAL'S CHROME, and UI.md §11 makes it a short list: tenant
 * name/logo, project switcher, profile menu — "no ⌘K, no keymap, no
 * timer". This slice ships the first third of that and nothing else,
 * because the other two thirds each need something that does not exist
 * yet.
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
 */
export function PortalFrame({ name, children }: { name: string; children: React.ReactNode }) {
  const t = useTranslations("portal");
  const tCommon = useTranslations("common");
  return (
    <div className="flex min-h-svh flex-col bg-background">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex w-full max-w-(--content-default) items-center justify-between gap-3 px-4 py-3 md:px-6">
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
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}

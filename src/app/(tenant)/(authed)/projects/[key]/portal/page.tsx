import type { Metadata } from "next";
import { UsersIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { PortalTasksEmpty, ProjectTasks } from "@/app/(portal)/portal/task-list";
import { AuthzError } from "@/authz/errors";
import { handleAuthzRedirect } from "@/authz/redirects";
import { Callout, EmptyState, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { requireTenantContext } from "@/members/tenant-context";
import { readPortalPreview } from "@/projects/portal-preview";

import { loadProject } from "../data";
import { PortalControls } from "./portal-forms";

/**
 * PROJECT → PORTAL (Phase 3 memo slice 4): the master switch, and what
 * the client sees.
 *
 * THE TAB'S WHOLE CLAIM IS THAT THE PREVIEW IS NOT A PREVIEW. It renders
 * `listPortalTasks` — the same function, in the same file, that
 * `/portal` calls under a real contact session — through a synthesised
 * principal for a real contact of this project's client
 * (`src/projects/portal-preview.ts`), and it draws the result with the
 * same component. SECURITY.md §5.1 states why in six words: *a separate
 * preview renderer is how previews lie*.
 *
 * SO THE "OFF" STATE IS PRODUCED BY THE DATABASE, NOT BY AN `if`. With
 * the master switch off, nothing in this file branches: the switch is a
 * column, the column is fanned out by a trigger, `portal_gate` reads it
 * on every row, and the projection comes back empty. Turn the switch off
 * and watch the panel below it go blank — that is the control being
 * demonstrated rather than described.
 *
 * WHAT THE PREVIEW CANNOT CLAIM, stated rather than left for a reviewer:
 * it renders in the MEMBER's language and timezone, not the contact's
 * (`resolveLocale` prefers the member session). The copy is therefore
 * the client's view in your words. Byte-identity with a real contact
 * session is View-as-Contact's test, and PLAN §0 already records that it
 * must pin the locale.
 *
 * THE BLOCKERS ARE THE MEMBER'S HALF OF AUTHZ §8. On the portal plane
 * every refusal renders identically, because a reason is a fact about
 * the agency. Here the reader IS the agency, and the one surface where
 * that rule would do harm is this one: a member who shared three tasks
 * and invited nobody must be told which of the four things in the way is
 * theirs to fix. The reasons are computed member-side from rows they may
 * read anyway — never from the projection's denial.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ key: string }>;
}): Promise<Metadata> {
  const { key } = await params;
  const [project, t] = await Promise.all([loadProject(key), getTranslations("projects.portal")]);
  return { title: `${project.key} · ${t("title")}` };
}

export default async function ProjectPortalPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const project = await loadProject(key);
  const { membership, actor } = await requireTenantContext();

  // 404, not a disabled page, and the guard is `readPortalPreview`'s own
  // `requireAccess` rather than a second round trip: the tab is HIDDEN
  // for a member who cannot manage the portal and for a tenant whose
  // plan or preference has the module off (UI.md §3.1), so anyone
  // arriving here typed the URL, and a hidden thing answers 404 (§7.3).
  // Catching the `AuthzError` covers all four gates plus scope with no
  // read this page was not already making.
  let preview;
  try {
    preview = await readPortalPreview({ tenantId: membership.tenantId, actor }, project.id);
  } catch (e) {
    // `handleAuthzRedirect` FIRST, exactly as `loadProject` does it
    // (`../data.ts`). `project:manage_portal` is not a ✦ code today, so
    // nothing here can raise MFA_REQUIRED — but if it ever becomes one,
    // a bare `notFound()` would answer a step-up prompt with a 404 and
    // the member would have no way to learn what to do. The same hazard
    // `hasAccess`'s docblock warns about, one line from the same cure.
    handleAuthzRedirect(e, `/projects/${key}/portal`);
    if (e instanceof AuthzError) notFound();
    throw e;
  }

  const t = await getTranslations("projects.portal");
  const tContacts = await getTranslations("clients.contacts");

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      {/* The preview leads, because it is the answer to the question the
          tab exists for. The controls sit beside it so a flip and its
          consequence are on one screen. */}
      <section className="flex flex-col gap-4 lg:col-span-2">
        {/* The same heading shape `SectionCard` draws, without the box:
            the preview's frame is the card the PORTAL itself renders, and
            wrapping that in a second one is §10.13's double hairline. */}
        <div className="flex flex-col">
          <h2 className="text-lg font-semibold text-foreground">{t("preview.title")}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {preview.contact
              ? t("preview.viewingAs", {
                  name: preview.contact.name,
                  profile: tContacts(`profiles.${preview.contact.profile}`),
                })
              : t("preview.noViewer")}
          </p>
        </div>

        {preview.blockers.length > 0 ? (
          <Callout tone="caution" title={t("blocked.title")}>
            <ul className="list-disc space-y-1 pl-5">
              {preview.blockers.map((blocker) => (
                <li key={blocker}>{t(`blocked.${blocker}`)}</li>
              ))}
            </ul>
          </Callout>
        ) : null}

        {preview.truncated ? (
          <Callout tone="info">
            {t("preview.truncated", { count: preview.tasks?.tasks.length ?? 0 })}
          </Callout>
        ) : null}

        {/* Exactly what /portal draws, or exactly what /portal draws when
            there is nothing — no third rendering of either. */}
        {preview.tasks ? <ProjectTasks project={preview.tasks} /> : <PortalTasksEmpty />}
      </section>

      <div className="flex flex-col gap-6">
        <SectionCard title={t("controls")}>
          <PortalControls project={project} />
        </SectionCard>
        <SectionCard title={t("audience.title")} description={t("audience.hint")}>
          {preview.audience === 0 ? (
            // §5.8's contract: a nothing-yet state carries the glyph for
            // what is missing and the verb that creates it. Here the verb
            // is real — the client's Contacts tab is where portal access
            // is granted — which is why this one is `empty` and the
            // portal's own is `forbidden`.
            <EmptyState
              variant="empty"
              icon={UsersIcon}
              title={t("audience.empty.title")}
              body={t("audience.empty.body")}
              action={
                <Button asChild size="sm">
                  <Link href={`/clients/${project.client.id}/contacts`}>
                    {t("audience.manage")}
                  </Link>
                </Button>
              }
            />
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-foreground">
                {t("audience.count", { count: preview.audience })}
              </p>
              <Button asChild variant="outline" size="sm" className="self-start">
                <Link href={`/clients/${project.client.id}/contacts`}>{t("audience.manage")}</Link>
              </Button>
            </div>
          )}
        </SectionCard>
      </div>
    </div>
  );
}

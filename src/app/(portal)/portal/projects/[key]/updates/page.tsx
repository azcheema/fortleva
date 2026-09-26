import type { Metadata } from "next";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";

import { Page, PageHeader, SectionCard } from "@/components/semantic";
import { UpdateView } from "@/components/updates/update-view";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/format";
import { listPortalUpdates, readUpdateBody } from "@/modules/work";
import type { PortalSnapshot } from "@/modules/work/update-snapshot";
import { portalReadOrNull } from "@/portal";
import { requirePortalContext } from "@/portal/context";
import { findPortalProjectByKey } from "@/projects/portal";

import { PortalFrame } from "../../../portal-frame";
import { PortalTasksEmpty } from "../../../task-list";

/**
 * `/portal/projects/[key]/updates` — every update the agency has
 * published for one project, newest first (Phase 3, DATA_MODEL §6.16).
 * The one-screen project page UI.md §4 describes lands with the Client
 * Timeline; this is its updates section, reachable from the project's
 * card on `/portal` today.
 *
 * TWO READS, BOTH UNDER THE CONTACT PRINCIPAL, and every refusal is the
 * plane's one uniform empty page: a key that is not this client's, a
 * project switched off, an archived one and a client with nothing
 * published all render `PortalTasksEmpty`, byte for byte, because a
 * reason is a fact about the agency (`src/portal/render.ts`).
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("portal.updates");
  return { title: t("title") };
}

export default async function PortalProjectUpdatesPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const { principal, name } = await requirePortalContext();
  const t = await getTranslations("portal.updates");
  const locale = await getLocale();

  const project = await portalReadOrNull("findPortalProjectByKey", () =>
    findPortalProjectByKey(principal, key),
  );
  const updates = project
    ? await portalReadOrNull("listPortalUpdates", () => listPortalUpdates(principal, { projectId: project.id }))
    : null;

  return (
    <PortalFrame name={name}>
      <Page>
        <div className="flex flex-col gap-6">
          <PageHeader
            title={project ? project.name : t("title")}
            description={project ? t("description", { project: project.name }) : undefined}
            actions={
              // Back to the PROJECT when there is one to go back to —
              // the one-screen page this list hangs off since the
              // Timeline slice — and to the home otherwise.
              <Button asChild variant="outline" size="sm">
                <Link href={project ? `/portal/projects/${project.key}` : "/portal"}>
                  {project ? t("backToProject", { project: project.name }) : t("back")}
                </Link>
              </Button>
            }
          />
          {!project || !updates || updates.length === 0 ? (
            <PortalTasksEmpty />
          ) : (
            updates.map((update) => (
              // The anchor the timeline's update entries link to.
              <SectionCard
                key={update.id}
                id={`update-${update.id}`}
                className="scroll-mt-16"
                title={update.title ?? t("title")}
                description={t("updatedAgo", { date: formatDate(locale, update.publishedAt) })}
              >
                <UpdateView
                  update={{
                    seq: update.seq,
                    health: update.health,
                    title: null,
                    periodStart: update.periodStart,
                    periodEnd: update.periodEnd,
                    publishedAt: update.publishedAt,
                    body: readUpdateBody(update.body),
                    metrics: (update.metrics as PortalSnapshot | null) ?? null,
                    editNote: update.editNote,
                  }}
                />
              </SectionCard>
            ))
          )}
        </div>
      </Page>
    </PortalFrame>
  );
}

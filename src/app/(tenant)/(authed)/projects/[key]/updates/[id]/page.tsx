import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { AuthzError } from "@/authz/errors";
import { handleAuthzRedirect } from "@/authz/redirects";
import { Callout, SectionCard } from "@/components/semantic";
import { UpdateView } from "@/components/updates/update-view";
import { Button } from "@/components/ui/button";
import { withTenant } from "@/db";
import { requireTenantContext } from "@/members/tenant-context";
import { getUpdate, readComposerContext, type ComposerContext, type UpdateDetail } from "@/modules/work";
import { readPreferences } from "@/preferences/service";

import { loadProject } from "../../data";
import { DraftActions } from "../draft-actions";
import { InternalCard } from "../internal-card";
import { PublishedActions } from "../published-actions";
import { UpdateComposer } from "../update-composer";

/**
 * ONE UPDATE. A draft's page is the composer; a published or archived
 * post's page is the post as the client reads it, the staff-only
 * figures beside it, and the verbs still open on it.
 */
const isUuid = (s: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

export async function generateMetadata({ params }: { params: Promise<{ key: string }> }): Promise<Metadata> {
  const { key } = await params;
  const [project, t] = await Promise.all([loadProject(key), getTranslations("projects.updates")]);
  return { title: `${project.key} · ${t("title")}` };
}

export default async function UpdatePage({ params }: { params: Promise<{ key: string; id: string }> }) {
  const { key, id } = await params;
  if (!isUuid(id)) notFound();
  const project = await loadProject(key);
  const { membership, actor } = await requireTenantContext();
  const ctx = { tenantId: membership.tenantId, actor };
  const t = await getTranslations("projects.updates");

  let update: UpdateDetail;
  let context: ComposerContext | null = null;
  try {
    update = await getUpdate(ctx, id);
    if (update.projectId !== project.id) notFound();
    if (update.status === "DRAFT" && update.caps.create && project.status !== "ARCHIVED") {
      context = await readComposerContext(ctx, project.id, {
        periodStart: update.periodStart,
        periodEnd: update.periodEnd,
        excludeId: update.id,
      });
    }
  } catch (e) {
    handleAuthzRedirect(e, `/projects/${key}/updates/${id}`);
    if (e instanceof AuthzError) notFound();
    throw e;
  }

  const base = `/projects/${project.key}/updates`;

  if (update.status === "DRAFT" && context) {
    return (
      <div className="flex flex-col gap-4">
        <Button asChild variant="ghost" size="sm" className="self-start">
          <Link href={base}>{t("composer.back")}</Link>
        </Button>
        <UpdateComposer
          projectId={project.id}
          projectKey={project.key}
          draft={{
            id: update.id,
            health: update.health,
            title: update.title,
            periodStart: update.periodStart,
            periodEnd: update.periodEnd,
            body: update.body,
          }}
          context={context}
        />
      </div>
    );
  }

  const prefs = await withTenant(membership.tenantId, { type: "member", id: membership.memberId }, (tx) =>
    readPreferences(tx, membership.tenantId),
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button asChild variant="ghost" size="sm">
          <Link href={base}>{t("detail.back")}</Link>
        </Button>
        {update.status === "PUBLISHED" ? (
          <PublishedActions
            projectKey={project.key}
            id={update.id}
            visibility={update.visibility}
            editNote={update.editNote}
            retractUntil={update.retractUntil?.toISOString() ?? null}
            caps={{ publish: update.caps.publish, changeVisibility: update.caps.changeVisibility }}
          />
        ) : null}
        {/* A draft the composer will not open (the project is archived)
            keeps its one verb: it can still be discarded. */}
        {update.status === "DRAFT" && update.caps.create ? (
          <DraftActions projectKey={project.key} id={update.id} />
        ) : null}
      </div>
      {update.status === "DRAFT" ? <Callout tone="info">{t("detail.draftBanner")}</Callout> : null}
      {update.status === "ARCHIVED" ? <Callout tone="caution">{t("detail.archivedBanner")}</Callout> : null}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-5">
        <SectionCard
          className="xl:col-span-3"
          description={
            <span className="flex flex-wrap gap-x-3 gap-y-0.5">
              {update.authorName ? <span>{t("detail.author", { name: update.authorName })}</span> : null}
              {update.publishedByName ? <span>{t("detail.publishedBy", { name: update.publishedByName })}</span> : null}
            </span>
          }
        >
          <div data-testid="update-detail" data-visibility={update.visibility}>
            <UpdateView
              update={{
                seq: update.seq,
                health: update.health,
                title: update.title,
                periodStart: update.periodStart ? new Date(`${update.periodStart}T00:00:00Z`) : null,
                periodEnd: update.periodEnd ? new Date(`${update.periodEnd}T00:00:00Z`) : null,
                publishedAt: update.publishedAt,
                body: update.body,
                metrics: update.metrics,
                editNote: update.editNote,
              }}
            />
          </div>
        </SectionCard>
        <div className="xl:col-span-2">
          {update.internal ? (
            <InternalCard internal={update.internal} currency={project.billingCurrency} durationStyle={prefs.durationStyle} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

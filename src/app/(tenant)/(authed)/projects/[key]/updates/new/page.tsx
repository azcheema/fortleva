import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { AuthzError } from "@/authz/errors";
import { handleAuthzRedirect } from "@/authz/redirects";
import { Button } from "@/components/ui/button";
import { requireTenantContext } from "@/members/tenant-context";
import { readComposerContext } from "@/modules/work";
import { ALL_METRICS_INCLUDED } from "@/modules/work/update-body";

import { loadProject } from "../../data";
import { UpdateComposer } from "../update-composer";

/**
 * A NEW UPDATE. The context read is the gate (`project_update:create`
 * + scope) and a refusal is a 404, the way a typed URL to any hidden
 * surface answers (UI.md §7.3). The draft row is created on the first
 * save, not on arrival: a composer opened and abandoned leaves nothing.
 */
export async function generateMetadata({ params }: { params: Promise<{ key: string }> }): Promise<Metadata> {
  const { key } = await params;
  const [project, t] = await Promise.all([loadProject(key), getTranslations("projects.updates.composer")]);
  return { title: `${project.key} · ${t("title")}` };
}

export default async function NewUpdatePage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const project = await loadProject(key);
  const { membership, actor } = await requireTenantContext();
  const ctx = { tenantId: membership.tenantId, actor };
  const t = await getTranslations("projects.updates.composer");
  if (project.status === "ARCHIVED") notFound();

  let context;
  try {
    context = await readComposerContext(ctx, project.id, { periodStart: null, periodEnd: null });
  } catch (e) {
    handleAuthzRedirect(e, `/projects/${key}/updates/new`);
    if (e instanceof AuthzError) notFound();
    throw e;
  }

  return (
    <div className="flex flex-col gap-4">
      <Button asChild variant="ghost" size="sm" className="self-start">
        <Link href={`/projects/${project.key}/updates`}>{t("back")}</Link>
      </Button>
      <UpdateComposer
        projectId={project.id}
        projectKey={project.key}
        draft={{
          id: null,
          health: context.previousHealth ?? "ON_TRACK",
          title: null,
          periodStart: null,
          periodEnd: null,
          body: { sections: [], metrics: { include: ALL_METRICS_INCLUDED } },
        }}
        context={context}
      />
    </div>
  );
}

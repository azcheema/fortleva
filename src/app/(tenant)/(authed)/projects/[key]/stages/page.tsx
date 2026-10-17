import { Columns3Icon } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { AuthzError } from "@/authz/errors";
import { handleAuthzRedirect } from "@/authz/redirects";
import { Callout, EmptyState, SectionCard } from "@/components/semantic";
import { stateLabel } from "@/lib/state-label";
import { isStageKind } from "@/lib/stage-rules";
import { requireTenantContext } from "@/members/tenant-context";
import { getProjectStages } from "@/modules/work";

import { AddStageForm, StageTable, type StageRowView } from "../../../settings/stages/stage-editor";
import { loadProject } from "../data";

/**
 * /projects/[key]/stages — this project's own stages (slice 123, founder
 * decision C99 (a)): rename, add, reorder within a kind, remove (its tasks
 * move to another stage of the same kind — or, for the last Backlog stage,
 * its deleted ones to where new tasks start, C104), where new tasks start, which
 * stages need approval. Not a tab: reached from the board's "Edit stages",
 * with the Board tab lit (`also` in the layout). `workflow:manage` + the
 * project's scope — the service's gate; anyone else sees `forbidden`.
 */
export default async function ProjectStagesPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const project = await loadProject(key);
  const { membership, actor } = await requireTenantContext();
  const ctx = { tenantId: membership.tenantId, actor };
  const t = await getTranslations("projects.stages");
  const back = `/projects/${project.key}/board`;

  let data: Awaited<ReturnType<typeof getProjectStages>>;
  try {
    data = await getProjectStages(ctx, project.id);
  } catch (e) {
    handleAuthzRedirect(e, `/projects/${project.key}/stages`);
    if (!(e instanceof AuthzError)) throw e;
    return (
      <SectionCard>
        <EmptyState variant="forbidden" icon={Columns3Icon} title={t("forbidden.title")} body={t("forbidden.body")} />
      </SectionCard>
    );
  }
  const tStates = await getTranslations("projects.states.seed");
  const rows: StageRowView[] = data.stages.flatMap((s) =>
    isStageKind(s.category)
      ? [
          {
            id: s.id,
            name: stateLabel({ name: s.name, seedKey: s.seedKey }, (k) => tStates(k)),
            category: s.category,
            isDefault: s.isDefault,
            requiresApproval: s.requiresApproval,
            tasks: s.tasks,
            binned: s.binned,
          },
        ]
      : [],
  );
  const scope = { kind: "project" as const, projectId: project.id };
  const canEdit = !data.archived;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">{t("title")}</h2>
        <Link className="text-sm text-muted-foreground underline-offset-2 hover:underline" href={back}>
          {t("back")}
        </Link>
      </div>
      {data.archived ? <Callout tone="info">{t("archived")}</Callout> : null}
      <SectionCard title={t("listTitle")} description={t("listDescription")} contentClassName="p-0">
        <StageTable scope={scope} rows={rows} canEdit={canEdit} />
      </SectionCard>
      {canEdit ? (
        <SectionCard title={t("addTitle")} description={t("addDescription")}>
          <AddStageForm scope={scope} />
        </SectionCard>
      ) : null}
    </div>
  );
}

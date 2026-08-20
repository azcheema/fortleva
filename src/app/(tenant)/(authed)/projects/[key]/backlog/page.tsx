import { ListIcon } from "lucide-react";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";

import { EmptyState, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { requireTenantContext } from "@/members/tenant-context";
import { listItems } from "@/modules/work";

import { loadProject } from "../data";
import { BacklogTable } from "./backlog-table";

/**
 * The minimal ordered task list (2W core slice): title-only create,
 * inline state/assignee/estimate/visibility, archive/delete. The full
 * backlog surface (virtualised list, filter chips, group-by, multi-
 * select) and the board arrive with the 2W UX finish; the schema and
 * services beneath are final.
 */
export default async function ProjectBacklogPage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<{ archived?: string }>;
}) {
  const [{ key }, { archived }] = await Promise.all([params, searchParams]);
  const project = await loadProject(key);
  const { membership, actor } = await requireTenantContext();
  const includeArchived = archived === "1";
  const data = await listItems(
    { tenantId: membership.tenantId, actor },
    project.id,
    { includeArchived },
  );
  const t = await getTranslations("projects.backlog");
  const tProjects = await getTranslations("projects");
  const locale = await getLocale();

  const empty = data.items.length === 0 && !includeArchived;

  return (
    <div className="flex flex-col gap-4">
      {empty && !data.caps.canCreate ? (
        <SectionCard>
          <EmptyState variant="forbidden" icon={ListIcon} title={t("empty.title")} body={t("empty.bodyReadOnly")} />
        </SectionCard>
      ) : (
        <>
          {empty ? (
            <SectionCard>
              <EmptyState
                variant="empty"
                icon={ListIcon}
                title={t("empty.title")}
                body={t("empty.body")}
                action={
                  <Button asChild size="sm">
                    <Link href="#new-task">{t("empty.action")}</Link>
                  </Button>
                }
              />
            </SectionCard>
          ) : null}
          <BacklogTable projectId={project.id} projectKey={project.key} locale={locale} data={data} />
          <p className="text-xs">
            <Link
              className="text-muted-foreground underline-offset-2 hover:underline"
              href={includeArchived ? `/projects/${project.key}/backlog` : `/projects/${project.key}/backlog?archived=1`}
            >
              {includeArchived ? tProjects("hideArchived") : tProjects("showArchived")}
            </Link>
          </p>
        </>
      )}
    </div>
  );
}

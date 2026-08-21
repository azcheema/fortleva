import { KanbanSquareIcon } from "lucide-react";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";

import { EmptyState, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { requireTenantContext } from "@/members/tenant-context";
import { listItems, projectWorkVersion } from "@/modules/work";
import { cn } from "@/lib/utils";

import { loadProject } from "../data";
import { Board } from "./board";
import { GROUP_BYS, isGroupBy, type GroupBy } from "./board-model";

/**
 * /projects/[key]/board (PLAN 2W; UI.md rule 5): columns = the project's
 * states, position = priority, group-by assignee / priority / epic as
 * lanes of the same columns (group-by-assignee IS the team view). The
 * list, the states, the members and the caps come from ONE service read
 * (`listItems`, the backlog's), so both surfaces always agree; the
 * freshness token rides along for the 12 s poll (ARC-18). URL state is
 * `?group=` so every view is a link.
 */
export default async function ProjectBoardPage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<{ group?: string }>;
}) {
  const [{ key }, { group }] = await Promise.all([params, searchParams]);
  const project = await loadProject(key);
  const { membership, actor } = await requireTenantContext();
  const ctx = { tenantId: membership.tenantId, actor };
  const groupBy: GroupBy = isGroupBy(group) ? group : "none";
  // The token is read BEFORE the list on purpose: a write that lands
  // between the two reads then leaves the token older than the list,
  // so the 12 s poll sees a difference and refreshes — the other order
  // would let the board sit stale until the next write.
  const version = await projectWorkVersion(ctx, project.id);
  const [data, t, locale] = await Promise.all([
    listItems(ctx, project.id),
    getTranslations("projects.board"),
    getLocale(),
  ]);
  const empty = data.items.length === 0;

  if (empty && !data.caps.canCreate) {
    return (
      <SectionCard>
        <EmptyState variant="forbidden" icon={KanbanSquareIcon} title={t("empty.title")} body={t("empty.bodyReadOnly")} />
      </SectionCard>
    );
  }

  const base = `/projects/${project.key}/board`;

  return (
    <div className="flex flex-col gap-4">
      <nav aria-label={t("group.label")} className="flex flex-wrap items-center gap-1 text-sm">
        <span className="eyebrow mr-1 text-muted-foreground">{t("group.label")}</span>
        {GROUP_BYS.map((g) => {
          const current = g === groupBy;
          return (
            <Button
              key={g}
              asChild
              size="sm"
              variant={current ? "secondary" : "ghost"}
              className={cn(current && "font-semibold")}
            >
              <Link
                href={g === "none" ? base : `${base}?group=${g}`}
                aria-current={current ? "page" : undefined}
                data-testid={`board-group-${g}`}
              >
                {t(`group.${g}`)}
              </Link>
            </Button>
          );
        })}
      </nav>
      <Board
        projectId={project.id}
        projectKey={project.key}
        locale={locale}
        data={data}
        groupBy={groupBy}
        version={version}
      />
    </div>
  );
}

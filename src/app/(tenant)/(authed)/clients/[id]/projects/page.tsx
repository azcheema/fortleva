import { FolderKanbanIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";

import {
  DataTable,
  EmptyState,
  EntityChip,
  ProgressMeter,
  SectionCard,
  StatusBadge,
} from "@/components/semantic";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { loadClient } from "../data";
import { CreateClientProjectForm } from "./create-project-form";

/**
 * Projects tab: the client's projects in the actor's scope + inline
 * create (project:create, direct scope). Same columns, same key rail
 * and the same milestone meter as /projects — one table, two entry
 * points, so a project cannot look like two different things.
 */
export default async function ClientProjectsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const client = await loadClient(id);
  const t = await getTranslations("clients.projects");
  const tProjects = await getTranslations("projects");
  const format = await getFormatter();
  const canCreate = client.caps.createProject && client.status === "ACTIVE";

  return (
    <div className="flex flex-col gap-6">
      {client.projects.length === 0 ? (
        <SectionCard>
          {canCreate ? (
            <EmptyState
              variant="empty"
              icon={FolderKanbanIcon}
              title={t("empty")}
              body={t("emptyDescription")}
              action={
                <Button asChild size="sm">
                  <Link href="#new-project">
                    <PlusIcon />
                    {tProjects("create.title")}
                  </Link>
                </Button>
              }
            />
          ) : client.caps.createProject ? (
            <EmptyState
              variant="forbidden"
              icon={FolderKanbanIcon}
              title={t("emptyReadOnly")}
              body={t("emptyReadOnlyDescription")}
            />
          ) : (
            <EmptyState
              variant="forbidden"
              title={t("scopedEmpty")}
              body={t("scopedEmptyDescription")}
            />
          )}
        </SectionCard>
      ) : (
        <DataTable scrollLabel={tProjects("title")}>
          <Table>
            <TableHeader>
              <TableRow>
                {/* Fixed in ch of the mono face: the keys are 1-8 characters
                    and must form a straight left edge across every row. */}
                <TableHead className="w-[10ch]">{tProjects("columns.key")}</TableHead>
                <TableHead>{tProjects("columns.name")}</TableHead>
                <TableHead>{tProjects("columns.status")}</TableHead>
                <TableHead priority="medium" className="text-right">
                  {tProjects("columns.milestones")}
                </TableHead>
                <TableHead priority="low" className="text-right">
                  {tProjects("columns.updated")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {client.projects.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="num-id w-[10ch] font-mono text-xs text-muted-foreground">
                    {p.key}
                  </TableCell>
                  <TableCell className="max-w-[420px]">
                    <EntityChip
                      id={p.id}
                      name={p.name}
                      kind="project"
                      href={`/projects/${p.key}`}
                      className="font-medium"
                    />
                  </TableCell>
                  <TableCell>
                    <StatusBadge domain="projectStatus" value={p.status} />
                  </TableCell>
                  <TableCell priority="medium" className="text-right">
                    {p.milestoneTotal === 0 ? (
                      <span className="text-muted-foreground">{"—"}</span>
                    ) : (
                      <ProgressMeter
                        value={p.milestoneDone}
                        total={p.milestoneTotal}
                        label={tProjects("milestonesProgress", {
                          done: p.milestoneDone,
                          total: p.milestoneTotal,
                        })}
                      />
                    )}
                  </TableCell>
                  <TableCell priority="low" className="num text-right text-muted-foreground">
                    {format.dateTime(p.updatedAt, { dateStyle: "medium" })}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </DataTable>
      )}

      {canCreate ? (
        <SectionCard id="new-project" className="scroll-mt-16" title={tProjects("create.title")}>
          <CreateClientProjectForm clientId={client.id} />
        </SectionCard>
      ) : null}
    </div>
  );
}

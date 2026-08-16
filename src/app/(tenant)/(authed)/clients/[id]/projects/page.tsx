import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";

import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

/** Projects tab: the client's projects in the actor's scope + inline create (project:create, direct scope). */
export default async function ClientProjectsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const client = await loadClient(id);
  const t = await getTranslations("clients.projects");
  const tProjects = await getTranslations("projects");
  const format = await getFormatter();

  return (
    <div className="flex flex-col gap-6">
      {client.projects.length === 0 ? (
        client.caps.createProject ? (
          <EmptyState title={t("empty")} description={t("emptyDescription")} />
        ) : (
          <EmptyState title={t("scopedEmpty")} description={t("scopedEmptyDescription")} />
        )
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tProjects("columns.key")}</TableHead>
                <TableHead>{tProjects("columns.name")}</TableHead>
                <TableHead>{tProjects("columns.status")}</TableHead>
                <TableHead className="text-right">{tProjects("columns.milestones")}</TableHead>
                <TableHead>{tProjects("columns.updated")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {client.projects.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-mono text-xs">
                    <Link href={`/projects/${p.key}`} className="hover:underline">
                      {p.key}
                    </Link>
                  </TableCell>
                  <TableCell className="font-medium">
                    <Link href={`/projects/${p.key}`} className="hover:underline">
                      {p.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant={p.status === "ACTIVE" ? "secondary" : "outline"}>
                      {tProjects(`status.${p.status}`)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {tProjects("milestonesProgress", { done: p.milestoneDone, total: p.milestoneTotal })}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {format.dateTime(p.updatedAt, { dateStyle: "medium" })}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {client.caps.createProject && client.status === "ACTIVE" ? (
        <Card size="sm">
          <CardHeader>
            <CardTitle>{tProjects("create.title")}</CardTitle>
          </CardHeader>
          <CardContent>
            <CreateClientProjectForm clientId={client.id} />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

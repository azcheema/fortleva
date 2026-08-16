import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { isAuthorized } from "@/authz/authorize";
import { listClients } from "@/clients/service";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/empty-state";
import { Page, PageHeader } from "@/components/page-header";
import { withTenant } from "@/db";
import { requireTenantContext } from "@/members/tenant-context";
import { listProjects } from "@/projects/service";

import { CreateProjectForm } from "./create-project-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("projects");
  return { title: t("shortTitle") };
}

/** /projects (UI.md §3.1): table grouped by client — key, name, status, lead, milestone progress. */
export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ archived?: string }>;
}) {
  const { membership, actor } = await requireTenantContext();
  const { archived } = await searchParams;
  const includeArchived = archived === "1";
  const t = await getTranslations("projects");
  const tCommon = await getTranslations("common");
  const ctx = { tenantId: membership.tenantId, actor };

  const [groups, canCreate] = await Promise.all([
    listProjects(ctx, { includeArchived }),
    withTenant(membership.tenantId, { type: "member", id: membership.memberId }, (tx) =>
      isAuthorized(tx, actor, "project:create"),
    ),
  ]);
  // Creation needs a client directly in scope — the same scoped list the Clients page shows.
  const clients = canCreate ? (await listClients(ctx)).map((c) => ({ id: c.id, name: c.name })) : [];

  return (
    <Page>
      <PageHeader
        title={t("title")}
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href={includeArchived ? "/projects" : "/projects?archived=1"}>
              {includeArchived ? t("hideArchived") : t("showArchived")}
            </Link>
          </Button>
        }
      />

      <section className="mt-6 flex flex-col gap-6">
        {groups.length === 0 ? (
          canCreate ? (
            clients.length === 0 ? (
              <EmptyState
                title={t("empty.noClients")}
                description={t("empty.noClientsDescription")}
                actions={
                  <Button asChild size="sm">
                    <Link href="/clients">{tCommon("add")}</Link>
                  </Button>
                }
              />
            ) : (
              <EmptyState title={t("empty.title")} description={t("empty.description")} />
            )
          ) : (
            <EmptyState title={t("empty.scoped")} description={t("empty.scopedDescription")} />
          )
        ) : (
          groups.map((g) => (
            <div key={g.clientId}>
              <h2 className="mb-2 text-sm font-semibold">
                <Link href={`/clients/${g.clientId}`} className="hover:underline">
                  {g.clientName}
                </Link>
              </h2>
              <div className="overflow-x-auto rounded-md border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-24">{t("columns.key")}</TableHead>
                      <TableHead>{t("columns.name")}</TableHead>
                      <TableHead>{t("columns.status")}</TableHead>
                      <TableHead>{t("columns.lead")}</TableHead>
                      <TableHead className="text-right">{t("columns.milestones")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {g.projects.map((p) => (
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
                            {t(`status.${p.status}`)}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {p.leadName ?? tCommon("none")}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {t("milestonesProgress", { done: p.milestoneDone, total: p.milestoneTotal })}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          ))
        )}
      </section>

      {canCreate && clients.length > 0 ? (
        <Card size="sm" className="mt-6">
          <CardHeader>
            <CardTitle>{t("create.title")}</CardTitle>
          </CardHeader>
          <CardContent>
            <CreateProjectForm clients={clients} autoFocus={groups.length === 0} />
          </CardContent>
        </Card>
      ) : null}
    </Page>
  );
}

import type { Metadata } from "next";
import { ArchiveIcon, ArchiveRestoreIcon } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { isAuthorized } from "@/authz/authorize";
import { listClients } from "@/clients/service";
import {
  DataTable,
  EmptyState,
  EntityChip,
  Page,
  PageHeader,
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
    <Page width="wide">
      <PageHeader
        title={t("title")}
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href={includeArchived ? "/projects" : "/projects?archived=1"}>
              {includeArchived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
              {includeArchived ? t("hideArchived") : t("showArchived")}
            </Link>
          </Button>
        }
      />

      <section className="mt-6 flex flex-col gap-6">
        {groups.length === 0 ? (
          <SectionCard>
            {canCreate ? (
              clients.length === 0 ? (
                <EmptyState
                  variant="empty"
                  title={t("empty.noClients")}
                  body={t("empty.noClientsDescription")}
                  action={
                    <Button asChild size="sm">
                      <Link href="/clients">{tCommon("add")}</Link>
                    </Button>
                  }
                />
              ) : (
                <EmptyState variant="empty" title={t("empty.title")} body={t("empty.description")} />
              )
            ) : (
              <EmptyState
                variant="forbidden"
                title={t("empty.scoped")}
                body={t("empty.scopedDescription")}
              />
            )}
          </SectionCard>
        ) : (
          groups.map((g) => (
            <div key={g.clientId}>
              <h2 className="mb-2">
                <EntityChip
                  id={g.clientId}
                  name={g.clientName}
                  kind="client"
                  size="md"
                  href={`/clients/${g.clientId}`}
                  className="font-medium"
                />
              </h2>
              <DataTable>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[10ch]">{t("columns.key")}</TableHead>
                      <TableHead>{t("columns.name")}</TableHead>
                      <TableHead>{t("columns.status")}</TableHead>
                      <TableHead>{t("columns.lead")}</TableHead>
                      <TableHead className="text-right">{t("columns.milestones")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {g.projects.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell className="num w-[10ch] font-mono text-xs text-muted-foreground">
                          {p.key}
                        </TableCell>
                        <TableCell className="max-w-80">
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
                        <TableCell className="text-muted-foreground">
                          {p.leadName ?? tCommon("none")}
                        </TableCell>
                        <TableCell className="num text-right">
                          {t("milestonesProgress", {
                            done: p.milestoneDone,
                            total: p.milestoneTotal,
                          })}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </DataTable>
            </div>
          ))
        )}
      </section>

      {canCreate && clients.length > 0 ? (
        <div className="mt-6">
          <SectionCard title={t("create.title")} description={t("create.description")}>
            <CreateProjectForm clients={clients} autoFocus={groups.length === 0} />
          </SectionCard>
        </div>
      ) : null}
    </Page>
  );
}

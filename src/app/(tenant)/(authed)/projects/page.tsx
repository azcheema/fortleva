import type { Metadata } from "next";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  Building2Icon,
  FolderKanbanIcon,
  GlobeIcon,
  PlusIcon,
} from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { isAuthorized } from "@/authz/authorize";
import { listClients } from "@/clients/service";
import {
  DataTable,
  EmptyState,
  EntityChip,
  MemberAvatar,
  Page,
  PageHeader,
  ProgressMeter,
  SectionCard,
  StatusBadge,
} from "@/components/semantic";
import { Badge } from "@/components/ui/badge";
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

/**
 * /projects (UI.md §3.1): one table per client, grouped under that
 * client's own EntityChip, so the identity colour is the thing the eye
 * lands on before it reads a word.
 *
 * The key column is fixed at 10ch of the mono face, so keys of unequal
 * length still form a straight left edge. Milestone progress is a
 * meter whose accessible value is the count beside it, never the bar.
 * Portal state is a BRAND badge with a globe — never the warm fill,
 * which product-wide means "Client can see" and nothing else.
 */
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
  const canCreateHere = canCreate && clients.length > 0;

  return (
    <Page width="wide">
      <PageHeader
        title={t("title")}
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <Link href={includeArchived ? "/projects" : "/projects?archived=1"}>
                {includeArchived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
                {includeArchived ? t("hideArchived") : t("showArchived")}
              </Link>
            </Button>
            {canCreateHere ? (
              <Button asChild size="sm">
                <Link href="#new-project">
                  <PlusIcon />
                  {t("create.title")}
                </Link>
              </Button>
            ) : null}
          </>
        }
      />

      <section className="mt-6 flex flex-col gap-8">
        {groups.length === 0 ? (
          <SectionCard>
            {canCreate ? (
              clients.length === 0 ? (
                <EmptyState
                  variant="empty"
                  icon={Building2Icon}
                  title={t("empty.noClients")}
                  body={t("empty.noClientsDescription")}
                  action={
                    <Button asChild size="sm">
                      <Link href="/clients">{tCommon("add")}</Link>
                    </Button>
                  }
                />
              ) : (
                <EmptyState
                  variant="empty"
                  icon={FolderKanbanIcon}
                  title={t("empty.title")}
                  body={t("empty.description")}
                  action={
                    <Button asChild size="sm">
                      <Link href="#new-project">
                        <PlusIcon />
                        {t("create.title")}
                      </Link>
                    </Button>
                  }
                />
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
            <div key={g.clientId} className="flex flex-col gap-2">
              {/* The count belongs to the group heading, beside the name it
                  counts — not stranded at the far right of the row. */}
              <h2 className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                <EntityChip
                  id={g.clientId}
                  name={g.clientName}
                  kind="client"
                  size="md"
                  href={`/clients/${g.clientId}`}
                  className="font-medium"
                />
                <span className="num shrink-0 text-xs text-muted-foreground">
                  {tCommon("projects", { count: g.projects.length })}
                </span>
              </h2>
              {/* One table per client, stacked — so the columns are pinned
                  rather than measured. With auto layout each group sized
                  its own columns from its own rows and the six headings
                  landed at six different x positions down the page. */}
              <DataTable scrollLabel={g.clientName}>
                <Table className="table-fixed min-w-3xl">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[10ch]">{t("columns.key")}</TableHead>
                      <TableHead className="max-w-[420px]">{t("columns.name")}</TableHead>
                      <TableHead className="w-36">{t("columns.status")}</TableHead>
                      <TableHead priority="low" className="w-28">
                        {t("columns.portal")}
                      </TableHead>
                      <TableHead priority="low" className="w-56">
                        {t("columns.lead")}
                      </TableHead>
                      <TableHead priority="medium" className="w-32 text-right">
                        {t("columns.milestones")}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {g.projects.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell className="num w-[10ch] font-mono text-xs text-muted-foreground">
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
                        {/* Presence, not absence: "Off" and "No lead" on every
                            row is body-weight text that reads as data. A muted
                            dash says the same thing and stops competing with
                            the project name for the eye. */}
                        <TableCell priority="low">
                          {p.portalEnabled ? (
                            <Badge variant="brand">
                              <GlobeIcon aria-hidden="true" />
                              {t("portalState.on")}
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground" title={t("portalState.off")}>
                              {"—"}
                              <span className="sr-only">{t("portalState.off")}</span>
                            </span>
                          )}
                        </TableCell>
                        <TableCell priority="low">
                          {p.leadName ? (
                            <span className="flex min-w-0 items-center gap-2">
                              <MemberAvatar id={p.leadMemberId} name={p.leadName} size="sm" />
                              <span className="truncate">{p.leadName}</span>
                            </span>
                          ) : (
                            <span className="text-muted-foreground" title={t("overview.leadNone")}>
                              {"—"}
                              <span className="sr-only">{t("overview.leadNone")}</span>
                            </span>
                          )}
                        </TableCell>
                        {/* One shape per column: a project with no milestones
                            gets the same meter at zero, not an em-dash. */}
                        <TableCell priority="medium" className="text-right">
                          <ProgressMeter
                            value={p.milestoneDone}
                            total={p.milestoneTotal}
                            label={t("milestonesProgress", {
                              done: p.milestoneDone,
                              total: p.milestoneTotal,
                            })}
                          />
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

      {canCreateHere ? (
        <div className="mt-8">
          <SectionCard
            id="new-project"
            className="scroll-mt-16"
            title={t("create.title")}
            description={t("create.description")}
          >
            <CreateProjectForm clients={clients} autoFocus={groups.length === 0} />
          </SectionCard>
        </div>
      ) : null}
    </Page>
  );
}

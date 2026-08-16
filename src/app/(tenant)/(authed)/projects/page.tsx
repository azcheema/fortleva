import type { Metadata } from "next";
import { ArchiveIcon, ArchiveRestoreIcon, GlobeIcon, PlusIcon } from "lucide-react";
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
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="min-w-0">
                  <EntityChip
                    id={g.clientId}
                    name={g.clientName}
                    kind="client"
                    size="md"
                    href={`/clients/${g.clientId}`}
                    className="font-medium"
                  />
                </h2>
                <span className="num shrink-0 text-xs text-muted-foreground">
                  {tCommon("projects", { count: g.projects.length })}
                </span>
              </div>
              <DataTable>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[10ch]">{t("columns.key")}</TableHead>
                      <TableHead>{t("columns.name")}</TableHead>
                      <TableHead>{t("columns.status")}</TableHead>
                      <TableHead>{t("columns.portal")}</TableHead>
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
                        <TableCell>
                          {p.portalEnabled ? (
                            <Badge variant="brand">
                              <GlobeIcon aria-hidden="true" />
                              {t("portalState.on")}
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground">{t("portalState.off")}</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {p.leadName ? (
                            <span className="flex min-w-0 items-center gap-2">
                              <MemberAvatar id={p.leadMemberId} name={p.leadName} size="sm" />
                              <span className="truncate">{p.leadName}</span>
                            </span>
                          ) : (
                            <span className="text-muted-foreground">{t("overview.leadNone")}</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          {p.milestoneTotal === 0 ? (
                            <span className="text-muted-foreground">{"—"}</span>
                          ) : (
                            <ProgressMeter
                              value={p.milestoneDone}
                              total={p.milestoneTotal}
                              label={t("milestonesProgress", {
                                done: p.milestoneDone,
                                total: p.milestoneTotal,
                              })}
                            />
                          )}
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

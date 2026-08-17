import type { Metadata } from "next";
import { ArchiveIcon, ArchiveRestoreIcon, Building2Icon, PlusIcon, XIcon } from "lucide-react";
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
  SectionCard,
  StatusBadge,
} from "@/components/semantic";
import { AvatarGroup, AvatarGroupCount } from "@/components/ui/avatar";
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
import { cn } from "@/lib/utils";
import { requireTenantContext } from "@/members/tenant-context";

import { CreateClientForm } from "./create-client-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("clients");
  return { title: t("shortTitle") };
}

/**
 * /clients (UI.md §3.1): table + inline create + archived toggle. The
 * list is scoped by the service (deny-default): a member with no
 * assignments sees the "no clients in your scope" empty state; a
 * creator sees the create form.
 *
 * When the archived filter is on it is stated as a CHIP under the
 * header, not merely as a button that swapped its own label (rule 12:
 * filter chips are always visible), and archived rows go quiet so the
 * state survives even when the status column scrolls off a phone.
 */
export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Promise<{ archived?: string }>;
}) {
  const { membership, actor } = await requireTenantContext();
  const { archived } = await searchParams;
  const includeArchived = archived === "1";
  const t = await getTranslations("clients");
  const tCommon = await getTranslations("common");
  const ctx = { tenantId: membership.tenantId, actor };

  const [clients, canCreate] = await Promise.all([
    listClients(ctx, { includeArchived }),
    withTenant(membership.tenantId, { type: "member", id: membership.memberId }, (tx) =>
      isAuthorized(tx, actor, "client:create"),
    ),
  ]);

  return (
    <Page width="wide">
      <PageHeader
        title={t("title")}
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <Link href={includeArchived ? "/clients" : "/clients?archived=1"}>
                {includeArchived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
                {includeArchived ? t("hideArchived") : t("showArchived")}
              </Link>
            </Button>
            {canCreate ? (
              <Button asChild size="sm">
                <Link href="#new-client">
                  <PlusIcon />
                  {t("create.title")}
                </Link>
              </Button>
            ) : null}
          </>
        }
      />

      {includeArchived ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {/* The visible label IS the accessible name (SC 2.5.3); the
              sr-only clause says what activating it does. */}
          <Button asChild variant="outline" size="sm">
            <Link href="/clients">
              {t("filters.archived")}
              <span className="sr-only">{t("filters.clear")}</span>
              <XIcon data-icon="inline-end" aria-hidden="true" />
            </Link>
          </Button>
        </div>
      ) : null}

      <section className="mt-6">
        {clients.length === 0 ? (
          <SectionCard>
            {canCreate ? (
              <EmptyState
                variant="empty"
                icon={Building2Icon}
                title={t("empty.title")}
                body={t("empty.description")}
                action={
                  <Button asChild size="sm">
                    <Link href="#new-client">
                      <PlusIcon />
                      {t("create.title")}
                    </Link>
                  </Button>
                }
              />
            ) : (
              <EmptyState
                variant="forbidden"
                title={t("empty.scoped")}
                body={t("empty.scopedDescription")}
              />
            )}
          </SectionCard>
        ) : (
          <DataTable scrollLabel={t("title")}>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columns.name")}</TableHead>
                  <TableHead>{t("columns.status")}</TableHead>
                  <TableHead priority="medium" className="text-right">
                    {t("columns.projects")}
                  </TableHead>
                  <TableHead priority="low" className="text-right">
                    {t("columns.contacts")}
                  </TableHead>
                  <TableHead priority="low" className="text-right">
                    {t("columns.members")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {clients.map((c) => (
                  <TableRow key={c.id}>
                    {/* Bounded, so a 220px void stops separating a city
                        from the status chip that belongs to it. */}
                    <TableCell className="max-w-[420px]">
                      <span className="flex min-w-0 items-center gap-2">
                        <EntityChip
                          id={c.id}
                          name={c.name}
                          kind="client"
                          href={`/clients/${c.id}`}
                          className={cn(
                            "font-medium",
                            c.status === "ARCHIVED" && "text-muted-foreground",
                          )}
                        />
                        {c.city ? (
                          <span className="shrink-0 text-xs text-muted-foreground">{c.city}</span>
                        ) : null}
                      </span>
                    </TableCell>
                    <TableCell>
                      <StatusBadge domain="clientStatus" value={c.status} />
                    </TableCell>
                    <TableCell priority="medium" className="num text-right">
                      {c.projectCount}
                    </TableCell>
                    <TableCell priority="low" className="num text-right">
                      {c.contactCount}
                    </TableCell>
                    <TableCell priority="low">
                      {c.assignedMembers.length === 0 ? (
                        <span className="flex justify-end text-muted-foreground">
                          {tCommon("none")}
                        </span>
                      ) : (
                        <AvatarGroup className="justify-end">
                          {c.assignedMembers.slice(0, 3).map((m) => (
                            <MemberAvatar key={m.memberId} id={m.memberId} name={m.name} />
                          ))}
                          {c.assignedMembers.length > 3 ? (
                            <AvatarGroupCount>
                              {tCommon("overflow", { count: c.assignedMembers.length - 3 })}
                            </AvatarGroupCount>
                          ) : null}
                        </AvatarGroup>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </DataTable>
        )}
      </section>

      {canCreate ? (
        <div className="mt-6">
          <SectionCard
            id="new-client"
            className="scroll-mt-16"
            title={t("create.title")}
            description={t("create.description")}
          >
            <CreateClientForm autoFocus={clients.length === 0} />
          </SectionCard>
        </div>
      ) : null}
    </Page>
  );
}

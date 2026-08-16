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
    <Page>
      <PageHeader
        title={t("title")}
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href={includeArchived ? "/clients" : "/clients?archived=1"}>
              {includeArchived ? t("hideArchived") : t("showArchived")}
            </Link>
          </Button>
        }
      />

      <section className="mt-6">
        {clients.length === 0 ? (
          canCreate ? (
            <EmptyState title={t("empty.title")} description={t("empty.description")} />
          ) : (
            <EmptyState title={t("empty.scoped")} description={t("empty.scopedDescription")} />
          )
        ) : (
          <div className="overflow-x-auto rounded-md border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("columns.name")}</TableHead>
                  <TableHead>{t("columns.status")}</TableHead>
                  <TableHead className="text-right">{t("columns.projects")}</TableHead>
                  <TableHead className="text-right">{t("columns.contacts")}</TableHead>
                  <TableHead>{t("columns.members")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {clients.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium">
                      <Link href={`/clients/${c.id}`} className="hover:underline">
                        {c.name}
                      </Link>
                      {c.city ? (
                        <span className="ml-2 text-xs text-muted-foreground">{c.city}</span>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <Badge variant={c.status === "ACTIVE" ? "secondary" : "outline"}>
                        {t(`status.${c.status}`)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{c.projectCount}</TableCell>
                    <TableCell className="text-right tabular-nums">{c.contactCount}</TableCell>
                    <TableCell className="max-w-64 truncate text-muted-foreground">
                      {c.assignedMembers.length === 0
                        ? tCommon("none")
                        : c.assignedMembers.map((m) => m.name).join(", ")}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      {canCreate ? (
        <Card size="sm" className="mt-6">
          <CardHeader>
            <CardTitle>{t("create.submit")}</CardTitle>
          </CardHeader>
          <CardContent>
            <CreateClientForm autoFocus={clients.length === 0} />
          </CardContent>
        </Card>
      ) : null}
    </Page>
  );
}

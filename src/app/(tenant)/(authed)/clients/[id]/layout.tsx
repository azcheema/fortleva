import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { Badge } from "@/components/ui/badge";
import { Page, PageHeader } from "@/components/page-header";
import { TabNav } from "@/components/tab-nav";

import { loadClient } from "./data";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const client = await loadClient(id);
  return { title: client.name };
}

/** /clients/[id] shell: name + status, tabs Overview · Projects · Contacts · Files (UI.md §3.1). */
export default async function ClientLayout({
  params,
  children,
}: {
  params: Promise<{ id: string }>;
  children: React.ReactNode;
}) {
  const { id } = await params;
  const client = await loadClient(id);
  const t = await getTranslations("clients");
  const base = `/clients/${client.id}`;

  const tabs = [
    { href: base, label: t("tabs.overview"), exact: true },
    ...(client.caps.viewProjects ? [{ href: `${base}/projects`, label: t("tabs.projects") }] : []),
    { href: `${base}/contacts`, label: t("tabs.contacts") },
    ...(client.caps.viewDocuments || !client.direct
      ? [{ href: `${base}/files`, label: t("tabs.files") }]
      : []),
  ];

  return (
    <Page>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            {client.name}
            {client.status === "ARCHIVED" ? (
              <Badge variant="outline">{t("status.ARCHIVED")}</Badge>
            ) : null}
          </span>
        }
        description={[client.orgNr, client.city].filter(Boolean).join(" · ") || undefined}
      />
      {client.status === "ARCHIVED" ? (
        <p
          role="status"
          className="mt-3 rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground"
        >
          {t("overview.archivedBanner")}
        </p>
      ) : null}
      {!client.direct ? (
        <p role="status" className="mt-3 text-xs text-muted-foreground">
          {t("overview.liftedNotice")}
        </p>
      ) : null}
      <TabNav tabs={tabs} className="mt-4" />
      <div className="mt-4">{children}</div>
    </Page>
  );
}

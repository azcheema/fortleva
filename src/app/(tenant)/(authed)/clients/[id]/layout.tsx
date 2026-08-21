import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { Callout, EntityTile, Page, PageHeader, StatusBadge } from "@/components/semantic";
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

/** /clients/[id] shell: name + status, tabs Overview · Projects · Contacts · Files · Agreements (UI.md §3.1). */
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
    // 2T: Service rows presented as agreements, with their rate cards
    // and this month's consumption (UI.md §3.1).
    ...(client.caps.viewServices ? [{ href: `${base}/agreements`, label: t("tabs.agreements") }] : []),
  ];

  return (
    <Page>
      <PageHeader
        title={
          // No truncate: §9 forbids clipping a title, and PageHeader
          // stacks below md precisely so the h1 can wrap instead.
          <span className="flex min-w-0 items-center gap-2.5">
            <EntityTile id={client.id} name={client.name} size="lg" />
            <span className="min-w-0">{client.name}</span>
          </span>
        }
        badges={<StatusBadge domain="clientStatus" value={client.status} />}
        description={[client.orgNr, client.city].filter(Boolean).join(" · ") || undefined}
      />
      {client.status === "ARCHIVED" ? (
        <Callout tone="caution" role="status" className="mt-4">
          {t("overview.archivedBanner")}
        </Callout>
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

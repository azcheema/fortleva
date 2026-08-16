import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { Badge } from "@/components/ui/badge";
import { Page, PageHeader } from "@/components/page-header";
import { TabNav } from "@/components/tab-nav";

import { loadProject } from "./data";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ key: string }>;
}): Promise<Metadata> {
  const { key } = await params;
  const project = await loadProject(key);
  return { title: `${project.key} · ${project.name}` };
}

/**
 * /projects/[key] shell (UI.md §3.1): tabs in the fixed order Board ·
 * Backlog · Timeline · Files · Team (Updates/Time/Portal arrive with
 * their phases; Board/Backlog are empty states until 2W). Overview is
 * the landing tab in Phase 2 because there is no board to land on.
 */
export default async function ProjectLayout({
  params,
  children,
}: {
  params: Promise<{ key: string }>;
  children: React.ReactNode;
}) {
  const { key } = await params;
  const project = await loadProject(key);
  const t = await getTranslations("projects");
  const base = `/projects/${project.key}`;

  const tabs = [
    { href: base, label: t("tabs.overview"), exact: true },
    { href: `${base}/board`, label: t("tabs.board") },
    { href: `${base}/backlog`, label: t("tabs.backlog") },
    { href: `${base}/timeline`, label: t("tabs.timeline") },
    ...(project.caps.viewDocuments ? [{ href: `${base}/files`, label: t("tabs.files") }] : []),
    { href: `${base}/team`, label: t("tabs.team") },
  ];

  return (
    <Page>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <span className="font-mono text-base text-muted-foreground">{project.key}</span>
            {project.name}
            <Badge variant={project.status === "ACTIVE" ? "secondary" : "outline"}>
              {t(`status.${project.status}`)}
            </Badge>
            {project.portalEnabled ? (
              <Badge className="bg-blue-50 text-blue-700">{t("overview.portalOn")}</Badge>
            ) : null}
          </span>
        }
        description={
          <Link href={`/clients/${project.client.id}`} className="hover:underline">
            {project.client.name}
          </Link>
        }
      />
      {project.status === "ARCHIVED" ? (
        <p
          role="status"
          className="mt-3 rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground"
        >
          {t("overview.archivedBanner")}
        </p>
      ) : null}
      <TabNav tabs={tabs} className="mt-4" />
      <div className="mt-4">{children}</div>
    </Page>
  );
}

import type { Metadata } from "next";
import { ExternalLinkIcon, GlobeIcon } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { Callout, EntityTile, Page, PageHeader, StatusBadge } from "@/components/semantic";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
 *
 * The header is the project's identity in one line: the key in the
 * mono face (it is a code, and it is typed), the name, then the two
 * facts that change how the project behaves — its status and whether a
 * client can reach it at all. The client sits above as an EntityChip,
 * so the workspace colour is present on every tab.
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
    <Page width="wide">
      <PageHeader
        breadcrumb={
          // A trail, not a chip: the client's tile stacked directly above
          // the project's own mark and — in a workspace of one client —
          // resolved to the same square twice. The name is the trail.
          <Link
            href={`/clients/${project.client.id}`}
            className="rounded-sm underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {project.client.name}
          </Link>
        }
        title={
          <span className="flex min-w-0 items-center gap-2.5">
            {/* The project's own mark, the same one its rows wear in every
                list — identity should not vanish on the detail page. */}
            <EntityTile id={project.id} name={project.name} size="lg" />
            <span className="num shrink-0 font-mono text-base text-muted-foreground">
              {project.key}
            </span>
            <span className="truncate">{project.name}</span>
          </span>
        }
        badges={
          <>
            <StatusBadge domain="projectStatus" value={project.status} />
            {/* Portal state is NOT client-visibility: it gets the brand tone and
                its own glyph so it can never be read as the warm "client can
                see" pill (UI.md §10.4 collision rule). §10.4 specifies a badge
                for portal ON only — "off" is the resting state of every
                project and does not need a chip on every tab. */}
            {project.portalEnabled ? (
              <Badge variant="brand">
                <GlobeIcon aria-hidden="true" />
                {t("overview.portalOn")}
              </Badge>
            ) : null}
            {/* Phase 3 slot: <HealthChip value={project.health} /> lands here,
                beside the status, once ProjectUpdate.health exists. */}
          </>
        }
        actions={
          project.productionUrl ? (
            <Button asChild variant="outline" size="sm">
              <a href={project.productionUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLinkIcon />
                {t("overview.openProduction")}
              </a>
            </Button>
          ) : null
        }
      />
      {project.status === "ARCHIVED" ? (
        <Callout tone="caution" role="status" className="mt-4">
          {t("overview.archivedBanner")}
        </Callout>
      ) : null}
      <TabNav tabs={tabs} className="mt-4" />
      <div className="mt-6">{children}</div>
    </Page>
  );
}

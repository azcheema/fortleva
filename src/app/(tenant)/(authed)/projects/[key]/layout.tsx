import type { Metadata } from "next";
import { GlobeIcon } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { Callout, Page, PageHeader, StatusBadge } from "@/components/semantic";
import { Badge } from "@/components/ui/badge";
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
    <Page width="wide">
      <PageHeader
        title={
          <span className="flex min-w-0 items-center gap-2">
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
                see" pill (DESIGN SPEC §2.4 collision rule). */}
            {project.portalEnabled ? (
              <Badge variant="brand">
                <GlobeIcon aria-hidden="true" />
                {t("overview.portalOn")}
              </Badge>
            ) : null}
          </>
        }
        description={
          <Link
            href={`/clients/${project.client.id}`}
            className="rounded-sm hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {project.client.name}
          </Link>
        }
      />
      {project.status === "ARCHIVED" ? (
        <Callout tone="caution" role="status" className="mt-4">
          {t("overview.archivedBanner")}
        </Callout>
      ) : null}
      <TabNav tabs={tabs} className="mt-4" />
      <div className="mt-4">{children}</div>
    </Page>
  );
}

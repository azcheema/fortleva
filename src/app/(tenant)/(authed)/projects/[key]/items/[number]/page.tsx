import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { withTenant } from "@/db";
import { listDocuments, type DocumentListItem } from "@/documents/service";
import { requireTenantContext } from "@/members/tenant-context";
import { readPreferences } from "@/preferences/service";

import { loadProject } from "../../data";
import { ItemPanel } from "../../item-panel/item-panel";
import { loadPanelItem } from "../../item-panel/panel-data";

/**
 * /projects/[key]/items/[number] — the item panel as a PAGE (UI.md §5.4):
 * the same component the peek renders, addressable, linkable and
 * printable, inside the project shell so the tabs stay lit. An unknown
 * number, an item of another project, or one outside this member's scope
 * is a 404 — existence never leaks across the client boundary (§7.3).
 */

const itemNumber = (raw: string): number | null =>
  /^\d{1,9}$/.test(raw) ? Number(raw) : null;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ key: string; number: string }>;
}): Promise<Metadata> {
  const { key, number } = await params;
  const project = await loadProject(key);
  // Validated here too: the title must never name an item key the page
  // itself refuses to render.
  const n = itemNumber(number);
  return { title: n === null ? project.name : `${project.key}-${n} · ${project.name}` };
}

export default async function ProjectItemPage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string; number: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ key, number }, query] = await Promise.all([params, searchParams]);
  const error = typeof query["error"] === "string" ? query["error"] : undefined;
  const n = itemNumber(number);
  if (n === null) notFound();
  const project = await loadProject(key);
  const { membership, actor } = await requireTenantContext();
  const ctx = { tenantId: membership.tenantId, actor };
  const self = `/projects/${project.key}/items/${n}`;
  const tStates = await getTranslations("projects.states.seed");
  const panel = await loadPanelItem(ctx, project.id, n!, self, (seedKey) => tStates(seedKey));
  if (!panel) notFound();
  const { item, states, canEdit, canApprove, canChangeVisibility, members } = panel;

  const [documents, prefs] = await Promise.all([
    project.caps.viewDocuments
      ? listDocuments(ctx, { attachedToWorkItemId: item.id })
      : Promise.resolve([] as DocumentListItem[]),
    withTenant(membership.tenantId, { type: "member", id: membership.memberId }, (tx) =>
      readPreferences(tx, membership.tenantId),
    ),
  ]);

  return (
    <ItemPanel
      surface="page"
      item={item}
      canEdit={canEdit}
      states={states}
      canApprove={canApprove}
      canChangeVisibility={canChangeVisibility}
      members={members}
      itemKey={`${project.key}-${item.number}`}
      projectKey={project.key}
      documents={documents}
      caps={{
        viewDocuments: project.caps.viewDocuments,
        uploadDocuments: project.caps.uploadDocuments && project.status !== "ARCHIVED",
        deleteDocuments: project.caps.deleteDocuments,
        changeDocumentVisibility: project.caps.changeDocumentVisibility,
      }}
      returnTo={self}
      durationStyle={prefs.durationStyle}
      weekStart={prefs.weekStart}
      showIsoWeek={prefs.showIsoWeek}
      error={error}
    />
  );
}

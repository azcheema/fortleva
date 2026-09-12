import { ListIcon } from "lucide-react";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";

import { EmptyState, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { withTenant } from "@/db";
import { listDocuments, type DocumentListItem } from "@/documents/service";
import { requireTenantContext } from "@/members/tenant-context";
import { listHrefOf, peekHrefOf } from "@/lib/work-view";
import { listItems, resolveStateNames } from "@/modules/work";
import { readPreferences } from "@/preferences/service";

import { loadProject } from "../data";
import { ItemPanel } from "../item-panel/item-panel";
import { loadPanelItem } from "../item-panel/panel-data";
import { PeekShell } from "../item-panel/peek-shell";
import { peekItemNumber } from "../item-panel/peek-param";
import { BacklogTable } from "./backlog-table";

/**
 * The project backlog: one ordered list, every property inline-editable
 * (2W core), with the view — filter chips, hide-done, group-by — kept in
 * the URL (2W-F, UI.md rule 6/§5.3).
 *
 * The FILTERS are not read here. `listItems` returns the whole project,
 * so filtering is a client-side predicate and its params are shallow;
 * this page's job is to load the list, resolve the state names once, and
 * hand the client the surface's own PATH so it can rebuild peek links
 * from the live URL. `archived` and `item` stay server params, because
 * both change what has to be loaded.
 */
export default async function ProjectBacklogPage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ key }, query] = await Promise.all([params, searchParams]);
  const archived = typeof query["archived"] === "string" ? query["archived"] : undefined;
  const item = typeof query["item"] === "string" ? query["item"] : undefined;
  const error = typeof query["error"] === "string" ? query["error"] : undefined;
  const project = await loadProject(key);
  const { membership, actor } = await requireTenantContext();
  const includeArchived = archived === "1";
  const ctx = { tenantId: membership.tenantId, actor };
  const base = `/projects/${project.key}/backlog`;
  // Every href on this surface goes through the one serializer: it
  // preserves whatever the member had chosen and puts exactly one `?`
  // in the URL. The hand-written `${listHref}${archived ? "&" : "?"}`
  // this replaces was correct only while one other param could exist.
  const listHref = listHrefOf(base, query);
  const peekNumber = peekItemNumber(item, project.key);
  // Sequential, deliberately (2026-09-12): fetching the list, the
  // preferences and the panel read CONCURRENTLY made the virtualised
  // backlog's window reset to the top after an inline edit's refresh —
  // reproducible in `work.spec.ts`, and one saved round trip is not
  // worth a list that jumps under the member's hands.
  const rawData = await listItems(ctx, project.id, { includeArchived });
  const tStates = await getTranslations("projects.states.seed");
  // ONE scope-checked read, never a lookup in the list: the list is
  // filtered (archived items need `?archived=1`), so an item could be
  // addressed and not open for a reason that is not permission
  // (panel-data.ts).
  const peekItem =
    peekNumber === null
      ? null
      : await loadPanelItem(ctx, project.id, peekNumber, listHref, (seedKey) => tStates(seedKey));
  const prefs = await withTenant(
    membership.tenantId,
    { type: "member", id: membership.memberId },
    (tx) => readPreferences(tx, membership.tenantId),
  );
  const t = await getTranslations("projects.backlog");
  const locale = await getLocale();
  // Stage names resolve HERE, once, at the server boundary — every
  // surface below (columns, cards, the move picker, the side-peek) then
  // receives plain strings. A state still wearing its seeded default
  // renders in the VIEWER's language; a renamed one renders its tenant
  // text, forever (DATA_MODEL §6.14).
  const data = resolveStateNames(rawData, (seedKey) => tStates(seedKey));
  let peekDocuments: DocumentListItem[] = [];
  if (peekItem && project.caps.viewDocuments) {
    peekDocuments = await listDocuments(
      { tenantId: membership.tenantId, actor },
      { attachedToWorkItemId: peekItem.item.id },
    );
  }

  const empty = data.items.length === 0 && !includeArchived;

  return (
    <div className="flex flex-col gap-4">
      {empty && !data.caps.canCreate ? (
        <SectionCard>
          <EmptyState variant="forbidden" icon={ListIcon} title={t("empty.title")} body={t("empty.bodyReadOnly")} />
        </SectionCard>
      ) : (
        <>
          {empty ? (
            <SectionCard>
              <EmptyState
                variant="empty"
                icon={ListIcon}
                title={t("empty.title")}
                body={t("empty.body")}
                action={
                  <Button asChild size="sm">
                    <Link href="#new-task">{t("empty.action")}</Link>
                  </Button>
                }
              />
            </SectionCard>
          ) : null}
          <BacklogTable
            projectId={project.id}
            projectKey={project.key}
            locale={locale}
            data={data}
            durationStyle={prefs.durationStyle}
            basePath={base}
            includeArchived={includeArchived}
          />
        </>
      )}
      {peekItem ? (
        <PeekShell returnHref={listHref}>
          <ItemPanel
            variant="peek"
            item={peekItem.item}
            canEdit={peekItem.canEdit}
            itemKey={`${project.key}-${peekItem.item.number}`}
            projectKey={project.key}
            documents={peekDocuments}
            caps={{
              viewDocuments: project.caps.viewDocuments,
              uploadDocuments: project.caps.uploadDocuments && project.status !== "ARCHIVED",
              deleteDocuments: project.caps.deleteDocuments,
              changeDocumentVisibility: project.caps.changeDocumentVisibility,
            }}
            returnTo={peekHrefOf(base, query, `${project.key}-${peekItem.item.number}`)}
            fullPageHref={`/projects/${project.key}/items/${peekItem.item.number}`}
            durationStyle={prefs.durationStyle}
            error={error}
          />
        </PeekShell>
      ) : null}
    </div>
  );
}

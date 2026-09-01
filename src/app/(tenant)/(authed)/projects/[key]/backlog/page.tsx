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
import { ItemPeek } from "../item-peek/item-peek";
import { PeekShell } from "../item-peek/peek-shell";
import { peekItemNumber } from "../item-peek/peek-param";
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
  const rawData = await listItems(
    { tenantId: membership.tenantId, actor },
    project.id,
    { includeArchived },
  );
  const tStates = await getTranslations("projects.states.seed");
  // Stage names resolve HERE, once, at the server boundary — every
  // surface below (columns, cards, the move picker, the side-peek) then
  // receives plain strings. A state still wearing its seeded default
  // renders in the VIEWER's language; a renamed one renders its tenant
  // text, forever (DATA_MODEL §6.14).
  const data = resolveStateNames(rawData, (seedKey) => tStates(seedKey));
  const prefs = await withTenant(membership.tenantId, { type: "member", id: membership.memberId }, (tx) =>
    readPreferences(tx, membership.tenantId),
  );
  const t = await getTranslations("projects.backlog");
  const locale = await getLocale();

  // The side-peek (2W-B): `?item=KEY-123` resolves against the loaded
  // list — an unknown number or a foreign key is silently no peek.
  const base = `/projects/${project.key}/backlog`;
  // Every href on this surface goes through the one serializer: it
  // preserves whatever the member had chosen and puts exactly one `?`
  // in the URL. The hand-written `${listHref}${archived ? "&" : "?"}`
  // this replaces was correct only while one other param could exist.
  const listHref = listHrefOf(base, query);
  const peekNumber = peekItemNumber(item, project.key);
  const peekItem = peekNumber === null ? undefined : data.items.find((i) => i.number === peekNumber);
  let peekDocuments: DocumentListItem[] = [];
  if (peekItem && project.caps.viewDocuments) {
    peekDocuments = await listDocuments(
      { tenantId: membership.tenantId, actor },
      { attachedToWorkItemId: peekItem.id },
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
          <ItemPeek
            item={peekItem}
            itemKey={`${project.key}-${peekItem.number}`}
            documents={peekDocuments}
            caps={{
              viewDocuments: project.caps.viewDocuments,
              uploadDocuments: project.caps.uploadDocuments && project.status !== "ARCHIVED",
              deleteDocuments: project.caps.deleteDocuments,
              changeDocumentVisibility: project.caps.changeDocumentVisibility,
            }}
            returnTo={peekHrefOf(base, query, `${project.key}-${peekItem.number}`)}
            durationStyle={prefs.durationStyle}
            error={error}
          />
        </PeekShell>
      ) : null}
    </div>
  );
}

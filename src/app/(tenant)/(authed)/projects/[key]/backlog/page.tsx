import { ListIcon } from "lucide-react";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";

import { EmptyState, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { withTenant } from "@/db";
import { listDocuments, type DocumentListItem } from "@/documents/service";
import { requireTenantContext } from "@/members/tenant-context";
import { listItems } from "@/modules/work";
import { readPreferences } from "@/preferences/service";

import { loadProject } from "../data";
import { ItemPeek } from "../item-peek/item-peek";
import { PeekShell } from "../item-peek/peek-shell";
import { peekItemNumber } from "../item-peek/peek-param";
import { BacklogTable } from "./backlog-table";

/**
 * The minimal ordered task list (2W core slice): title-only create,
 * inline state/assignee/estimate/visibility, archive/delete. The full
 * backlog surface (virtualised list, filter chips, group-by, multi-
 * select) and the board arrive with the 2W UX finish; the schema and
 * services beneath are final.
 */
export default async function ProjectBacklogPage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<{ archived?: string; item?: string; error?: string }>;
}) {
  const [{ key }, { archived, item, error }] = await Promise.all([params, searchParams]);
  const project = await loadProject(key);
  const { membership, actor } = await requireTenantContext();
  const includeArchived = archived === "1";
  const data = await listItems(
    { tenantId: membership.tenantId, actor },
    project.id,
    { includeArchived },
  );
  const prefs = await withTenant(membership.tenantId, { type: "member", id: membership.memberId }, (tx) =>
    readPreferences(tx, membership.tenantId),
  );
  const t = await getTranslations("projects.backlog");
  const tProjects = await getTranslations("projects");
  const locale = await getLocale();

  // The side-peek (2W-B): `?item=KEY-123` resolves against the loaded
  // list — an unknown number or a foreign key is silently no peek.
  const base = `/projects/${project.key}/backlog`;
  const listHref = includeArchived ? `${base}?archived=1` : base;
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
            listHref={listHref}
          />
          <p className="text-xs">
            <Link
              className="text-muted-foreground underline-offset-2 hover:underline"
              href={includeArchived ? `/projects/${project.key}/backlog` : `/projects/${project.key}/backlog?archived=1`}
            >
              {includeArchived ? tProjects("hideArchived") : tProjects("showArchived")}
            </Link>
          </p>
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
            returnTo={`${listHref}${includeArchived ? "&" : "?"}item=${project.key}-${peekItem.number}`}
            durationStyle={prefs.durationStyle}
            error={error}
          />
        </PeekShell>
      ) : null}
    </div>
  );
}

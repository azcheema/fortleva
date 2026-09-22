import { KanbanSquareIcon } from "lucide-react";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";

import { EmptyState, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { withTenant } from "@/db";
import { listDocuments, type DocumentListItem } from "@/documents/service";
import { requireTenantContext } from "@/members/tenant-context";
import { projectItemSpent } from "@/modules/time";
import { listItems, projectWorkVersion, resolveStateNames } from "@/modules/work";
import { readPreferences } from "@/preferences/service";
import { cn } from "@/lib/utils";

import { loadProject } from "../data";
import { GROUP_BYS, isGroupBy, listHrefOf, peekHrefOf, workViewHref, type GroupBy } from "@/lib/work-view";

import { ItemPanel } from "../item-panel/item-panel";
import { loadPanelItem, loadPanelTimer } from "../item-panel/panel-data";
import { PeekShell } from "../item-panel/peek-shell";
import { peekItemNumber } from "../item-panel/peek-param";
import { Board } from "./board";

/**
 * /projects/[key]/board (PLAN 2W; UI.md rule 5): columns = the project's
 * states, position = priority, group-by assignee / priority / epic as
 * lanes of the same columns (group-by-assignee IS the team view). The
 * list, the states, the members and the caps come from ONE service read
 * (`listItems`, the backlog's), so both surfaces always agree; the
 * freshness token rides along for the 12 s poll (ARC-18). URL state is
 * `?group=` so every view is a link.
 */
export default async function ProjectBoardPage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ key }, query] = await Promise.all([params, searchParams]);
  const group = typeof query["group"] === "string" ? query["group"] : undefined;
  const item = typeof query["item"] === "string" ? query["item"] : undefined;
  const error = typeof query["error"] === "string" ? query["error"] : undefined;
  const project = await loadProject(key);
  const { membership, actor } = await requireTenantContext();
  const ctx = { tenantId: membership.tenantId, actor };
  const groupBy: GroupBy = isGroupBy(group) ? group : "none";
  // The token is read BEFORE the list on purpose: a write that lands
  // between the two reads then leaves the token older than the list,
  // so the 12 s poll sees a difference and refreshes — the other order
  // would let the board sit stale until the next write.
  const version = await projectWorkVersion(ctx, project.id);
  // The state translator is resolved first so the panel read can run
  // BESIDE the list rather than after it — a peek is one page load, not
  // three serial transactions. The BACKLOG deliberately does NOT do this
  // (see its page): fetching concurrently there made the virtualised
  // list's window jump back to the top after an inline edit's refresh.
  // The board renders no window, and its suite is green on this shape.
  const tStates = await getTranslations("projects.states.seed");
  const peekNumber = peekItemNumber(item, project.key);
  const listHref = listHrefOf(`/projects/${project.key}/board`, query);
  const [rawData, peekItem, timer, spent, t, locale, prefs] = await Promise.all([
    listItems(ctx, project.id),
    // ONE scope-checked read, never a lookup in the list: the board
    // drops archived items, so an archived one could be addressed and
    // not open (panel-data.ts).
    peekNumber === null
      ? Promise.resolve(null)
      : loadPanelItem(ctx, project.id, peekNumber, listHref, (seedKey) => tStates(seedKey)),
    // Always, not only for a peek: a focused card takes `T` too, and its
    // running badge needs the member's timer on the first paint. On a full
    // load or a refresh the timer read is the layout pill's own per-request
    // one (`getCurrentTimerOnce`) and only the `time:track` check is new; on
    // a CLIENT navigation (a peek, `?group=`, board ↔ backlog) the layout
    // does not render, so this is a timer read of its own as well (recorded).
    loadPanelTimer(ctx, project),
    // Σ spent per task for the cards — its own gated read (`time:view_team`
    // for the team figure, `time:track` for the member's own, else null),
    // never a ride on `listItems`, which is `work_item:view` data the
    // backlog shares. One `groupBy`, scope-checked like the Time tab's.
    projectItemSpent(ctx, project.id),
    getTranslations("projects.board"),
    getLocale(),
    withTenant(membership.tenantId, { type: "member", id: membership.memberId }, (tx) =>
      readPreferences(tx, membership.tenantId),
    ),
  ]);
  // Stage names resolve HERE, once, at the server boundary — every
  // surface below (columns, cards, the move picker, the side-peek) then
  // receives plain strings. A state still wearing its seeded default
  // renders in the VIEWER's language; a renamed one renders its tenant
  // text, forever (DATA_MODEL §6.14).
  const data = resolveStateNames(rawData, (seedKey) => tStates(seedKey));
  const empty = data.items.length === 0;

  // The side-peek (2W-B) — same URL contract as the backlog's. One
  // serializer for both work surfaces: it preserves whatever the member
  // had chosen and puts exactly one `?` in the URL (`listHref` above).
  const boardBase = `/projects/${project.key}/board`;
  let peekDocuments: DocumentListItem[] = [];
  if (peekItem && project.caps.viewDocuments) {
    peekDocuments = await listDocuments(
      { tenantId: membership.tenantId, actor },
      { attachedToWorkItemId: peekItem.item.id },
    );
  }

  if (empty && !data.caps.canCreate) {
    return (
      <SectionCard>
        <EmptyState variant="forbidden" icon={KanbanSquareIcon} title={t("empty.title")} body={t("empty.bodyReadOnly")} />
      </SectionCard>
    );
  }

  const base = `/projects/${project.key}/board`;

  return (
    <div className="flex flex-col gap-4">
      <nav aria-label={t("group.label")} className="flex flex-wrap items-center gap-1 text-sm">
        <span className="eyebrow mr-1 text-muted-foreground">{t("group.label")}</span>
        {GROUP_BYS.map((g) => {
          const current = g === groupBy;
          return (
            <Button
              key={g}
              asChild
              size="sm"
              variant={current ? "secondary" : "ghost"}
              className={cn(current && "font-semibold")}
            >
              <Link
                href={workViewHref(base, query, {
                  group: g === "none" ? null : g,
                  item: null,
                  error: null,
                })}
                aria-current={current ? "page" : undefined}
                data-testid={`board-group-${g}`}
              >
                {t(`group.${g}`)}
              </Link>
            </Button>
          );
        })}
      </nav>
      <Board
        projectId={project.id}
        projectKey={project.key}
        locale={locale}
        data={data}
        groupBy={groupBy}
        version={version}
        durationStyle={prefs.durationStyle}
        peekOpen={Boolean(peekItem)}
        timer={timer}
        spent={spent}
      />
      {peekItem ? (
        <PeekShell returnHref={listHref}>
          <ItemPanel
            surface="board"
            item={peekItem.item}
            itemCaps={peekItem.caps}
            states={peekItem.states}
            members={peekItem.members}
            contacts={peekItem.contacts}
            milestones={peekItem.milestones}
            labels={peekItem.labels}
            activity={peekItem.activity}
            subtasks={peekItem.subtasks}
            comments={peekItem.comments}
            itemKey={`${project.key}-${peekItem.item.number}`}
            projectId={project.id}
            projectKey={project.key}
            documents={peekDocuments}
            caps={{
              viewDocuments: project.caps.viewDocuments,
              uploadDocuments: project.caps.uploadDocuments && project.status !== "ARCHIVED",
              deleteDocuments: project.caps.deleteDocuments,
              changeDocumentVisibility: project.caps.changeDocumentVisibility,
            }}
            returnTo={peekHrefOf(boardBase, query, `${project.key}-${peekItem.item.number}`)}
            fullPageHref={`/projects/${project.key}/items/${peekItem.item.number}`}
            durationStyle={prefs.durationStyle}
            weekStart={prefs.weekStart}
            showIsoWeek={prefs.showIsoWeek}
            error={error}
            timer={timer}
          />
        </PeekShell>
      ) : null}
    </div>
  );
}

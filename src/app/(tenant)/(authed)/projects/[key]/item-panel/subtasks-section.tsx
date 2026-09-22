import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { ProgressMeter, SectionCard, StatusIcon, VisibilityBadge, visibilityRowCue } from "@/components/semantic";
import { STATUS_MAP, childTypeOf } from "@/lib/enum-map";
import { cn } from "@/lib/utils";
import { isDone, panelItemHref, panelSurfaceOf } from "@/lib/work-view";
import type { ResolvedItemDetail, ResolvedItemSubtasks } from "@/modules/work";

import { SubtaskAdd } from "./subtask-add";

/**
 * The item panel's Subtasks section (UI.md §5.4, slice 9): the item's
 * live children in the project's one order, each a link to its own
 * panel ON THE SAME SURFACE (`panelItemHref` — the rule the rail's
 * "Part of" link shares): a subtask opened from a peek over the board
 * is a peek over the board, with the member's filters intact; opened
 * from the full page, it is the full page. A row is the state's icon
 * and name, the key, the title (struck when done, as the backlog
 * strikes it), the assignee, and the row's own visibility chip and cue
 * — a child is a class-B row like its parent, and it carries its OWN
 * visibility (§3.1 inheritance: defaulted from the parent at creation,
 * never inherited live).
 *
 * The meter is the plan's progress rule: done over everything not
 * cancelled. The add row is a control only for a member who holds
 * `work_item:create` (the board's "+" rule) and only while the parent
 * is not archived — a live child under an archived parent is a card on
 * the board whose parent the team considers closed. A UI gate, like the
 * panel's upload gate on the PROJECT's status; the service itself does
 * not refuse an archived parent. The section is rendered only for a level
 * that HAS children (`childTypeOf`; `item-panel.tsx`), and its copy is
 * keyed by that child level: an Epic's children are Tasks.
 *
 * The add island sits at ONE position in the tree — after the list,
 * whether or not there is one — and renders the nothing-yet state
 * itself (its button is that state's one verb). Rendered as the empty
 * state's `action` instead, the island moved to a different slot the
 * moment the first row landed, and React remounted it: the field
 * closed, the live region forgot what it was about to say (the first
 * browser run of item-subtasks.spec.ts).
 */
export async function SubtasksSection({
  item,
  itemKey,
  projectId,
  projectKey,
  surface,
  returnTo,
  subtasks,
  canCreate,
}: {
  item: Pick<ResolvedItemDetail, "id" | "number" | "type" | "visibility" | "archivedAt">;
  /** "ACME-12" — named by the visibility hint under the add row. */
  itemKey: string;
  projectId: string;
  projectKey: string;
  surface: "board" | "backlog" | "page";
  /** This panel's own URL — a child's link is this URL re-addressed (peek), or the child's page. */
  returnTo: string;
  subtasks: ResolvedItemSubtasks;
  /** `work_item:create` — whether the add row is a control here. */
  canCreate: boolean;
}) {
  const [t, tCommon] = await Promise.all([getTranslations("projects.item.subtasks"), getTranslations("common")]);
  // The section is not rendered for a level without children; the
  // fallback only satisfies the type.
  const level = childTypeOf(item.type) ?? "SUBTASK";
  const rows = subtasks.rows;

  const add =
    canCreate && !item.archivedAt ? (
      <SubtaskAdd
        key={item.id}
        parentId={item.id}
        parentNumber={item.number}
        parentKey={itemKey}
        parentVisibility={item.visibility}
        projectId={projectId}
        projectKey={projectKey}
        surface={panelSurfaceOf(surface)}
        level={level}
        hasRows={rows.length > 0}
      />
    ) : null;

  return (
    <SectionCard
      id="subtasks"
      title={t(`title.${level}`)}
      actions={
        subtasks.total > 0 ? (
          <ProgressMeter
            value={subtasks.done}
            total={subtasks.total}
            label={t("progress", { done: subtasks.done, total: subtasks.total })}
          />
        ) : null
      }
    >
      <div data-testid="item-subtasks" className="flex flex-col gap-3">
        {/* Two slots, always: the list (or the reader's sentence), then
            the island — so the island's position never changes. */}
        {rows.length === 0 ? (
          add ? null : <p className="text-sm text-muted-foreground">{t(`empty.${level}.title`)}</p>
        ) : (
          <ul className="flex flex-col" data-testid="item-subtask-list">
            {rows.map((row) => {
              const spec = STATUS_MAP.stateCategory[row.stateCategory];
              const done = isDone(row);
              return (
                <li
                  key={row.id}
                  data-testid="item-subtask-row"
                  data-number={row.number}
                  className={cn(
                    "-mx-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-2 py-1.5 text-sm",
                    visibilityRowCue(row.visibility),
                  )}
                >
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <StatusIcon name={spec.icon} className="size-3.5 shrink-0 text-muted-foreground" />
                    <Link
                      href={panelItemHref(surface, returnTo, projectKey, row.number)}
                      className="flex min-w-0 items-baseline gap-2 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    >
                      <span className="num-id shrink-0 text-xs text-muted-foreground">
                        {projectKey}-{row.number}
                      </span>
                      <span className={cn("wrap-anywhere", done ? "text-muted-foreground line-through" : "font-medium")}>
                        {row.title}
                      </span>
                    </Link>
                  </span>
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span data-testid="item-subtask-state">{row.stateName}</span>
                    {row.assigneeName ? <span>{row.assigneeName}</span> : null}
                    {/* Its own sentence, not the bare name: on a line of
                        meta "Astrid Lindqvist" beside a colleague's name
                        says nothing about which side of the glass the
                        work is on — the board card's rule (`card.assigneeContact`). */}
                    {row.assigneeContactName ? (
                      <span>{t("withClient", { name: row.assigneeContactName })}</span>
                    ) : null}
                    {row.archivedAt ? <span>{tCommon("archived")}</span> : null}
                    <VisibilityBadge value={row.visibility} size="sm" />
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {add}
      </div>
    </SectionCard>
  );
}

"use client";

import { PaperclipIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useQueryStates } from "nuqs";
import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import {
  DataTable,
  EmptyState,
  InlineEdit,
  MemberAvatar,
  PriorityIndicator,
  RowActions,
  VisibilityInlineEdit,
  visibilityRowCue,
  type RowAction,
} from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { WorkFilterBar } from "@/components/work-view/filter-bar";
import { isoDateOf, parseEstimateMinutes } from "@/lib/duration";
import { PRIORITIES, type Priority } from "@/lib/enum-map";
import { durationInputText, formatDate, formatDuration, type DurationStyle } from "@/lib/format";
import type { FormResult } from "@/lib/server-actions";
import { cn } from "@/lib/utils";
import {
  canEnterState,
  filtersOf,
  peekHrefOf,
  visibleColumns,
  workView,
  workViewHref,
  workViewParsers,
  type Lane,
  type Rollup,
} from "@/lib/work-view";
import type { ResolvedItemList } from "@/modules/work";

import {
  assignItemAction,
  createItemAction,
  deleteItemAction,
  renameItemAction,
  setItemArchivedAction,
  setItemDueDateAction,
  setItemEstimateAction,
  setItemPriorityAction,
  setItemStateAction,
  setItemVisibilityAction,
} from "./actions";

/**
 * The ordered task list (2W core slice, grown into the full backlog by
 * 2W-F). Every property is an <InlineEdit> — text at rest, the control
 * on click (founder mandate 1); every mutation runs in a transition
 * with a toast on failure so a failed action never looks like a revert.
 *
 * The view — which filters are on, and how the list is grouped — lives
 * in the URL and is read HERE, live, rather than taken as a prop. The
 * filters are shallow (no server round trip: `listItems` already
 * returned the whole project), so the server's `searchParams` is stale
 * the moment a chip is clicked, and a peek link built from a server
 * prop would drop the member's filters on the way back. Reading
 * `useSearchParams()` is the standing trap's own prescription.
 *
 * Virtualisation, rank drag and the multiselect bulk bar are the next
 * slices; the row model they need (`workRows`) is already the shape
 * this renders.
 */

const useRun = (locale: string) => {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<FormResult>, quiet = true) =>
    start(async () => {
      const r = await fn().catch(() => ({ ok: false as const, message: locale }));
      if (!r.ok) toast.error(r.message);
      else if (!quiet) toast.success(r.message);
      router.refresh();
    });
  return { pending, run };
};

/** Every data column except the key — what a group header spans. */
const SPAN_AFTER_KEY = 8;

export function BacklogTable({
  projectId,
  projectKey,
  locale,
  data,
  durationStyle,
  basePath,
  includeArchived,
}: {
  projectId: string;
  projectKey: string;
  locale: string;
  data: ResolvedItemList;
  /** The tenant's `ui.durationStyle` — REQUIRED (standing trap: state a
   * shared component must reflect is never a default). */
  durationStyle: DurationStyle;
  /** The surface's path WITHOUT a query — the peek links rebuild the
   * query from the live URL, never from a server snapshot. */
  basePath: string;
  /** Whether the server loaded archived items too (`?archived=1`). */
  includeArchived: boolean;
}) {
  const t = useTranslations("projects.backlog");
  const tView = useTranslations("projects.workView");
  const tCommon = useTranslations("common");
  const tProjects = useTranslations("projects");
  const tPriority = useTranslations("states.priority");
  const { run } = useRun(t("actionFailed"));
  const searchParams = useSearchParams();
  const [params, setParams] = useQueryStates(workViewParsers, {
    shallow: true,
    history: "replace",
  });

  const filters = filtersOf(params);
  // Rows and summary from ONE call: computed separately they drifted,
  // because an epic is a header rather than a row under epic grouping.
  const { rows, rollup } = workView(data.items, params.group, data.members, filters);
  const peekHref = (number: number) =>
    peekHrefOf(basePath, searchParams, `${projectKey}-${number}`);
  // The archived toggle is a REAL navigation (it changes what the server
  // loads), but its href must still be built from the LIVE url: the
  // filters are shallow, so a server-rendered href would carry the query
  // as it was before the first chip was clicked and silently drop them.
  const archivedHref = workViewHref(basePath, searchParams, {
    archived: includeArchived ? null : "1",
    item: null,
    error: null,
  });

  // The same one rule as every board surface (2W-R): TRIAGE and — for a
  // non-approver — a gated state are not offered; an item ALREADY in a
  // filtered state keeps it via the current-value fallback below, so it
  // stays displayable and reopenable.
  const stateOptions = data.states
    .filter((s) => !s.isHidden && canEnterState(s, data.caps.canApprove))
    .map((s) => ({ value: s.id, label: s.name }));
  const assigneeOptions = [
    { value: "", label: t("unassigned") },
    ...data.members.map((m) => ({ value: m.id, label: m.name })),
  ];
  // "" means NONE so the resting cell shows the muted placeholder, the
  // same convention as the assignee's "" = unassigned.
  const priorityOptions = PRIORITIES.map((p) => ({
    value: p === "NONE" ? "" : p,
    label: tPriority(p),
  }));

  // Things exist, none match: the third empty state (UI.md §5.8), never
  // conflated with "nothing yet" — the verb is to clear the filter, and
  // offering "create the first task" here would be a lie about the list.
  const filteredEmpty = rollup.total > 0 && rollup.shown === 0;

  return (
    <div className="flex flex-col gap-3">
      <WorkFilterBar
        states={visibleColumns(data.states, data.items)}
        members={data.members}
        rollup={rollup}
      />
      <DataTable flush scrollLabel={t("scrollLabel")}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[10ch]">{t("columns.key")}</TableHead>
              <TableHead>{t("columns.title")}</TableHead>
              <TableHead priority="medium" className="w-[14ch]">{t("columns.state")}</TableHead>
              <TableHead priority="low" className="w-[13ch]">{t("columns.priority")}</TableHead>
              <TableHead priority="low" className="w-[16ch]">{t("columns.assignee")}</TableHead>
              <TableHead priority="low" className="w-[9ch] text-right">{t("columns.estimate")}</TableHead>
              <TableHead priority="low" className="w-[12ch]">{t("columns.due")}</TableHead>
              <TableHead priority="medium" className="w-[13ch]">{t("columns.visibility")}</TableHead>
              <TableHead className="w-0 text-right">
                <span className="sr-only">{t("columns.actions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              if (row.kind === "group") {
                return (
                  <GroupRow
                    key={`g:${row.key}`}
                    lane={row.lane}
                    rollup={row.rollup}
                    locale={locale}
                    durationStyle={durationStyle}
                    projectKey={projectKey}
                  />
                );
              }
              const item = row.item;
              const done = item.stateCategory === "DONE" || item.stateCategory === "CANCELLED";
              const actions: RowAction[] = [
                item.archivedAt
                  ? {
                      key: "restore",
                      label: t("actions.restore"),
                      onSelect: () => run(() => setItemArchivedAction(item.id, projectKey, false), false),
                    }
                  : {
                      key: "archive",
                      label: t("actions.archive"),
                      onSelect: () => run(() => setItemArchivedAction(item.id, projectKey, true), false),
                    },
                ...(data.caps.canDelete
                  ? [
                      {
                        key: "delete",
                        label: t("actions.delete"),
                        tone: "danger" as const,
                        confirm: t("actions.confirmDelete"),
                        onSelect: () => run(() => deleteItemAction(item.id, projectKey), false),
                      },
                    ]
                  : []),
              ];
              return (
                <TableRow key={item.id} className={cn(visibilityRowCue(item.visibility))}>
                  <TableCell className="num-id text-muted-foreground">
                    {/* The key IS the link to the item's peek (UI.md §5.4:
                        every peek is a link); the paperclip says the task
                        carries delivered files without opening it. */}
                    <span className="flex items-center gap-1.5">
                      <Link
                        className="underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                        href={peekHref(item.number)}
                      >
                        {projectKey}-{item.number}
                      </Link>
                      {item.attachmentCount > 0 ? (
                        <span
                          data-testid="attachment-count"
                          className="num inline-flex items-center gap-0.5 text-xs"
                          title={t("attachments", { count: item.attachmentCount })}
                        >
                          <PaperclipIcon aria-hidden="true" className="size-3" />
                          <span className="sr-only">{t("attachments", { count: item.attachmentCount })}</span>
                          {item.attachmentCount}
                        </span>
                      ) : null}
                    </span>
                  </TableCell>
                  <TableCell className="min-w-56">
                    <InlineEdit
                      kind="text"
                      name="title"
                      density="table"
                      value={item.title}
                      label={t("titleLabel")}
                      placeholder={t("titleLabel")}
                      readOnly={!data.caps.canEdit}
                      hiddenInput={false}
                      display={
                        <span className={cn("text-sm", done ? "text-muted-foreground line-through" : "font-medium", item.archivedAt ? "opacity-100 text-muted-foreground" : "")}>
                          {item.title}
                        </span>
                      }
                      onCommit={(next) => {
                        if (next.trim() && next !== item.title)
                          run(() => renameItemAction(item.id, projectKey, next));
                      }}
                    />
                  </TableCell>
                  <TableCell priority="medium" data-testid="backlog-state">
                    <InlineEdit
                      kind="select"
                      name="stateId"
                      density="table"
                      fit
                      value={item.stateId}
                      label={t("stateLabel")}
                      placeholder={t("stateLabel")}
                      options={stateOptions.some((o) => o.value === item.stateId)
                        ? stateOptions
                        : [{ value: item.stateId, label: item.stateName }, ...stateOptions]}
                      readOnly={!data.caps.canEdit}
                      hiddenInput={false}
                      display={<span className="text-sm">{item.stateName}</span>}
                      onCommit={(next) => {
                        if (next !== item.stateId) run(() => setItemStateAction(item.id, projectKey, next));
                      }}
                    />
                  </TableCell>
                  <TableCell priority="low" data-testid="backlog-priority">
                    <InlineEdit
                      kind="select"
                      name="priority"
                      density="table"
                      fit
                      value={item.priority === "NONE" ? "" : item.priority}
                      label={t("priorityLabel")}
                      placeholder={tPriority("NONE")}
                      options={priorityOptions}
                      readOnly={!data.caps.canEdit}
                      hiddenInput={false}
                      display={
                        item.priority !== "NONE" ? (
                          <PriorityIndicator value={item.priority as Priority} showLabel />
                        ) : null
                      }
                      onCommit={(next) => {
                        const chosen = next === "" ? "NONE" : next;
                        if (chosen !== item.priority)
                          run(() => setItemPriorityAction(item.id, projectKey, chosen));
                      }}
                    />
                  </TableCell>
                  <TableCell priority="low">
                    <InlineEdit
                      kind="select"
                      name="assigneeMemberId"
                      density="table"
                      fit
                      value={item.assigneeMemberId ?? ""}
                      label={t("assigneeLabel")}
                      placeholder={t("unassigned")}
                      options={assigneeOptions}
                      readOnly={!data.caps.canEdit}
                      hiddenInput={false}
                      display={
                        item.assigneeName ? (
                          <span className="text-sm">{item.assigneeName}</span>
                        ) : null
                      }
                      onCommit={(next) => {
                        if (next !== (item.assigneeMemberId ?? ""))
                          run(() => assignItemAction(item.id, projectKey, next));
                      }}
                    />
                  </TableCell>
                  <TableCell priority="low" className="text-right" data-testid="backlog-estimate">
                    <InlineEdit
                      kind="text"
                      name="estimate"
                      density="table"
                      fit
                      align="end"
                      // The edit seed is the locale-blind "1h 30m" the parser
                      // reads back in every style (format.ts round-trip rule).
                      value={item.estimateMinutes != null ? durationInputText(item.estimateMinutes * 60) : ""}
                      label={t("estimateLabel")}
                      placeholder={t("estimatePlaceholder")}
                      readOnly={!data.caps.canEdit}
                      hiddenInput={false}
                      display={
                        item.estimateMinutes != null ? (
                          <span className="num text-sm">{formatDuration(locale, item.estimateMinutes, durationStyle)}</span>
                        ) : null
                      }
                      onCommit={(next) => {
                        const minutes = parseEstimateMinutes(next);
                        if (minutes === undefined) {
                          toast.error(t("invalidEstimate"));
                          return;
                        }
                        if (minutes !== item.estimateMinutes)
                          run(() => setItemEstimateAction(item.id, projectKey, minutes));
                      }}
                    />
                  </TableCell>
                  <TableCell priority="low" data-testid="backlog-due">
                    <InlineEdit
                      kind="date"
                      name="dueDate"
                      density="table"
                      fit
                      value={item.targetDate ? isoDateOf(item.targetDate) : ""}
                      label={t("dueLabel")}
                      placeholder={t("duePlaceholder")}
                      readOnly={!data.caps.canEdit}
                      hiddenInput={false}
                      // The browser refuses what isIsoDate would (year range),
                      // so a typo year never sits in the cell looking saved.
                      inputProps={{ min: "1970-01-01", max: "2100-12-31" }}
                      display={
                        item.targetDate ? (
                          <span className="num text-sm">
                            {/* @db.Date = UTC midnight: format in UTC or the
                                day shifts west of UTC (review HIGH). */}
                            {formatDate(locale, item.targetDate, {
                              year: "numeric",
                              month: "short",
                              day: "numeric",
                              timeZone: "UTC",
                            })}
                          </span>
                        ) : null
                      }
                      onCommit={(next) => {
                        const current = item.targetDate ? isoDateOf(item.targetDate) : "";
                        if (next !== current)
                          run(() => setItemDueDateAction(item.id, projectKey, next === "" ? null : next));
                      }}
                    />
                  </TableCell>
                  <TableCell priority="medium">
                    <VisibilityInlineEdit
                      value={item.visibility}
                      density="table"
                      fit
                      readOnly={!data.caps.canChangeVisibility}
                      hiddenInput={false}
                      onCommit={(next) => {
                        if (next !== item.visibility)
                          run(() => setItemVisibilityAction(item.id, projectKey, next), false);
                      }}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    {data.caps.canEdit ? (
                      <RowActions
                        label={tCommon("actionsFor", { name: `${projectKey}-${item.number}` })}
                        items={actions}
                      />
                    ) : null}
                  </TableCell>
                </TableRow>
              );
            })}
            {/* The create row stays at the foot of the list even under a
                filter: it is the surface's verb, and a filter that hides
                the way to add work would be the dead end §5.8 forbids.
                A task created here may not match the filter — the
                summary count above says so immediately. */}
            {data.caps.canCreate ? (
              <CreateRow projectId={projectId} projectKey={projectKey} />
            ) : null}
          </TableBody>
        </Table>
      </DataTable>
      <p className="text-xs">
        <Link
          className="text-muted-foreground underline-offset-2 hover:underline"
          href={archivedHref}
          data-testid="backlog-archived-toggle"
        >
          {includeArchived ? tProjects("hideArchived") : tProjects("showArchived")}
        </Link>
      </p>
      {filteredEmpty ? (
        <EmptyState
          variant="filtered"
          title={tView("empty.filteredTitle")}
          body={tView("empty.filteredBody")}
          action={
            <Button
              size="sm"
              variant="outline"
              data-testid="backlog-filtered-clear"
              onClick={() =>
                void setParams({ state: null, assignee: null, priority: null, hideDone: null })
              }
            >
              {tView("empty.filteredAction")}
            </Button>
          }
        />
      ) : null}
    </div>
  );
}

/**
 * A group's header line. It is a row of the same table — one `--row-h`,
 * one spanning cell — so the list keeps a single rhythm and the group
 * label scrolls with the rows it names.
 *
 * The rollup counts the WHOLE group, not the filtered part: a
 * denominator that shrinks when you filter is a lie about the size of
 * the work. `shown` appears beside it only while a filter is hiding
 * something.
 */
function GroupRow({
  lane,
  rollup,
  locale,
  durationStyle,
  projectKey,
}: {
  lane: Lane;
  rollup: Rollup;
  locale: string;
  durationStyle: DurationStyle;
  projectKey: string;
}) {
  const t = useTranslations("projects.workView");
  const tPriority = useTranslations("states.priority");
  const title =
    lane.kind === "member"
      ? lane.name
      : lane.kind === "unassigned"
        ? t("lanes.unassigned")
        : lane.kind === "priority"
          ? tPriority(lane.priority)
          : lane.kind === "epic"
            ? lane.title || t("lanes.epicUntitled")
            : t("lanes.noEpic");

  return (
    <TableRow data-testid="backlog-group" data-lane={lane.key} className="bg-muted/40">
      <TableCell colSpan={SPAN_AFTER_KEY + 1}>
        <span className="flex items-center gap-2">
          {lane.kind === "member" ? <MemberAvatar id={lane.memberId} name={lane.name} size="sm" /> : null}
          {lane.kind === "priority" ? <PriorityIndicator value={lane.priority} /> : null}
          {lane.kind === "epic" && lane.epicKey > 0 ? (
            <span className="num-id text-xs text-muted-foreground">
              {projectKey}-{lane.epicKey}
            </span>
          ) : null}
          <span className="truncate text-sm font-semibold">{title}</span>
          <span className="num text-xs text-muted-foreground">
            {rollup.shown === rollup.total
              ? t("rollup.count", { total: rollup.total })
              : t("rollup.countFiltered", { shown: rollup.shown, total: rollup.total })}
          </span>
          {rollup.done > 0 ? (
            <span className="num text-xs text-muted-foreground">
              {t("rollup.done", { done: rollup.done })}
            </span>
          ) : null}
          {rollup.estimateMinutes > 0 ? (
            <span className="num ml-auto text-xs text-muted-foreground">
              {formatDuration(locale, rollup.estimateMinutes, durationStyle)}
            </span>
          ) : null}
        </span>
      </TableCell>
    </TableRow>
  );
}

/** Title-only create (UI rules 2 + 3): AT REST this row is a button —
 * an always-mounted input in a resting row is the defect the founder
 * mandate exists to prevent (and the visual audit fails on it).
 * Activating swaps in the focused field; Enter creates and STAYS open
 * for the next title; Escape or an empty blur returns to rest.
 * Deliberately not a <form action> — we clear the value on success,
 * React never resets it mid-flight. */
function CreateRow({ projectId, projectKey }: { projectId: string; projectKey: string }) {
  const t = useTranslations("projects.backlog");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = () => {
    const value = title.trim();
    if (!value || pending) return;
    start(async () => {
      const r = await createItemAction(projectId, projectKey, value).catch(() => ({
        ok: false as const,
        message: t("actionFailed"),
      }));
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      setTitle("");
      inputRef.current?.focus();
      router.refresh();
    });
  };

  return (
    <TableRow id="new-task" className="scroll-mt-16">
      <TableCell className="text-muted-foreground" aria-hidden="true">
        <PlusIcon className="size-3.5" />
      </TableCell>
      <TableCell colSpan={SPAN_AFTER_KEY}>
        {editing ? (
          <Input
            ref={inputRef}
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              } else if (e.key === "Escape") {
                setTitle("");
                setEditing(false);
              }
            }}
            onBlur={() => {
              if (title.trim() === "" && !pending) setEditing(false);
            }}
            placeholder={t("createPlaceholder")}
            aria-label={t("createLabel")}
            disabled={pending}
            className="h-7 border-none bg-transparent px-1 shadow-none"
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="flex h-7 w-full items-center rounded-md px-1 text-left text-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {t("empty.action")}
          </button>
        )}
      </TableCell>
    </TableRow>
  );
}

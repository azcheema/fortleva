import type { Metadata } from "next";
import { ListTodoIcon } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { AuthzError } from "@/authz/errors";
import { handleAuthzRedirect } from "@/authz/redirects";
import { EmptyState, EntityTile, MemberAvatar, Page, PageHeader, PriorityGlyph, SectionCard, StatusIcon } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { listDocuments, type DocumentListItem } from "@/documents/service";
import { withTenant } from "@/db";
import { resolveTimeZone } from "@/i18n/resolve";
import { todayIn } from "@/lib/due-date";
import { dateColumn } from "@/lib/duration";
import { STATUS_MAP, type Priority, type StatusValue } from "@/lib/enum-map";
import { dateFormat } from "@/lib/format";
import {
  TASK_LIST_CAP,
  dueBounds,
  groupTasks,
  hasTaskFilters,
  isOverdue,
  parseTaskListParams,
  tasksHref,
  withSelfAsMe,
  type TaskAssignee,
  type TaskListParams,
} from "@/lib/task-list-plan";
import { cn } from "@/lib/utils";
import { requireTenantContext } from "@/members/tenant-context";
import { followMovedKey, listAllTasks, resolveRowState } from "@/modules/work";
import { readOpenSavedView } from "@/modules/work/saved-views";
import { readPreferences } from "@/preferences/service";
import { getProjectByKey, type ProjectDetail } from "@/projects/service";

import { ItemPanel } from "../projects/[key]/item-panel/item-panel";
import { loadPanelItem, loadPanelTimer } from "../projects/[key]/item-panel/panel-data";
import { PeekShell } from "../projects/[key]/item-panel/peek-shell";
import { PeekFocusReturn } from "./peek-focus-return";
import { TaskFilterBar } from "./task-filter-bar";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("tasks");
  return { title: t("title") };
}

type Row = {
  readonly id: string;
  readonly key: string;
  readonly title: string;
  readonly projectId: string;
  readonly projectKey: string;
  readonly projectName: string;
  readonly stateCategory: string;
  readonly stateName: string;
  readonly priority: string;
  readonly dueOn: string | null;
  readonly assignee: TaskAssignee;
  readonly href: string;
};

/**
 * /tasks (slice 130; founder decision C107 — design
 * docs/research/2026-10-17-slice-130-all-tasks-and-lineup-design.md). Every
 * open task in the projects the member reaches, soonest due first (C107 (c)),
 * narrowed by four quick toggles and three pickers, grouped by project or by
 * person on request — and a task opened BESIDE the list (C107 (b)): the
 * backlog's peek, over this page, so the place and the filters are kept.
 *
 * The parameters are read strictly (`parseTaskListParams`), and every link is
 * built from the APPLIED values — a project key or a person the list cannot
 * show is KEPT and matches nothing (slice 136: a saved view must never open as
 * everyone's tasks), its picker naming it as gone. Every word and date is
 * formatted here, on the server, in UTC (a due date is a `@db.Date`): no label
 * can differ between Node's and the browser's ICU on hydration. "Today" is the
 * member's day (`resolveTimeZone`); "this week" is the workspace's
 * (`ui.weekStart`).
 */
export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { membership, actor } = await requireTenantContext();
  const ctx = { tenantId: membership.tenantId, actor };
  const [t, tCommon, tStates, tPriority, locale, timeZone, raw] = await Promise.all([
    getTranslations("tasks"),
    getTranslations("common"),
    getTranslations("projects.states.seed"),
    getTranslations("states.priority"),
    getLocale(),
    resolveTimeZone(),
    searchParams,
  ]);
  const today = todayIn(timeZone);
  const prefs = await withTenant(membership.tenantId, { type: "member", id: membership.memberId }, (tx) =>
    readPreferences(tx, membership.tenantId),
  );
  const params = withSelfAsMe(parseTaskListParams(raw), actor.memberId);

  const read = await listAllTasks(ctx, {
    projectKey: params.project,
    person: params.person,
    due: params.due ? dueBounds(params.due, today, prefs.weekStart) : null,
  });

  if (!read) {
    return (
      <Page>
        <PageHeader title={t("title")} />
        <div className="mt-6">
          <SectionCard>
            <EmptyState variant="forbidden" title={tCommon("forbiddenTitle")} body={t("forbidden")} />
          </SectionCard>
        </div>
      </Page>
    );
  }

  // The saved view the address names (slice 136, C113 (d)) — the reader's own
  // view of this page, or none; a stale or someone else's id is dropped from
  // every link below.
  const openView = await readOpenSavedView(ctx, params.view, { kind: "TASKS", projectId: null });

  // ── the task beside the list (C107 (b)) — the backlog page's loads ──
  // A task that cannot be opened is no peek, silently: a project out of
  // scope, a missing one and a missing number all look the same.
  const peekHref = params.item
    ? tasksHref({ ...params, project: read.projectKey, person: read.person, view: openView?.id ?? null })
    : null;
  let peekProject: ProjectDetail | null = null;
  if (params.item && peekHref) {
    try {
      peekProject = await getProjectByKey(ctx, params.item.projectKey);
    } catch (e) {
      handleAuthzRedirect(e, peekHref); // MFA step-up, if a ✦ code ever gates the read
      if (!(e instanceof AuthzError)) throw e;
    }
  }
  const listBase: TaskListParams = {
    ...params,
    project: read.projectKey,
    person: read.person,
    item: null,
    view: openView?.id ?? null,
  };
  const listHref = tasksHref(listBase);
  const peekItem =
    peekProject && params.item
      ? await loadPanelItem(ctx, peekProject.id, params.item.number, listHref, (seedKey) => tStates(seedKey))
      : null;
  // A task MOVED (slice 131, C108 (c)): its old key opens it under its new
  // one — for a reader who can open it there; anyone else gets no peek.
  if (params.item && peekProject && !peekItem) {
    const moved = await followMovedKey(ctx, peekProject.id, params.item.number);
    if (moved) redirect(tasksHref({ ...listBase, item: { projectKey: moved.projectKey, number: moved.number } }));
  }
  const applied: TaskListParams = { ...listBase, item: peekItem && params.item ? params.item : null };
  const peekTimer = peekItem && peekProject ? await loadPanelTimer(ctx, peekProject) : null;
  let peekDocuments: DocumentListItem[] = [];
  if (peekItem && peekProject?.caps.viewDocuments) {
    peekDocuments = await listDocuments(ctx, { attachedToWorkItemId: peekItem.item.id });
  }
  const error = typeof raw["error"] === "string" ? raw["error"] : undefined;

  const shortDay = dateFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" });
  const longDay = dateFormat(locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const dueText = (iso: string) => (iso.slice(0, 4) === today.slice(0, 4) ? shortDay : longDay).format(dateColumn(iso));
  const collator = new Intl.Collator(locale);

  const rows: Row[] = read.entries.map((entry) => {
    const e = resolveRowState(entry, (seedKey) => tStates(seedKey));
    return {
      id: e.id,
      key: `${e.projectKey}-${e.number}`,
      title: e.title,
      projectId: e.projectId,
      projectKey: e.projectKey,
      projectName: e.projectName,
      stateCategory: e.stateCategory,
      stateName: e.stateName,
      priority: e.priority,
      dueOn: e.dueOn,
      assignee: e.assignee,
      href: tasksHref({ ...listBase, item: { projectKey: e.projectKey, number: e.number } }),
    };
  });
  const groups = applied.group ? groupTasks(rows, applied.group, collator.compare) : [{ key: "all", rows }];
  const people = read.people
    .filter((p) => p.id !== actor.memberId)
    // The id breaks a tie, so two people with one name keep their places between loads.
    .sort((a, b) => collator.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const filtered = hasTaskFilters(applied);
  const personName = (a: TaskAssignee) => (a.kind === "none" ? t("nobody") : a.name);

  const groupHeading = (key: string, sample: Row) => {
    if (applied.group === "project") {
      return (
        <>
          <EntityTile id={sample.projectId} name={sample.projectName} />
          <span className="min-w-0 truncate">{sample.projectName}</span>
        </>
      );
    }
    return key === "none" ? (
      <span>{t("nobody")}</span>
    ) : (
      <>
        {sample.assignee.kind !== "none" ? <MemberAvatar id={sample.assignee.id} name={sample.assignee.name} size="sm" /> : null}
        <span className="min-w-0 truncate">{personName(sample.assignee)}</span>
        {sample.assignee.kind === "contact" ? <span className="shrink-0 font-normal text-muted-foreground">{t("atClient")}</span> : null}
      </>
    );
  };

  return (
    <Page width="wide">
      <PageHeader title={t("title")} description={t("description")} />

      <div className="mt-6">
        <SectionCard contentClassName="p-0">
          <TaskFilterBar
            applied={applied}
            projects={read.projects}
            people={people}
            openView={openView}
            selfId={actor.memberId}
            projectKnown={read.projectKnown}
            personKnown={read.personKnown}
          />
          {read.truncated ? (
            <p className="border-b border-border px-4 py-2 text-sm text-muted-foreground" data-testid="tasks-truncated">
              {t("truncated", { count: TASK_LIST_CAP })}
            </p>
          ) : null}
          <PeekFocusReturn openKey={applied.item ? `${applied.item.projectKey}-${applied.item.number}` : null} label={t("title")}>
            {rows.length === 0 && filtered ? (
              <EmptyState
                variant="filtered"
                title={t("emptyFiltered.title")}
                body={t("emptyFiltered.body")}
                action={
                  <Button asChild size="sm" variant="outline">
                    <Link href={tasksHref({ due: null, person: null, project: null, group: applied.group, item: null, view: applied.view })} data-testid="tasks-clear-filters">
                      {t("clearFilters")}
                    </Link>
                  </Button>
                }
              />
            ) : rows.length === 0 ? (
              // Nothing open anywhere: a task is made in a project — the way there.
              <EmptyState
                variant="empty"
                icon={ListTodoIcon}
                title={t("empty.title")}
                body={t("empty.body")}
                action={
                  <Button asChild size="sm">
                    <Link href="/projects">{t("empty.action")}</Link>
                  </Button>
                }
              />
            ) : (
              <div data-testid="tasks-list">
                {groups.map((group) => (
                  <section
                    key={group.key}
                    data-testid="tasks-group"
                    data-group={group.key}
                    className="border-b border-border last:border-b-0"
                  >
                    {applied.group ? (
                      <h2 className="flex min-w-0 items-center gap-2 px-4 pt-3 pb-1 text-sm font-medium">
                        {groupHeading(group.key, group.rows[0]!)}
                        <span className="num shrink-0 text-xs text-muted-foreground">{group.rows.length}</span>
                      </h2>
                    ) : null}
                    <ul>
                      {group.rows.map((row) => {
                        const state = STATUS_MAP.stateCategory[row.stateCategory as StatusValue<"stateCategory">];
                        const overdue = isOverdue(row.dueOn, today);
                        return (
                          <li key={row.id} data-testid="tasks-row" data-item-id={row.id} className="border-t border-border first:border-t-0 hover:bg-accent">
                            <Link
                              href={row.href}
                              scroll={false}
                              data-task-key={row.key}
                              className="flex min-h-10 min-w-0 items-center gap-3 px-4 py-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                            >
                              {state ? <StatusIcon name={state.icon} aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" /> : null}
                              {/* Below `sm` the title needs the room more than the key does — the peek names it. */}
                              <span className="num-id hidden shrink-0 text-xs text-muted-foreground sm:inline sm:min-w-[10ch]">{row.key}</span>
                              <span className="min-w-0 flex-1 truncate text-sm font-medium" title={row.title}>
                                {row.title}
                              </span>
                              {applied.group !== "project" ? (
                                <>
                                  <span className="hidden w-36 shrink-0 truncate text-xs text-muted-foreground sm:block" title={row.projectName}>
                                    {row.projectName}
                                  </span>
                                  <span className="sr-only sm:hidden">{row.projectName}</span>
                                </>
                              ) : null}
                              {applied.group !== "person" ? (
                                <>
                                  <span className="hidden w-36 shrink-0 items-center gap-1.5 md:flex" data-testid="tasks-row-person">
                                    {row.assignee.kind !== "none" ? (
                                      <MemberAvatar id={row.assignee.id} name={row.assignee.name} size="sm" />
                                    ) : null}
                                    <span
                                      className={cn("min-w-0 truncate text-xs", row.assignee.kind === "none" ? "text-muted-foreground" : "")}
                                      title={personName(row.assignee)}
                                    >
                                      {personName(row.assignee)}
                                    </span>
                                  </span>
                                  <span className="sr-only md:hidden">{personName(row.assignee)}</span>
                                </>
                              ) : null}
                              <span className="hidden w-24 shrink-0 truncate text-xs text-muted-foreground lg:block" title={row.stateName}>
                                {row.stateName}
                              </span>
                              {/* Below `lg` the state is not drawn, and To do and In progress share an icon — so it is still said. */}
                              <span className="sr-only lg:hidden">{row.stateName}</span>
                              {/* A fixed slot, so the dates line up whether or not a row has a priority. */}
                              <span className="inline-flex w-4 shrink-0 items-end justify-center">
                                {row.priority !== "NONE" ? (
                                  <>
                                    <PriorityGlyph value={row.priority as Priority} />
                                    <span className="sr-only">{t("priority", { priority: tPriority(row.priority as Priority) })}</span>
                                  </>
                                ) : null}
                              </span>
                              <span
                                className={cn(
                                  "shrink-0 text-right text-xs whitespace-nowrap tabular-nums sm:w-24",
                                  overdue ? "text-(--tone-danger-fg)" : "text-muted-foreground",
                                )}
                                data-testid="tasks-row-due"
                              >
                                {row.dueOn ? <time dateTime={row.dueOn}>{dueText(row.dueOn)}</time> : null}
                                {overdue ? <span className="sr-only">{t("overdueSuffix")}</span> : null}
                              </span>
                            </Link>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ))}
              </div>
            )}
          </PeekFocusReturn>
        </SectionCard>
      </div>

      {peekItem && peekProject && applied.item ? (
        <PeekShell returnHref={listHref}>
          <ItemPanel
            surface="tasks"
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
            repeat={peekItem.repeat}
            itemKey={`${peekProject.key}-${peekItem.item.number}`}
            projectId={peekProject.id}
            projectKey={peekProject.key}
            documents={peekDocuments}
            caps={{
              viewDocuments: peekProject.caps.viewDocuments,
              uploadDocuments: peekProject.caps.uploadDocuments && peekProject.status !== "ARCHIVED",
              deleteDocuments: peekProject.caps.deleteDocuments,
              changeDocumentVisibility: peekProject.caps.changeDocumentVisibility,
            }}
            returnTo={tasksHref(applied)}
            fullPageHref={`/projects/${peekProject.key}/items/${peekItem.item.number}`}
            durationStyle={prefs.durationStyle}
            weekStart={prefs.weekStart}
            showIsoWeek={prefs.showIsoWeek}
            workspaceTimeZone={prefs.timezone}
            error={error}
            timer={peekTimer}
          />
        </PeekShell>
      ) : null}
    </Page>
  );
}

"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useOptimistic, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { SavedViewControls, type OpenView } from "@/components/work-view/saved-view-controls";
import { canonicalTasksQuery, searchOf } from "@/lib/saved-view-plan";
import { tasksHref, type TaskListParams, type TaskPersonFilter } from "@/lib/task-list-plan";

/**
 * The Tasks page's filters (slice 130; C107 (c) — design §3.3, §3.4): four
 * quick toggles — Overdue, Due this week, Nobody assigned, Mine — and three
 * native selects — project, person, group by (the calendar's filter pattern).
 *
 * The parameters are the server's PARSED ones (`applied`), never the raw URL,
 * and every change navigates to `tasksHref` of them with the peek closed — the
 * server reads each against the member's own scope, so a key or a person typed
 * into the URL matches nothing unless it names one they reach (slice 136; it
 * was no filter before), and its picker names it as gone. The pressed state
 * moves at once (`useOptimistic` inside the transition), so a slow page never
 * looks like a toggle that did not take.
 *
 * Overdue and Due this week are one parameter, as are Mine, Nobody and the
 * person picker: choosing one replaces the other.
 *
 * Saved views (slice 136, C113): "Save view" / "Update view" at the end of the
 * pickers' row, comparing the filters SHOWN (the optimistic ones) with the
 * open view's — so the button answers the press, not the round trip.
 */
export function TaskFilterBar({
  applied,
  projects,
  people,
  openView,
  selfId,
  projectKnown,
  personKnown,
}: {
  applied: TaskListParams;
  /** Every project in scope, by name; the picker is drawn only when there are two or more. */
  projects: readonly { readonly key: string; readonly name: string }[];
  /** The OTHER members assigned to open tasks in scope — "Me" is its own option. */
  people: readonly { readonly id: string; readonly name: string }[];
  /** The reader's own saved view the address names, or null — REQUIRED. */
  openView: OpenView | null;
  /** The reader's member id: their own id as a person filter is "Me" in a view. */
  selfId: string;
  /**
   * False when the APPLIED project / person names none the list can show —
   * an archived project, someone with no open task here (slice 136: kept as
   * a filter that matches nothing). The picker then offers it as gone, so
   * its value is never silently another.
   */
  projectKnown: boolean;
  personKnown: boolean;
}) {
  const t = useTranslations("tasks");
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [shown, setShown] = useOptimistic(applied);

  const go = (patch: Partial<TaskListParams>) => {
    const next: TaskListParams = { ...shown, ...patch, item: null };
    startTransition(() => {
      setShown(next);
      router.push(tasksHref(next), { scroll: false });
    });
  };

  const currentQuery = canonicalTasksQuery(searchOf(tasksHref(shown).split("?")[1] ?? ""), selfId);

  const personValue = shown.person === null ? "" : shown.person.kind === "member" ? shown.person.id : shown.person.kind;
  const personOf = (value: string): TaskPersonFilter | null =>
    value === "" ? null : value === "me" ? { kind: "me" } : value === "none" ? { kind: "none" } : { kind: "member", id: value };

  const toggle = (label: string, pressed: boolean, onPress: () => void, testId: string) => (
    <Button type="button" size="sm" variant={pressed ? "secondary" : "outline"} aria-pressed={pressed} onClick={onPress} data-testid={testId}>
      {label}
    </Button>
  );

  return (
    <div className="flex flex-col gap-3 border-b border-border px-4 py-3" data-testid="tasks-filters">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t("quickFilters")}>
        {toggle(t("filterOverdue"), shown.due === "overdue", () => go({ due: shown.due === "overdue" ? null : "overdue" }), "tasks-filter-overdue")}
        {toggle(t("filterWeek"), shown.due === "week", () => go({ due: shown.due === "week" ? null : "week" }), "tasks-filter-week")}
        {toggle(
          t("filterNobody"),
          shown.person?.kind === "none",
          () => go({ person: shown.person?.kind === "none" ? null : { kind: "none" } }),
          "tasks-filter-nobody",
        )}
        {toggle(
          t("filterMine"),
          shown.person?.kind === "me",
          () => go({ person: shown.person?.kind === "me" ? null : { kind: "me" } }),
          "tasks-filter-mine",
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {projects.length > 1 || (!projectKnown && applied.project !== null) ? (
          <div className="flex min-w-0 items-center gap-2">
            <Label htmlFor="tasks-project" className="text-sm text-muted-foreground">
              {t("projectFilter")}
            </Label>
            <NativeSelect
              id="tasks-project"
              className="w-auto max-w-full"
              value={shown.project ?? ""}
              onChange={(e) => go({ project: e.target.value === "" ? null : e.target.value })}
              data-testid="tasks-project-filter"
            >
              <option value="">{t("allProjects")}</option>
              {!projectKnown && applied.project !== null ? <option value={applied.project}>{t("projectGone")}</option> : null}
              {projects.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name}
                </option>
              ))}
            </NativeSelect>
          </div>
        ) : null}
        <div className="flex min-w-0 items-center gap-2">
          <Label htmlFor="tasks-person" className="text-sm text-muted-foreground">
            {t("personFilter")}
          </Label>
          <NativeSelect
            id="tasks-person"
            className="w-auto max-w-full"
            value={personValue}
            onChange={(e) => go({ person: personOf(e.target.value) })}
            data-testid="tasks-person-filter"
          >
            <option value="">{t("anyone")}</option>
            <option value="me">{t("me")}</option>
            <option value="none">{t("nobody")}</option>
            {!personKnown && applied.person?.kind === "member" ? <option value={applied.person.id}>{t("personGone")}</option> : null}
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <Label htmlFor="tasks-group" className="text-sm text-muted-foreground">
            {t("groupBy")}
          </Label>
          <NativeSelect
            id="tasks-group"
            className="w-auto max-w-full"
            value={shown.group ?? ""}
            onChange={(e) => go({ group: e.target.value === "project" || e.target.value === "person" ? e.target.value : null })}
            data-testid="tasks-group-by"
          >
            <option value="">{t("groupNone")}</option>
            <option value="project">{t("groupProject")}</option>
            <option value="person">{t("groupPerson")}</option>
          </NativeSelect>
        </div>
        <div className="min-w-0 sm:ml-auto">
          <SavedViewControls
            kind="TASKS"
            projectId={null}
            currentQuery={currentQuery}
            openView={openView}
            // The filters SHOWN — a press still navigating included.
            openHref={(id) => tasksHref({ ...shown, item: null, view: id })}
          />
        </div>
      </div>
    </div>
  );
}

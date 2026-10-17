"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useOptimistic, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { tasksHref, type TaskListParams, type TaskPersonFilter } from "@/lib/task-list-plan";

/**
 * The Tasks page's filters (slice 130; C107 (c) — design §3.3, §3.4): four
 * quick toggles — Overdue, Due this week, Nobody assigned, Mine — and three
 * native selects — project, person, group by (the calendar's filter pattern).
 *
 * The parameters are the server's PARSED ones (`applied`), never the raw URL,
 * and every change navigates to `tasksHref` of them with the peek closed — the
 * server reads each against the member's own scope, so a key or a person typed
 * into the URL is no filter unless it names one they reach. The pressed state
 * moves at once (`useOptimistic` inside the transition), so a slow page never
 * looks like a toggle that did not take.
 *
 * Overdue and Due this week are one parameter, as are Mine, Nobody and the
 * person picker: choosing one replaces the other.
 */
export function TaskFilterBar({
  applied,
  projects,
  people,
}: {
  applied: TaskListParams;
  /** Every project in scope, by name; the picker is drawn only when there are two or more. */
  projects: readonly { readonly key: string; readonly name: string }[];
  /** The OTHER members assigned to open tasks in scope — "Me" is its own option. */
  people: readonly { readonly id: string; readonly name: string }[];
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
        {projects.length > 1 ? (
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
      </div>
    </div>
  );
}

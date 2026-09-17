import { ListChecksIcon } from "lucide-react";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";

import { EmptyState, PriorityGlyph, SectionCard, StatusIcon } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { dateColumn } from "@/lib/duration";
import { STATUS_MAP, type Priority, type StatusValue } from "@/lib/enum-map";
import { formatDate } from "@/lib/format";
import { groupQueue, type QueueGroup } from "@/lib/my-work-queue";
import { cn } from "@/lib/utils";
import { itemReturnTo } from "@/lib/work-view/item-surface";

/** One queue row after the page has resolved its state name — plain data, no Dates. */
export type QueueRow = {
  id: string;
  /** `ACME-12` — the key the row shows. */
  key: string;
  number: number;
  title: string;
  projectKey: string;
  projectName: string;
  stateCategory: string;
  stateName: string;
  priority: string;
  /** The due day as an ISO date, or null. */
  targetDate: string | null;
};

/**
 * `/home`'s queue (UI.md rule 8): the member's open assigned tasks in
 * four due-date groups (`lib/my-work-queue.ts` says why four).
 *
 * A SERVER COMPONENT, and the rows are plain links: nothing here edits,
 * so nothing here ships JavaScript. A row opens the task's peek over its
 * project's backlog — the address the inbox links a task by, so the two
 * cards on this page send a member to the same place.
 *
 * Overdue is said twice, never by colour alone (UI.md §9): the group's
 * heading in words, and the danger tone on the heading and its dates.
 *
 * The groups are headed `div`s, not labelled `section`s: four landmark
 * regions on every visit would crowd the landmark list that the h3s
 * already make navigable (review, slice 23).
 */
export async function MyWorkQueue({
  rows,
  truncated,
  today,
}: {
  rows: readonly QueueRow[];
  truncated: boolean;
  /** The member's local date (UI.md §8) — the groups are relative to it. */
  today: string;
}) {
  const [t, tPriority, locale] = await Promise.all([
    getTranslations("home"),
    getTranslations("states.priority"),
    getLocale(),
  ]);
  const groups = groupQueue(rows, today);
  const thisYear = today.slice(0, 4);

  const dueText = (group: QueueGroup, iso: string): string => {
    const day = dateColumn(iso);
    // A @db.Date is a calendar day: formatted in UTC, or it shifts west.
    if (group === "soon") return formatDate(locale, day, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
    return formatDate(locale, day, {
      day: "numeric",
      month: "short",
      ...(iso.slice(0, 4) === thisYear ? {} : { year: "numeric" }),
      timeZone: "UTC",
    });
  };

  return (
    <SectionCard
      title={t("queue")}
      description={t("queueDescription")}
      contentClassName={groups.length > 0 ? "p-0" : undefined}
    >
      {groups.length === 0 ? (
        <EmptyState
          variant="empty"
          icon={ListChecksIcon}
          title={t("queueEmpty.title")}
          body={t("queueEmpty.body")}
          action={
            <Button asChild>
              <Link href="/projects">{t("queueEmpty.action")}</Link>
            </Button>
          }
          className="mx-auto items-center py-8 text-center"
        />
      ) : (
        <div data-testid="home-queue">
          {/* FIRST, beside the headings whose counts it qualifies: the read
              sorts by due date, so a cap cuts from the end — the last group
              drawn may be short and a later one missing entirely, and only
              this sentence can say so (a "N+" on the last heading was wrong
              whenever the cap fell on a group boundary — review, slice 23). */}
          {truncated ? (
            <p data-testid="home-queue-truncated" className="border-b border-border px-4 py-2.5 text-xs text-muted-foreground">
              {t("queueTruncated", { count: rows.length })}
            </p>
          ) : null}
          {groups.map(({ group, rows: groupRows }) => (
            <div
              key={group}
              data-testid="home-queue-group"
              data-group={group}
              className="border-b border-border last:border-b-0"
            >
              <h3
                className={cn(
                  "eyebrow flex items-center gap-1.5 px-4 pt-3 pb-1",
                  group === "overdue" ? "text-(--tone-danger-fg)" : "text-muted-foreground",
                )}
              >
                {t(`queueGroups.${group}`)}
                <span className="num">{groupRows.length}</span>
              </h3>
              <ul>
                {groupRows.map((row) => {
                  const state = STATUS_MAP.stateCategory[row.stateCategory as StatusValue<"stateCategory">];
                  return (
                    <li key={row.id} data-testid="home-queue-row" className="border-t border-border first:border-t-0">
                      <Link
                        href={itemReturnTo("backlog-peek", row.projectKey, row.number)}
                        className="flex min-h-10 items-center gap-3 px-4 py-2 hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                      >
                        {state ? (
                          <StatusIcon name={state.icon} aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                        ) : null}
                        {/* Below `sm` the title needs the room more than the key does — the
                            row still links by it, and the peek names it. */}
                        <span className="num-id hidden shrink-0 text-xs text-muted-foreground sm:inline sm:min-w-[10ch]">{row.key}</span>
                        <span className="min-w-0 flex-1 truncate text-sm font-medium" title={row.title}>
                          {row.title}
                        </span>
                        <span className="hidden w-36 shrink-0 truncate text-xs text-muted-foreground sm:block" title={row.projectName}>
                          {row.projectName}
                        </span>
                        <span className="hidden w-24 shrink-0 truncate text-xs text-muted-foreground md:block" title={row.stateName}>
                          {row.stateName}
                        </span>
                        {/* Below `md` the state is not drawn, and To do and In progress
                            share an icon — so it is still said. */}
                        <span className="sr-only md:hidden">{row.stateName}</span>
                        {/* A fixed slot, so the dates below line up whether or not a row has a priority. */}
                        <span className="inline-flex w-4 shrink-0 items-end justify-center">
                          {row.priority !== "NONE" ? (
                            <>
                              <PriorityGlyph value={row.priority as Priority} />
                              <span className="sr-only">
                                {t("queuePriority", { priority: tPriority(row.priority as Priority) })}
                              </span>
                            </>
                          ) : null}
                        </span>
                        {/* Today's group names its day in the heading; a date there would say it twice.
                            A fixed column from `sm` so dates align; on a phone it takes only what it holds. */}
                        <span
                          className={cn(
                            "shrink-0 text-right text-xs whitespace-nowrap tabular-nums sm:w-20",
                            group === "overdue" ? "text-(--tone-danger-fg)" : "text-muted-foreground",
                          )}
                        >
                          {row.targetDate && group !== "today" ? (
                            <time dateTime={row.targetDate}>{dueText(group, row.targetDate)}</time>
                          ) : null}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

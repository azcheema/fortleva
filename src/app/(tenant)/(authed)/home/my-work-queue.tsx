import { ListChecksIcon } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { EmptyState, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { groupQueue } from "@/lib/my-work-queue";

import type { TimerPillState } from "../time/actions";
import { QueueRows, type QueueRow } from "./queue-rows";

export type { QueueRow } from "./queue-rows";

/**
 * `/home`'s queue (UI.md rule 8): the member's open assigned tasks in
 * four due-date groups (`lib/my-work-queue.ts` says why four).
 *
 * A SERVER COMPONENT around a client list: the card, the empty state and
 * the truncation sentence render here with no JavaScript; the rows are
 * `QueueRows`, which carries the two row verbs (`J K`, `T` and the
 * start-stop button — slice 24) and so the pill's timer facts. A row is
 * a link to the task's peek over its project's backlog — the address the
 * inbox links a task by, so the two cards on this page send a member to
 * the same place.
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
  timer,
}: {
  rows: readonly QueueRow[];
  truncated: boolean;
  /** The member's local date (UI.md §8) — the groups are relative to it. */
  today: string;
  /** The member's timer, or `null` where they can start none (`QueueRows` says what that decides). */
  timer: TimerPillState | null;
}) {
  const t = await getTranslations("home");
  const groups = groupQueue(rows, today);

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
          <QueueRows groups={groups} today={today} timer={timer} />
        </div>
      )}
    </SectionCard>
  );
}

import type { Metadata } from "next";
import {
  ActivityIcon,
  BadgeCheckIcon,
  CircleCheckIcon,
  CirclePlusIcon,
  FileCheckIcon,
  FilePenIcon,
  FileUpIcon,
  FlagIcon,
  InboxIcon,
  MegaphoneIcon,
  MessageSquareIcon,
  PackageCheckIcon,
  RotateCcwIcon,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { getLocale, getTranslations } from "next-intl/server";

import { EmptyState, Page, PageHeader, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { resolveTimeZone } from "@/i18n/resolve";
import { activityHref, groupByDay, parseActivityParams } from "@/lib/activity-plan";
import { todayIn } from "@/lib/due-date";
import { dateColumn, localDateString } from "@/lib/duration";
import { dateFormat } from "@/lib/format";
import { addDays } from "@/lib/week";
import { requireTenantContext } from "@/members/tenant-context";
import { readActivityFeed, type FeedActor, type FeedEvent, type FeedSubject } from "@/modules/work";

import { ActivityFilterBar } from "./activity-filter-bar";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("activity");
  return { title: t("title") };
}

const ICON: Record<FeedEvent["kind"], LucideIcon> = {
  task_added: CirclePlusIcon,
  task_done: CircleCheckIcon,
  client_comment: MessageSquareIcon,
  file_added: FileUpIcon,
  file_decided: FileCheckIcon,
  update_published: MegaphoneIcon,
  milestone_done: FlagIcon,
  version_shipped: PackageCheckIcon,
  version_decided: BadgeCheckIcon,
};

/**
 * /activity (slice 133; founder decision C110 — design
 * docs/research/2026-10-18-slice-133-activity-design.md §3.2). What happened
 * across the projects the member reaches: work and client events, newest
 * first, by day, each naming who did it (C110 (a) — and nothing BY person: no
 * filter, no count), with a project and a client filter and earlier days on
 * request.
 *
 * Server-rendered throughout: every day is formatted HERE in the reader's
 * zone (`resolveTimeZone`), so nothing can differ between Node's and the
 * browser's ICU on hydration. No clock time is shown (see `dayOf`). The parameters are read strictly and every
 * link is built from the APPLIED values.
 */
export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { membership, actor } = await requireTenantContext();
  const ctx = { tenantId: membership.tenantId, actor };
  const [t, tCommon, locale, timeZone, raw] = await Promise.all([
    getTranslations("activity"),
    getTranslations("common"),
    getLocale(),
    resolveTimeZone(),
    searchParams,
  ]);
  const today = todayIn(timeZone);
  const params = parseActivityParams(raw);
  const read = await readActivityFeed(ctx, { params, timeZone, today });

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

  const applied = read.applied;
  const filtered = applied.project !== null || applied.client !== null;
  // The DAY only, never the clock: with a teammate named on each line, times
  // would read as when each was working and "last active" — which
  // SECURITY.md §9.7.3 rules out (the code review's M2). The order within a
  // day is newest first.
  const dayOf = (e: FeedEvent) => localDateString(e.at, timeZone);
  const weekday = dateFormat(locale, { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  const weekdayYear = dateFormat(locale, { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  const shortDay = dateFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" });
  const dayLabel = (day: string): string => {
    if (day === today) return t("today");
    if (day === addDays(today, -1)) return t("yesterday");
    const text = (day.slice(0, 4) === today.slice(0, 4) ? weekday : weekdayYear).format(dateColumn(day));
    return text.charAt(0).toLocaleUpperCase(locale) + text.slice(1);
  };

  const actorName = (a: FeedActor): string => {
    if (a.kind === "system") return t("system");
    if (a.kind === "member") return a.id === actor.memberId ? t("you") : (a.name ?? t("someone"));
    const name = a.name ?? t("someone");
    return a.clientName ? t("contactActor", { name, client: a.clientName }) : name;
  };

  const linkTo = (href: string | null) =>
    function EventLink(chunks: ReactNode) {
      return href ? (
        <Link href={href} className="font-medium underline underline-offset-4">
          {chunks}
        </Link>
      ) : (
        <span className="font-medium">{chunks}</span>
      );
    };
  const who = (chunks: ReactNode) => <span className="font-medium">{chunks}</span>;

  const taskText = (e: FeedEvent, task: { number: number; title: string }) =>
    e.place.projectKey ? `${e.place.projectKey}-${task.number} ${task.title}` : task.title;
  const taskHref = (e: FeedEvent, task: { number: number }) =>
    e.place.projectKey ? `/projects/${e.place.projectKey}/backlog?item=${e.place.projectKey}-${task.number}` : null;
  const filesHref = (e: FeedEvent) =>
    e.place.projectKey ? `/projects/${e.place.projectKey}/files` : e.place.clientId ? `/clients/${e.place.clientId}/files` : "/files";
  const timelineHref = (e: FeedEvent) => (e.place.projectKey ? `/projects/${e.place.projectKey}/timeline` : null);
  const updateHref = (e: FeedEvent, id: string) => (e.place.projectKey ? `/projects/${e.place.projectKey}/updates/${id}` : null);
  const updateText = (seq: number | null, title: string | null) => {
    const label = seq !== null ? t("updateLabel", { seq }) : t("updateNoNumber");
    return title ? `${label}: ${title}` : label;
  };

  const commentSentence = (e: FeedEvent, on: FeedSubject, a: string) => {
    switch (on.type) {
      case "task":
        return t.rich("event.commentTask", { actor: a, task: taskText(e, on.task), who, link: linkTo(taskHref(e, on.task)) });
      case "file":
        return t.rich("event.commentFile", { actor: a, file: on.name, who, link: linkTo(filesHref(e)) });
      case "update":
        return t.rich("event.commentUpdate", { actor: a, update: updateText(on.seq, null), who, link: linkTo(updateHref(e, on.updateId)) });
      case "version":
        return t.rich("event.commentVersion", { actor: a, version: on.version, who, link: linkTo(timelineHref(e)) });
    }
  };

  const sentence = (e: FeedEvent): ReactNode => {
    const a = actorName(e.actor);
    switch (e.kind) {
      case "task_added":
        return t.rich(e.request ? "event.taskRequested" : "event.taskAdded", { actor: a, task: taskText(e, e.task), who, link: linkTo(taskHref(e, e.task)) });
      case "task_done":
        return t.rich("event.taskDone", { actor: a, task: taskText(e, e.task), who, link: linkTo(taskHref(e, e.task)) });
      case "client_comment":
        return commentSentence(e, e.on, a);
      case "file_added":
        return e.version > 1
          ? t.rich("event.fileVersion", { actor: a, n: e.version, file: e.file, who, link: linkTo(filesHref(e)) })
          : t.rich("event.fileAdded", { actor: a, file: e.file, who, link: linkTo(filesHref(e)) });
      case "file_decided":
        return t.rich(e.approved ? "event.fileApproved" : "event.fileChanges", { actor: a, file: e.file, who, link: linkTo(filesHref(e)) });
      case "update_published":
        return t.rich(e.shared ? "event.updateShared" : "event.updateInternal", {
          actor: a,
          update: updateText(e.seq, e.title),
          who,
          link: linkTo(updateHref(e, e.updateId)),
        });
      case "milestone_done":
        return t.rich("event.milestoneDone", { milestone: e.milestone, link: linkTo(timelineHref(e)) });
      case "version_shipped":
        return t.rich("event.versionShipped", { version: e.version, link: linkTo(timelineHref(e)) });
      case "version_decided":
        return t.rich(e.approved ? "event.versionApproved" : "event.versionChanges", { actor: a, version: e.version, who, link: linkTo(timelineHref(e)) });
    }
  };

  const iconOf = (e: FeedEvent): LucideIcon =>
    e.kind === "task_added" && e.request
      ? InboxIcon
      : (e.kind === "file_decided" || e.kind === "version_decided") && !e.approved
        ? e.kind === "file_decided"
          ? FilePenIcon
          : RotateCcwIcon
        : ICON[e.kind];

  const placeOf = (e: FeedEvent): ReactNode =>
    e.place.projectKey && e.place.projectName ? (
      <Link href={`/projects/${e.place.projectKey}`} className="underline-offset-2 hover:underline">
        {e.place.projectName}
      </Link>
    ) : e.place.clientId && e.place.clientName ? (
      <Link href={`/clients/${e.place.clientId}`} className="underline-offset-2 hover:underline">
        {e.place.clientName}
      </Link>
    ) : (
      t("workspace")
    );

  const days = groupByDay(read.events, dayOf);
  const shown = read.window;

  return (
    <Page>
      <PageHeader title={t("title")} description={t("description")} />

      <div className="mt-6">
        <SectionCard contentClassName="p-0">
          <ActivityFilterBar applied={applied} projects={read.projects} clients={read.clients} />
          {days.length === 0 && read.earlier === null && filtered && applied.until === null ? (
            <EmptyState
              variant="filtered"
              title={t("emptyFiltered.title")}
              body={t("emptyFiltered.body")}
              action={
                <Button asChild size="sm" variant="outline">
                  <Link href={activityHref({ project: null, client: null, until: null, skip: 0 })} data-testid="activity-clear-filters">
                    {t("emptyFiltered.clear")}
                  </Link>
                </Button>
              }
            />
          ) : days.length === 0 && read.earlier === null && applied.until === null ? (
            <EmptyState
              variant="empty"
              icon={ActivityIcon}
              title={t("empty.title")}
              body={t("empty.body")}
              action={
                <Button asChild size="sm">
                  <Link href="/projects">{t("empty.action")}</Link>
                </Button>
              }
            />
          ) : (
            <div data-testid="activity-list">
              {days.length === 0 ? (
                <p className="px-4 py-6 text-sm text-muted-foreground" data-testid="activity-nothing">
                  {t("nothingInWindow", { from: shortDay.format(dateColumn(shown.from)), to: shortDay.format(dateColumn(shown.to)) })}
                </p>
              ) : (
                days.map((group) => (
                  <section key={group.day} data-testid="activity-day" data-day={group.day} className="border-b border-border">
                    <h2 className="px-4 pt-4 pb-1 text-sm font-medium">{dayLabel(group.day)}</h2>
                    <ul>
                      {group.events.map((e) => {
                        const Icon = iconOf(e);
                        return (
                          <li key={e.id} className="flex gap-3 px-4 py-2.5" data-testid="activity-event" data-kind={e.kind}>
                            <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                            <div className="min-w-0 flex-1">
                              <p className="text-sm wrap-break-word">{sentence(e)}</p>
                              {e.kind === "client_comment" && e.excerpt ? (
                                <p className="mt-0.5 line-clamp-2 text-sm wrap-break-word text-muted-foreground">{e.excerpt}</p>
                              ) : null}
                              <p className="mt-0.5 text-xs text-muted-foreground">
                                {placeOf(e)}
                              </p>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ))
              )}
              <div className="flex flex-wrap items-center gap-2 px-4 py-3">
                {read.earlier ? (
                  <Button asChild size="sm" variant="outline">
                    <Link href={activityHref({ ...applied, until: read.earlier.until, skip: read.earlier.skip })} data-testid="activity-earlier">
                      {t("earlier")}
                    </Link>
                  </Button>
                ) : (
                  <p className="text-sm text-muted-foreground" data-testid="activity-end">
                    {t("end")}
                  </p>
                )}
                {applied.until ? (
                  <Button asChild size="sm" variant="ghost">
                    <Link href={activityHref({ ...applied, until: null, skip: 0 })} data-testid="activity-today">
                      {t("backToToday")}
                    </Link>
                  </Button>
                ) : null}
              </div>
            </div>
          )}
        </SectionCard>
      </div>
    </Page>
  );
}

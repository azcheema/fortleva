import type { Metadata } from "next";
import { ChevronLeftIcon, ChevronRightIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { AuthzError } from "@/authz/errors";
import { EmptyState, Page, PageHeader, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { withTenant } from "@/db";
import { resolveLocale, resolveTimeZone } from "@/i18n/resolve";
import { localDateString } from "@/lib/duration";
import { dateFormat } from "@/lib/format";
import { addDays, isIsoDate, weekContaining } from "@/lib/week";
import { requireTenantContext } from "@/members/tenant-context";
import {
  getCurrentShift,
  getCurrentTimer,
  getNoticeStatus,
  listMyEntries,
  listMyShifts,
  listWorkTypes,
  type EntryListRow,
} from "@/modules/time";
import { readPreferences } from "@/preferences/service";
import { listProjects } from "@/projects/service";

import { labelOf } from "./label";
import { NewEntryForm } from "./new-entry-form";
import { NoticeGate } from "./notice-gate";
import { QuickStart, type PickerProject } from "./quick-start";
import { ShiftStrip, type ShiftStripShift } from "./shift-strip";
import { TimeWeek, type WeekEntryRow } from "./time-week";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("nav");
  return { title: t("time") };
}

/**
 * /time — My Time (UI.md §3.1, rule 9; PLAN.md 2T screens, D1/D2/D6):
 * today's shift strip (clock in/out, breaks, reconciliation), the quick
 * start, the week grid (continue on every row, inline duration, overlap
 * and review badges) and the New-entry form. Own rows only — the team
 * view is /time/team. The staff notice gates the first timer.
 */
export default async function TimePage({ searchParams }: { searchParams: Promise<{ w?: string }> }) {
  const { membership, actor } = await requireTenantContext();
  const ctx = { tenantId: membership.tenantId, actor };
  const t = await getTranslations("time");
  const tCommon = await getTranslations("common");
  const locale = await resolveLocale();
  const timezone = await resolveTimeZone();
  // Clock labels are formatted HERE, once, with the memoised server
  // formatter — never in the client grid (see TimeWeek's note on ICU).
  const clock = dateFormat(locale, { hour: "2-digit", minute: "2-digit", timeZone: timezone, hourCycle: "h23" });
  const sp = await searchParams;

  const prefs = await withTenant(membership.tenantId, { type: "member", id: membership.memberId }, (tx) =>
    readPreferences(tx, membership.tenantId),
  );
  const today = localDateString(new Date(), timezone);
  const anchor = isIsoDate(sp.w) ? sp.w : today;
  const week = weekContaining(anchor, prefs.weekStart);

  let data: {
    entries: EntryListRow[];
    shifts: Awaited<ReturnType<typeof listMyShifts>>;
    timer: Awaited<ReturnType<typeof getCurrentTimer>>;
    shift: Awaited<ReturnType<typeof getCurrentShift>>;
    notice: Awaited<ReturnType<typeof getNoticeStatus>>;
    workTypes: Awaited<ReturnType<typeof listWorkTypes>>;
    projects: PickerProject[];
  } | null = null;
  try {
    const [entries, shifts, timer, shift, notice, workTypes, groups] = await Promise.all([
      listMyEntries(ctx, { from: week.from, to: week.to }),
      listMyShifts(ctx, { from: week.from, to: week.to }),
      getCurrentTimer(ctx),
      getCurrentShift(ctx),
      getNoticeStatus(ctx, locale),
      listWorkTypes(ctx),
      listProjects(ctx),
    ]);
    data = {
      entries,
      shifts,
      timer,
      shift,
      notice,
      workTypes,
      projects: groups.flatMap((g) =>
        g.projects
          .filter((p) => p.status !== "ARCHIVED")
          .map((p) => ({ id: p.id, key: p.key, name: p.name, clientId: g.clientId, clientName: g.clientName })),
      ),
    };
  } catch (e) {
    if (!(e instanceof AuthzError)) throw e;
  }

  if (!data) {
    return (
      <Page>
        <PageHeader title={t("title")} />
        <div className="mt-6">
          <SectionCard>
            <EmptyState variant="forbidden" title={tCommon("forbiddenTitle")} body={t("noPermission")} />
          </SectionCard>
        </div>
      </Page>
    );
  }

  const { entries, shifts, timer, shift, notice, workTypes, projects } = data;
  const serverNow = timer.serverNow.toISOString();
  const noticeRequired = notice.required && !notice.acknowledged;

  const rows: WeekEntryRow[] = entries.map((e) => ({
    id: e.id,
    date: e.localDate.toISOString().slice(0, 10),
    startedAt: e.startedAt.toISOString(),
    stoppedAt: e.stoppedAt?.toISOString() ?? null,
    durationSeconds: e.durationSeconds,
    label: labelOf(e),
    timeLabel: `${clock.format(e.startedAt)}–${e.stoppedAt ? clock.format(e.stoppedAt) : "…"}`,
    projectKey: e.project?.key ?? null,
    serviceName: e.service?.name ?? null,
    workTypeName: e.workType?.name ?? null,
    billable: e.billable,
    overlaps: e.overlaps,
    needsReview: e.needsReview,
    locked: e.lockedReason !== null,
    entryMode: e.entryMode,
  }));
  // Day headings, formatted once here (server ICU only — see TimeWeek's note).
  const dayLabels = Object.fromEntries(
    week.days.map((d) => [d, dateFormat(locale, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${d}T00:00:00Z`))]),
  );

  const toShift = (s: (typeof shifts)[number]): ShiftStripShift => ({
    id: s.id,
    startedAt: s.startedAt.toISOString(),
    stoppedAt: s.stoppedAt?.toISOString() ?? null,
    workedSeconds: s.workedSeconds,
    needsReview: s.needsReview,
    breaks: s.breaks.map((b) => ({ id: b.id, startedAt: b.startedAt.toISOString(), stoppedAt: b.stoppedAt?.toISOString() ?? null })),
  });
  const shiftsToday = shifts
    .filter((s) => s.localDate.toISOString().slice(0, 10) === today && s.stoppedAt !== null)
    .map(toShift);
  const trackedToday = entries
    .filter((e) => e.localDate.toISOString().slice(0, 10) === today && e.stoppedAt !== null)
    .reduce((s, e) => s + (e.durationSeconds ?? 0), 0);

  const weekLabel = t("weekLabel", { week: week.isoWeek, from: week.from, to: week.to });
  const prev = `/time?w=${addDays(week.from, -7)}`;
  const next = `/time?w=${addDays(week.from, 7)}`;

  return (
    <Page>
      <PageHeader
        title={t("title")}
        description={weekLabel}
        actions={
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="icon-sm" aria-label={t("prevWeek")}>
              <Link href={prev}>
                <ChevronLeftIcon aria-hidden="true" />
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href="/time">{t("thisWeek")}</Link>
            </Button>
            <Button asChild variant="outline" size="icon-sm" aria-label={t("nextWeek")}>
              <Link href={next}>
                <ChevronRightIcon aria-hidden="true" />
              </Link>
            </Button>
            <Button asChild size="sm">
              <Link href="#new-entry">
                <PlusIcon aria-hidden="true" />
                {t("newEntryButton")}
              </Link>
            </Button>
          </div>
        }
      />
      <div className="mt-6 flex flex-col gap-4">
        {noticeRequired && notice.notice ? <NoticeGate notice={notice.notice} /> : null}
        {prefs.time.shiftsEnabled ? (
          <ShiftStrip
            shiftsToday={shiftsToday}
            openShift={shift.shift ? toShift(shift.shift) : null}
            trackedTodaySeconds={trackedToday}
            runningStartedAt={timer.running?.startedAt.toISOString() ?? null}
            serverNow={serverNow}
            durationStyle={prefs.durationStyle}
          />
        ) : null}
        <QuickStart
          running={
            timer.running
              ? {
                  id: timer.running.id,
                  label: labelOf(timer.running),
                  projectKey: timer.running.project?.key ?? null,
                  startedAt: timer.running.startedAt.toISOString(),
                  description: timer.running.description,
                }
              : null
          }
          projects={projects}
          workTypes={workTypes.map((w) => ({ id: w.id, name: w.name }))}
          serverNow={serverNow}
          noticeRequired={noticeRequired}
        />
        <TimeWeek days={week.days} dayLabels={dayLabels} entries={rows} durationStyle={prefs.durationStyle} />
        {noticeRequired ? null : (
          <NewEntryForm today={today} projects={projects} workTypes={workTypes.map((w) => ({ id: w.id, name: w.name }))} />
        )}
      </div>
    </Page>
  );
}


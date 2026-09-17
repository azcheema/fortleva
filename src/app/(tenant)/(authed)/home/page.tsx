import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireMemberSession } from "@/auth/session";
import { Page, PageHeader } from "@/components/semantic";
import { requireTenantContext } from "@/members/tenant-context";
import { isoDateOf } from "@/lib/duration";
import { canTrackTime, getCurrentTimerOnce, myTimeTotals } from "@/modules/time";
import { listMyWork, resolveRowState } from "@/modules/work";
import { inboxGlance } from "@/notify/inbox";

import { getTimerStateAction, type TimerPillState } from "../time/actions";
import { labelOf } from "../time/label";
import { resolveWeekContext } from "../time/week-context";
import { InboxCard } from "./inbox-card";
import { MyWorkQueue, type QueueRow } from "./my-work-queue";
import { HomeTimeStrip, type HomeTimeStripProps } from "./time-strip";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("home");
  return { title: t("title") };
}

const greetingKey = (hour: number): "morning" | "afternoon" | "evening" =>
  hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";

/**
 * /home — "My Work" (UI.md rule 8): the post-login destination.
 *
 * The three em-dash tiles that used to stand here are gone. A tile
 * earns its card when it carries a number that changes; three cards
 * showing "—" were 330px of the first phone screen spent saying
 * nothing. They come back with the numbers, in 2W/2T — the first two
 * are here: this week's and today's OWN hours, with the timer slot
 * (rule 8 "timer slot, this-week hours (own)"), for a member who can
 * track time at all — decided by `canTrackTime` BEFORE any time service
 * runs, so a member or tenant the module is not on for triggers none of
 * its bootstrap on the landing page.
 *
 * THE QUEUE (2W, slice 23): the member's open assigned tasks in due-date
 * groups (`my-work-queue.tsx`), for a member who may view work at all —
 * `listMyWork` answers `null` otherwise and the page draws no card, the
 * strip's rule. ABOVE it, the INBOX CARD: the newest unread
 * notifications, drawn only while something is unread — above, because
 * it is at most five rows and a queue can run to a hundred, which would
 * put the glance two phone screens down (review, slice 23).
 *
 * NOT HERE, ON PURPOSE: rule 8's "waiting on client" and "triage count".
 * Nothing in 2W can put a task in either — no code writes a contact
 * assignee or a `triageStatus` until the portal (Phase 3) — so both would
 * be cards whose number is always zero, the tiles this comment's first
 * paragraph took away. They arrive with the writers that fill them.
 *
 * THE QUEUE'S TIMER (slice 24): the rows carry `T` and a start-stop
 * button, which need the member's timer as the pill sees it. For a member
 * who tracks time that is `getTimerStateAction()` — the SAME per-request
 * snapshot the strip and the layout's pill read (`getCurrentTimerOnce`),
 * not a second query — and `null` otherwise, where the rows show no
 * control and claim no key.
 */
export default async function HomePage() {
  // Still required, and still first: a user with no ACTIVE membership is
  // redirected to the workspace picker rather than shown an empty queue.
  const { membership, actor, userEmail } = await requireTenantContext();
  const ctx = { tenantId: membership.tenantId, actor };
  const [session, t, tStates, { prefs, timezone, today, week, weekLabel }, tracks, myWork, glance] = await Promise.all([
    requireMemberSession(),
    getTranslations("home"),
    getTranslations("projects.states.seed"),
    resolveWeekContext(),
    canTrackTime(ctx),
    listMyWork(ctx),
    inboxGlance(ctx),
  ]);
  const firstName = session.user.name.split(/\s+/)[0] || userEmail;
  // The viewer's clock: Member.timezone → tenant `ui.timezone` → Europe/Stockholm (UI.md §8).
  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: timezone }).format(new Date()));

  let strip: HomeTimeStripProps | null = null;
  let queueTimer: TimerPillState | null = null;
  if (tracks) {
    const [totals, timer, pillState] = await Promise.all([
      myTimeTotals(ctx, { from: week.from, to: week.to, today }),
      getCurrentTimerOnce(ctx.tenantId, ctx.actor.memberId, Boolean(ctx.actor.impersonated)),
      getTimerStateAction(),
    ]);
    queueTimer = pillState;
    strip = {
      weekSeconds: totals.weekSeconds,
      todaySeconds: totals.todaySeconds,
      running: timer.running
        ? (() => {
            // The row's START date decides where its seconds land when it stops — the strip counts it the same way live.
            const startDate = timer.running.localDate.toISOString().slice(0, 10);
            return {
              startedAt: timer.running.startedAt.toISOString(),
              label: labelOf(timer.running),
              countsToday: startDate === today,
              countsThisWeek: startDate >= week.from && startDate <= week.to,
            };
          })()
        : null,
      serverNow: timer.serverNow.toISOString(),
      durationStyle: prefs.durationStyle,
      weekLabel,
    };
  }

  const queue: QueueRow[] | null = myWork
    ? myWork.items.map((item) => {
        const row = resolveRowState(item, (seedKey) => tStates(seedKey));
        return {
          id: row.id,
          key: `${row.projectKey}-${row.number}`,
          number: row.number,
          title: row.title,
          projectKey: row.projectKey,
          projectName: row.projectName,
          stateCategory: row.stateCategory,
          stateName: row.stateName,
          priority: row.priority,
          targetDate: row.targetDate ? isoDateOf(row.targetDate) : null,
        };
      })
    : null;

  return (
    <Page>
      {/* No "Workspace: {name}" subtitle: the header says it 60px above. */}
      <PageHeader title={t(`greeting.${greetingKey(hour)}`, { name: firstName })} />

      <div className="mt-6 flex flex-col gap-4">
        {strip ? <HomeTimeStrip {...strip} /> : null}
        {/* On ROWS, not the count: the two are separate statements, so the
            count can disagree with the rows by a notification read or written
            between them — this guard only keeps that from drawing an EMPTY card. */}
        {glance.rows.length > 0 ? <InboxCard glance={glance} serverNow={new Date().toISOString()} /> : null}
        {queue && myWork ? <MyWorkQueue rows={queue} truncated={myWork.truncated} today={today} timer={queueTimer} /> : null}
      </div>
    </Page>
  );
}

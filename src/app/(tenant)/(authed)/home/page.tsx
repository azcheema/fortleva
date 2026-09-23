import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";

import { requireMemberSession } from "@/auth/session";
import { Page, PageHeader } from "@/components/semantic";
import { requireTenantContext } from "@/members/tenant-context";
import { isoDateOf } from "@/lib/duration";
import { canTrackTime, getCurrentTimerOnce, myTimeTotals } from "@/modules/time";
import { listMyWork, resolveRowState, triageGlance, waitingOnClient } from "@/modules/work";
import { inboxGlance } from "@/notify/inbox";

import { getTimerStateAction, type TimerPillState } from "../time/actions";
import { labelOf } from "../time/label";
import { resolveWeekContext } from "../time/week-context";
import { InboxCard } from "./inbox-card";
import { MyWorkQueue, type QueueRow } from "./my-work-queue";
import { TriageCard } from "./triage-card";
import { WaitingCard } from "./waiting-card";
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
 * THE TRIAGE COUNT (Phase 3, slice 6c): rule 8's, and it waited here
 * for a writer since 2W. This comment used to say it and "waiting on
 * client" were absent on purpose, because nothing could put a task in
 * either and both would have been cards whose number is always zero —
 * the tiles the first paragraph took away. Slice 6a's portal intake
 * gave `triageStatus` its writer and 6b gave the requests a lane to be
 * answered in, so the count arrives now: `triageGlance` answers `null`
 * without `work_item:triage`, and the card is drawn only while
 * something is actually waiting (the inbox card's rule).
 *
 * WAITING ON CLIENT (Phase 3, slice 6c's third commit): rule 8's last
 * card, and the one that waited longest. This comment used to say it was
 * absent because `assigneeContactId` had no writer; 6c's first commit
 * gave it one, its second gave the member plane a surface that lists
 * contact-assigned work, and its third gave the client a way to hand a
 * task back. So the card arrives whole, in two groups: what the client
 * says is done (waiting on YOU) and what is still with them. `null`
 * without `work_item:view` + `project:view`, the queue's rule, and drawn
 * only while it has a row.
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
  const [session, t, tStates, { prefs, timezone, today, week, weekLabel }, tracks, myWork, glance, triage, waiting] =
    await Promise.all([
      requireMemberSession(),
      getTranslations("home"),
      getTranslations("projects.states.seed"),
      resolveWeekContext(),
      canTrackTime(ctx),
      listMyWork(ctx),
      inboxGlance(ctx),
      triageGlance(ctx),
      waitingOnClient(ctx),
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
        {/* ABOVE the queue and BELOW the inbox: a client waiting on an
            answer outranks the member's own list — nobody else is going
            to notice it — while the inbox stays first because it is at
            most five rows and already has that place.

            ON THE ROWS, NOT ON `total`, and a code review caught the
            first cut doing the opposite while a comment here claimed
            this. Gating on `total` is what PRODUCES an empty card: a
            glance whose every project fell out of the name lookup would
            render a heading, "3 requests waiting for an answer", an
            empty list and a stray "1 more project" line — a number with
            no way to act on it, the §5.8 failure this card's own
            docblock says it prevents. It should be unreachable now that
            the lookup carries the member's scope, which is exactly why
            the guard is on the thing the member can actually use. */}
        {triage && triage.projects.length > 0 ? <TriageCard glance={triage} /> : null}
        {/* BELOW triage, ABOVE the member's own queue. A client's
            unanswered REQUEST outranks this, because nothing has been
            agreed there at all; but work the client has handed back
            outranks the member's own list, because nobody else is going
            to notice it either. ON THE ROWS, never on a count — the
            triage card's own lesson: a heading with an empty list under
            it is the §5.8 failure these cards exist to avoid. */}
        {waiting && (waiting.ticked.length > 0 || waiting.waiting.length > 0) ? (
          <WaitingCard glance={waiting} />
        ) : null}
        {queue && myWork ? <MyWorkQueue rows={queue} truncated={myWork.truncated} today={today} timer={queueTimer} /> : null}
      </div>
    </Page>
  );
}

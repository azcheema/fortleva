import type { Metadata } from "next";
import { InboxIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { requireMemberSession } from "@/auth/session";
import { EmptyState, Page, PageHeader, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { requireTenantContext } from "@/members/tenant-context";
import { canTrackTime, getCurrentTimerOnce, myTimeTotals } from "@/modules/time";

import { labelOf } from "../time/label";
import { resolveWeekContext } from "../time/week-context";
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
 * The queue's empty state offers ONE verb (§5.8), and it is a create
 * verb — the two buttons it replaced were copies of two rail items
 * sitting 200px to the left.
 */
export default async function HomePage() {
  // Still required, and still first: a user with no ACTIVE membership is
  // redirected to the workspace picker rather than shown an empty queue.
  const { membership, actor, userEmail } = await requireTenantContext();
  const ctx = { tenantId: membership.tenantId, actor };
  const [session, t, { prefs, timezone, today, week, weekLabel }, tracks] = await Promise.all([
    requireMemberSession(),
    getTranslations("home"),
    resolveWeekContext(),
    canTrackTime(ctx),
  ]);
  const firstName = session.user.name.split(/\s+/)[0] || userEmail;
  // The viewer's clock: Member.timezone → tenant `ui.timezone` → Europe/Stockholm (UI.md §8).
  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: timezone }).format(new Date()));

  let strip: HomeTimeStripProps | null = null;
  if (tracks) {
    const [totals, timer] = await Promise.all([
      myTimeTotals(ctx, { from: week.from, to: week.to, today }),
      getCurrentTimerOnce(ctx.tenantId, ctx.actor.memberId, Boolean(ctx.actor.impersonated)),
    ]);
    strip = {
      weekSeconds: totals.weekSeconds,
      todaySeconds: totals.todaySeconds,
      running: timer.running
        ? {
            startedAt: timer.running.startedAt.toISOString(),
            // The row's START date decides where its seconds land when it stops — the strip counts it the same way live.
            localDate: timer.running.localDate.toISOString().slice(0, 10),
            label: labelOf(timer.running),
          }
        : null,
      serverNow: timer.serverNow.toISOString(),
      today,
      weekFrom: week.from,
      weekTo: week.to,
      durationStyle: prefs.durationStyle,
      weekLabel,
    };
  }

  return (
    <Page>
      {/* No "Workspace: {name}" subtitle: the header says it 60px above. */}
      <PageHeader title={t(`greeting.${greetingKey(hour)}`, { name: firstName })} />

      <div className="mt-6 flex flex-col gap-4">
        {strip ? <HomeTimeStrip {...strip} /> : null}
        <SectionCard title={t("queue")} description={t("queueDescription")}>
          <EmptyState
            variant="empty"
            icon={InboxIcon}
            title={t("empty.title")}
            body={t("empty.description")}
            action={
              <Button asChild>
                <Link href="/clients#new-client">
                  <PlusIcon />
                  {t("empty.action")}
                </Link>
              </Button>
            }
            className="mx-auto items-center py-8 text-center"
          />
        </SectionCard>
      </div>
    </Page>
  );
}

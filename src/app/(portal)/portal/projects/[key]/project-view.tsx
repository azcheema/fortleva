import Link from "next/link";
import { getLocale, getTimeZone, getTranslations } from "next-intl/server";

import { Callout, HealthChip, Page, PageHeader, ProgressMeter, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { formatDay } from "@/lib/format";
import { listPortalTasks, listPortalTimeline, listPortalUpdates } from "@/modules/work";
import { portalReadOrNull, type PortalPrincipal } from "@/portal";
import { findPortalProjectByKey, readPortalProjectSummary } from "@/projects/portal";

import { PortalFrame } from "../../portal-frame";
import { LatestUpdate, PortalTasksEmpty, ProjectTasks, TaskRow, isWaitingOnYou } from "../../task-list";
import { PortalTimeline } from "./project-timeline";

/**
 * THE ONE-SCREEN PROJECT PAGE, AS A COMPONENT (UI.md §4: "this exact
 * order") — everything `/portal/projects/[key]` is, minus the decision
 * about who is asking.
 *
 * It is a component and not a page for the reason `<PortalHome>` is:
 * View-as-Contact renders it too, under a synthesised principal, at
 * `/view-as/projects/[key]`, and `e2e/view-as.spec.ts` compares the two
 * renderings byte for byte. ONE component, two routes, differing in how
 * the principal was obtained and in nothing else. So nothing in here may
 * reach for a request context — the contact's name comes in as a prop,
 * their language and time zone are the whole request's — and the
 * project is resolved INSIDE from the key, so the two routes cannot
 * hand it two different projects.
 *
 * THE ORDER IS THE SPEC'S: header (name, health, phase and next
 * milestone, progress) → what is waiting on the reader → the latest
 * update → the timeline → the shared tasks by category. Files and
 * deliverables, the hours widget and version sign-off are the slices
 * after this one; requests are already on the task list under
 * "Requested" (UI.md §11's sixth category).
 *
 * FIVE SEQUENTIAL READS, five transactions, each through
 * `portalReadOrNull` — never `Promise.all`, for the reason
 * `portal-home.tsx` gives (two independent transactions that both
 * reject with something other than `AuthzError` would leave one an
 * unhandled rejection). And every refusal is the plane's one uniform
 * empty page: a key that is not this client's, a project switched off,
 * an archived one and a project with nothing shared all render the same
 * `PortalTasksEmpty`, because a reason is a fact about the agency
 * (`src/portal/render.ts`).
 *
 * THE HEALTH IS THE NEWEST PUBLISHED POST'S, read once and used twice —
 * the chip beside the name and the post under the header — so the two
 * cannot disagree. A project with no post yet has no chip: health is
 * human-chosen on a post, never computed (DATA_MODEL §6.16), and an
 * inferred "on track" would be the agency's word put in its mouth.
 */
export async function PortalProjectView({
  principal,
  name,
  projectKey,
}: {
  principal: PortalPrincipal;
  name: string;
  projectKey: string;
}) {
  const t = await getTranslations("portal");
  const locale = await getLocale();
  // The request's zone — the product default on the portal plane, and
  // pinned to the same on `/view-as` — decides which day is "today" for
  // the header's "next milestone".
  const timeZone = await getTimeZone();

  const project = await portalReadOrNull("findPortalProjectByKey", () =>
    findPortalProjectByKey(principal, projectKey),
  );
  const summary = project
    ? await portalReadOrNull("readPortalProjectSummary", () =>
        readPortalProjectSummary(principal, project.id, { timeZone }),
      )
    : null;
  const updates = project
    ? await portalReadOrNull("listPortalUpdates", () =>
        listPortalUpdates(principal, { projectId: project.id, latestOnly: true }),
      )
    : null;
  const timeline = project
    ? await portalReadOrNull("listPortalTimeline", () => listPortalTimeline(principal, { projectId: project.id }))
    : null;
  const list = project
    ? await portalReadOrNull("listPortalTasks", () => listPortalTasks(principal, { projectId: project.id }))
    : null;

  const latest = updates?.[0] ?? null;
  const tasks = list?.projects[0] ?? null;
  const waiting = tasks?.tasks.filter(isWaitingOnYou) ?? [];
  const events = timeline?.entries ?? [];
  // THE EMPTY STATE IS FOR A PAGE WITH NO PLAN EITHER. A project whose
  // only shared rows are undated open milestones has a header — the
  // phase, the meter — and no section to draw under it, and that is
  // rendered as exactly that: the plan, and nothing else yet. Drawing
  // "Nothing shared with you yet" under a meter that counts shared
  // milestones would be the page contradicting itself (a review asked
  // the question; this is the answer, on purpose).
  const nothing = !latest && events.length === 0 && !tasks && !(summary && summary.milestones.total > 0);

  // The header's one sentence, built from the summary's two facts. The
  // phase's own end is the next thing due when they are the same row,
  // and that reads as one fact, not two.
  const phase = summary?.phase ?? null;
  const next = summary?.nextMilestone ?? null;
  const facts: string[] = [];
  if (phase) facts.push(t("project.phase", { name: phase.name }));
  // `formatDay`, not `formatDate`: a milestone's due date is a day encoded
  // as UTC midnight, and the task list's `targetDate` takes the same
  // formatter for the same reason.
  if (next && phase && next.id === phase.id) facts.push(t("project.phaseDue", { date: formatDay(locale, next.dueAt) }));
  else if (next) facts.push(t("project.nextMilestone", { name: next.name, date: formatDay(locale, next.dueAt) }));

  return (
    <PortalFrame name={name}>
      <Page>
        <div className="flex flex-col gap-6">
          <PageHeader
            title={project ? project.name : t("project.title")}
            badges={latest ? <HealthChip value={latest.health} /> : null}
            description={
              project && (facts.length > 0 || (summary && summary.milestones.total > 0)) ? (
                <span data-slot="portal-project-facts" className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  {facts.map((fact) => (
                    <span key={fact}>{fact}</span>
                  ))}
                  {summary && summary.milestones.total > 0 ? (
                    <ProgressMeter
                      value={summary.milestones.done}
                      total={summary.milestones.total}
                      label={t("project.milestonesProgress", summary.milestones)}
                    />
                  ) : null}
                </span>
              ) : undefined
            }
            actions={
              <Button asChild variant="outline" size="sm">
                {/* No prefetch: rendered on the member plane too (View-as). */}
                <Link href="/portal" prefetch={false}>
                  {t("project.back")}
                </Link>
              </Button>
            }
          />

          {!project || nothing ? (
            <PortalTasksEmpty />
          ) : (
            <>
              {/* 2. WHAT IS WAITING ON THE READER — the same rows the
                  category list below draws, with the same tick, listed
                  first because "what do you need from me" is the
                  question this page answers before the other two. Only
                  where it would work: `isWaitingOnYou` is the tick's own
                  predicate. Absent when nothing is. */}
              {waiting.length > 0 ? (
                <SectionCard
                  title={t("actionItems.title")}
                  description={t("actionItems.description")}
                  contentClassName="p-4"
                >
                  <ul data-slot="portal-action-items" className="flex flex-col gap-2">
                    {waiting.map((task) => (
                      <TaskRow key={task.id} task={task} />
                    ))}
                  </ul>
                </SectionCard>
              ) : null}

              {/* 3. THE LATEST UPDATE — the card the `/portal` home
                  draws, with its "All updates" link. */}
              {latest ? (
                <SectionCard contentClassName="p-0">
                  <LatestUpdate update={latest} />
                </SectionCard>
              ) : null}

              {/* 4. THE TIMELINE. Omitted rather than drawn empty: a
                  card saying "nothing yet" under a header that already
                  shows the plan would be a row of space saying nothing. */}
              {events.length > 0 ? (
                <SectionCard title={t("timeline.title")} description={t("timeline.description")}>
                  <div data-slot="portal-timeline" className="flex flex-col gap-4">
                    {timeline?.truncated ? (
                      <Callout tone="info">{t("timeline.truncated", { count: events.length })}</Callout>
                    ) : null}
                    <PortalTimeline entries={events} projectKey={project.key} />
                  </div>
                </SectionCard>
              ) : null}

              {/* 5. THE SHARED TASKS BY CATEGORY — the home's card, under
                  its own heading, because the h1 already carries the
                  project's name. */}
              {list?.truncated ? (
                <Callout tone="info">{t("tasks.truncated", { count: list.shown })}</Callout>
              ) : null}
              {tasks ? <ProjectTasks project={tasks} title={t("tasks.heading")} /> : null}
            </>
          )}
        </div>
      </Page>
    </PortalFrame>
  );
}

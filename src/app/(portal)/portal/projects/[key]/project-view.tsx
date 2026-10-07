import Link from "next/link";
import { getLocale, getTimeZone, getTranslations } from "next-intl/server";

import { Callout, HealthChip, Page, PageHeader, ProgressMeter, SectionCard } from "@/components/semantic";
import { Button } from "@/components/ui/button";
import { listPortalDocuments } from "@/documents/portal";
import { formatDay } from "@/lib/format";
import { readPortalHours } from "@/modules/time";
import { isWaitingOnYou, listPortalAgencyReplies, listPortalTasks, listPortalTimeline, listPortalUpdates } from "@/modules/work";
import { portalReadOrNull, type PortalPrincipal } from "@/portal";
import { fileAnchor, versionAnchor } from "@/portal/signoff-vocabulary";
import { findPortalProjectByKey, readPortalProjectSummary } from "@/projects/portal";

import { PortalFileList } from "../../files/file-list";
import type { PortalFileError } from "../../files/files-view";
import { PortalFrame } from "../../portal-frame";

import { AgencyReplyItem, LatestUpdate, PortalTasksEmpty, ProjectTasks, TaskRow } from "../../task-list";
import { ProjectHours } from "./project-hours";
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
 * update → the timeline → the shared tasks by category → files and
 * deliverables → hours & retainer. Requests are already on the task
 * list under "Requested" (UI.md §11's sixth category).
 *
 * EIGHT SEQUENTIAL READS (the eighth since slice 76; seven with Milestones
 * hidden, nine with Tasks hidden — slice 80), one transaction each, each through
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
 *
 * THE SECTION SWITCHES (Phase 3 slice 80, founder decision C47) take a
 * section off this page and nothing else — LAYOUT, never a refusal:
 *  - Tasks hidden: the task section lists the client's own requests
 *    alone (C47c), from a second, narrowed read; "Waiting on you" is
 *    drawn from the whole list, so a task handed to the reader stays on
 *    it (C47b).
 *  - Updates hidden: no latest-update card and no health chip (the chip
 *    IS that post's), because the read itself follows the switch; the
 *    rail drops its update entries.
 *  - Milestones hidden: no phase, next milestone or meter — the summary
 *    is not even read — and no milestone entries on the rail.
 *  - Files hidden: no files section and no delivered versions on the
 *    rail. The files are still read, because an ask to sign a deliverable
 *    off is on "Waiting on you" either way; its "Review" then leads to
 *    the Files page, where the same row carries the control, instead of
 *    to an anchor this page no longer draws.
 * A page left with NOTHING DRAWN — no section, no shipped version, no
 * hours, no request, and nothing waiting — is the plane's one empty page,
 * as a page with nothing shared is.
 */
export async function PortalProjectView({
  principal,
  name,
  projectKey,
  error,
}: {
  principal: PortalPrincipal;
  name: string;
  projectKey: string;
  /** A refused download's word, when the files section's form sent the reader back here (`../../files/actions.ts`). */
  error?: PortalFileError;
}) {
  const t = await getTranslations("portal");
  const tDomain = await getTranslations("domainErrors");
  const locale = await getLocale();
  // The request's zone — the product default on the portal plane, and
  // pinned to the same on `/view-as` — decides which day is "today" for
  // the header's "next milestone".
  const timeZone = await getTimeZone();

  const project = await portalReadOrNull("findPortalProjectByKey", () =>
    findPortalProjectByKey(principal, projectKey),
  );
  // Not read at all with Milestones hidden: the header's phase, next
  // milestone and meter are the only things drawn from it.
  const summary =
    project && project.sections.milestones
      ? await portalReadOrNull("readPortalProjectSummary", () =>
          readPortalProjectSummary(principal, project.id, { timeZone }),
        )
      : null;
  // Follows the Updates switch, so a hidden section takes the card and the
  // health chip with it — both are drawn from this one post.
  const updates = project
    ? await portalReadOrNull("listPortalUpdates", () =>
        listPortalUpdates(principal, { projectId: project.id, latestOnly: true, followSectionSwitches: true }),
      )
    : null;
  const timeline = project
    ? await portalReadOrNull("listPortalTimeline", () => listPortalTimeline(principal, { projectId: project.id }))
    : null;
  // THE WHOLE LIST, whatever the Tasks switch says: "Waiting on you" is
  // drawn from it (C47b).
  const list = project
    ? await portalReadOrNull("listPortalTasks", () => listPortalTasks(principal, { projectId: project.id }))
    : null;
  // …and the task SECTION's list: the same answer while the section is
  // shown, the client's own requests alone while it is hidden (C47c) —
  // one more sequential read, only then.
  const sectionList =
    project && !project.sections.tasks
      ? await portalReadOrNull("listPortalTasks", () =>
          listPortalTasks(principal, { projectId: project.id, followSectionSwitches: true }),
        )
      : list;
  // The sixth read (the portal files slice): this project's shared files,
  // for section 6. Sequential, like the five above.
  const files = project
    ? await portalReadOrNull("listPortalDocuments", () => listPortalDocuments(principal, { projectId: project.id }))
    : null;
  // The seventh (the hours & retainer slice): the live hours widget and
  // the published time reports, for section 7. `portal.hours.view` is
  // PRIMARY only; the projection answers EMPTY for a collaborator (its
  // own rule, as `listPortalUpdates`' hours block), so the section is
  // simply absent — the same page, minus one card, which is what "no
  // money to a collaborator" looks like. Null here is a real refusal
  // (the project is not theirs), like every other read above.
  const hours = project
    ? await portalReadOrNull("readPortalHours", () => readPortalHours(principal, project.id, { timeZone }))
    : null;

  // The eighth (Phase 3 slice 76, C45): this project's tasks whose newest
  // shared comment is the agency's — "Your agency replied" rows on the
  // "Waiting on you" card, as on the home. Sequential, like the rest.
  const replies = project
    ? await portalReadOrNull("listPortalAgencyReplies", () =>
        listPortalAgencyReplies(principal, { projectId: project.id }),
      )
    : null;

  const latest = updates?.[0] ?? null;
  const tasks = list?.projects[0] ?? null;
  const sectionTasks = sectionList?.projects[0] ?? null;
  const waiting = tasks?.tasks.filter(isWaitingOnYou) ?? [];
  // ONE ROW PER TASK: a task the reader was handed AND the agency last
  // spoke on is already on this card as its tick row, whose title opens
  // the same page — a second row for it would read as two things waiting
  // (code review). The home's card lists no tick rows, so it keeps both.
  const waitingIds = new Set(waiting.map((task) => task.id));
  const replied = (replies ?? []).filter((reply) => !waitingIds.has(reply.taskId));
  const events = timeline?.entries ?? [];
  const documents = files?.documents ?? [];
  const showFiles = project?.sections.files ?? false;
  // THE ASKS THIS READER MAY ANSWER (the sign-off slice): the shipped
  // versions and the deliverables whose `canDecide` the projections set
  // — drawn from the same rows the rail and the files section draw, so
  // the card can never list an ask its row then offers no control for.
  // (With Files hidden the files section is not drawn here, and the ask
  // leads to the Files page's copy of the same row instead.)
  const pendingVersions = events.flatMap((e) => (e.kind === "version_shipped" && e.approval.canDecide ? [e] : []));
  const pendingDeliverables = documents.filter((d) => d.approval?.canDecide);
  const asks = pendingVersions.length + pendingDeliverables.length;
  // THE EMPTY STATE IS FOR A PAGE WITH NO PLAN EITHER. A project whose
  // only shared rows are undated open milestones has a header — the
  // phase, the meter — and no section to draw under it, and that is
  // rendered as exactly that: the plan, and nothing else yet. Drawing
  // "Nothing shared with you yet" under a meter that counts shared
  // milestones would be the page contradicting itself (a review asked
  // the question; this is the answer, on purpose).
  //
  // WHAT IS DRAWN, not what exists (slice 80): with a section hidden, its
  // rows are shared and still not on this page, so they no longer keep the
  // empty state away — but "Waiting on you" does, because it is drawn
  // whatever the switches say.
  const hasHours = hours !== null && (hours.live !== null || hours.reports.length > 0);
  const nothing =
    asks === 0 &&
    waiting.length === 0 &&
    !latest &&
    events.length === 0 &&
    !sectionTasks &&
    // A reply's task passes the list's own rule, so `tasks` is set whenever
    // a reply is — except for a race between the two reads; stated anyway,
    // as on the home, so the page can never draw "nothing shared" under a
    // card listing a reply.
    replied.length === 0 &&
    !(showFiles && documents.length > 0) &&
    !hasHours &&
    !(summary && summary.milestones.total > 0);

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
    <PortalFrame name={name} principal={principal} nav="home">
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

          {error ? (
            // A refused download from the files section below, drawn in
            // place: `alert`, never `status`, on the plane with no toast.
            // The budget refusal is the domain error's own sentence.
            <Callout tone="danger" role="alert">
              {error === "rate" ? tDomain("DOWNLOAD_RATE_LIMITED") : t("files.errors.download")}
            </Callout>
          ) : null}

          {!project || nothing ? (
            <PortalTasksEmpty />
          ) : (
            <>
              {/* 2. WHAT IS WAITING ON THE READER — the asks to sign off
                  first (a decision the agency is blocked on), then the
                  same task rows the category list below draws, with the
                  same tick. Listed first because "what do you need from
                  me" is the question this page answers before the other
                  two. Only where it would work: `canDecide` and
                  `isWaitingOnYou` are the controls' own predicates.
                  Absent when nothing is.

                  AN ASK ON THIS CARD IS A LINK, NOT THE CONTROL (the
                  home's shape). The control lives ONCE per subject — on
                  the rail entry or the file row — and "Review" jumps to
                  it. Drawing it here too would put the decision under a
                  row that the same round trip removes: the action
                  revalidates the page, `canDecide` turns false, and the
                  row the reader just pressed vanishes with its
                  confirmation (a code review traced it). One instance,
                  on an element that stays, is what "in place" means. */}
              {asks > 0 || waiting.length > 0 || replied.length > 0 ? (
                <SectionCard
                  title={t("actionItems.title")}
                  description={t("actionItems.description")}
                  contentClassName="p-4"
                >
                  <ul data-slot="portal-action-items" className="flex flex-col gap-3">
                    {pendingVersions.map((v) => (
                      <li
                        key={`version-${v.id}`}
                        data-slot="portal-action-item"
                        data-kind="version"
                        className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1"
                      >
                        <span className="text-sm text-foreground">
                          {t("actionItems.signoffVersion", { version: v.title ? `${v.version} · ${v.title}` : v.version })}
                        </span>
                        <Button asChild variant="outline" size="sm">
                          <a href={`#${versionAnchor(v.id)}`}>{t("actionItems.review")}</a>
                        </Button>
                      </li>
                    ))}
                    {pendingDeliverables.map((d) => (
                      <li
                        key={`deliverable-${d.id}`}
                        data-slot="portal-action-item"
                        data-kind="deliverable"
                        className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1"
                      >
                        <span className="text-sm text-foreground">
                          {t("actionItems.signoffDeliverable", { name: d.name, number: d.approval?.versionNumber ?? d.version.number })}
                        </span>
                        <Button asChild variant="outline" size="sm">
                          {showFiles ? (
                            <a href={`#${fileAnchor(d.id)}`}>{t("actionItems.review")}</a>
                          ) : (
                            // Files hidden: this page draws no row to jump
                            // to, so the ask leads to the Files page's row,
                            // which carries the same control. No prefetch:
                            // rendered on the member plane too (View-as).
                            <Link href={`/portal/files#${fileAnchor(d.id)}`} prefetch={false}>
                              {t("actionItems.review")}
                            </Link>
                          )}
                        </Button>
                      </li>
                    ))}
                    {waiting.map((task) => (
                      <TaskRow key={task.id} task={task} />
                    ))}
                    {replied.map((reply) => (
                      <AgencyReplyItem key={`reply-${reply.taskId}`} reply={reply} showProject={false} />
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
                  project's name. With Tasks hidden (C47c) it is the
                  client's own requests, under a heading that says so. */}
              {sectionList?.truncated ? (
                <Callout tone="info">{t("tasks.truncated", { count: sectionList.shown })}</Callout>
              ) : null}
              {sectionTasks ? (
                <ProjectTasks
                  project={sectionTasks}
                  title={project.sections.tasks ? t("tasks.heading") : t("tasks.requestsHeading")}
                />
              ) : null}

              {/* 6. FILES & DELIVERABLES (UI.md §4 item 6; the portal
                  files slice): the project's shared files, deliverables
                  first, each with its download. Omitted when there are
                  none, like the rail. AFTER the tasks, which is §4's
                  order — a refused download returns the reader here
                  with the banner at the top of the page. Absent while
                  the Files section is hidden (C47). */}
              {showFiles && documents.length > 0 ? (
                <SectionCard
                  title={t("files.projectTitle")}
                  description={t("files.projectDescription")}
                  contentClassName="p-0"
                >
                  <div data-slot="portal-project-files" className="flex flex-col">
                    {files?.truncated ? (
                      <div className="p-4 pb-0">
                        <Callout tone="info">{t("files.truncated", { count: documents.length })}</Callout>
                      </div>
                    ) : null}
                    <PortalFileList documents={documents} returnTo={`/portal/projects/${project.key}`} />
                  </div>
                </SectionCard>
              ) : null}

              {/* 7. HOURS & RETAINER (UI.md §4 item 7; the hours & retainer
                  slice): the live monthly widget when the project shares
                  hours, the published time reports when there are any.
                  Absent for a collaborator (the projection answers empty)
                  and for a project that shares neither — `hasHours` is the
                  one place that decides. */}
              {hasHours && hours ? <ProjectHours hours={hours} /> : null}
            </>
          )}
        </div>
      </Page>
    </PortalFrame>
  );
}

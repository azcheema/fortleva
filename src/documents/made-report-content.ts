import { fail } from "@/lib/domain-error";
import { isoDateOf, localDateString } from "@/lib/duration";
import { listPortalTasks, listPortalUpdates, PORTAL_UPDATE_LIMIT, readUpdateBody } from "@/modules/work";
import type { PortalPrincipal } from "@/portal";
import { listPortalProjects } from "@/projects/portal";

import {
  MADE_REPORT_MAX_PROJECTS,
  MADE_REPORT_MAX_TASKS,
  MADE_REPORT_MAX_UPDATES,
  reportMonthWindow,
  type MadeReportContent,
  type MadeReportProject,
  type MadeReportTask,
  type MadeReportUpdate,
} from "./made-report-shape";

export * from "./made-report-shape";

/**
 * WHAT A MADE MONTHLY REPORT SAYS, AND HOW IT IS READ (Phase 7 slice 119;
 * founder decision C95 (b), (c); design
 * docs/research/2026-10-15-slice-119-monthly-report-design.md §2).
 *
 * THIS FILE QUERIES NO TABLE. Every line of the report comes from a portal
 * projection — `listPortalProjects`, `listPortalTasks`, `listPortalUpdates` —
 * called with a CONTACT principal (synthesised by the member plane's one
 * builder, `src/portal/synthesise.ts`), so each read runs under
 * `withPortalRead` where `portal_gate` and the projection's own terms decide
 * before any code here does. The report therefore cannot name a task, an
 * update or a project the client's own portal would not show that person:
 * an INTERNAL task, an unpublished or INTERNAL update, a project whose portal
 * is off or whose section is hidden (C47, followed), an archived project. That
 * is SECURITY.md §5.1's View-as argument — "a separate preview renderer is
 * how previews lie" — made for a PDF; a report that filtered rows of its own
 * would be that renderer.
 *
 * WHAT IS READ (C95 (b)): per ticked project, the tasks FINISHED in the month
 * (DONE now, `completedAt` in the window — a narrowing the projection applies
 * in its own `where`) and the updates PUBLISHED in the month. Each update's
 * health is drawn; the project's health is its newest update's. NOT read, by
 * the founder's word: the website speed, milestones (a task's "phase" is a
 * milestone's name, so it is left off the task line), files, hours and the
 * update's frozen numbers strip (C95 (c) — it counts hours and milestones).
 *
 * THE FINGERPRINT and the shape are `./made-report-shape.ts` (pure).
 *
 * THE WINDOW is the month in the WORKSPACE'S zone: "finished in September" is
 * September where the agency works.
 */

export type DeriveMadeReportInput = {
  /** `YYYY-MM-01`. */
  readonly month: string;
  /** The workspace's zone — the month's window and every day label. */
  readonly timezone: string;
  /** The projects ticked, in the order to draw them. */
  readonly projectIds: readonly string[];
};

/**
 * THE CONTENT, AS THE CLIENT — in SEQUENCE: each projection opens its own
 * contact-principal transaction, and nothing here races (AGENTS.md).
 *
 * Refusals are the MEMBER's (the caller is the agency, making or publishing):
 * a ticked project the client cannot see now is MADE_REPORT_PROJECT_HIDDEN;
 * more than the ceilings is MADE_REPORT_TOO_LARGE — a report refuses rather
 * than trims, because a silently shortened report lies by omission. A
 * projection's AuthzError (the person paused meanwhile, the module closed)
 * is left to the caller, which answers MADE_REPORT_NO_AUDIENCE.
 */
export async function deriveMadeReportContent(
  principal: PortalPrincipal,
  input: DeriveMadeReportInput,
): Promise<MadeReportContent> {
  if (!/^\d{4}-\d{2}-01$/.test(input.month)) fail("INVALID_INPUT", "report month");
  if (input.projectIds.length === 0) fail("INVALID_INPUT", "no project");
  if (input.projectIds.length > MADE_REPORT_MAX_PROJECTS) fail("MADE_REPORT_TOO_LARGE", "projects");
  const window = reportMonthWindow(input.month, input.timezone);

  // 1. The projects the client can see NOW — portal on, not archived, under
  //    `portal_gate` — and their names, as the client reads them.
  const visible = new Map((await listPortalProjects(principal, "portal.report.view")).map((p) => [p.id, p.name]));
  for (const id of input.projectIds) {
    if (!visible.has(id)) fail("MADE_REPORT_PROJECT_HIDDEN", "a ticked project is not the client's to see");
  }

  const projects: MadeReportProject[] = [];
  let taskCount = 0;
  let updateCount = 0;
  for (const projectId of input.projectIds) {
    // 2. The tasks finished in the month, as the client's home card draws
    //    the list (the Tasks switch followed, C47): a hidden section leaves
    //    the client's own requests alone.
    const list = await listPortalTasks(principal, { projectId, followSectionSwitches: true, doneWithin: window });
    if (list.truncated) fail("MADE_REPORT_TOO_LARGE", "tasks");
    const tasks: MadeReportTask[] = (list.projects[0]?.tasks ?? [])
      .flatMap((t) => (t.completedAt ? [{ id: t.id, title: t.title, completedOn: localDateString(t.completedAt, input.timezone) }] : []))
      .sort((a, b) => a.completedOn.localeCompare(b.completedOn) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    taskCount += tasks.length;
    if (taskCount > MADE_REPORT_MAX_TASKS) fail("MADE_REPORT_TOO_LARGE", "tasks");

    // 3. The updates published in the month (the Updates switch followed).
    //    Newest first from the projection; a report reads the month in
    //    order, so oldest first here.
    const posts = await listPortalUpdates(principal, {
      projectId,
      followSectionSwitches: true,
      publishedSince: window.from,
      publishedBefore: window.to,
    });
    // The projection caps at PORTAL_UPDATE_LIMIT with no `truncated` flag: a
    // full page (fifty or more) may have been cut, and a cut report is
    // refused, not trimmed.
    if (posts.length >= PORTAL_UPDATE_LIMIT) fail("MADE_REPORT_TOO_LARGE", "updates");
    const updates: MadeReportUpdate[] = [...posts]
      .sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime() || a.seq - b.seq)
      .map((u) => ({
        id: u.id,
        seq: u.seq,
        health: u.health,
        title: u.title,
        publishedOn: localDateString(u.publishedAt, input.timezone),
        periodStart: u.periodStart ? isoDateOf(u.periodStart) : null,
        periodEnd: u.periodEnd ? isoDateOf(u.periodEnd) : null,
        editNote: u.editNote,
        // The sections only — never `metrics` (C95 (c)).
        sections: readUpdateBody(u.body).sections.map((s) => ({ key: s.key, title: s.title, body: s.body })),
      }));
    updateCount += updates.length;
    if (updateCount > MADE_REPORT_MAX_UPDATES) fail("MADE_REPORT_TOO_LARGE", "updates");

    projects.push({
      id: projectId,
      name: visible.get(projectId)!,
      health: updates.length > 0 ? updates[updates.length - 1]!.health : null,
      tasks,
      updates,
    });
  }
  return { month: input.month, projects };
}


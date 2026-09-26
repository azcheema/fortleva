import { DEFAULT_TIMEZONE } from "@/i18n/config";
import { localDateString } from "@/lib/duration";
import {
  authorizePortal,
  withPortalRead,
  type PortalCapability,
  type PortalPrincipal,
} from "@/portal";

/**
 * THE PROJECTS A CONTACT CAN SEE, AS A CONTACT SEES THEM — two columns.
 *
 * It exists because the request form has to ask "which project is this
 * about", and a picker is a projection like any other: the list of names
 * a client is shown is the list of names the agency has published to
 * them, and nothing else. Putting it here rather than deriving it from
 * `listPortalTasks` is deliberate — a client whose project has nothing
 * shared in it yet still has that project, and still needs to be able
 * to ask for something in it. Deriving the picker from the task list
 * would have made "you have no shared tasks" silently mean "you may not
 * ask us for anything".
 *
 * WHAT BOUNDS IT IS THE POLICY, not this `where`. `project`'s
 * `portal_gate` is `client_id = app.client_id AND portal_enabled`
 * (migration 20260816180000), so under the contact principal this read
 * can only ever return portal-enabled projects of the contact's own
 * client. The filter below repeats the archive term the policy does NOT
 * have — the same gap `listPortalTasks` documents at length: archiving a
 * project leaves `portalEnabled` TRUE, so without this line an agency
 * that archived a finished project would go on inviting requests into
 * it for ever.
 *
 * NO COUNT, NO DATES, NO STATUS. A picker needs a name and a value. A
 * project's own status is the agency's word for where its work stands
 * and is not on UI.md §11's "shown to a contact" side; adding it here
 * because a select-list looked bare is exactly how a projection grows.
 */

/** One row of the request form's project picker. */
export type PortalProjectOption = {
  readonly id: string;
  readonly name: string;
};

/**
 * ORDERED BY NAME, not by anything the agency decides. There is no
 * "recent" and no "active first": both would publish a fact about how
 * the agency works, and a client with four projects reads an
 * alphabetical list without being told anything.
 */
export type PortalProjectRef = {
  readonly id: string;
  readonly key: string;
  readonly name: string;
};

/**
 * ONE PROJECT OF THE CONTACT'S OWN CLIENT, BY ITS KEY — the resolver a
 * portal route under `/portal/projects/[key]` starts with. The key is
 * the project's public handle ("ACME"), already on every task the client
 * reads; what this proves is that THIS contact may see THIS project
 * (`portal_gate` on `project` binds client + `portal_enabled`), and it
 * answers null — the plane's one uniform "nothing" — for any key that is
 * not theirs, switched off, or archived. The route treats null exactly
 * as it treats an empty list.
 */
export async function findPortalProjectByKey(
  principal: PortalPrincipal,
  key: string,
): Promise<PortalProjectRef | null> {
  const upper = key.toUpperCase();
  if (!/^[A-Z][A-Z0-9]{0,7}$/.test(upper)) return null;
  return withPortalRead(principal, async (tx) => {
    await authorizePortal(tx, principal, "portal.project.view");
    return tx.project.findFirst({
      where: {
        tenantId: principal.tenantId,
        clientId: principal.clientId,
        key: upper,
        portalEnabled: true,
        archivedAt: null,
      },
      select: { id: true, key: true, name: true },
    });
  });
}

/**
 * THE HEADER OF THE ONE-SCREEN PROJECT PAGE (UI.md §4: "Phase: Design ·
 * Next milestone: Launch due 12 Sep", and the milestone progress bar),
 * computed from the CLIENT_VISIBLE milestones alone. The health chip is
 * not here: it is the newest published update's, and the page takes it
 * from `listPortalUpdates`, so the header and the post under it cannot
 * name two different healths.
 *
 * THE RULES, stated because each is a choice:
 *  - `phase` is the milestone the agency has IN_PROGRESS — the earliest
 *    due if it has several, undated last — or null. One phase, because
 *    the header has room for one sentence and a client is owed the
 *    agency's answer, not its whole board.
 *  - `nextMilestone` is the soonest milestone not yet reached whose DAY
 *    is today or later in the reader's zone, whatever its status. "Next"
 *    means coming up: an open milestone whose published day has passed
 *    is on the rail at that day, not in a sentence that would call it
 *    the next thing. Compared by calendar day and not by instant (a
 *    review caught the instant form): a milestone due today is "next"
 *    all day, which is the day the sentence matters most. It may be the
 *    phase itself (the phase's own end is the next thing due), and the
 *    page renders that as one fact rather than two.
 *  - `milestones` counts DONE over everything not CANCELLED — the same
 *    rule the frozen snapshot's `milestones` block applies
 *    (`update-metrics.ts`), so the header's "2 of 5" and the newest
 *    post's "2 of 5" agree on the day it is published.
 *
 * NO STATUS AND NO ORDERING KEY LEAVES HERE. Which milestone is "paused"
 * is the agency's word for its own plan; the plan's order is the
 * agency's too. A name and a day are what a client reads.
 */
export type PortalMilestoneRef = {
  readonly id: string;
  readonly name: string;
  readonly dueAt: Date | null;
};

export type PortalProjectSummary = {
  readonly phase: PortalMilestoneRef | null;
  readonly nextMilestone: (PortalMilestoneRef & { readonly dueAt: Date }) | null;
  readonly milestones: { readonly done: number; readonly total: number };
};

export async function readPortalProjectSummary(
  principal: PortalPrincipal,
  projectId: string,
  /** The reader's clock and zone — the request's (`getTimeZone()`), so View-as and the portal agree. */
  clock: { readonly now?: Date; readonly timeZone?: string } = {},
): Promise<PortalProjectSummary> {
  const now = clock.now ?? new Date();
  const timeZone = clock.timeZone ?? DEFAULT_TIMEZONE;
  const today = localDateString(now, timeZone);
  return withPortalRead(principal, async (tx) => {
    await authorizePortal(tx, principal, "portal.project.view", { kind: "project", projectId });
    // Tenant, client, visibility and the portal switch are `portal_gate`'s
    // under this principal (the three-term form on `milestone`); repeated
    // as defence in depth. The project's archive is the projection's own
    // term, as everywhere on this plane.
    const rows = await tx.milestone.findMany({
      where: {
        tenantId: principal.tenantId,
        clientId: principal.clientId,
        projectId,
        visibility: "CLIENT_VISIBLE",
        portalEnabled: true,
        status: { not: "CANCELLED" },
        project: { archivedAt: null },
      },
      select: { id: true, name: true, status: true, dueAt: true },
      // Soonest due first, undated last, the row id as the stable tie —
      // never the plan's own order (UI.md §11: the agency's sequence is
      // the agency's).
      orderBy: [{ dueAt: { sort: "asc", nulls: "last" } }, { id: "asc" }],
    });
    const ref = (m: (typeof rows)[number]): PortalMilestoneRef => ({ id: m.id, name: m.name, dueAt: m.dueAt });
    const inProgress = rows.find((m) => m.status === "IN_PROGRESS");
    // `dueAt` is a DAY encoded as UTC midnight (the member form writes
    // `${day}T00:00:00Z`), so its day is read in UTC — `formatDay`'s own
    // rule — while "today" is the reader's. Running the column through
    // the reader's zone would move a milestone due today to yesterday
    // for any zone west of UTC (the fix review's note).
    const next = rows.find(
      (m) => m.status !== "DONE" && m.dueAt !== null && m.dueAt.toISOString().slice(0, 10) >= today,
    );
    return {
      phase: inProgress ? ref(inProgress) : null,
      nextMilestone: next && next.dueAt ? { ...ref(next), dueAt: next.dueAt } : null,
      milestones: { done: rows.filter((m) => m.status === "DONE").length, total: rows.length },
    };
  });
}

export async function listPortalProjects(
  principal: PortalPrincipal,
  /**
   * THE CAPABILITY THIS LIST IS *FOR*, and it is required rather than
   * defaulted. A picker is only ever rendered as the first field of
   * something, and a contact who may not do that something must not be
   * shown a form that will refuse them at the end of it — they get the
   * portal's one uniform empty answer instead, at the top, like every
   * other refusal on this plane. Making the caller name the verb is what
   * keeps the two in step: the page and the action ask the same
   * question.
   */
  capability: PortalCapability,
): Promise<readonly PortalProjectOption[]> {
  return withPortalRead(principal, async (tx) => {
    // No ref on either: every row this returns is gated individually by
    // `portal_gate`, and naming one project would be inventing a
    // resource the query does not have (`PortalScopeRef`). The contact
    // row behind both checks is read once per transaction
    // (`authorizePortal` memoises it), so the second is free.
    await authorizePortal(tx, principal, "portal.project.view");
    await authorizePortal(tx, principal, capability);
    return tx.project.findMany({
      where: {
        tenantId: principal.tenantId,
        clientId: principal.clientId,
        portalEnabled: true,
        archivedAt: null,
      },
      select: { id: true, name: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });
  });
}

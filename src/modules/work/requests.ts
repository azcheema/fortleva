import { randomUUID } from "node:crypto";

import { deny } from "@/authz/errors";
import { nextCounter, type TenantDb } from "@/db";
import { fail } from "@/lib/domain-error";

import { bottomRank, lockContactRequestBudget, lockProjectRanks } from "./rank-lock";
import { ensureProjectStates } from "./states";

/**
 * The two length caps live in `request-limits.ts`, a LEAF that imports
 * nothing, because the portal's `"use client"` form needs them for its
 * `maxLength` attributes — and importing them from here would pull this
 * file's graph (Prisma, `pg`, Node builtins) into the browser bundle.
 * Its header records the build failure that proved it. Re-exported so a
 * server caller still has one import site.
 */
export { REQUEST_BODY_MAX, REQUEST_TITLE_MAX } from "./request-limits";

/**
 * REQUESTS — `WorkItem(kind = REQUEST)`, the row a client puts on the
 * agency's board (DATA_MODEL.md §6.14, plan §3.1).
 *
 * WHY THIS IS A FILE OF ITS OWN AND NOT PART OF `portal-writes.ts`,
 * stated first because it is the question a reviewer will ask. The
 * portal tripwire (`src/authz/portal-projections.test.ts`) greps the
 * TEXT of every portal-surface file for internal column names, and
 * `stateId` is on that list — rightly: the portal is shown state
 * CATEGORIES and never a tenant's own state ids or names. But a row
 * that lands in TRIAGE has to *name* `stateId` somewhere, so a brokered
 * create written inline in `portal-writes.ts` would have meant either a
 * failing tripwire or a weakened one. Keeping the list absolute is
 * worth more than the inlining, so the INSERT lives here — beside the
 * other work-module services, where the member-side triage verb
 * (`work_item:triage`, Accept / Decline / Duplicate / Snooze) will join
 * it — and `portal-writes.ts` keeps the part that must be read as a
 * unit: who is allowed, under which principal, with which audit row.
 *
 * WHAT IS FORCED HERE, AND WHY IT IS FORCED HERE. `createRequest` takes
 * a project, a title, an optional body and the contact who reported it.
 * Everything else that decides what the row IS — `kind`, `source`,
 * `visibility`, the state, the triage status, `clientId` — is chosen by
 * this function from the project row it just read, and cannot be
 * influenced by its caller at all. That is AUTHZ.md §8's "hard-coded
 * field values that the request body cannot override" as a SIGNATURE
 * rather than as a discipline: there is no parameter to pass.
 */

/**
 * The columns a portal request may carry from the submitter, and the
 * ONLY ones. Two, which is the point.
 */
export type RequestInput = {
  readonly projectId: string;
  /** One line. Trimmed and length-checked by the caller's own parser. */
  readonly title: string;
  /**
   * The body, as PLAIN TEXT — never ProseMirror JSON. A contact's
   * request is a paragraph typed into a textarea, and admitting a
   * document here would mean admitting whatever a client's browser
   * chose to send into a `jsonb` column that the member panel renders:
   * the editor's own schema check runs in the member app, not on this
   * plane. It lands in `descriptionText`, which is what the search feed
   * and the panel's preview already read, and `description` stays NULL —
   * so the panel shows the text and nobody has to trust it as markup.
   */
  readonly body: string | null;
  /** The contact who submitted it — `reportedByContactId`, attribution only. */
  readonly reportedByContactId: string;
};

/** What the caller needs to audit, notify and link it. */
export type CreatedRequest = {
  readonly id: string;
  readonly number: number;
  readonly clientId: string;
  readonly projectId: string;
  readonly projectKey: string;
};

/**
 * Create a `kind = REQUEST` row in the project's hidden TRIAGE state.
 *
 * RUNS IN THE CALLER'S TRANSACTION and takes no principal: the caller
 * owns the authorization (`authorizePortal`, then a system transaction)
 * and the audit row. This function owns the shape of the row.
 *
 * THE STATE IS RESOLVED, NOT TRANSITIONED, and the difference matters.
 * `transitionState` refuses to ENTER a TRIAGE state outright ("triage
 * entry is not a state change") because on the member plane arriving in
 * triage is the `work_item:triage` verb and carries a triage status. An
 * intake is the one path that is allowed to start there, so the row is
 * INSERTed into the state with `triageStatus: PENDING` — which is also
 * what the `work_item_triage_has_status` CHECK requires, so a future
 * edit that forgets the status is a constraint error rather than a row
 * the triage lane cannot see.
 *
 * THE TRIAGE STATE IS SEEDED LAZILY, like every other state of a
 * project (`ensureProjectStates`). A project whose board has never been
 * opened has no `workflow_state` rows at all, and a client can
 * legitimately be the first person to touch a project's work — so this
 * cannot assume the states exist. It is hidden (`isHidden`) until it
 * has items, which is exactly the behaviour this row turns on.
 */
export async function createRequest(
  tx: TenantDb,
  tenantId: string,
  input: RequestInput,
): Promise<CreatedRequest> {
  // **AN EMPTY `projectId` MUST NOT REACH A `where`.** Prisma silently
  // DROPS an `undefined` filter (the trap this repo already has a memory
  // of), and this read runs under the SYSTEM principal, where every
  // portal policy is satisfied — so a dropped filter would return an
  // arbitrary project OF THE WHOLE TENANT, and the line below would file
  // one client's words into another client's project, born
  // CLIENT_VISIBLE. The database cannot help on this path; this read is
  // the only thing deciding ownership. A security review traced it as
  // unreachable from today's single caller and worth one line anyway,
  // because the broker is on the public barrel and the next caller need
  // not be a `FormData` action.
  if (!input.projectId) throw new Error("createRequest: projectId is required");
  const project = await tx.project.findFirst({
    where: { tenantId, id: input.projectId },
    select: { id: true, key: true, clientId: true, archivedAt: true, portalEnabled: true },
  });
  // THE TWO TRANSACTIONS ARE NOT ONE INSTANT, which is the honest
  // weakness of every brokered write. The caller has already proved the
  // project is reachable under the contact's OWN principal — client
  // ownership and `portal_enabled`, decided by `portal_gate` — but that
  // was a transaction ago, and this one runs as `system`, where every
  // policy is satisfied. So the switch is re-read here rather than
  // assumed.
  //
  // Nothing LEAKS if it is not: `stamp_portal_enabled` derives the new
  // row's own flag from the project at INSERT, so a request filed into a
  // just-switched-off project would be invisible to the client anyway.
  // What it would be is a request the submitter believes was received
  // and can no longer see — which is the same failure as eating their
  // words, one layer down. Refused instead.
  //
  // A MISSING PROJECT AND A SWITCHED-OFF ONE ANSWER IDENTICALLY, on
  // purpose: both mean "not a target", and the portal renders every
  // authorization refusal the same way (`src/portal/render.ts`), so the
  // two must not be distinguishable by message either.
  //
  // THE CLAIM IS ABOUT THIS PAIR AND NOT ABOUT EVERY REFUSAL, which a
  // security review was right to sharpen. An ARCHIVED project of the
  // contact's own client passes `authorizePortal` — `project`'s
  // `portal_gate` has no archive term — and is refused HERE, a whole
  // transaction later than an unreachable one, so the two differ in
  // TIMING even though they return the same bytes. Accepted rather than
  // closed: an archived project never appears in the picker
  // (`src/projects/portal.ts`), so a contact has nothing to compare
  // against, and moving the check earlier would mean teaching the
  // generic `authorizePortal` about archives.
  if (!project || !project.portalEnabled) deny("NOT_FOUND", "project");
  // Archiving is a DIFFERENT fact and keeps its own code, because a
  // future member-side caller would want to read it — the contact
  // still sees the plane's one generic message, since `ARCHIVED` is not
  // on `action.ts`'s disclosure list.
  if (project!.archivedAt) fail("ARCHIVED", "project");

  await ensureProjectStates(tx, tenantId, input.projectId);
  const triage = await tx.workflowState.findFirst({
    where: { tenantId, projectId: input.projectId, category: "TRIAGE" },
    orderBy: { rank: "asc" },
    select: { id: true },
  });
  // A tenant cannot delete a workflow state today (nothing in the
  // product writes or removes one after the lazy seed), so this is a
  // belt rather than a branch anyone can reach — and it fails CLOSED,
  // because the alternative is landing a client's request in whatever
  // state happened to sort first.
  //
  // A PLAIN `Error`, NOT `INVALID_INPUT`. A security review caught the
  // first version: `INVALID_INPUT` is on `src/portal/action.ts`'s
  // disclosure allow-list, whose rule is "each is something the reader
  // themself did" — and a tenant's workflow being broken is a fact
  // about the AGENCY, so a contact would have been handed a refusal
  // distinguishable from the plane's uniform one. This is an invariant
  // violation rather than a business rule, so it reaches the error
  // boundary, which is what `src/portal/render.ts` says a bug must do.
  if (!triage) throw new Error("createRequest: project has no TRIAGE state");

  const number = await nextCounter(tx, `work_item:${input.projectId}`);
  const id = randomUUID();
  // The project's rank queue, for the reason `createItem` takes it: a
  // create has no retry, and without the queue a create and a "move to
  // bottom" can mint the same key under READ COMMITTED (rank-lock.ts).
  await lockProjectRanks(tx, input.projectId);
  const rank = await bottomRank(tx, tenantId, input.projectId);

  await tx.workItem.create({
    data: {
      id,
      tenantId,
      // FROM THE PROJECT, never from the caller: `client_id` is the RLS
      // predicate every portal policy is written against, so deriving it
      // from the row rather than accepting it is what makes "a contact
      // cannot file into another client" a property of this code and not
      // a check somebody has to remember.
      clientId: project!.clientId,
      projectId: input.projectId,
      number,
      // A request is a TASK-level row: it has no children and it is not
      // an epic. `type` is the agency's hierarchy and `kind` is what the
      // row is about — orthogonal, per §6.14.
      type: "TASK",
      kind: "REQUEST",
      title: input.title,
      descriptionText: input.body,
      stateId: triage!.id,
      // `work_item_state_sync` derives this from the state anyway; set
      // so the insert and the row agree without a round trip.
      stateCategory: "TRIAGE",
      triageStatus: "PENDING",
      source: "PORTAL",
      // THE CLIENT MUST BE ABLE TO SEE WHAT THEY SUBMITTED. This is the
      // one row in the product that is born CLIENT_VISIBLE, and it is
      // deliberate rather than an exception to the INTERNAL default: a
      // request that vanishes on submit is a form that ate the client's
      // words. `portal_gate` then lets them read it back, and
      // `listPortalTasks` shows it under "Requested".
      //
      // WHAT THEY GET BACK IS THE TITLE, NOT THE BODY, and a security
      // review was right to sharpen this: `listPortalTasks`' select is
      // id/title/category/dates/phase, so the paragraph typed into
      // `descriptionText` is stored and never projected. Enough to see
      // that the request exists and is being looked at; the body comes
      // back with a portal detail view, which does not exist yet.
      visibility: "CLIENT_VISIBLE",
      reportedByContactId: input.reportedByContactId,
      // Nobody at the agency created it and nobody is assigned it yet.
      createdByMemberId: null,
      rootId: id,
      rank,
    },
    // Narrow, because a select-less create returns the whole row — the
    // standing trap, and on this path the row carries the body the
    // client just typed.
    select: { id: true },
  });

  await tx.workItemActivity.create({
    data: {
      tenantId,
      clientId: project!.clientId,
      projectId: input.projectId,
      workItemId: id,
      // The history row names the CONTACT, and the member-actor column
      // is left null: no employee did this, and writing one would put a
      // member's name against a client's act in the panel's timeline.
      actorContactId: input.reportedByContactId,
      field: "created",
      // INTERNAL like every other "created" row (`writeActivity` forces
      // it the same way): the field is not on the portal-safe list, and
      // the client already knows they submitted it.
      visibility: "INTERNAL",
    },
    select: { id: true },
  });

  return {
    id,
    number,
    clientId: project!.clientId,
    projectId: input.projectId,
    projectKey: project!.key,
  };
}

/**
 * THE RATE LIMIT ON REQUEST CREATION (plan §3, "rate limits on request
 * creation"; AUTHZ.md §8, "rate limits still key on the contact").
 *
 * IT IS A POSTGRES COUNT AND NOT THE UPSTASH LIMITER, deliberately.
 * `src/ratelimit` fails OPEN when Upstash is unconfigured — which it is,
 * and is documented to be (PLAN §0: no Upstash, no SES, no cron) — so
 * making this the only control would have meant shipping one that does
 * nothing in the only deployment that exists, with a green test beside
 * it. `src/ratelimit`'s own header names the alternative for exactly
 * this case: "the fail-CLOSED budgets in this product are the Postgres
 * counters". This is one. (A cheap Upstash bucket now sits in FRONT of
 * it in `portal-writes.ts`, which is the right layering — fail-open in
 * front of fail-closed — and is a no-op until Upstash is provisioned.)
 *
 * COUNTED IN THE WRITER'S OWN TRANSACTION, behind the per-contact
 * advisory lock `lockContactRequestBudget` takes (`rank-lock.ts`, which
 * also explains why the lock lives there and what its key space really
 * is). Without the lock two submissions that arrive together both see
 * N-1 and both land. The window is measured on the DATABASE's clock,
 * returned by that same statement.
 *
 * WHAT IT COUNTS is rows this contact caused through the portal, inside
 * the window — including ones the agency has since declined or deleted,
 * because the budget is about how often somebody may submit, not about
 * how many live rows they own. Counting only live rows would let a
 * submitter reset their own budget by having them declined.
 */
export const REQUEST_WINDOW_MINUTES = 15;
export const REQUEST_WINDOW_LIMIT = 5;

export async function assertRequestBudget(
  tx: TenantDb,
  tenantId: string,
  contactId: string,
): Promise<void> {
  const now = await lockContactRequestBudget(tx, contactId);
  const since = new Date(now.getTime() - REQUEST_WINDOW_MINUTES * 60_000);
  const used = await tx.workItem.count({
    where: { tenantId, reportedByContactId: contactId, source: "PORTAL", createdAt: { gte: since } },
  });
  if (used >= REQUEST_WINDOW_LIMIT) fail("REQUEST_RATE_LIMITED");
}

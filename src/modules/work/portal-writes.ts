import { record } from "@/audit/record";
import { withTenant } from "@/db";
import { fail, isDeadlock, isLockTimeout } from "@/lib/domain-error";
import { emit } from "@/notify/emit";
import { allow } from "@/ratelimit";
import { retryOnContention } from "@/lib/retry";
import { authorizePortal, withPortalRead, type PortalPrincipal } from "@/portal";

import { requestReceivers } from "./notify";
import { REQUEST_BODY_MAX, REQUEST_TITLE_MAX } from "./request-limits";
import { assertRequestBudget, createRequest } from "./requests";

/**
 * THE WORK MODULE'S BROKERED WRITES — the other half of the portal
 * plane, and the half that runs as `system`.
 *
 * `portal.ts` next door is reads: every one of them under the CONTACT
 * principal, so a projection bug is still caught by `portal_gate`. This
 * file is the opposite arrangement and needs its own justification,
 * which AUTHZ.md §8 gives: a contact may INSERT exactly one kind of row
 * directly (a comment, pinned by a WITH CHECK that spells the whole
 * predicate out), and **everything else a contact can cause is
 * brokered** — authorized first under their own principal, then written
 * under a system one that forces every column the submitter does not
 * get to choose.
 *
 * IT IS A SEPARATE FILE SO THAT "THIS CODE RUNS AS SYSTEM" IS A
 * PROPERTY OF THE FILENAME (founder decision, 2026-09-20). A system
 * transaction satisfies every `portal_gate`, so the database is not
 * helping here: the guarantees in this file are the ones its own code
 * makes. Keeping that in a file nobody opens by accident is the point.
 *
 * THE SHAPE EVERY FUNCTION HERE TAKES, and it is not negotiable:
 *
 *   1. `withPortalRead` + `authorizePortal(capability, ref)` — the
 *      contact's OWN transaction decides whether this may happen at
 *      all. `authorizePortal` refuses a system handle outright (step 0),
 *      so this cannot be folded into step 2 even by accident.
 *   2. `withTenant(tenantId, {type:'system'})` — the write, with every
 *      identifying column derived from rows rather than from arguments.
 *   3. An audit row **in the same transaction**, naming the CONTACT as
 *      actor (`brokeredForContactId`), plus `notify.emit()` so somebody
 *      at the agency finds out.
 *
 * WHAT IS DELIBERATELY NOT HERE. No row-shaping and no SQL: the INSERT
 * lives in `requests.ts` and the reason is written at the top of that
 * file — the portal tripwire greps this file's TEXT for internal column
 * names, and a create that lands a row in a workflow state has to name
 * one. Keeping the forbidden list absolute is worth more than the
 * inlining. What stays here is the part that has to be read as a unit:
 * who is allowed, under which principal, with which trail.
 *
 * THE TWO TRANSACTIONS ARE NOT ONE INSTANT, which is the honest weakness
 * of every brokered write and is handled rather than hidden. Between the
 * authorization and the write, an agency could switch the project's
 * portal off or archive it. `createRequest` therefore re-reads the
 * project under the system principal and refuses both — its own header
 * says why, and a dbtest drives the case by calling it directly, since
 * the broker cannot produce it. What none of that can do is make the
 * pair atomic: that would need the write to run under the contact's own
 * principal, which is the arrangement the census exists to forbid. The
 * window is one transaction wide and nothing leaks inside it.
 */

/**
 * HOW LONG A SUBMISSION MAY WAIT ON A LOCK before it gives up and is
 * retried. Deliberately short: the two locks it wants are held only for
 * the length of a write, so a wait this long means a member is running
 * something big on the same project — and a client pressing a button
 * should be told to try again rather than parked. `withTenant` scales
 * it by the same LINK FACTOR as every other budget.
 */
const REQUEST_LOCK_WAIT_MS = 3000;

/** What a contact may type into the request form, and nothing else. */
export type PortalRequestInput = {
  readonly projectId: string;
  readonly title: string;
  readonly body: string | null;
};

/** The human key of the row that was created — `<Project.key>-<number>`. */
export type PortalRequestCreated = {
  readonly id: string;
  readonly projectKey: string;
  readonly number: number;
};

/**
 * SUBMIT A REQUEST (`portal.request.create`).
 *
 * THE RESOURCE REF IS THE PROJECT, and passing it is what makes steps 3
 * and 4 of the pipeline run: the project must be reachable under
 * `portal_gate`, which is the contact's own client AND `portal_enabled`.
 * A request into another client's project, or into a project whose
 * portal is off, is therefore refused by the DATABASE before any of this
 * function's own opinions apply — the same property `listPortalTasks`
 * relies on for a narrowed read.
 *
 * THE INPUT IS PARSED BEFORE ANYTHING IS AUTHORIZED, which is the one
 * place this file deviates from "authorize first". A blank title is not
 * a fact about the agency — it is a fact about what the reader typed —
 * so it may be reported plainly, and doing it here means an empty form
 * never opens a transaction at all. Everything that could disclose
 * something about the agency happens after the gate.
 */
export async function createPortalRequest(
  principal: PortalPrincipal,
  input: PortalRequestInput,
): Promise<PortalRequestCreated> {
  const title = input.title.trim();
  const body = input.body?.trim() ?? "";
  if (title.length === 0) fail("INVALID_INPUT", "title");
  if (title.length > REQUEST_TITLE_MAX) fail("INVALID_INPUT", "title too long");
  if (body.length > REQUEST_BODY_MAX) fail("INVALID_INPUT", "body too long");
  // **AN EMPTY PROJECT ID IS REFUSED HERE AND NOT PASSED ON.** Prisma
  // drops an `undefined` `where` filter silently, and the write below
  // runs under a principal every portal policy is satisfied by, so a
  // dropped filter would resolve an arbitrary project of the tenant —
  // possibly another client's — and file this client's words into it,
  // born CLIENT_VISIBLE. Today's only caller always passes a string, so
  // this is a belt; a security review asked for it because this function
  // is on the public barrel and the next caller need not be a `FormData`
  // action. `authorizePortal` and `createRequest` each carry their own.
  if (!input.projectId) fail("INVALID_INPUT", "project");

  // THE CHEAP FILTER, IN FRONT OF THE FAIL-CLOSED ONE. This is the
  // Upstash limiter, and it is a NO-OP today: Upstash is unprovisioned,
  // so `allow` returns true through the no-op limiter (PLAN §0). It is
  // here because the authoritative budget is a Postgres count that costs
  // a transaction and an advisory lock to evaluate — so without a
  // front filter, a contact who has spent their five could go on paying
  // that price at line rate. Fail-open IN FRONT OF fail-closed is the
  // right layering and the opposite of the arrangement `requests.ts`
  // rejects; the budget below, not this, is what actually holds.
  if (!(await allow("portal.request_create", principal.contactId))) {
    fail("REQUEST_RATE_LIMITED", "front filter");
  }

  await withPortalRead(principal, (tx) =>
    authorizePortal(tx, principal, "portal.request.create", {
      kind: "project",
      projectId: input.projectId,
    }),
  );

  // **THE LOCK WAITS ARE BOUNDED, which `createItem` does not do and
  // this path cannot afford not to.** Two advisory locks are taken
  // inside: this contact's budget key, then the project's rank queue —
  // and the queue is one a member's bulk edit or rebalance can be
  // holding. This repo measured that Prisma's transaction budget does
  // NOT end a statement the database has parked on a lock (a blocked
  // fan-out under a 3 s budget was still waiting past 30 s,
  // `portal-contention.dbtest.ts`), so without `lockTimeoutMs` a
  // submission could park indefinitely while holding this contact's own
  // budget lock, with every later submission queued behind it. The
  // shape is `setPortalEnabled`'s, for the same reason and with the same
  // parts: a bounded wait, a bounded retry, and a visible refusal when
  // the attempts are spent — which the contact sees as the plane's one
  // generic message, because `REQUEST_BUSY` is not on the disclosure
  // list.
  try {
    return await retryOnContention(() =>
      withTenant(principal.tenantId, { type: "system" }, async (tx) => {
        // The rate limit, first thing inside the write: a refusal must
        // not consume a counter value or a rank (`requests.ts` explains
        // why it is a Postgres count and not the fail-open limiter).
        await assertRequestBudget(tx, principal.tenantId, principal.contactId);

        const created = await createRequest(tx, principal.tenantId, {
          projectId: input.projectId,
          title,
          body: body.length > 0 ? body : null,
          reportedByContactId: principal.contactId,
        });

        await record(tx, {
          action: "portal.request_created",
          targetType: "WorkItem",
          targetId: created.id,
          // The contact, not the system transaction — see `record()`'s
          // own note on this field. Without it the one event family
          // whose actor is not an employee would have no actor at all.
          brokeredForContactId: principal.contactId,
          // Ids and a number, never the title: an audit row is read by
          // operators and retained far longer than the row it describes
          // (SECURITY.md §7 — metadata is minimized by the caller).
          metadata: {
            projectId: created.projectId,
            clientId: created.clientId,
            number: created.number,
          },
        });

        const receivers = await requestReceivers(tx, principal.tenantId, created.projectId);
        await emit(tx, principal.tenantId, {
          kind: "work_item.request_received",
          entity: { type: "WorkItem", id: created.id },
          // NO ACTOR IS PASSED, and that is correct rather than missing:
          // no employee did this, and `emit` only knows how to name a
          // member. A CONTACT actor on a member's notification needs a
          // name resolved on the member plane, which belongs to the
          // slice that gives contacts a presence there. The consequence
          // is small and worth stating: `emit` drops the actor from the
          // receivers, so with none passed nobody is dropped — which is
          // what we want, because the person who acted is not among them.
          clientId: created.clientId,
          projectId: created.projectId,
          memberIds: receivers,
          // IDS ONLY (emit's rule), and this comment used to claim the
          // wrong mechanism for it (code review): the in-app inbox
          // rebuilds its link from `entityId`/`projectId` under the
          // RECEIVER's principal and never reads `params` at all — it
          // is the EMAIL renderer that consumes them, at send time, with
          // no principal. Which is exactly why the rule matters here:
          // whatever goes in travels to an inbox outside this product.
          // `projectKey` is a tenant-chosen label rather than an id, and
          // it is the agency's own, never the client's words.
          params: { projectKey: created.projectKey, itemNumber: String(created.number) },
          dedupeKey: `request:${created.id}`,
        });

        return { id: created.id, projectKey: created.projectKey, number: created.number };
      },
      { lockTimeoutMs: REQUEST_LOCK_WAIT_MS },
      ),
    );
  } catch (e) {
    // BOTH shapes, as `setPortalEnabled` learned to do: a spent lock
    // timeout and a deadlock that survives its attempts mean the same
    // thing to the caller — nothing was written, try again — and
    // letting either through raw would put a 500 on the one thing a
    // client can do. The detail is the breadcrumb for whoever reads the
    // server log; the contact is told nothing but the plane's generic
    // refusal, because `REQUEST_BUSY` is not disclosable.
    if (isLockTimeout(e)) fail("REQUEST_BUSY", "lock timeout");
    if (isDeadlock(e)) fail("REQUEST_BUSY", "deadlock");
    throw e;
  }
}

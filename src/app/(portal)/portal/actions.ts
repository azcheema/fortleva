"use server";

import { revalidatePath } from "next/cache";

import { decidePortalDeliverable } from "@/documents/portal-signoff";
import { setPortalTaskDone } from "@/modules/work";
import { runPortalAction } from "@/portal/action";
import { requirePortalContext } from "@/portal/context";
import { parseSignoffInput, type SignoffDecision } from "@/portal/signoff-vocabulary";
import { decidePortalVersion } from "@/projects/portal-signoff";

/**
 * THE SECOND THING A CLIENT CAN DO, and the first that changes a row the
 * AGENCY made: ticking "I've done my part" on a task handed to them, and
 * unticking it again (Phase 3 slice 6c).
 *
 * **THE PRINCIPAL COMES FROM `requirePortalContext()` AND FROM NOWHERE
 * ELSE** — the rule `requests/new/actions.ts` states at length and the
 * one `brokered-writes.test.ts` pins structurally. It matters twice on
 * this plane: a `contactId` in an argument is a value the browser
 * chooses, and View-as-Contact renders the portal's own components under
 * a MEMBER session, so an action that took its identity from anywhere
 * else would let a member inside View-as stamp a claim in their client's
 * name. It cannot: no contact session is found on a member request and
 * the call redirects to `/portal/login`. Since this slice the member
 * planes also render the surface `inert`, so the button is not even
 * reachable there — but that is a courtesy on top of the mechanism, not
 * the mechanism.
 *
 * **THE ITEM ID IS AN ARGUMENT AND THAT IS SAFE, because it is not an
 * identity.** `setPortalTaskDone` re-derives every identifying term from
 * the principal — tenant, client, and `assigneeContactId = contactId`,
 * which is what makes it the contact's OWN task rather than any task
 * their client can see — and an id that does not satisfy those terms is
 * `NOT_FOUND`. The id names WHICH row to look for; it never widens which
 * rows are reachable.
 *
 * `runPortalAction` rather than `runAction`: on this plane a denial's
 * reason is a fact about the agency, so every authorization failure
 * comes back as one message and the reason goes to the server log
 * (`src/portal/action.ts`). The only refusals a contact is told the real
 * reason for are the allow-listed two, and `INVALID_INPUT` is the one
 * this action can actually produce — a tick on work the agency has
 * already finished or dropped.
 *
 * **IT RETURNS THE STAMP, so the island can adopt a canonical value**
 * rather than keep its optimistic guess. `changed: false` is a real
 * answer and not a failure: a double press on a slow link is the
 * ordinary way here, and the service answers with the row's true value.
 *
 * `revalidatePath('/portal')` because the claim is drawn on that page
 * and nowhere else on this plane. NOT a redirect — the client stays
 * where they are; and the standing trap about a transition around a
 * revalidating action is why the island guards on its own pending flag
 * rather than on the transition (see `task-done.tsx`).
 */
export async function setTaskDoneAction(
  itemId: string,
  done: boolean,
): Promise<
  { ok: true; markedDoneAt: string | null } | { ok: false; message: string }
> {
  const { principal } = await requirePortalContext();
  const result = await runPortalAction("setTaskDone", () =>
    setPortalTaskDone(principal, itemId, done),
  );
  if (!result.ok) return result;
  revalidatePath("/portal");
  // An ISO string, never a `Date`: the value crosses a server-action
  // boundary into a client component, and the island renders it through
  // next-intl's formatter on the client.
  return { ok: true, markedDoneAt: result.value.markedDoneAt?.toISOString() ?? null };
}

/**
 * SIGN OFF — approve, or request changes to, a shipped version or a
 * delivered file the agency asked the client to review (Phase 3,
 * decision #7). The same three rules as the tick above, for the same
 * reasons: the principal is `requirePortalContext()`'s and nobody's
 * else; the ROW id is an argument and that is safe, because the writer
 * re-derives every identifying term from the principal and — unlike
 * the tick — writes under the CONTACT principal, so the database
 * itself refuses a row RLS does not show them; and `runPortalAction`
 * collapses every refusal into the plane's one sentence, except the
 * reader's own input (`INVALID_INPUT`: an unknown decision, a missing
 * or over-long note) and their own rate budget.
 *
 * THE INPUT IS PARSED HERE, before the writer is called — a bad form
 * never opens a transaction, and the parse is the one shared function
 * both writers trust (`parseSignoffInput`).
 *
 * `revalidatePath("/portal", "layout")`: the decision is drawn on the
 * home's card, the project page (twice — the card and the rail or the
 * file row) and the files page, so the whole plane's segment is
 * revalidated rather than three paths guessed. NOT a redirect. The
 * value returned is the row's TRUE state — `changed: false` on a double
 * press hands back the decision that stands — with ISO dates, because
 * it crosses into a client component.
 */
type SignoffAnswer =
  | { ok: true; status: SignoffDecision; decidedAt: string; note: string | null; changed: boolean }
  | { ok: false; message: string };

export async function decideVersionAction(
  versionId: string,
  decision: SignoffDecision,
  note: string | null,
): Promise<SignoffAnswer> {
  const { principal } = await requirePortalContext();
  const result = await runPortalAction("decideVersion", async () =>
    decidePortalVersion(principal, versionId, parseSignoffInput({ decision, note })),
  );
  if (!result.ok) return result;
  revalidatePath("/portal", "layout");
  const v = result.value;
  return { ok: true, status: v.status, decidedAt: v.decidedAt.toISOString(), note: v.note, changed: v.changed };
}

export async function decideDeliverableAction(
  documentId: string,
  decision: SignoffDecision,
  note: string | null,
): Promise<SignoffAnswer> {
  const { principal } = await requirePortalContext();
  const result = await runPortalAction("decideDeliverable", async () =>
    decidePortalDeliverable(principal, documentId, parseSignoffInput({ decision, note })),
  );
  if (!result.ok) return result;
  revalidatePath("/portal", "layout");
  const v = result.value;
  return { ok: true, status: v.status, decidedAt: v.decidedAt.toISOString(), note: v.note, changed: v.changed };
}

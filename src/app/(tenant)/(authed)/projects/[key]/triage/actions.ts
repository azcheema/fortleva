"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { z } from "zod";

import { requireTenantContext } from "@/members/tenant-context";
import {
  TRIAGE_REASON_MAX,
  listItems,
  triageItem,
  type TriageOutcome,
  type WorkCtx,
} from "@/modules/work";
import { runAction, type ActionResult } from "@/lib/server-actions";
import { ITEM_SURFACES, itemReturnTo } from "@/lib/work-view";

/**
 * The triage lane's four verbs, as server actions.
 *
 * ONE ACTION, NOT FOUR, and the reason is the shape of the thing rather
 * than brevity: Accept / Decline / Duplicate / Snooze are one decision
 * with four outcomes, the service takes them as one discriminated union,
 * and four thin wrappers would have been four places to forget the
 * revalidation. The union is re-parsed here because a server action's
 * arguments arrive from the network — `verb` is not trusted to be one of
 * the four just because the client's types say so.
 *
 * TENANT AND MEMBER COME FROM `requireTenantContext()`, never from the
 * form (the standing rule). What the client sends is an item id, a verb
 * and the verb's own field; everything that decides what may happen to
 * that row — the permission, the scope, the target state, the audit row
 * — is the service's.
 *
 * IT RETURNS `ActionResult`, NOT A THROW, because an action failure must
 * never look like a revert (the standing trap): the lane removes the row
 * optimistically, and a refusal has to arrive as a typed message the
 * surface can toast and roll back on.
 */

const uuid = z.uuid();
const keyShape = z.string().regex(/^[A-Z][A-Z0-9]*$/);

/**
 * The reason is capped HERE as well as in the service and the column.
 * Three times is not paranoia: this is the layer that can tell the
 * member which field is wrong, the service is the layer no caller can
 * skip, and the column is the layer no WRITER can skip.
 */
const input = z.discriminatedUnion("verb", [
  z.object({ verb: z.literal("ACCEPT") }),
  z.object({ verb: z.literal("DECLINE"), reason: z.string().trim().min(1).max(TRIAGE_REASON_MAX) }),
  z.object({
    verb: z.literal("DUPLICATE"),
    reason: z.string().trim().min(1).max(TRIAGE_REASON_MAX),
    duplicateOfId: uuid,
  }),
  // An ISO instant from the client's own `<input type="date">`, already
  // resolved to a moment. The BOUNDS are the service's (`parseInput`):
  // "not in the past" is a rule about the clock, and the clock this
  // action reads is the same one the service reads, so checking it twice
  // buys nothing and could disagree at the boundary.
  z.object({ verb: z.literal("SNOOZE"), until: z.iso.datetime() }),
]);

export type TriageActionInput = z.input<typeof input>;

/**
 * WHERE THE MEMBER PRESSED IT, which decides two things and nothing else:
 * the address an MFA step-up returns to, and what is revalidated after.
 *
 * Absent means the lane. Present means the item panel's request band —
 * the door C29 gave `DECLINE` outside the lane, because an ACCEPTED
 * request keeps `kind = REQUEST` for ever while `listTriage` filters
 * `stateCategory = TRIAGE`, so the row the agency could no longer end
 * was not on the one screen that could end it.
 *
 * **IT CARRIES A SURFACE AND A NUMBER, NEVER A PATH.** `itemReturnTo`'s
 * own docblock calls the return address an open-redirect surface and
 * says it must be "built ONLY from validated values" — so the address is
 * composed HERE, from a closed enum and an integer that have been through
 * zod, exactly as `createSubtaskAction` and the backlog's actions
 * compose theirs. A first cut had the client compute the path and pass
 * it; a fresh review would have been right to call that a hole.
 */
const origin = z.object({
  surface: z.enum(ITEM_SURFACES),
  itemNumber: z.number().int().positive(),
});

export type TriageOrigin = z.input<typeof origin>;

export async function triageAction(
  itemId: string,
  projectKey: string,
  raw: TriageActionInput,
  from?: TriageOrigin,
): Promise<ActionResult<TriageOutcome>> {
  const parsed = input.safeParse(raw);
  const id = uuid.safeParse(itemId);
  const key = keyShape.safeParse(projectKey);
  if (!parsed.success || !id.success || !key.success) {
    // The generic refusal: a malformed verb is not something a member
    // did, it is something a client sent, and there is no field to
    // point at. The surface's own field validation is what tells a
    // member about an empty reason before it ever gets here.
    return { ok: false, message: (await getTranslations("common"))("invalidInput") };
  }
  const { membership, actor } = await requireTenantContext();
  const ctx: WorkCtx = { tenantId: membership.tenantId, actor };
  const lane = `/projects/${key.data}/triage`;
  // The step-up return address is where the member actually is. A
  // malformed origin falls back to the lane rather than refusing: the
  // verb is the point, and a wrong return address is not worth losing a
  // reply already typed for a client over.
  const panel = from ? origin.safeParse(from) : null;
  const path =
    panel?.success === true
      ? itemReturnTo(panel.data.surface, key.data, panel.data.itemNumber)
      : lane;

  const result = await runAction(path, () =>
    triageItem(
      ctx,
      id.data,
      parsed.data.verb === "SNOOZE"
        ? { verb: "SNOOZE", until: new Date(parsed.data.until) }
        : parsed.data,
    ),
  );

  if (result.ok) {
    // BOTH SURFACES, because a triage moves the row OUT of the lane and
    // INTO (or out of) the board and the backlog. Revalidating only this
    // route would leave an accepted request missing from the board until
    // the next full load.
    revalidatePath(lane);
    revalidatePath(`/projects/${key.data}/board`);
    revalidatePath(`/projects/${key.data}/backlog`);
    // AND THE ITEM PAGE ITSELF when that is where it happened. The two
    // PEEKS are already covered by the board and backlog paths above;
    // what is not is `/projects/[key]/items/[number]`, so it is named
    // literally.
    //
    // A first cut wrote `revalidatePath(\`/projects/${key.data}\`,
    // "layout")` with a comment claiming it covered all three stops. It
    // covered NONE: `revalidatePath` with a `type` builds the tag
    // `_N_T_/projects/ACME/layout`, while a render's implicit tags are
    // derived from the ROUTE PATTERN (`_N_T_/projects/[key]/layout`), so
    // the two never meet. Next's docs say as much — a literal path takes
    // no `type`. The panel still refreshed, but only because ANY
    // `revalidatePath` call sets `pathWasRevalidated`, which the lane
    // path above was already doing. A dead statement with a confident
    // comment is worse than no statement; found by a fresh review.
    if (panel?.success === true) {
      revalidatePath(`/projects/${key.data}/items/${panel.data.itemNumber}`);
    }
  }
  return result;
}

/** One row a duplicate may point at — the project's own open work. */
export type DuplicateTarget = { id: string; key: string; title: string };

/**
 * The most rows the picker will carry.
 *
 * `listItems` reads the whole project — there is no narrower read on the
 * barrel and inventing one for a control opened a few times a week would
 * be its own slice — so the honest thing is to cap what CROSSES THE
 * WIRE. The list is searched client-side; beyond this many rows a member
 * is typing, not scrolling, and the right fix then is a server-side
 * search rather than a bigger array (recorded rather than pretended
 * away: a code review pointed out that the docblock below called the
 * full list "the most expensive thing this surface could carry" and then
 * carried it, just lazily).
 */
const DUPLICATE_TARGET_LIMIT = 200;

/**
 * THE DUPLICATE PICKER'S LIST, read ON OPEN rather than rendered into
 * every lane page — the shape `quickCreateProjectsAction` established.
 *
 * Marking a request as a duplicate is the rarest of the four verbs, and
 * a project's whole item list is the most expensive thing this surface
 * could carry; loading it with the lane would make every member pay for
 * a control most of them never open.
 *
 * SAME PROJECT ONLY, which is `resolveDuplicate`'s own rule and not a
 * convenience: `duplicate_of_id`'s foreign key binds only the tenant, so
 * the database would accept a row in another CLIENT's project. Narrowing
 * here to the project the lane belongs to means the member's scope was
 * already asserted on it, and the service refuses anything else
 * regardless — this list cannot offer what that would reject.
 *
 * REQUESTS IN TRIAGE ARE EXCLUDED: a request cannot be a duplicate of
 * another unanswered request, or the lane would have two rows pointing
 * at each other and no work behind either. Cancelled rows are excluded
 * for the same reason — pointing at something that was also dropped
 * tells the client nothing.
 */
export async function triageDuplicateTargetsAction(
  projectId: string,
  projectKey: string,
): Promise<ActionResult<DuplicateTarget[]>> {
  const id = uuid.safeParse(projectId);
  const key = keyShape.safeParse(projectKey);
  if (!id.success || !key.success) {
    return { ok: false, message: (await getTranslations("common"))("invalidInput") };
  }
  const { membership, actor } = await requireTenantContext();
  const ctx: WorkCtx = { tenantId: membership.tenantId, actor };
  return runAction(`/projects/${key.data}/triage`, async () => {
    const list = await listItems(ctx, id.data, { includeArchived: false });
    return list.items
      .filter(
        (i) =>
          i.stateCategory !== "TRIAGE" &&
          i.stateCategory !== "CANCELLED" &&
          // DONE is excluded too, because the empty copy beside this
          // list says "no OPEN tasks to point at" and a picker that
          // offers finished work is answering a different question:
          // "we are already on it" is not true of something shipped
          // last quarter (code review).
          i.stateCategory !== "DONE",
      )
      .slice(0, DUPLICATE_TARGET_LIMIT)
      .map((i) => ({ id: i.id, key: `${key.data}-${i.number}`, title: i.title }));
  });
}

"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { z } from "zod";

import { requireTenantContext } from "@/members/tenant-context";
import { changeState, updateItemDescription, type DescriptionSaved } from "@/modules/work";
import { runAction, type ActionResult } from "@/lib/server-actions";
import { stateLabel } from "@/lib/state-label";

/**
 * The item panel's server actions. Tenant and member come from
 * `requireTenantContext()`, never from the caller — and the DOCUMENT is
 * whatever the browser sent, so the service's normaliser decides what is
 * stored (src/lib/rich-text/normalize.ts), not a schema here. A shape
 * check still runs on the two identifiers, which ARE addresses.
 */

const Save = z.object({
  itemId: z.uuid(),
  projectKey: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,7}$/),
  /** 32 hex characters — the token the panel handed this editor. */
  baseToken: z.string().regex(/^[0-9a-f]{32}$/),
});

export async function saveDescriptionAction(input: {
  itemId: string;
  projectKey: string;
  doc: unknown;
  baseToken: string;
}): Promise<ActionResult<DescriptionSaved>> {
  const { membership, actor } = await requireTenantContext();
  const parsed = Save.safeParse(input);
  const key = parsed.success ? parsed.data.projectKey : "";
  return runAction(`/projects/${key}`, async () => {
    if (!parsed.success) throw new Error("invalid description save input");
    const saved = await updateItemDescription(
      { tenantId: membership.tenantId, actor },
      parsed.data.itemId,
      { doc: input.doc, baseToken: parsed.data.baseToken },
    );
    // ONLY the board. Its cards carry the checklist badge this write
    // changes (board.tsx), so it would otherwise show a stale n/m.
    //
    // NOT the backlog: its table renders no checklist and no description,
    // so revalidating it bought nothing and evicted the member's
    // prefetch cache on a field that saves every two seconds.
    //
    // NOT the item page either — and this is the fix, not an omission.
    // `revalidatePath('/projects/ACME/items/[number]', 'page')` mixes a
    // RESOLVED segment with a bracket placeholder, which matches no
    // route and no cache tag: it was a silent no-op that read as
    // coverage. The page is dynamic, so a real navigation re-renders it
    // from the row regardless, and the editor already holds the newer
    // document than any cache could.
    revalidatePath(`/projects/${key}/board`);
    return saved;
  });
}

const SetState = z.object({
  itemId: z.uuid(),
  stateId: z.uuid(),
  projectKey: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,7}$/),
  itemNumber: z.number().int().min(1).max(999_999_999),
  surface: z.enum(["board", "backlog", "page"]),
});

/** The canonical row the picker replaces its optimistic slice with. */
export type StateCommitted = {
  stateId: string;
  stateCategory: string;
  /** Resolved HERE: the work module has no locale, the panel does. */
  stateName: string;
  /** False when the item was already in that state — nothing was written. */
  changed: boolean;
};

/**
 * The item panel's State picker (UI.md §5.2 `S`).
 *
 * It calls `changeState`, never `moveItemAction`: that action with a
 * `stateId` and no anchor resolves both anchors to null and re-ranks the
 * item to the BOTTOM of the project. `changeState` has no rank
 * parameter at all, so the panel physically cannot re-rank — which is
 * also why the rank-only audit carve-out is never in play here. A state
 * change is never a routine edit: `transitionState` writes the activity
 * row and `work_item.state_changed` in the same transaction, as it does
 * for every other entry point.
 */
export async function setPanelStateAction(
  input: z.input<typeof SetState>,
): Promise<ActionResult<StateCommitted>> {
  // Tenant and member come from the session, NEVER from the caller.
  const { membership, actor } = await requireTenantContext();
  const t = await getTranslations("projects.item");
  const parsed = SetState.safeParse(input);
  if (!parsed.success) return { ok: false, message: t("state.failed") };
  const { itemId, stateId, projectKey, itemNumber, surface } = parsed.data;

  // THE STEP-UP RETURN ADDRESS. `setItemStateAction` hardcodes the
  // backlog, which is wrong from a board peek and wrong from the item
  // page; `moveItemAction` fixed the same defect with a `surface` enum
  // that has no value meaning "the item page". This is built from a
  // validated ENUM plus a validated key shape plus a bounded integer —
  // never a path from caller text, which would be an open-redirect
  // surface. Accepted, recorded cost: a step-up drops `?group=` and any
  // filter chips.
  const returnTo =
    surface === "page"
      ? `/projects/${projectKey}/items/${itemNumber}`
      : `/projects/${projectKey}/${surface}?item=${projectKey}-${itemNumber}`;

  const tSeed = await getTranslations("projects.states.seed");
  const r = await runAction(returnTo, async () => {
    const c = await changeState({ tenantId: membership.tenantId, actor }, itemId, stateId);
    return {
      stateId: c.stateId,
      stateCategory: c.stateCategory,
      stateName: stateLabel({ name: c.stateName, seedKey: c.stateSeedKey }, (k) => tSeed(k)),
      changed: c.changed,
    };
  });

  // Only when something actually changed — and never the item page:
  // `revalidatePath('/projects/KEY/items/[number]')` mixes a resolved
  // segment with a bracket placeholder, matches no route and no cache
  // tag, and is a silent no-op that reads as coverage (the same lesson
  // `saveDescriptionAction` above records). The page is dynamic, so the
  // client's `router.refresh()` re-reads it from the row.
  if (r.ok && r.value.changed) {
    revalidatePath(`/projects/${projectKey}/board`);
    revalidatePath(`/projects/${projectKey}/backlog`);
  }
  return r;
}

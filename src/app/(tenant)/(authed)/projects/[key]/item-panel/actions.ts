"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { z } from "zod";

import { requireTenantContext } from "@/members/tenant-context";
import {
  createComment,
  createItem,
  deleteComment,
  setCommentVisibility,
  updateComment,
  updateItemDescription,
  type CommentCreated,
  type CommentEdited,
  type CommentVisibilityCommitted,
  type DescriptionSaved,
  type WorkCtx,
} from "@/modules/work";
import { PROJECT_KEY_RE } from "@/projects/service";
import { runAction, type ActionResult } from "@/lib/server-actions";
import { ITEM_SURFACES, MAX_TITLE_LENGTH, itemReturnTo } from "@/lib/work-view";

/**
 * The item panel's server actions. Tenant and member come from
 * `requireTenantContext()`, never from the caller — and the DOCUMENT is
 * whatever the browser sent, so the service's normaliser decides what is
 * stored (src/lib/rich-text/normalize.ts), not a schema here. A shape
 * check still runs on the two identifiers, which ARE addresses.
 *
 * The panel's PROPERTY setters (S, P, E, D) are not here: they are the
 * backlog table's own actions, shared by both surfaces
 * (`../backlog/actions.ts`), so the table and the panel cannot drift
 * into two validations of one field.
 *
 * `createSubtaskAction` IS here: it is the Subtasks section's own verb
 * (slice 9), and the one create that names a parent. It goes through the
 * same `createItem` as the backlog's row and the board's column "+", so
 * a subtask lands exactly as any task does — numbered, at the bottom of
 * the project's order, in the default state, its visibility defaulted
 * from the parent — and the tree trigger has the last word on nesting.
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

const CreateSubtask = z.object({
  parentId: z.uuid(),
  /** The parent's number — only the MFA step-up return address needs it (`itemReturnTo`). */
  parentNumber: z.number().int().min(1).max(999_999_999),
  projectId: z.uuid(),
  // The projects service's own key rule — `itemReturnTo` builds the
  // step-up address on the strength of it.
  projectKey: z.string().regex(PROJECT_KEY_RE),
  surface: z.enum(ITEM_SURFACES),
  title: z.string().trim().min(1).max(MAX_TITLE_LENGTH),
});

/**
 * Title-only create under a parent (UI rule 2). Returns the new item's
 * id and number; a refusal — a subtask under a subtask, a parent that is
 * gone, a project out of scope — is a typed message the island toasts,
 * never a silent nothing. Both list surfaces are revalidated: the new
 * row is a backlog row and a board card the moment it exists. The
 * parent binds the project: `createItem` reads it under the project the
 * actor was just scoped to, so a mismatched pair is NOT_FOUND.
 */
export async function createSubtaskAction(
  input: z.input<typeof CreateSubtask>,
): Promise<ActionResult<{ id: string; number: number }>> {
  const { membership, actor } = await requireTenantContext();
  const parsed = CreateSubtask.safeParse(input);
  if (!parsed.success) {
    // The one refusal a shape check can produce for a member: the title
    // is empty or too long. The identifiers are the panel's own props.
    const t = await getTranslations("projects.item.subtasks");
    return { ok: false, message: t("invalidTitle", { max: MAX_TITLE_LENGTH }) };
  }
  const p = parsed.data;
  const r = await runAction(itemReturnTo(p.surface, p.projectKey, p.parentNumber), () =>
    createItem({ tenantId: membership.tenantId, actor }, { projectId: p.projectId, title: p.title, parentId: p.parentId }),
  );
  if (r.ok) {
    revalidatePath(`/projects/${p.projectKey}/backlog`);
    revalidatePath(`/projects/${p.projectKey}/board`);
  }
  return r;
}

/**
 * The Comments section's four verbs (slice 10). The DOCUMENT is whatever
 * the browser sent — `normalizeComment` decides what is stored, not a
 * schema here — and the identifiers are checked for shape because they
 * are addresses; the MFA step-up return address is the panel's own
 * (`itemReturnTo`), as for every other panel action. No `revalidatePath`:
 * a comment is on no list surface, and the islands `router.refresh()`
 * inside their own transition (comment-card.tsx, comment-composer.tsx).
 */
const CommentAddress = {
  /** The item's number — only the MFA step-up return address needs it. */
  itemNumber: z.number().int().min(1).max(999_999_999),
  projectKey: z.string().regex(PROJECT_KEY_RE),
  surface: z.enum(ITEM_SURFACES),
};

const CommentAddressSchema = z.object(CommentAddress);

/**
 * ONE shape for the four verbs: the tenant and actor from the session,
 * the identifiers parsed, the step-up return address computed from the
 * PARSED address (never from the raw input), and the service call with
 * the parsed data — so the invariant that an address is validated
 * before it is used is written once. The DOCUMENT is passed beside the
 * parsed data, raw: the normaliser is its gate.
 */
async function commentAction<S extends z.ZodObject<typeof CommentAddress>, T>(
  schema: S,
  input: unknown,
  fn: (parsed: z.output<S>, ctx: WorkCtx) => Promise<T>,
): Promise<ActionResult<T>> {
  const { membership, actor } = await requireTenantContext();
  const parsed = schema.safeParse(input);
  const address = parsed.success ? CommentAddressSchema.parse(parsed.data) : null;
  const returnTo = address ? itemReturnTo(address.surface, address.projectKey, address.itemNumber) : "/projects";
  return runAction(returnTo, async () => {
    if (!parsed.success) throw new Error("invalid comment input");
    return fn(parsed.data, { tenantId: membership.tenantId, actor });
  });
}

const CreateComment = z.object({
  itemId: z.uuid(),
  visibility: z.enum(["INTERNAL", "CLIENT_VISIBLE"]),
  ...CommentAddress,
});

export async function createCommentAction(
  input: z.input<typeof CreateComment> & { doc: unknown },
): Promise<ActionResult<CommentCreated>> {
  return commentAction(CreateComment, input, (p, ctx) =>
    createComment(ctx, p.itemId, { doc: input.doc, visibility: p.visibility }),
  );
}

const CommentTarget = z.object({ commentId: z.uuid(), ...CommentAddress });

export async function updateCommentAction(
  input: z.input<typeof CommentTarget> & { doc: unknown },
): Promise<ActionResult<CommentEdited>> {
  return commentAction(CommentTarget, input, (p, ctx) => updateComment(ctx, p.commentId, { doc: input.doc }));
}

export async function deleteCommentAction(input: z.input<typeof CommentTarget>): Promise<ActionResult<{ id: string }>> {
  return commentAction(CommentTarget, input, async (p, ctx) => {
    await deleteComment(ctx, p.commentId);
    return { id: p.commentId };
  });
}

const CommentVisibility = z.object({ visibility: z.enum(["INTERNAL", "CLIENT_VISIBLE"]), ...CommentTarget.shape });

export async function setCommentVisibilityAction(
  input: z.input<typeof CommentVisibility>,
): Promise<ActionResult<CommentVisibilityCommitted>> {
  return commentAction(CommentVisibility, input, (p, ctx) => setCommentVisibility(ctx, p.commentId, p.visibility));
}

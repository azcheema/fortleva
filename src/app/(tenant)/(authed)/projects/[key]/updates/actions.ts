"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { runAction, type ActionResult } from "@/lib/server-actions";
import { requireTenantContext } from "@/members/tenant-context";
import {
  annotateUpdate,
  archiveUpdate,
  createUpdateDraft,
  discardUpdateDraft,
  publishUpdate,
  readComposerContext,
  retractUpdate,
  setUpdateVisibility,
  updateUpdateDraft,
  UPDATE_EDIT_NOTE_MAX,
  UPDATE_TITLE_MAX,
  type ComposerContext,
  type UpdatePublished,
} from "@/modules/work";

/**
 * Server actions for /projects/[key]/updates (Phase 3, DATA_MODEL
 * §6.16). Thin: parse → the service authorises, scopes, mutates and
 * audits in one transaction → revalidate. Tenant and actor come from
 * the session; the body is whatever the composer sent and the SERVICE
 * normalises it (`normalizeUpdateBody`), so a crafted document is
 * refused where every other rich-text write refuses it.
 *
 * `projectKey` is validated to the key's own shape before it reaches a
 * path: it is what `runAction` returns to after an MFA step-up, and an
 * unvalidated one would be an open redirect.
 */

const uuid = z.uuid();
const keyShape = z.string().regex(/^[A-Z][A-Z0-9]{0,7}$/);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable();
const health = z.enum(["ON_TRACK", "AT_RISK", "OFF_TRACK", "ON_HOLD", "COMPLETE"]);
const visibility = z.enum(["INTERNAL", "CLIENT_VISIBLE"]);

const draftInput = z.object({
  projectId: uuid,
  projectKey: keyShape,
  id: uuid.nullable(),
  health,
  title: z.string().max(UPDATE_TITLE_MAX).nullable(),
  periodStart: isoDate,
  periodEnd: isoDate,
  body: z.unknown(),
});
export type SaveDraftInput = z.input<typeof draftInput>;

const ctxOf = async () => {
  const { membership, actor } = await requireTenantContext();
  return { tenantId: membership.tenantId, actor };
};

const updatesPath = (key: string, sub = "") => `/projects/${key}/updates${sub}`;

const revalidate = (key: string) => {
  revalidatePath(updatesPath(key), "layout");
  // The header chip and the portal card both read the newest published post.
  revalidatePath(`/projects/${key}`, "layout");
  revalidatePath("/portal");
};

const invalid = (): ActionResult<never> => ({ ok: false, message: "" });

export async function saveUpdateDraftAction(raw: SaveDraftInput): Promise<ActionResult<{ id: string }>> {
  const parsed = draftInput.safeParse(raw);
  if (!parsed.success) return invalid();
  const input = parsed.data;
  const ctx = await ctxOf();
  const r = await runAction(updatesPath(input.projectKey), async () => {
    const fields = {
      health: input.health,
      title: input.title,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      body: input.body,
    };
    return input.id === null
      ? createUpdateDraft(ctx, input.projectId, fields)
      : updateUpdateDraft(ctx, input.id, fields);
  });
  if (r.ok) revalidate(input.projectKey);
  return r;
}

const verbInput = z.object({ projectKey: keyShape, id: uuid });

export async function publishUpdateAction(raw: {
  projectKey: string;
  id: string;
  visibility: "INTERNAL" | "CLIENT_VISIBLE";
}): Promise<ActionResult<UpdatePublished>> {
  const parsed = verbInput.extend({ visibility }).safeParse(raw);
  if (!parsed.success) return invalid();
  const { projectKey, id, visibility: audience } = parsed.data;
  const ctx = await ctxOf();
  const r = await runAction(updatesPath(projectKey, `/${id}`), () => publishUpdate(ctx, id, { visibility: audience }));
  if (r.ok) revalidate(projectKey);
  return r;
}

export async function discardUpdateDraftAction(raw: { projectKey: string; id: string }): Promise<ActionResult<void>> {
  const parsed = verbInput.safeParse(raw);
  if (!parsed.success) return invalid();
  const { projectKey, id } = parsed.data;
  const ctx = await ctxOf();
  const r = await runAction(updatesPath(projectKey), () => discardUpdateDraft(ctx, id));
  if (r.ok) revalidate(projectKey);
  return r;
}

export async function archiveUpdateAction(raw: { projectKey: string; id: string }): Promise<ActionResult<void>> {
  const parsed = verbInput.safeParse(raw);
  if (!parsed.success) return invalid();
  const { projectKey, id } = parsed.data;
  const ctx = await ctxOf();
  const r = await runAction(updatesPath(projectKey, `/${id}`), () => archiveUpdate(ctx, id));
  if (r.ok) revalidate(projectKey);
  return r;
}

export async function retractUpdateAction(raw: { projectKey: string; id: string }): Promise<ActionResult<void>> {
  const parsed = verbInput.safeParse(raw);
  if (!parsed.success) return invalid();
  const { projectKey, id } = parsed.data;
  const ctx = await ctxOf();
  const r = await runAction(updatesPath(projectKey, `/${id}`), () => retractUpdate(ctx, id));
  if (r.ok) revalidate(projectKey);
  return r;
}

export async function setUpdateVisibilityAction(raw: {
  projectKey: string;
  id: string;
  visibility: "INTERNAL" | "CLIENT_VISIBLE";
}): Promise<ActionResult<void>> {
  const parsed = verbInput.extend({ visibility }).safeParse(raw);
  if (!parsed.success) return invalid();
  const { projectKey, id, visibility: audience } = parsed.data;
  const ctx = await ctxOf();
  const r = await runAction(updatesPath(projectKey, `/${id}`), () => setUpdateVisibility(ctx, id, audience));
  if (r.ok) revalidate(projectKey);
  return r;
}

export async function annotateUpdateAction(raw: {
  projectKey: string;
  id: string;
  editNote: string | null;
}): Promise<ActionResult<void>> {
  const parsed = verbInput.extend({ editNote: z.string().max(UPDATE_EDIT_NOTE_MAX).nullable() }).safeParse(raw);
  if (!parsed.success) return invalid();
  const { projectKey, id, editNote } = parsed.data;
  const ctx = await ctxOf();
  const r = await runAction(updatesPath(projectKey, `/${id}`), () => annotateUpdate(ctx, id, editNote));
  if (r.ok) revalidate(projectKey);
  return r;
}

const contextInput = z.object({
  projectId: uuid,
  projectKey: keyShape,
  periodStart: isoDate,
  periodEnd: isoDate,
  excludeId: uuid.nullable(),
});

/** The composer's window-dependent context, re-asked when the dates change. */
export async function composerContextAction(raw: {
  projectId: string;
  projectKey: string;
  periodStart: string | null;
  periodEnd: string | null;
  excludeId: string | null;
}): Promise<ActionResult<ComposerContext>> {
  const parsed = contextInput.safeParse(raw);
  if (!parsed.success) return invalid();
  const { projectId, projectKey, periodStart, periodEnd, excludeId } = parsed.data;
  const ctx = await ctxOf();
  return runAction(updatesPath(projectKey), () =>
    readComposerContext(ctx, projectId, { periodStart, periodEnd, ...(excludeId ? { excludeId } : {}) }),
  );
}

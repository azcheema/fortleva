"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { z } from "zod";

import { requireTenantContext } from "@/members/tenant-context";
import {
  assignItem,
  changeItemVisibility,
  changeState,
  createItem,
  deleteItem,
  moveItem,
  setItemArchived,
  updateItemFields,
  type MovedItem,
  type WorkCtx,
} from "@/modules/work";
import { runAction, runForm, type ActionResult, type FormResult } from "@/lib/server-actions";

/**
 * Thin server actions for the project's work surfaces (the backlog
 * list and the board share them): parse → call the work service →
 * revalidate both routes. Tenant and member come from
 * requireTenantContext(), never from the form.
 */

const uuid = z.uuid();
const keyShape = z.string().regex(/^[A-Z][A-Z0-9]*$/);

const ctxOf = async (): Promise<WorkCtx> => {
  const { membership, actor } = await requireTenantContext();
  return { tenantId: membership.tenantId, actor };
};

const backlogPath = (key: string) => `/projects/${key}/backlog`;
const boardPath = (key: string) => `/projects/${key}/board`;

/** One order, one item set: whichever surface wrote, both re-render. */
const revalidate = (key: string) => {
  revalidatePath(backlogPath(key));
  revalidatePath(boardPath(key));
};

export async function createItemAction(
  projectId: string,
  projectKey: string,
  title: string,
): Promise<FormResult> {
  const ctx = await ctxOf();
  const t = await getTranslations("projects.backlog");
  const id = uuid.safeParse(projectId);
  const key = keyShape.safeParse(projectKey);
  const trimmed = title.trim().slice(0, 400);
  if (!id.success || !key.success || trimmed.length === 0) {
    return { ok: false, message: t("invalidTitle") };
  }
  const r = await runForm(backlogPath(key.data), async () => {
    const created = await createItem(ctx, { projectId: id.data, title: trimmed });
    return t("created", { key: `${key.data}-${created.number}` });
  });
  if (r.ok) revalidate(key.data);
  return r;
}

export async function renameItemAction(
  itemId: string,
  projectKey: string,
  title: string,
): Promise<FormResult> {
  const ctx = await ctxOf();
  const t = await getTranslations("projects.backlog");
  const id = uuid.safeParse(itemId);
  const key = keyShape.safeParse(projectKey);
  const trimmed = title.trim().slice(0, 400);
  if (!id.success || !key.success || trimmed.length === 0) {
    return { ok: false, message: t("invalidTitle") };
  }
  const r = await runForm(backlogPath(key.data), async () => {
    await updateItemFields(ctx, id.data, { title: trimmed });
    return t("saved");
  });
  if (r.ok) revalidate(key.data);
  return r;
}

export async function setItemStateAction(
  itemId: string,
  projectKey: string,
  stateId: string,
): Promise<FormResult> {
  const ctx = await ctxOf();
  const t = await getTranslations("projects.backlog");
  const id = uuid.safeParse(itemId);
  const state = uuid.safeParse(stateId);
  const key = keyShape.safeParse(projectKey);
  if (!id.success || !state.success || !key.success) {
    return { ok: false, message: t("invalidTitle") };
  }
  const r = await runForm(backlogPath(key.data), async () => {
    await changeState(ctx, id.data, state.data);
    return t("saved");
  });
  if (r.ok) revalidate(key.data);
  return r;
}

export async function assignItemAction(
  itemId: string,
  projectKey: string,
  memberId: string,
): Promise<FormResult> {
  const ctx = await ctxOf();
  const t = await getTranslations("projects.backlog");
  const id = uuid.safeParse(itemId);
  const key = keyShape.safeParse(projectKey);
  const member = memberId === "" ? null : uuid.safeParse(memberId).data ?? null;
  if (!id.success || !key.success || (memberId !== "" && member === null)) {
    return { ok: false, message: t("invalidTitle") };
  }
  const r = await runForm(backlogPath(key.data), async () => {
    await assignItem(ctx, id.data, member);
    return t("saved");
  });
  if (r.ok) revalidate(key.data);
  return r;
}

export async function setItemEstimateAction(
  itemId: string,
  projectKey: string,
  estimateMinutes: number | null,
): Promise<FormResult> {
  const ctx = await ctxOf();
  const t = await getTranslations("projects.backlog");
  const id = uuid.safeParse(itemId);
  const key = keyShape.safeParse(projectKey);
  const minutes = z.number().int().min(0).max(600_000).nullable().safeParse(estimateMinutes);
  if (!id.success || !key.success || !minutes.success) {
    return { ok: false, message: t("invalidEstimate") };
  }
  const r = await runForm(backlogPath(key.data), async () => {
    await updateItemFields(ctx, id.data, { estimateMinutes: minutes.data });
    return t("saved");
  });
  if (r.ok) revalidate(key.data);
  return r;
}

export async function setItemVisibilityAction(
  itemId: string,
  projectKey: string,
  visibility: string,
): Promise<FormResult> {
  const ctx = await ctxOf();
  const t = await getTranslations("projects.backlog");
  const id = uuid.safeParse(itemId);
  const key = keyShape.safeParse(projectKey);
  if (!id.success || !key.success) return { ok: false, message: t("invalidTitle") };
  // Anything unrecognised falls to INTERNAL — the worst-bug guard.
  const next = visibility === "CLIENT_VISIBLE" ? "CLIENT_VISIBLE" : "INTERNAL";
  const r = await runForm(backlogPath(key.data), async () => {
    await changeItemVisibility(ctx, id.data, next);
    return t("saved");
  });
  if (r.ok) revalidate(key.data);
  return r;
}

export async function setItemArchivedAction(
  itemId: string,
  projectKey: string,
  archived: boolean,
): Promise<FormResult> {
  const ctx = await ctxOf();
  const t = await getTranslations("projects.backlog");
  const id = uuid.safeParse(itemId);
  const key = keyShape.safeParse(projectKey);
  if (!id.success || !key.success) return { ok: false, message: t("invalidTitle") };
  const r = await runForm(backlogPath(key.data), async () => {
    await setItemArchived(ctx, id.data, archived);
    return archived ? t("archivedToast") : t("restoredToast");
  });
  if (r.ok) revalidate(key.data);
  return r;
}

export async function deleteItemAction(itemId: string, projectKey: string): Promise<FormResult> {
  const ctx = await ctxOf();
  const t = await getTranslations("projects.backlog");
  const id = uuid.safeParse(itemId);
  const key = keyShape.safeParse(projectKey);
  if (!id.success || !key.success) return { ok: false, message: t("invalidTitle") };
  const r = await runForm(backlogPath(key.data), async () => {
    await deleteItem(ctx, id.data);
    return t("deletedToast");
  });
  if (r.ok) revalidate(key.data);
  return r;
}

/**
 * Board: title-only create straight into a column (UI rule 2). The id +
 * number come back for a caller that wants them; the board itself keeps
 * its optimistic card until the revalidated page replaces it, which is
 * the same round trip.
 */
export async function createItemInStateAction(
  projectId: string,
  projectKey: string,
  stateId: string,
  title: string,
): Promise<ActionResult<{ id: string; number: number }>> {
  const ctx = await ctxOf();
  const t = await getTranslations("projects.backlog");
  const parsed = z
    .object({
      projectId: uuid,
      projectKey: keyShape,
      stateId: uuid,
      title: z.string().trim().min(1).max(400),
    })
    .safeParse({ projectId, projectKey, stateId, title });
  if (!parsed.success) return { ok: false, message: t("invalidTitle") };
  const input = parsed.data;
  const r = await runAction(boardPath(input.projectKey), () =>
    createItem(ctx, { projectId: input.projectId, title: input.title, stateId: input.stateId }),
  );
  if (r.ok) revalidate(input.projectKey);
  return r;
}

/**
 * Board drop / "Move to…" (UI.md §7.1): the client sends ids — a target
 * state and at most the neighbour it lands after/before — never a rank.
 * The service computes the rank under lock and runs the state machine
 * in the same transaction; the canonical row comes back so the
 * optimistic card is replaced, not merged (§7.2).
 */
export async function moveItemAction(input: {
  itemId: string;
  projectKey: string;
  stateId?: string;
  afterId?: string | null;
  beforeId?: string | null;
}): Promise<ActionResult<MovedItem>> {
  const ctx = await ctxOf();
  const t = await getTranslations("projects.board");
  const parsed = z
    .object({
      itemId: uuid,
      projectKey: keyShape,
      stateId: uuid.optional(),
      afterId: uuid.nullable().optional(),
      beforeId: uuid.nullable().optional(),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false, message: t("moveFailed") };
  const { itemId, projectKey, stateId, afterId, beforeId } = parsed.data;
  const r = await runAction(boardPath(projectKey), () =>
    moveItem(ctx, {
      itemId,
      ...(stateId ? { stateId } : {}),
      afterId: afterId ?? null,
      beforeId: beforeId ?? null,
    }),
  );
  if (r.ok) revalidate(projectKey);
  return r;
}


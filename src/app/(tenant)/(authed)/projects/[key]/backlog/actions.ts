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
  setItemArchived,
  updateItemFields,
  type WorkCtx,
} from "@/modules/work";
import { runForm, type FormResult } from "@/lib/server-actions";

/**
 * Thin server actions for the minimal task list (2W core slice):
 * parse → call the work service → revalidate. Tenant and member come
 * from requireTenantContext(), never from the form.
 */

const uuid = z.uuid();
const keyShape = z.string().regex(/^[A-Z][A-Z0-9]*$/);

const ctxOf = async (): Promise<WorkCtx> => {
  const { membership, actor } = await requireTenantContext();
  return { tenantId: membership.tenantId, actor };
};

const backlogPath = (key: string) => `/projects/${key}/backlog`;

const revalidate = (key: string) => {
  revalidatePath(backlogPath(key));
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

"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { z } from "zod";

import { SAVED_VIEW_KINDS } from "@/lib/saved-view-plan";
import { runAction, type ActionResult } from "@/lib/server-actions";
import { requireTenantContext } from "@/members/tenant-context";
// Off the barrel on purpose: saved views are one feature's service.
import {
  createSavedView,
  deleteSavedView,
  renameSavedView,
  updateSavedViewQuery,
  type SavedViewWritten,
} from "@/modules/work/saved-views";

/**
 * Server actions for SAVED VIEWS (slice 136, C113): made from the Tasks page
 * or a backlog, updated there, renamed and deleted from the left menu. Thin:
 * parse → service (which gates, scopes and audits in its transaction) →
 * revalidate. Tenant and member come from the session, never from the form.
 *
 * Every success revalidates the WHOLE signed-in layout: the left menu is
 * drawn there, and a view's name or its link (which carries its filters) is
 * in it. Rare acts, so the full re-render is the price of a menu that never
 * lies.
 */

const uuid = z.uuid();
// Generous: the service reads both strictly and refuses past its own bounds.
const nameField = z.string().max(500);
const queryField = z.string().max(8000);

const ctxOf = async () => {
  const { membership, actor } = await requireTenantContext();
  return { tenantId: membership.tenantId, actor };
};

const revalidateMenu = (): void => revalidatePath("/", "layout");

const INVALID = async (): Promise<{ ok: false; message: string }> => ({
  ok: false,
  message: (await getTranslations("common"))("invalidInput"),
});

/** "Save view" — the filters on screen, under a name. */
export async function createSavedViewAction(raw: {
  kind: string;
  projectId: string | null;
  name: string;
  query: string;
}): Promise<ActionResult<SavedViewWritten>> {
  const parsed = z
    .object({ kind: z.enum(SAVED_VIEW_KINDS), projectId: uuid.nullable(), name: nameField, query: queryField })
    .safeParse(raw);
  if (!parsed.success) return INVALID();
  const ctx = await ctxOf();
  const r = await runAction("/tasks", () => createSavedView(ctx, parsed.data));
  if (r.ok) revalidateMenu();
  return r;
}

/** "Update view" — the open view keeps the filters on screen. */
export async function updateSavedViewAction(raw: {
  id: string;
  query: string;
}): Promise<ActionResult<SavedViewWritten & { changed: boolean }>> {
  const parsed = z.object({ id: uuid, query: queryField }).safeParse(raw);
  if (!parsed.success) return INVALID();
  const ctx = await ctxOf();
  const r = await runAction("/tasks", () => updateSavedViewQuery(ctx, parsed.data.id, parsed.data.query));
  if (r.ok && r.value.changed) revalidateMenu();
  return r;
}

/** The left menu's Rename. */
export async function renameSavedViewAction(raw: {
  id: string;
  name: string;
}): Promise<ActionResult<{ name: string; changed: boolean }>> {
  const parsed = z.object({ id: uuid, name: nameField }).safeParse(raw);
  if (!parsed.success) return INVALID();
  const ctx = await ctxOf();
  const r = await runAction("/tasks", () => renameSavedView(ctx, parsed.data.id, parsed.data.name));
  if (r.ok && r.value.changed) revalidateMenu();
  return r;
}

/** The left menu's Delete — only the view goes. */
export async function deleteSavedViewAction(raw: { id: string }): Promise<ActionResult> {
  const parsed = z.object({ id: uuid }).safeParse(raw);
  if (!parsed.success) return INVALID();
  const ctx = await ctxOf();
  const r = await runAction("/tasks", async () => {
    await deleteSavedView(ctx, parsed.data.id);
    return undefined;
  });
  if (r.ok) revalidateMenu();
  return r;
}

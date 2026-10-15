"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { z } from "zod";

import { field, runForm, type FormResult } from "@/lib/server-actions";
import { STAGE_KINDS } from "@/lib/stage-rules";
import { requireTenantContext } from "@/members/tenant-context";
import {
  addProjectStage,
  addWorkspaceStage,
  moveProjectStage,
  moveWorkspaceStage,
  removeProjectStage,
  removeWorkspaceStage,
  renameProjectStage,
  renameWorkspaceStage,
  restoreWorkspaceStages,
  setProjectDefaultStage,
  setProjectStageApproval,
  setWorkspaceDefaultStage,
  setWorkspaceStageApproval,
  type WorkCtx,
} from "@/modules/work";

/**
 * Server actions for the stage editors (slice 123, C99 (a)): the workspace
 * default (/settings/stages) and a project's own (/projects/[key]/stages),
 * ONE file because the two tables are one component. Thin: parse → service
 * (gates, scope, rules under the lock, audit, one transaction) → revalidate.
 * Tenant and member come from the session; the PROJECT id is the target the
 * service scope-checks, never trusted as anything more.
 */

const SETTINGS_PATH = "/settings/stages";

const ctxOf = async (): Promise<WorkCtx> => {
  const { membership, actor } = await requireTenantContext();
  return { tenantId: membership.tenantId, actor };
};

const scopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("workspace") }),
  z.object({ kind: z.literal("project"), projectId: z.uuid() }),
]);
export type StageScope = z.infer<typeof scopeSchema>;

/** A workspace entry's key (a uuid, or `seed-<KEY>` for a built-in one) or a state id. */
const stageId = z.string().min(1).max(64);
const kind = z.enum(STAGE_KINDS);

function revalidate(scope: StageScope): void {
  if (scope.kind === "workspace") revalidatePath(SETTINGS_PATH);
  // Every project page reads the stages (board, backlog, the panel's
  // picker, the Stages page itself); the key is not known here.
  else revalidatePath("/projects/[key]", "layout");
}

const returnTo = (scope: StageScope) => (scope.kind === "workspace" ? SETTINGS_PATH : "/projects");

const scopeOfForm = (fd: FormData): StageScope | null => {
  const parsed = scopeSchema.safeParse(
    field(fd, "scope") === "project" ? { kind: "project", projectId: field(fd, "projectId") } : { kind: "workspace" },
  );
  return parsed.success ? parsed.data : null;
};

/** AutoForm (one per row): the name cell. */
export async function renameStageAction(formData: FormData): Promise<FormResult> {
  const t = await getTranslations("stageEditor");
  const tCommon = await getTranslations("common");
  const scope = scopeOfForm(formData);
  const id = stageId.safeParse(field(formData, "id"));
  const name = field(formData, "name");
  if (!scope || !id.success || name === null) return { ok: false, message: tCommon("invalidInput") };
  const ctx = await ctxOf();
  const r = await runForm(returnTo(scope), async () => {
    if (scope.kind === "workspace") await renameWorkspaceStage(ctx, id.data, name);
    else await renameProjectStage(ctx, scope.projectId, id.data, name);
    return t("renamed");
  });
  if (r.ok) revalidate(scope);
  return r;
}

export type AddStageState = FormResult | null;

/** useActionState: the add form under the table. */
export async function addStageAction(_prev: AddStageState, formData: FormData): Promise<AddStageState> {
  const t = await getTranslations("stageEditor");
  const tCommon = await getTranslations("common");
  const scope = scopeOfForm(formData);
  const k = kind.safeParse(field(formData, "kind"));
  const name = field(formData, "name");
  if (!scope || !k.success || name === null) return { ok: false, message: tCommon("invalidInput") };
  const ctx = await ctxOf();
  const r = await runForm(returnTo(scope), async () => {
    if (scope.kind === "workspace") await addWorkspaceStage(ctx, { name, kind: k.data });
    else await addProjectStage(ctx, scope.projectId, { name, kind: k.data });
    return t("added");
  });
  if (r.ok) revalidate(scope);
  return r;
}

const rowInput = z.object({ scope: scopeSchema, id: stageId });

export async function moveStageAction(raw: { scope: StageScope; id: string; dir: "up" | "down" }): Promise<FormResult> {
  const t = await getTranslations("stageEditor");
  const tCommon = await getTranslations("common");
  const parsed = rowInput.extend({ dir: z.enum(["up", "down"]) }).safeParse(raw);
  if (!parsed.success) return { ok: false, message: tCommon("invalidInput") };
  const { scope, id, dir } = parsed.data;
  const ctx = await ctxOf();
  const r = await runForm(returnTo(scope), async () => {
    if (scope.kind === "workspace") await moveWorkspaceStage(ctx, id, dir);
    else await moveProjectStage(ctx, scope.projectId, id, dir);
    return t("moved");
  });
  if (r.ok) revalidate(scope);
  return r;
}

export async function setDefaultStageAction(raw: { scope: StageScope; id: string }): Promise<FormResult> {
  const t = await getTranslations("stageEditor");
  const tCommon = await getTranslations("common");
  const parsed = rowInput.safeParse(raw);
  if (!parsed.success) return { ok: false, message: tCommon("invalidInput") };
  const { scope, id } = parsed.data;
  const ctx = await ctxOf();
  const r = await runForm(returnTo(scope), async () => {
    if (scope.kind === "workspace") await setWorkspaceDefaultStage(ctx, id);
    else await setProjectDefaultStage(ctx, scope.projectId, id);
    return t("defaultSet");
  });
  if (r.ok) revalidate(scope);
  return r;
}

export async function setStageApprovalAction(raw: { scope: StageScope; id: string; on: boolean }): Promise<FormResult> {
  const t = await getTranslations("stageEditor");
  const tCommon = await getTranslations("common");
  const parsed = rowInput.extend({ on: z.boolean() }).safeParse(raw);
  if (!parsed.success) return { ok: false, message: tCommon("invalidInput") };
  const { scope, id, on } = parsed.data;
  const ctx = await ctxOf();
  const r = await runForm(returnTo(scope), async () => {
    if (scope.kind === "workspace") await setWorkspaceStageApproval(ctx, id, on);
    else await setProjectStageApproval(ctx, scope.projectId, id, on);
    return on ? t("approvalOn") : t("approvalOff");
  });
  if (r.ok) revalidate(scope);
  return r;
}

/** Remove a stage; a project's tasks in it move to `targetId` (another stage of the same kind). */
export async function removeStageAction(raw: {
  scope: StageScope;
  id: string;
  targetId: string | null;
}): Promise<FormResult> {
  const t = await getTranslations("stageEditor");
  const tCommon = await getTranslations("common");
  const parsed = rowInput.extend({ targetId: z.uuid().nullable() }).safeParse(raw);
  if (!parsed.success) return { ok: false, message: tCommon("invalidInput") };
  const { scope, id, targetId } = parsed.data;
  const ctx = await ctxOf();
  const r = await runForm(returnTo(scope), async () => {
    if (scope.kind === "workspace") {
      await removeWorkspaceStage(ctx, id);
      return t("removed");
    }
    const { moved } = await removeProjectStage(ctx, scope.projectId, id, targetId);
    return moved > 0 ? t("removedMoved", { count: moved }) : t("removed");
  });
  if (r.ok) revalidate(scope);
  return r;
}

/** Back to Fortleva's original stages — for projects made from now on. */
export async function restoreStagesAction(): Promise<FormResult> {
  const t = await getTranslations("stageEditor");
  const ctx = await ctxOf();
  const r = await runForm(SETTINGS_PATH, async () => {
    await restoreWorkspaceStages(ctx);
    return t("restored");
  });
  if (r.ok) revalidatePath(SETTINGS_PATH);
  return r;
}

"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { z } from "zod";

import { assignMemberToProject, unassignMemberFromProject } from "@/clients/assignments";
import { dateField, field, has, runForm, type FormResult } from "@/lib/server-actions";
import { requireTenantContext } from "@/members/tenant-context";
import {
  createMilestone,
  reorderMilestone,
  setMilestoneStatus,
  updateMilestone,
  type ReorderTarget,
} from "@/projects/milestones";
import {
  archiveProject,
  changeProjectKey,
  changeProjectStatus,
  setHoursSharingMode,
  setPortalEnabled,
  unarchiveProject,
  updateProject,
  type ProjectPatch,
} from "@/projects/service";
import { createVersion, shipVersion, updateVersion } from "@/projects/versions";

/**
 * Server actions for /projects/[key]/*. Tenant + actor from the session;
 * the services authorize + scope + audit in one transaction. Forms
 * carry the project id (never trusted for scope — the service asserts
 * it) and the key only to build revalidation paths.
 */

const uuid = z.uuid();
const STATUSES = ["PLANNED", "ACTIVE", "PAUSED", "COMPLETED", "CANCELLED"] as const;
const CADENCES = ["NONE", "WEEKLY", "BIWEEKLY", "MONTHLY"] as const;
const HOURS_MODES = ["NONE", "HOURS", "BILLABLE_AMOUNT"] as const;
const MILESTONE_STATUSES = ["PLANNED", "IN_PROGRESS", "PAUSED", "DONE", "CANCELLED"] as const;

const ctxOf = async () => {
  const { membership, actor } = await requireTenantContext();
  return { tenantId: membership.tenantId, actor };
};

const invalid = async (): Promise<FormResult> => ({
  ok: false,
  message: (await getTranslations("common"))("invalidInput"),
});

const oneOf = <T extends readonly string[]>(list: T, v: string | null): T[number] | null =>
  v !== null && list.includes(v) ? (v as T[number]) : null;

const projectPath = (key: string, sub = "") => `/projects/${key}${sub}`;

const revalidateProject = (key: string) => {
  revalidatePath(projectPath(key), "layout");
  revalidatePath("/projects");
};

// ── Overview: fields (AutoForm) ─────────────────────────────────────

export async function updateProjectAction(formData: FormData): Promise<FormResult> {
  const projectId = uuid.safeParse(formData.get("projectId"));
  const key = field(formData, "projectKey") ?? "";
  if (!projectId.success || !key) return invalid();
  const ctx = await ctxOf();
  const tCommon = await getTranslations("common");
  const patch: ProjectPatch = {};
  for (const f of [
    "name",
    "type",
    "scopeSummary",
    "productionUrl",
    "stagingUrl",
    "repoUrl",
    "hostingNotes",
    "internalNotes",
    "billingCurrency",
  ] as const) {
    if (has(formData, f)) patch[f] = field(formData, f) ?? "";
  }
  if (has(formData, "startDate")) patch.startDate = dateField(formData, "startDate");
  if (has(formData, "launchDate")) patch.launchDate = dateField(formData, "launchDate");
  if (has(formData, "leadMemberId")) patch.leadMemberId = field(formData, "leadMemberId") || null;
  if (has(formData, "updateCadence")) {
    patch.updateCadence = oneOf(CADENCES, field(formData, "updateCadence")) ?? "NONE";
  }
  // Checkbox: present ⇒ on; the form always carries a marker so "off" is distinguishable.
  if (has(formData, "defaultBillableMarker")) patch.defaultBillable = formData.get("defaultBillable") === "on";
  const r = await runForm(projectPath(key), async () => {
    await updateProject(ctx, projectId.data, patch);
    return tCommon("saved");
  });
  if (r.ok) revalidateProject(key);
  return r;
}

export async function changeProjectStatusAction(
  projectId: string,
  key: string,
  status: string,
): Promise<FormResult> {
  const s = oneOf(STATUSES, status);
  if (!uuid.safeParse(projectId).success || !s) return invalid();
  const ctx = await ctxOf();
  const tCommon = await getTranslations("common");
  const r = await runForm(projectPath(key), async () => {
    await changeProjectStatus(ctx, projectId, s);
    return tCommon("saved");
  });
  if (r.ok) revalidateProject(key);
  return r;
}

export async function changeProjectKeyAction(formData: FormData): Promise<FormResult> {
  const projectId = uuid.safeParse(formData.get("projectId"));
  const key = field(formData, "projectKey") ?? "";
  if (!projectId.success || !key) return invalid();
  const ctx = await ctxOf();
  const tCommon = await getTranslations("common");
  const r = await runForm(projectPath(key), async () => {
    const res = await changeProjectKey(ctx, projectId.data, field(formData, "key") ?? "");
    revalidatePath("/projects");
    revalidatePath(projectPath(key), "layout");
    revalidatePath(projectPath(res.key), "layout");
    return res.changed ? res.key : tCommon("saved");
  });
  return r;
}

export async function setProjectArchivedAction(
  projectId: string,
  key: string,
  archived: boolean,
): Promise<FormResult> {
  if (!uuid.safeParse(projectId).success) return invalid();
  const ctx = await ctxOf();
  const t = await getTranslations("projects.overview");
  const r = await runForm(projectPath(key), async () => {
    if (archived) {
      await archiveProject(ctx, projectId);
      return t("archivedToast");
    }
    await unarchiveProject(ctx, projectId);
    return t("restoredToast");
  });
  if (r.ok) revalidateProject(key);
  return r;
}

// ── Portal switch + hours sharing (project:edit now; project:manage_portal in Phase 3) ──

export async function setPortalEnabledAction(
  projectId: string,
  key: string,
  enabled: boolean,
): Promise<FormResult> {
  if (!uuid.safeParse(projectId).success) return invalid();
  const ctx = await ctxOf();
  const t = await getTranslations("projects.overview");
  const r = await runForm(projectPath(key), async () => {
    await setPortalEnabled(ctx, projectId, enabled);
    return enabled ? t("portalOn") : t("portalOff");
  });
  if (r.ok) revalidateProject(key);
  return r;
}

export async function setHoursSharingAction(
  projectId: string,
  key: string,
  mode: string,
): Promise<FormResult> {
  const m = oneOf(HOURS_MODES, mode);
  if (!uuid.safeParse(projectId).success || !m) return invalid();
  const ctx = await ctxOf();
  const tCommon = await getTranslations("common");
  const r = await runForm(projectPath(key), async () => {
    await setHoursSharingMode(ctx, projectId, m);
    return tCommon("saved");
  });
  if (r.ok) revalidateProject(key);
  return r;
}

// ── Team ────────────────────────────────────────────────────────────

export async function assignProjectMemberAction(
  projectId: string,
  key: string,
  memberId: string,
  memberName: string,
): Promise<FormResult> {
  if (!uuid.safeParse(projectId).success || !uuid.safeParse(memberId).success) return invalid();
  const { tenantId, actor } = await ctxOf();
  const t = await getTranslations("assignments");
  const r = await runForm(projectPath(key, "/team"), async () => {
    await assignMemberToProject({ tenantId, actor, memberId, projectId });
    return t("added", { name: memberName });
  });
  if (r.ok) revalidateProject(key);
  return r;
}

export async function unassignProjectMemberAction(
  projectId: string,
  key: string,
  memberId: string,
  memberName: string,
): Promise<FormResult> {
  if (!uuid.safeParse(projectId).success || !uuid.safeParse(memberId).success) return invalid();
  const { tenantId, actor } = await ctxOf();
  const t = await getTranslations("assignments");
  const r = await runForm(projectPath(key, "/team"), async () => {
    await unassignMemberFromProject({ tenantId, actor, memberId, projectId });
    return t("removed", { name: memberName });
  });
  if (r.ok) revalidateProject(key);
  return r;
}

// ── Timeline: milestones ────────────────────────────────────────────

export async function createMilestoneAction(
  _prev: FormResult | null,
  formData: FormData,
): Promise<FormResult> {
  const projectId = uuid.safeParse(formData.get("projectId"));
  const key = field(formData, "projectKey") ?? "";
  if (!projectId.success || !key) return invalid();
  const ctx = await ctxOf();
  const tCommon = await getTranslations("common");
  const r = await runForm(projectPath(key, "/timeline"), async () => {
    await createMilestone(ctx, {
      projectId: projectId.data,
      name: field(formData, "name") ?? "",
      dueAt: dateField(formData, "dueAt"),
      visibility: field(formData, "visibility") === "CLIENT_VISIBLE" ? "CLIENT_VISIBLE" : "INTERNAL",
    });
    return tCommon("saved");
  });
  if (r.ok) revalidateProject(key);
  return r;
}

export async function updateMilestoneAction(formData: FormData): Promise<FormResult> {
  const milestoneId = uuid.safeParse(formData.get("milestoneId"));
  const key = field(formData, "projectKey") ?? "";
  if (!milestoneId.success || !key) return invalid();
  const ctx = await ctxOf();
  const tCommon = await getTranslations("common");
  const r = await runForm(projectPath(key, "/timeline"), async () => {
    await updateMilestone(ctx, milestoneId.data, {
      name: field(formData, "name") ?? "",
      dueAt: dateField(formData, "dueAt"),
      visibility: field(formData, "visibility") === "CLIENT_VISIBLE" ? "CLIENT_VISIBLE" : "INTERNAL",
    });
    return tCommon("saved");
  });
  if (r.ok) revalidateProject(key);
  return r;
}

export async function setMilestoneStatusAction(
  milestoneId: string,
  key: string,
  status: string,
): Promise<FormResult> {
  const s = oneOf(MILESTONE_STATUSES, status);
  if (!uuid.safeParse(milestoneId).success || !s) return invalid();
  const ctx = await ctxOf();
  const tCommon = await getTranslations("common");
  const r = await runForm(projectPath(key, "/timeline"), async () => {
    await setMilestoneStatus(ctx, milestoneId, s);
    return tCommon("saved");
  });
  if (r.ok) revalidateProject(key);
  return r;
}

/** Keyboard/menu twin of drag (UI.md §7.1): the client names a neighbour, never a rank. */
export async function reorderMilestoneAction(
  milestoneId: string,
  key: string,
  target: ReorderTarget,
): Promise<FormResult> {
  if (!uuid.safeParse(milestoneId).success) return invalid();
  const anchor = "afterId" in target ? target.afterId : "beforeId" in target ? target.beforeId : null;
  if (anchor !== null && !uuid.safeParse(anchor).success) return invalid();
  const ctx = await ctxOf();
  const tCommon = await getTranslations("common");
  const r = await runForm(projectPath(key, "/timeline"), async () => {
    await reorderMilestone(ctx, milestoneId, target);
    return tCommon("saved");
  });
  if (r.ok) revalidateProject(key);
  return r;
}

// ── Timeline: versions ──────────────────────────────────────────────

export async function createVersionAction(
  _prev: FormResult | null,
  formData: FormData,
): Promise<FormResult> {
  const projectId = uuid.safeParse(formData.get("projectId"));
  const key = field(formData, "projectKey") ?? "";
  if (!projectId.success || !key) return invalid();
  const ctx = await ctxOf();
  const tCommon = await getTranslations("common");
  const r = await runForm(projectPath(key, "/timeline"), async () => {
    await createVersion(ctx, {
      projectId: projectId.data,
      version: field(formData, "version") ?? "",
      title: field(formData, "title"),
      releaseNotes: field(formData, "releaseNotes"),
    });
    return tCommon("saved");
  });
  if (r.ok) revalidateProject(key);
  return r;
}

export async function updateVersionAction(formData: FormData): Promise<FormResult> {
  const versionId = uuid.safeParse(formData.get("versionId"));
  const key = field(formData, "projectKey") ?? "";
  if (!versionId.success || !key) return invalid();
  const ctx = await ctxOf();
  const tCommon = await getTranslations("common");
  const r = await runForm(projectPath(key, "/timeline"), async () => {
    await updateVersion(ctx, versionId.data, {
      ...(has(formData, "version") ? { version: field(formData, "version") ?? "" } : {}),
      title: field(formData, "title"),
      releaseNotes: field(formData, "releaseNotes"),
    });
    return tCommon("saved");
  });
  if (r.ok) revalidateProject(key);
  return r;
}

export async function shipVersionAction(
  versionId: string,
  key: string,
  versionLabel: string,
): Promise<FormResult> {
  if (!uuid.safeParse(versionId).success) return invalid();
  const ctx = await ctxOf();
  const t = await getTranslations("projects.timeline");
  const r = await runForm(projectPath(key, "/timeline"), async () => {
    await shipVersion(ctx, versionId);
    return t("shippedToast", { version: versionLabel });
  });
  if (r.ok) revalidateProject(key);
  return r;
}

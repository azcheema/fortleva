"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { z } from "zod";

import { field, has, runForm, type FormResult } from "@/lib/server-actions";
import { isIsoDate } from "@/lib/week";
import { requireTenantContext } from "@/members/tenant-context";
import {
  archiveBudget,
  archiveReport,
  createBudget,
  deleteReport,
  generateReport,
  publishReport,
  unpublishReport,
  updateBudget,
  type TimeCtx,
} from "@/modules/time";

/**
 * Server actions for the project Time tab and its Reports sub-view
 * (PLAN.md 2T screens; D3 published reports; budgets). Thin: parse →
 * service (authorize + audit in one tx) → revalidate the tab.
 */

const uuid = z.uuid();
const keyShape = z.string().regex(/^[A-Z][A-Z0-9]*$/);

const ctxOf = async (): Promise<TimeCtx> => {
  const { membership, actor } = await requireTenantContext();
  return { tenantId: membership.tenantId, actor };
};

const timePath = (key: string) => `/projects/${key}/time`;
const revalidate = (key: string) => {
  revalidatePath(timePath(key));
  revalidatePath(`${timePath(key)}/reports`);
};

export async function generateReportAction(formData: FormData): Promise<FormResult> {
  const t = await getTranslations("projects.time.reports");
  const tCommon = await getTranslations("common");
  const ctx = await ctxOf();
  const projectId = uuid.safeParse(field(formData, "projectId"));
  const key = keyShape.safeParse(field(formData, "projectKey"));
  const periodStart = field(formData, "periodStart");
  const periodEnd = field(formData, "periodEnd");
  const groupBy = field(formData, "groupBy");
  const title = (field(formData, "title") ?? "").trim();
  if (!projectId.success || !key.success || !isIsoDate(periodStart) || !isIsoDate(periodEnd) || title === "") {
    return { ok: false, message: tCommon("invalidInput") };
  }
  if (!["DAY", "WORK_ITEM", "EPIC", "SERVICE"].includes(groupBy ?? "")) return { ok: false, message: tCommon("invalidInput") };
  const r = await runForm(timePath(key.data), async () => {
    await generateReport(ctx, {
      projectId: projectId.data,
      title,
      periodStart,
      periodEnd,
      groupBy: groupBy as "DAY" | "WORK_ITEM" | "EPIC" | "SERVICE",
      includeAmounts: has(formData, "includeAmounts"),
      includeNonBillable: has(formData, "includeNonBillable"),
    });
    return t("generated");
  });
  if (r.ok) revalidate(key.data);
  return r;
}

const reportVerb = async (
  verb: "publish" | "unpublish" | "archive" | "delete",
  reportId: string,
  projectKey: string,
): Promise<FormResult> => {
  const t = await getTranslations("projects.time.reports");
  const tCommon = await getTranslations("common");
  const id = uuid.safeParse(reportId);
  const key = keyShape.safeParse(projectKey);
  if (!id.success || !key.success) return { ok: false, message: tCommon("invalidInput") };
  const ctx = await ctxOf();
  const r = await runForm(timePath(key.data), async () => {
    if (verb === "publish") await publishReport(ctx, id.data);
    else if (verb === "unpublish") await unpublishReport(ctx, id.data);
    else if (verb === "archive") await archiveReport(ctx, id.data);
    else await deleteReport(ctx, id.data);
    return t(({ publish: "published", unpublish: "unpublished", archive: "archived", delete: "deleted" } as const)[verb]);
  });
  if (r.ok) revalidate(key.data);
  return r;
};

export async function publishReportAction(reportId: string, projectKey: string): Promise<FormResult> {
  return reportVerb("publish", reportId, projectKey);
}
export async function unpublishReportAction(reportId: string, projectKey: string): Promise<FormResult> {
  return reportVerb("unpublish", reportId, projectKey);
}
export async function archiveReportAction(reportId: string, projectKey: string): Promise<FormResult> {
  return reportVerb("archive", reportId, projectKey);
}
export async function deleteReportAction(reportId: string, projectKey: string): Promise<FormResult> {
  return reportVerb("delete", reportId, projectKey);
}

export async function saveBudgetAction(formData: FormData): Promise<FormResult> {
  const t = await getTranslations("projects.time.budget");
  const tCommon = await getTranslations("common");
  const ctx = await ctxOf();
  const projectId = uuid.safeParse(field(formData, "projectId"));
  const key = keyShape.safeParse(field(formData, "projectKey"));
  const kind = field(formData, "kind");
  const amount = (field(formData, "amount") ?? "").trim();
  const period = field(formData, "period") ?? "NONE";
  const thresholds = (field(formData, "thresholds") ?? "80,100")
    .split(/[,\s]+/)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!projectId.success || !key.success || (kind !== "HOURS" && kind !== "MONEY") || amount === "") {
    return { ok: false, message: tCommon("invalidInput") };
  }
  if (!["NONE", "WEEKLY", "MONTHLY", "QUARTERLY", "YEARLY"].includes(period)) return { ok: false, message: tCommon("invalidInput") };
  const existingId = field(formData, "budgetId");
  const r = await runForm(timePath(key.data), async () => {
    if (existingId && uuid.safeParse(existingId).success) {
      await updateBudget(ctx, existingId, { amount, thresholds, includeNonBillable: has(formData, "includeNonBillable") });
    } else {
      await createBudget(ctx, {
        projectId: projectId.data,
        kind,
        amount,
        period: period as "NONE" | "WEEKLY" | "MONTHLY" | "QUARTERLY" | "YEARLY",
        periodAnchor: period === "NONE" ? null : (field(formData, "periodAnchor") || null),
        thresholds,
        includeNonBillable: has(formData, "includeNonBillable"),
        notifyMemberIds: [ctx.actor.memberId],
      });
    }
    return t("saved");
  });
  if (r.ok) revalidate(key.data);
  return r;
}

export async function archiveBudgetAction(budgetId: string, projectKey: string): Promise<FormResult> {
  const t = await getTranslations("projects.time.budget");
  const tCommon = await getTranslations("common");
  const id = uuid.safeParse(budgetId);
  const key = keyShape.safeParse(projectKey);
  if (!id.success || !key.success) return { ok: false, message: tCommon("invalidInput") };
  const ctx = await ctxOf();
  const r = await runForm(timePath(key.data), async () => {
    await archiveBudget(ctx, id.data);
    return t("archived");
  });
  if (r.ok) revalidate(key.data);
  return r;
}

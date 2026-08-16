"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";

import { generateTenantExport } from "@/export/service";
import { runForm, type FormResult } from "@/lib/server-actions";
import { requireTenantContext } from "@/members/tenant-context";

/**
 * Server action for /settings/export. tenant:export is ✦ — runForm
 * turns MFA_REQUIRED into step-up navigation back here. Downloads reuse
 * the /files downloadAction (presigned, attachment-only, audited as
 * file.downloaded + export.downloaded).
 */

const PATH = "/settings/export";

const ctxOf = async () => {
  const { membership, actor } = await requireTenantContext();
  return { tenantId: membership.tenantId, actor };
};

export async function generateExportAction(): Promise<FormResult> {
  const ctx = await ctxOf();
  const t = await getTranslations("settings.export");
  const r = await runForm(PATH, async () => {
    const result = await generateTenantExport(ctx);
    return t("generated", { name: result.name });
  });
  if (r.ok) revalidatePath(PATH);
  return r;
}

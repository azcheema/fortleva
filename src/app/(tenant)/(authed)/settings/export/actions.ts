"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { z } from "zod";

import { getExportDownloadUrl } from "@/documents/service";
import { deleteExport, generateTenantExport } from "@/export/service";
import { orBounce } from "@/lib/bounce";
import { withBounce } from "@/lib/bounce-code";
import { runForm, type FormResult } from "@/lib/server-actions";
import { requireTenantContext } from "@/members/tenant-context";

/**
 * Server actions for /settings/export — every one `tenant:export` (✦):
 * runForm (generate) and orBounce (download, delete) turn MFA_REQUIRED into
 * step-up navigation back here.
 * Generate; DOWNLOAD (slice 136b: its own path, `getExportDownloadUrl` —
 * presigned, attachment-only, audited file.downloaded + export.downloaded —
 * no longer Files' `downloadAction`, which now never reaches an export); and
 * DELETE (slice 136b: Files, where an owner once deleted one, no longer can).
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

const uuid = z.uuid();

// A refusal comes back here as its CODE in `?error=`, never its sentence
// (`orBounce`, slice 137).

/** The row's download: off to the presigned URL, or back here with the refusal. */
export async function downloadExportAction(formData: FormData): Promise<void> {
  const id = uuid.safeParse(formData.get("documentId"));
  const ctx = await ctxOf();
  if (!id.success) redirect(withBounce(PATH, "domain.INVALID_INPUT"));
  const { url } = await orBounce(PATH, () => getExportDownloadUrl(ctx, id.data));
  redirect(url);
}

/** The row menu's Delete, after its confirmation. */
export async function deleteExportAction(formData: FormData): Promise<void> {
  const id = uuid.safeParse(formData.get("documentId"));
  const ctx = await ctxOf();
  if (!id.success) redirect(withBounce(PATH, "domain.INVALID_INPUT"));
  await orBounce(PATH, () => deleteExport(ctx, id.data));
  revalidatePath(PATH);
}

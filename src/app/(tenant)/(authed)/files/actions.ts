"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { z } from "zod";

import { AuthzError } from "@/authz/errors";
import { handleAuthzRedirect } from "@/authz/redirects";
import { UploadRejectedError } from "@/documents/allowlist";
import {
  changeVisibility,
  commitUpload,
  createUpload,
  DocumentError,
  getDownloadUrl,
  softDeleteDocument,
  type CreateUploadResult,
} from "@/documents/service";
import { requireTenantContext } from "@/members/tenant-context";

/**
 * Server actions for /files. Tenant + actor come from the session
 * (requireTenantContext) — never from the form. Errors are flattened
 * to messages; MFA denials become step-up navigation.
 */

export type ActionResult<T = undefined> =
  | { ok: true; value: T }
  | { ok: false; message: string };

type Translate = Awaited<ReturnType<typeof getTranslations<"files.errors">>>;

const messageOf = (t: Translate, e: unknown): string | null => {
  if (e instanceof AuthzError) {
    switch (e.reason) {
      case "NOT_ENTITLED":
        return e.detail?.startsWith("maxStorageBytes") ? t("quota") : t("notEntitled");
      case "NOT_FOUND":
        return t("notFound");
      case "FORBIDDEN":
        return t("forbidden");
      default:
        return e.message;
    }
  }
  if (e instanceof UploadRejectedError) {
    switch (e.code) {
      case "TYPE_NOT_ALLOWED":
        return t("typeNotAllowed");
      case "SIZE_INVALID":
        return t("sizeInvalid");
      case "NAME_INVALID":
        return t("nameInvalid");
    }
  }
  if (e instanceof DocumentError) {
    switch (e.code) {
      case "UPLOAD_MISSING":
      case "UPLOAD_SIZE_MISMATCH":
        return t("uploadIncomplete");
      case "NOT_PENDING":
        return t("notPending");
      case "CLIENT_REQUIRED":
        return t("clientRequired");
    }
  }
  return null;
};

async function guard<T>(path: string, fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    handleAuthzRedirect(e, path);
    const t = await getTranslations("files.errors");
    const message = messageOf(t, e);
    if (message) return { ok: false, message };
    throw e;
  }
}

const presignSchema = z.object({
  name: z.string().min(1).max(255),
  contentType: z.string().max(255),
  sizeBytes: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/i),
});

export async function presignUploadAction(
  raw: z.input<typeof presignSchema>,
): Promise<ActionResult<CreateUploadResult>> {
  const { membership, actor } = await requireTenantContext();
  const parsed = presignSchema.safeParse(raw);
  if (!parsed.success) {
    const t = await getTranslations("files.errors");
    return { ok: false, message: t("invalidRequest") };
  }
  return guard("/files", () =>
    createUpload(
      { tenantId: membership.tenantId, actor },
      { ...parsed.data, visibility: "INTERNAL" },
    ),
  );
}

export async function commitUploadAction(
  fileObjectId: string,
): Promise<ActionResult<{ documentId: string }>> {
  const { membership, actor } = await requireTenantContext();
  const result = await guard("/files", () =>
    commitUpload(
      { tenantId: membership.tenantId, actor },
      { fileObjectId, visibility: "INTERNAL" },
    ),
  );
  if (result.ok) revalidatePath("/files");
  return result;
}

export async function downloadAction(formData: FormData): Promise<void> {
  const documentId = String(formData.get("documentId") ?? "");
  const { membership, actor } = await requireTenantContext();
  const result = await guard("/files", () =>
    getDownloadUrl({ tenantId: membership.tenantId, actor }, documentId),
  );
  if (!result.ok) redirect(`/files?error=${encodeURIComponent(result.message)}`);
  // Off-origin, short-lived, Content-Disposition: attachment (SECURITY.md §5).
  redirect(result.value.url);
}

export async function deleteDocumentAction(formData: FormData): Promise<void> {
  const documentId = String(formData.get("documentId") ?? "");
  const { membership, actor } = await requireTenantContext();
  const result = await guard("/files", () =>
    softDeleteDocument({ tenantId: membership.tenantId, actor }, documentId),
  );
  if (!result.ok) redirect(`/files?error=${encodeURIComponent(result.message)}`);
  revalidatePath("/files");
}

/** Wired for Phase 2 (clients): today the select is disabled in the UI
 * and CLIENT_VISIBLE is refused server-side without a clientId. */
export async function changeVisibilityAction(formData: FormData): Promise<void> {
  const documentId = String(formData.get("documentId") ?? "");
  const visibility =
    formData.get("visibility") === "CLIENT_VISIBLE" ? "CLIENT_VISIBLE" : "INTERNAL";
  const { membership, actor } = await requireTenantContext();
  const result = await guard("/files", () =>
    changeVisibility({ tenantId: membership.tenantId, actor }, documentId, visibility),
  );
  if (!result.ok) redirect(`/files?error=${encodeURIComponent(result.message)}`);
  revalidatePath("/files");
}

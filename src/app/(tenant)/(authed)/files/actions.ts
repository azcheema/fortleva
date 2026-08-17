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
import { DomainError } from "@/lib/domain-error";
import { requireTenantContext } from "@/members/tenant-context";

/**
 * Server actions for files — used by /files and by the client/project
 * Files tabs. Tenant + actor come from the session
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
  if (e instanceof DomainError && e.code === "CLIENT_MISMATCH") return t("clientRequired");
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

/** Same-origin absolute path only (never an open redirect). */
const SAFE_PATH = /^\/(?![/\\])/;

/**
 * Where a document hangs (Phase 2): tenant-internal (nothing), a client
 * (client-level) or a project. Scope is asserted server-side by the
 * service; CLIENT_VISIBLE needs a client. `returnTo` is the page to
 * revalidate / bounce back to.
 */
const targetSchema = z.object({
  clientId: z.uuid().optional(),
  projectId: z.uuid().optional(),
  visibility: z.enum(["INTERNAL", "CLIENT_VISIBLE"]).default("INTERNAL"),
  returnTo: z.string().regex(SAFE_PATH).default("/files"),
});
export type UploadTarget = z.input<typeof targetSchema>;

const presignSchema = z.object({
  name: z.string().min(1).max(255),
  contentType: z.string().max(255),
  sizeBytes: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/i),
});

export async function presignUploadAction(
  raw: z.input<typeof presignSchema>,
  rawTarget: UploadTarget = {},
): Promise<ActionResult<CreateUploadResult>> {
  const { membership, actor } = await requireTenantContext();
  const parsed = presignSchema.safeParse(raw);
  const target = targetSchema.safeParse(rawTarget);
  if (!parsed.success || !target.success) {
    const t = await getTranslations("files.errors");
    return { ok: false, message: t("invalidRequest") };
  }
  const { clientId, projectId, visibility, returnTo } = target.data;
  return guard(returnTo, () =>
    createUpload(
      { tenantId: membership.tenantId, actor },
      { ...parsed.data, clientId, projectId, visibility },
    ),
  );
}

export async function commitUploadAction(
  fileObjectId: string,
  rawTarget: UploadTarget = {},
): Promise<ActionResult<{ documentId: string }>> {
  const { membership, actor } = await requireTenantContext();
  const target = targetSchema.safeParse(rawTarget);
  if (!target.success) {
    const t = await getTranslations("files.errors");
    return { ok: false, message: t("invalidRequest") };
  }
  const { clientId, projectId, visibility, returnTo } = target.data;
  const result = await guard(returnTo, () =>
    commitUpload(
      { tenantId: membership.tenantId, actor },
      { fileObjectId, clientId, projectId, visibility },
    ),
  );
  if (result.ok) revalidatePath(returnTo);
  return result;
}

const returnToOf = (formData: FormData): string => {
  const v = formData.get("returnTo");
  return typeof v === "string" && SAFE_PATH.test(v) ? v : "/files";
};

const withError = (path: string, message: string): string =>
  `${path}${path.includes("?") ? "&" : "?"}error=${encodeURIComponent(message)}`;

export async function downloadAction(formData: FormData): Promise<void> {
  const documentId = String(formData.get("documentId") ?? "");
  const returnTo = returnToOf(formData);
  const { membership, actor } = await requireTenantContext();
  const result = await guard(returnTo, () =>
    getDownloadUrl({ tenantId: membership.tenantId, actor }, documentId),
  );
  if (!result.ok) redirect(withError(returnTo, result.message));
  // Off-origin, short-lived, Content-Disposition: attachment (SECURITY.md §5).
  redirect(result.value.url);
}

export async function deleteDocumentAction(formData: FormData): Promise<void> {
  const documentId = String(formData.get("documentId") ?? "");
  const returnTo = returnToOf(formData);
  const { membership, actor } = await requireTenantContext();
  const result = await guard(returnTo, () =>
    softDeleteDocument({ tenantId: membership.tenantId, actor }, documentId),
  );
  if (!result.ok) redirect(withError(returnTo, result.message));
  revalidatePath(returnTo);
}

const visibilitySchema = z.object({
  documentId: z.uuid(),
  visibility: z.enum(["INTERNAL", "CLIENT_VISIBLE"]),
  returnTo: z.string().regex(SAFE_PATH).default("/files"),
});

/**
 * Flip INTERNAL ⇄ CLIENT_VISIBLE (document:change_visibility, audited);
 * CLIENT_VISIBLE is refused server-side without a clientId.
 *
 * Deliberately NOT a <form action>: React resets a form after its
 * action runs, which restores the native <select> to the value the
 * server rendered — so a successful change looked like a silent revert
 * while the database held the new value (the worst possible lie for
 * this particular control). The caller invokes this directly inside a
 * transition and renders the result; a failure returns a message to
 * show, never a redirect the surface might swallow.
 */
export async function changeVisibilityAction(
  raw: z.input<typeof visibilitySchema>,
): Promise<ActionResult<void>> {
  const parsed = visibilitySchema.safeParse(raw);
  if (!parsed.success) {
    const t = await getTranslations("files.errors");
    return { ok: false, message: t("visibilityFailed") };
  }
  const { documentId, visibility, returnTo } = parsed.data;
  const { membership, actor } = await requireTenantContext();
  const result = await guard(returnTo, () =>
    changeVisibility({ tenantId: membership.tenantId, actor }, documentId, visibility),
  );
  if (result.ok) revalidatePath(returnTo);
  return result;
}

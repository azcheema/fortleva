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
  requestDocumentSignoff,
  softDeleteDocument,
  type CreateUploadResult,
} from "@/documents/service";
import { domainBounceOf, orBounce } from "@/lib/bounce";
import type { BounceCode } from "@/lib/bounce-code";
import { DomainError } from "@/lib/domain-error";
import { safeNext } from "@/lib/safe-next";
import { messageForError } from "@/lib/server-actions";
import { requireTenantContext } from "@/members/tenant-context";

/**
 * Server actions for files — used by /files and by the client/project
 * Files tabs. Tenant + actor come from the session
 * (requireTenantContext) — never from the form. A refusal is a message
 * for the actions that answer (upload, visibility) and a CODE in `?error=`
 * for the form POSTs that redirect (download, delete, sign-off ask —
 * `orBounce`); MFA denials become step-up navigation.
 */

export type ActionResult<T = undefined> =
  | { ok: true; value: T }
  | { ok: false; message: string };

/** The `files.errors.*` key a refusal reads as here — or null for the member plane's own mapping. */
const fileErrorKeyOf = (
  e: unknown,
):
  | "quota"
  | "notEntitled"
  | "notFound"
  | "forbidden"
  | "typeNotAllowed"
  | "sizeInvalid"
  | "nameInvalid"
  | "clientRequired"
  | "uploadIncomplete"
  | "notPending"
  | "anchorInternal"
  | null => {
  if (e instanceof AuthzError) {
    switch (e.reason) {
      case "NOT_ENTITLED":
        return e.detail?.startsWith("maxStorageBytes") ? "quota" : "notEntitled";
      case "NOT_FOUND":
        return "notFound";
      case "FORBIDDEN":
        return "forbidden";
      // A switched-off module speaks the member plane's own words for it,
      // `domainErrors.*` (slice 137 — this was the error's own text,
      // `DISABLED_BY_TENANT: …`).
      case "FEATURE_DISABLED":
      case "DISABLED_BY_TENANT":
        return null;
      case "MFA_REQUIRED":
        return null; // never reached: step-up navigation first
    }
  }
  if (e instanceof UploadRejectedError) {
    switch (e.code) {
      case "TYPE_NOT_ALLOWED":
        return "typeNotAllowed";
      case "SIZE_INVALID":
        return "sizeInvalid";
      case "NAME_INVALID":
        return "nameInvalid";
    }
  }
  if (e instanceof DomainError && e.code === "CLIENT_MISMATCH") return "clientRequired";
  if (e instanceof DocumentError) {
    switch (e.code) {
      case "UPLOAD_MISSING":
      case "UPLOAD_SIZE_MISMATCH":
        return "uploadIncomplete";
      case "NOT_PENDING":
        return "notPending";
      case "CLIENT_REQUIRED":
        return "clientRequired";
      case "ANCHOR_INTERNAL":
        return "anchorInternal";
    }
  }
  // Any other domain refusal — the sign-off asks' own sentences, the
  // attachment flip's VISIBILITY_BUSY (slice 72), which reached the member
  // as a generic failure before this fallback — speaks the member plane's
  // one mapping (`domainErrors.*`).
  return null;
};

/** A refusal as the page it bounces back to reads it (`?error=`, `bounce-code.ts`). */
const fileBounceOf = (e: unknown): BounceCode | null => {
  const key = fileErrorKeyOf(e);
  return key !== null ? `files.${key}` : domainBounceOf(e);
};

async function guard<T>(path: string, fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    handleAuthzRedirect(e, path);
    const key = fileErrorKeyOf(e);
    const message = key !== null ? (await getTranslations("files.errors"))(key) : await messageForError(e);
    if (message) return { ok: false, message };
    throw e;
  }
}

/** Same-origin absolute path only (never an open redirect) — the sign-in surfaces' allowlist, `safeNext`. */
const isSafePath = (v: string): boolean => safeNext(v, "/files") === v;

/**
 * Where a document hangs (Phase 2): tenant-internal (nothing), a client
 * (client-level) or a project. Scope is asserted server-side by the
 * service; CLIENT_VISIBLE needs a client. `returnTo` is the page to
 * revalidate / bounce back to.
 */
const targetSchema = z
  .object({
    clientId: z.uuid().optional(),
    projectId: z.uuid().optional(),
    // No default: an ANCHORED upload with no explicit choice inherits
    // its work item's visibility in the service (DATA_MODEL §10); the
    // service defaults every un-anchored path to INTERNAL as before.
    visibility: z.enum(["INTERNAL", "CLIENT_VISIBLE"]).optional(),
    // Phase 3, the portal files slice: a member may mark an upload a
    // DELIVERABLE (grouped first on the client's files list, an event
    // on their timeline per version). The generated kinds are not a
    // choice — `UploadKind` in the service says why.
    kind: z.enum(["GENERAL", "DELIVERABLE"]).optional(),
    returnTo: z.string().refine(isSafePath).default("/files"),
    // 2W-A: anchor to a work item — the anchor implies client + project
    // (derived from the item; the service refuses a disagreement).
    attachedToType: z.literal("WORK_ITEM").optional(),
    attachedToId: z.uuid().optional(),
  })
  .refine((v) => (v.attachedToType === undefined) === (v.attachedToId === undefined), {
    message: "attachedToType and attachedToId come together",
  })
  .refine((v) => v.attachedToId === undefined || (v.clientId === undefined && v.projectId === undefined), {
    message: "an anchored upload derives client and project from the item",
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
  const { clientId, projectId, visibility, returnTo, attachedToType, attachedToId } = target.data;
  return guard(returnTo, () =>
    createUpload(
      { tenantId: membership.tenantId, actor },
      { ...parsed.data, clientId, projectId, visibility, attachedToType, attachedToId },
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
  const { clientId, projectId, visibility, kind, returnTo, attachedToType, attachedToId } = target.data;
  const result = await guard(returnTo, () =>
    commitUpload(
      { tenantId: membership.tenantId, actor },
      { fileObjectId, clientId, projectId, visibility, kind, attachedToType, attachedToId },
    ),
  );
  if (result.ok) revalidatePath(returnTo);
  return result;
}

const returnToOf = (formData: FormData): string => {
  const v = formData.get("returnTo");
  return typeof v === "string" ? safeNext(v, "/files") : "/files";
};

// The three form POSTs below answer a refusal by sending the member back to
// `returnTo` with its CODE in `?error=` (`orBounce`) — never the sentence,
// which a link anyone writes could otherwise put on the page (slice 137).

export async function downloadAction(formData: FormData): Promise<void> {
  const documentId = String(formData.get("documentId") ?? "");
  const returnTo = returnToOf(formData);
  const { membership, actor } = await requireTenantContext();
  const { url } = await orBounce(
    returnTo,
    () => getDownloadUrl({ tenantId: membership.tenantId, actor }, documentId),
    fileBounceOf,
  );
  // Off-origin, short-lived, Content-Disposition: attachment (SECURITY.md §5).
  redirect(url);
}

/**
 * Ask the client to sign a deliverable off (Phase 3, sign-off): a form
 * POST from the row's menu, back to the page it was on, with the code of
 * the service's own refusal — not a DELIVERABLE, not shared, no committed
 * file, an open ask, a standing approval of the newest version: a
 * `domainErrors.*` key, which `fileBounceOf` falls back to.
 */
export async function requestDocumentSignoffAction(formData: FormData): Promise<void> {
  const documentId = String(formData.get("documentId") ?? "");
  const returnTo = returnToOf(formData);
  const { membership, actor } = await requireTenantContext();
  await orBounce(
    returnTo,
    () => requestDocumentSignoff({ tenantId: membership.tenantId, actor }, documentId),
    fileBounceOf,
  );
  revalidatePath(returnTo);
}

export async function deleteDocumentAction(formData: FormData): Promise<void> {
  const documentId = String(formData.get("documentId") ?? "");
  const returnTo = returnToOf(formData);
  const { membership, actor } = await requireTenantContext();
  await orBounce(
    returnTo,
    () => softDeleteDocument({ tenantId: membership.tenantId, actor }, documentId),
    fileBounceOf,
  );
  revalidatePath(returnTo);
}

const visibilitySchema = z.object({
  documentId: z.uuid(),
  visibility: z.enum(["INTERNAL", "CLIENT_VISIBLE"]),
  returnTo: z.string().refine(isSafePath).default("/files"),
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

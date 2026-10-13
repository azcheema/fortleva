"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { z } from "zod";

import {
  commitReportUpload,
  deleteReport,
  editReport,
  hideReport,
  publishReport,
} from "@/documents/reports";
import { DocumentError } from "@/documents/service";
import { runAction, runForm, type ActionResult, type FormResult } from "@/lib/server-actions";
import { requireTenantContext } from "@/members/tenant-context";

/**
 * Server actions for a client's Reports tab (Phase 6 slice 115; founder
 * decision C91). Each one only PARSES: tenant and actor come from the
 * session, never the form, and `src/documents/reports.ts` does everything
 * else — both codes of each verb, the direct scope, the audit row, the mails.
 * The upload's first hop is the Files page's own `presignUploadAction`
 * (`document:upload`, the client as its target, INTERNAL); only the commit is
 * the report's.
 */

const uuid = z.uuid();
const pathOf = (clientId: string): string => `/clients/${clientId}/reports`;

const invalid = async (): Promise<{ ok: false; message: string }> => ({
  ok: false,
  message: (await getTranslations("common"))("invalidInput"),
});

const ctxOf = async () => {
  const { membership, actor } = await requireTenantContext();
  return { tenantId: membership.tenantId, actor };
};

const commitSchema = z.object({
  fileObjectId: uuid,
  clientId: uuid,
  month: z.string().regex(/^\d{4}-\d{2}$/),
  name: z.string().max(255).optional(),
});

/** The upload's commit: the bytes already in storage become an INTERNAL report. */
export async function commitReportUploadAction(raw: z.input<typeof commitSchema>): Promise<ActionResult<{ documentId: string }>> {
  const parsed = commitSchema.safeParse(raw);
  if (!parsed.success) return invalid();
  const { clientId, ...rest } = parsed.data;
  const ctx = await ctxOf();
  try {
    const r = await runAction(pathOf(clientId), () => commitReportUpload(ctx, { clientId, ...rest }));
    if (r.ok) revalidatePath(pathOf(clientId));
    return r;
  } catch (e) {
    // The commit's own refusals — no bytes at the key, the wrong size, an
    // object already committed — speak the Files page's words (the code
    // review's L1: `runAction` maps only authorization and domain errors, and
    // an unmapped one left the form at "Finishing…" for ever).
    if (!(e instanceof DocumentError)) throw e;
    const t = await getTranslations("files.errors");
    return { ok: false, message: e.code === "NOT_PENDING" ? t("notPending") : t("uploadIncomplete") };
  }
}

/**
 * Publish: the client's people can see it, and they are told. The toast says
 * how many were emailed now — or that nobody has portal access yet, or that
 * they were told before (a report published again after a hide).
 */
export async function publishReportAction(clientId: string, documentId: string): Promise<FormResult> {
  if (!uuid.safeParse(clientId).success || !uuid.safeParse(documentId).success) return invalid();
  const ctx = await ctxOf();
  const t = await getTranslations("clients.reports.toast");
  const r = await runForm(pathOf(clientId), async () => {
    const out = await publishReport(ctx, documentId);
    if (!out.published) return t("alreadyPublished");
    if (out.reachable === 0) return t("publishedNobody");
    // Someone has portal access, but every such address is blocked (bounced or
    // reported as spam) — never "already emailed" (the code review's L2).
    if (out.mailable === 0) return t("publishedUndeliverable");
    if (out.queued === 0) return t("publishedToldBefore");
    return t("published", { count: out.queued });
  });
  if (r.ok) revalidatePath(pathOf(clientId));
  return r;
}

/** Hide: back to the team only — at once, no question (it takes access away). */
export async function hideReportAction(clientId: string, documentId: string): Promise<FormResult> {
  if (!uuid.safeParse(clientId).success || !uuid.safeParse(documentId).success) return invalid();
  const ctx = await ctxOf();
  const t = await getTranslations("clients.reports.toast");
  const r = await runForm(pathOf(clientId), async () => ((await hideReport(ctx, documentId)).hidden ? t("hidden") : t("alreadyHidden")));
  if (r.ok) revalidatePath(pathOf(clientId));
  return r;
}

const editSchema = z.object({
  clientId: uuid,
  documentId: uuid,
  name: z.string().max(255),
  month: z.string().regex(/^\d{4}-\d{2}$/),
});

/** The name and month — the edit dialog's form (useActionState). */
export async function editReportAction(_prev: FormResult | null, fd: FormData): Promise<FormResult> {
  const parsed = editSchema.safeParse({
    clientId: fd.get("clientId"),
    documentId: fd.get("documentId"),
    name: fd.get("name"),
    month: fd.get("month"),
  });
  if (!parsed.success) return invalid();
  const { clientId, documentId, name, month } = parsed.data;
  const ctx = await ctxOf();
  const t = await getTranslations("clients.reports.toast");
  const r = await runForm(pathOf(clientId), async () => {
    await editReport(ctx, documentId, { name, month });
    return t("saved");
  });
  if (r.ok) revalidatePath(pathOf(clientId));
  return r;
}

/** Delete — from the row menu, after its question. */
export async function deleteReportAction(clientId: string, documentId: string): Promise<FormResult> {
  if (!uuid.safeParse(clientId).success || !uuid.safeParse(documentId).success) return invalid();
  const ctx = await ctxOf();
  const t = await getTranslations("clients.reports.toast");
  const r = await runForm(pathOf(clientId), async () => {
    await deleteReport(ctx, documentId);
    return t("deleted");
  });
  if (r.ok) revalidatePath(pathOf(clientId));
  return r;
}

"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { z } from "zod";

import { runAction, type ActionResult } from "@/lib/server-actions";
import { requireTenantContext } from "@/members/tenant-context";
import {
  finishImport,
  importBatch,
  matchImportPeople,
  previewImportMatches,
  restoreImport,
  startImport,
  undoImport,
  type BatchResult,
} from "@/modules/work/import/service";

/**
 * Server actions for a project's Import page (Phase 6 slice 121; founder
 * decision C97). The tenant and the member come from the session
 * (`requireTenantContext`), never from a parameter; everything the browser
 * sends is checked again by the service (design R1) — these only shape the
 * call and say which page to refresh.
 */

const uuid = z.uuid();
const projectKey = z.string().regex(/^[A-Z][A-Z0-9]{0,7}$/);
const pathOf = (key: string) => `/projects/${key}/import`;

const invalid = async (): Promise<{ ok: false; message: string }> => ({
  ok: false,
  message: (await getTranslations("common"))("invalidInput"),
});

const ctxOf = async () => {
  const { membership, actor } = await requireTenantContext();
  return { tenantId: membership.tenantId, actor };
};

/** Every page the new tasks appear on. */
const refresh = (key: string) => {
  revalidatePath(pathOf(key));
  revalidatePath(`/projects/${key}/backlog`);
  revalidatePath(`/projects/${key}/board`);
};

export async function startImportAction(
  key: string,
  raw: { projectId: string; source: "CSV" | "TRELLO"; fileName: string; rowCount: number },
): Promise<ActionResult<{ jobId: string }>> {
  if (!projectKey.safeParse(key).success) return invalid();
  const ctx = await ctxOf();
  return runAction(pathOf(key), () => startImport(ctx, raw));
}

/** One batch of rows; no refresh per batch — the finish does it once. */
export async function importBatchAction(key: string, jobId: string, rows: unknown): Promise<ActionResult<BatchResult>> {
  if (!projectKey.safeParse(key).success || !uuid.safeParse(jobId).success) return invalid();
  const ctx = await ctxOf();
  const t = await getTranslations("projects.import");
  return runAction(pathOf(key), () => importBatch(ctx, jobId, rows, { linkLabel: t("trelloLink") }));
}

export async function finishImportAction(key: string, jobId: string): Promise<ActionResult<void>> {
  if (!projectKey.safeParse(key).success || !uuid.safeParse(jobId).success) return invalid();
  const ctx = await ctxOf();
  const r = await runAction(pathOf(key), () => finishImport(ctx, jobId));
  // Refreshed whatever the finish answered: the batches before it wrote tasks.
  refresh(key);
  return r;
}

export async function matchPeopleAction(key: string, projectId: string, emails: string[]): Promise<ActionResult<Record<string, string>>> {
  if (!projectKey.safeParse(key).success || !uuid.safeParse(projectId).success || !Array.isArray(emails)) return invalid();
  const ctx = await ctxOf();
  return runAction(pathOf(key), () => matchImportPeople(ctx, projectId, emails.filter((e) => typeof e === "string")));
}

export async function previewMatchesAction(
  key: string,
  input: { projectId: string; source: "CSV" | "TRELLO"; sourceIds: string[] },
): Promise<ActionResult<{ willUpdate: number; willKeep: number }>> {
  const shape = z.object({ projectId: uuid, source: z.enum(["CSV", "TRELLO"]), sourceIds: z.array(z.string()) });
  const parsed = shape.safeParse(input);
  if (!projectKey.safeParse(key).success || !parsed.success) return invalid();
  const ctx = await ctxOf();
  return runAction(pathOf(key), () => previewImportMatches(ctx, parsed.data));
}

export async function undoImportAction(key: string, jobId: string): Promise<ActionResult<{ removed: number; kept: number }>> {
  if (!projectKey.safeParse(key).success || !uuid.safeParse(jobId).success) return invalid();
  const ctx = await ctxOf();
  const r = await runAction(pathOf(key), () => undoImport(ctx, jobId));
  if (r.ok) refresh(key);
  return r;
}

export async function restoreImportAction(key: string, jobId: string): Promise<ActionResult<{ restored: number; skipped: number }>> {
  if (!projectKey.safeParse(key).success || !uuid.safeParse(jobId).success) return invalid();
  const ctx = await ctxOf();
  const r = await runAction(pathOf(key), () => restoreImport(ctx, jobId));
  if (r.ok) refresh(key);
  return r;
}

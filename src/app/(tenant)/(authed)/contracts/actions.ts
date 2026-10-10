"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";

import { isUuid } from "@/db/context";
import { runAction, runForm, type ActionResult, type FormResult } from "@/lib/server-actions";
import { requireTenantContext } from "@/members/tenant-context";
import {
  deleteContractDraft,
  listContractSigners,
  startContract,
  updateContractDraft,
  type DraftPatch,
  type FillInKey,
  type SignerOption,
} from "@/modules/contracts";

/**
 * Server actions for /contracts (Phase 4 slice 112). Tenant and actor come
 * from the session, never from a parameter; `src/modules/contracts/` checks the
 * permission, the client scope and the draft's state, and audits. Each action
 * only parses — an id that is not a uuid is refused here so it never reaches a
 * query.
 */

const LIST = "/contracts";
const pageOf = (id: string) => `/contracts/${id}`;

const ctxOf = async () => {
  const { membership, actor } = await requireTenantContext();
  return { tenantId: membership.tenantId, actor };
};

const invalid = async (): Promise<{ ok: false; message: string }> => {
  const tCommon = await getTranslations("common");
  return { ok: false, message: tCommon("invalidInput") };
};

const optionalUuid = (v: unknown): v is string | null => v === null || (typeof v === "string" && (v === "" || isUuid(v)));

/** The client's main contacts in the portal — the New contract form's signer list, once a client is picked. */
export async function contractSignersAction(clientId: unknown): Promise<ActionResult<SignerOption[]>> {
  if (typeof clientId !== "string" || !isUuid(clientId)) return invalid();
  const ctx = await ctxOf();
  return runAction(LIST, () => listContractSigners(ctx, clientId));
}

/** Start a contract; its id comes back so the form opens it. */
export async function startContractAction(input: unknown): Promise<ActionResult<string>> {
  if (typeof input !== "object" || input === null) return invalid();
  const { clientId, templateId, signerContactId, title } = input as Record<string, unknown>;
  if (typeof clientId !== "string" || !isUuid(clientId)) return invalid();
  if (!optionalUuid(templateId ?? null) || !optionalUuid(signerContactId ?? null)) return invalid();
  if (title !== undefined && typeof title !== "string") return invalid();
  const ctx = await ctxOf();
  const r = await runAction(LIST, async () => (await startContract(ctx, { clientId, templateId, signerContactId, title })).id);
  if (r.ok) revalidatePath(LIST);
  return r;
}

/** Save a draft's changed fields; the fill-ins still in its text come back. */
export async function saveContractDraftAction(id: unknown, patch: unknown): Promise<ActionResult<FillInKey[]>> {
  if (typeof id !== "string" || !isUuid(id) || typeof patch !== "object" || patch === null) return invalid();
  const input = patch as Record<string, unknown>;
  const allowed: (keyof DraftPatch)[] = ["title", "body", "language", "signerContactId", "startsOn", "endsOn"];
  const clean: Record<string, unknown> = {};
  for (const key of allowed) if (key in input) clean[key] = input[key];
  if ("signerContactId" in clean && !optionalUuid(clean["signerContactId"] ?? null)) return invalid();
  const ctx = await ctxOf();
  const r = await runAction(pageOf(id), async () => (await updateContractDraft(ctx, id, clean as DraftPatch)).remainingFillIns);
  if (r.ok) {
    revalidatePath(pageOf(id));
    revalidatePath(LIST);
  }
  return r;
}

export async function deleteContractDraftAction(id: unknown): Promise<FormResult> {
  if (typeof id !== "string" || !isUuid(id)) return invalid();
  const ctx = await ctxOf();
  const t = await getTranslations("contracts.draft");
  const r = await runForm(LIST, async () => {
    await deleteContractDraft(ctx, id);
    return t("deleted");
  });
  if (r.ok) revalidatePath(LIST);
  return r;
}

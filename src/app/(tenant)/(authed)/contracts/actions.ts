"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";

import { isUuid } from "@/db/context";
import { DomainError } from "@/lib/domain-error";
import { caution, runAction, runForm, type ActionResult, type FormResult } from "@/lib/server-actions";
import { requireTenantContext } from "@/members/tenant-context";
import {
  changeSentContract,
  contractPdfUrl,
  deleteContractDraft,
  ensureContractPdf,
  listContractSigners,
  newContractVersion,
  sendContract,
  startContract,
  updateContractDraft,
  withdrawContract,
  type ContractPdfKind,
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

/** Save a draft's changed fields; the fill-ins still in its text and the row's new `updatedAt` (ISO) come back. */
export async function saveContractDraftAction(
  id: unknown,
  patch: unknown,
): Promise<ActionResult<{ readonly remaining: FillInKey[]; readonly updatedAt: string }>> {
  if (typeof id !== "string" || !isUuid(id) || typeof patch !== "object" || patch === null) return invalid();
  const input = patch as Record<string, unknown>;
  const allowed: (keyof DraftPatch)[] = ["title", "body", "language", "signerContactId", "startsOn", "endsOn"];
  const clean: Record<string, unknown> = {};
  for (const key of allowed) if (key in input) clean[key] = input[key];
  if ("signerContactId" in clean && !optionalUuid(clean["signerContactId"] ?? null)) return invalid();
  const ctx = await ctxOf();
  const r = await runAction(pageOf(id), async () => {
    const saved = await updateContractDraft(ctx, id, clean as DraftPatch);
    return { remaining: saved.remainingFillIns, updatedAt: saved.updatedAt.toISOString() };
  });
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

/**
 * Send the draft for signature (slice 112b; C84 (b)): `seen` is the draft's
 * `updatedAt` as the page read it, `typedName` the sender's signature. The PDF
 * as sent is drawn after the send commits; if it could not be, the send still
 * stands — a CAUTION, never a revert-looking error (Download and the jobs
 * route make it later).
 */
export async function sendContractAction(id: unknown, seen: unknown, typedName: unknown): Promise<FormResult> {
  if (typeof id !== "string" || !isUuid(id) || typeof seen !== "string" || typeof typedName !== "string") return invalid();
  const ctx = await ctxOf();
  const t = await getTranslations("contracts.send");
  const r = await runForm(pageOf(id), async () => {
    await sendContract(ctx, id, { seen, typedName });
    try {
      await ensureContractPdf(ctx, id, "sent");
    } catch (e) {
      if (!(e instanceof DomainError)) console.error("contracts: sent, its PDF not made yet", e instanceof Error ? e.name : typeof e);
      return caution(t("sentNoPdf"));
    }
    return t("sent");
  });
  if (r.ok) {
    revalidatePath(pageOf(id));
    revalidatePath(LIST);
  }
  return r;
}

export async function withdrawContractAction(id: unknown): Promise<FormResult> {
  if (typeof id !== "string" || !isUuid(id)) return invalid();
  const ctx = await ctxOf();
  const t = await getTranslations("contracts.sent");
  const r = await runForm(pageOf(id), async () => {
    await withdrawContract(ctx, id);
    return t("withdrawn");
  });
  if (r.ok) {
    revalidatePath(pageOf(id));
    revalidatePath(LIST);
  }
  return r;
}

/** "Change it" on a sent contract — withdrawn and copied as a new draft; the new draft's id comes back. */
export async function changeContractAction(id: unknown): Promise<ActionResult<string>> {
  if (typeof id !== "string" || !isUuid(id)) return invalid();
  const ctx = await ctxOf();
  const r = await runAction(pageOf(id), async () => (await changeSentContract(ctx, id)).id);
  if (r.ok) {
    revalidatePath(pageOf(id));
    revalidatePath(LIST);
  }
  return r;
}

/** A new version (a draft) of a declined or withdrawn contract; its id comes back. */
export async function newVersionAction(id: unknown): Promise<ActionResult<string>> {
  if (typeof id !== "string" || !isUuid(id)) return invalid();
  const ctx = await ctxOf();
  const r = await runAction(pageOf(id), async () => (await newContractVersion(ctx, id)).id);
  if (r.ok) {
    revalidatePath(pageOf(id));
    revalidatePath(LIST);
  }
  return r;
}

/** A short-lived link to the PDF as sent or the signed copy (made now if it was not yet). */
export async function contractPdfUrlAction(id: unknown, kind: unknown): Promise<ActionResult<string>> {
  if (typeof id !== "string" || !isUuid(id) || (kind !== "sent" && kind !== "signed")) return invalid();
  const ctx = await ctxOf();
  const r = await runAction(pageOf(id), () => contractPdfUrl(ctx, id, kind as ContractPdfKind));
  if (!r.ok) return r;
  if (r.value.created) revalidatePath(pageOf(id));
  return { ok: true, value: r.value.url };
}

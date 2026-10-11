"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";

import { AuthzError } from "@/authz/errors";
import { isUuid } from "@/db/context";
import { DomainError } from "@/lib/domain-error";
import { caution, runAction, runForm, type ActionResult, type FormResult } from "@/lib/server-actions";
import { requireTenantContext } from "@/members/tenant-context";
import {
  changeSentContract,
  commitContractUpload,
  contractPdfUrl,
  deleteContractDraft,
  deleteUploadedContract,
  presignContractUpload,
  setContractReminders,
  setUploadedContractShown,
  updateUploadedContract,
  type ContractUploadTicket,
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
/** Every client's Contracts tab (slice 112c) — the route's FILE path, route groups included (Next 16's page tags). */
const CLIENT_TAB = "/(tenant)/(authed)/clients/[id]/contracts";
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

/**
 * A CONTRACT SIGNED ELSEWHERE (slice 112c; C84 (f), C86): step 1 of putting one
 * in — a presigned PUT for the signed PDF. The browser PUTs the bytes straight
 * to the bucket, then commits (step 3) with the details.
 */
export async function presignContractUploadAction(input: unknown): Promise<ActionResult<ContractUploadTicket>> {
  if (typeof input !== "object" || input === null) return invalid();
  const { clientId, fileName, contentType, sizeBytes, sha256 } = input as Record<string, unknown>;
  const ctx = await ctxOf();
  return runAction(LIST, () => presignContractUpload(ctx, { clientId, fileName, contentType, sizeBytes, sha256 }));
}

/** Step 3: the stored bytes checked, the contract put in (SIGNED, not shown) — its id comes back so the dialog opens it. */
export async function commitContractUploadAction(input: unknown): Promise<ActionResult<string> & { readonly uploadGone?: boolean }> {
  if (typeof input !== "object" || input === null) return invalid();
  const { fileObjectId, clientId, title, signedOn, startsOn, endsOn } = input as Record<string, unknown>;
  const ctx = await ctxOf();
  // Whether the uploaded file can still be committed: refused as a file (not
  // a PDF, not the bytes announced) or already gone, it cannot — the dialog
  // then uploads afresh rather than trying it again (the fix re-check's low).
  let uploadGone = false;
  const r = await runAction(LIST, async () => {
    try {
      return (await commitContractUpload(ctx, { fileObjectId, clientId, title, signedOn, startsOn, endsOn })).id;
    } catch (e) {
      if ((e instanceof DomainError && e.code === "CONTRACT_UPLOAD_INVALID") || (e instanceof AuthzError && e.reason === "NOT_FOUND")) {
        uploadGone = true;
      }
      throw e;
    }
  });
  if (!r.ok) return { ...r, uploadGone };
  revalidatePath(LIST);
  if (typeof clientId === "string" && isUuid(clientId)) revalidatePath(`/clients/${clientId}/contracts`);
  return r;
}

/** Its title, the day it was signed, its term (`contract:edit`). */
export async function saveUploadedContractAction(id: unknown, input: unknown): Promise<FormResult> {
  if (typeof id !== "string" || !isUuid(id) || typeof input !== "object" || input === null) return invalid();
  const { title, signedOn, startsOn, endsOn } = input as Record<string, unknown>;
  const ctx = await ctxOf();
  const t = await getTranslations("contracts.uploaded");
  const r = await runForm(pageOf(id), async () => {
    await updateUploadedContract(ctx, id, { title, signedOn, startsOn, endsOn });
    return t("saved");
  });
  if (r.ok) {
    revalidatePath(pageOf(id));
    revalidatePath(CLIENT_TAB, "page");
  }
  return r;
}

/** Show it to the client's main contacts in their portal, or hide it (`contract:send` — C86 (a)). */
export async function setContractShownAction(id: unknown, shown: unknown): Promise<FormResult> {
  if (typeof id !== "string" || !isUuid(id) || typeof shown !== "boolean") return invalid();
  const ctx = await ctxOf();
  const t = await getTranslations("contracts.uploaded");
  const r = await runForm(pageOf(id), async () => {
    await setUploadedContractShown(ctx, id, shown);
    return shown ? t("shownNow") : t("hiddenNow");
  });
  if (r.ok) {
    revalidatePath(pageOf(id));
    revalidatePath(CLIENT_TAB, "page");
  }
  return r;
}

/**
 * "Remind before it ends" on a signed contract, off or back on (`contract:edit`
 * — C87 (a), slice 112c3). Off: no reminders and off Renewals.
 */
export async function setContractRemindersAction(id: unknown, on: unknown): Promise<FormResult> {
  if (typeof id !== "string" || !isUuid(id) || typeof on !== "boolean") return invalid();
  const ctx = await ctxOf();
  const t = await getTranslations("contracts.reminders");
  const r = await runForm(pageOf(id), async () => {
    await setContractReminders(ctx, id, on);
    return on ? t("onNow") : t("offNow");
  });
  if (r.ok) {
    // Its page, and both lists' "Reminders off" (the re-check's nit).
    revalidatePath(pageOf(id));
    revalidatePath(LIST);
    revalidatePath(CLIENT_TAB, "page");
  }
  return r;
}

/** Delete one that was put in wrong, with its file (`contract:delete` — C86 (b)). */
export async function deleteUploadedContractAction(id: unknown): Promise<FormResult> {
  if (typeof id !== "string" || !isUuid(id)) return invalid();
  const ctx = await ctxOf();
  const t = await getTranslations("contracts.uploaded");
  const r = await runForm(LIST, async () => {
    await deleteUploadedContract(ctx, id);
    return t("deleted");
  });
  if (r.ok) {
    revalidatePath(LIST);
    revalidatePath(CLIENT_TAB, "page");
  }
  return r;
}

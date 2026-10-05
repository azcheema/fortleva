"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { z } from "zod";

import { verifyStepUpWithHeaders } from "@/auth/step-up";
import { enrolUrl } from "@/authz/redirects";
import { field, runForm, type FormResult } from "@/lib/server-actions";
import { requireTenantContext } from "@/members/tenant-context";
import { approveSealedAsk, denySealedAsk, SEALED_REASON_MAX } from "@/modules/vault";

/**
 * ANSWERING A CLIENT'S ASK TO OPEN THEIR SEALED LOGINS (Phase 3V slice 93;
 * founder decisions C52 (f), C61 (b), (c), (f)). Each action only PARSES:
 * tenant and actor come from the session, and the vault's services check
 * the rest — `credential:unseal`, the scope, the ask still answerable — and
 * write the audit row and the mails.
 *
 * APPROVING ALWAYS ASKS FOR A FRESH FACTOR (CP4, C61 (b)): it hands secrets
 * to the client, so the dialog carries the member's authenticator code,
 * verified HERE through the product's one step-up door just before the
 * service runs — the share and show-to-client forms' shape; the service
 * then wants a factor no older than a minute. DENYING asks none (C61 (b)).
 */

const uuid = z.uuid();
const pathOf = (id: string) => `/vault/requests/${id}`;

const invalid = async (): Promise<{ ok: false; message: string }> => ({
  ok: false,
  message: (await getTranslations("common"))("invalidInput"),
});

export async function approveSealedAskAction(_prev: FormResult | null, formData: FormData): Promise<FormResult> {
  const id = uuid.safeParse(formData.get("requestId"));
  if (!id.success) return invalid();
  const path = pathOf(id.data);
  const t = await getTranslations("vault.requests");
  const code = (field(formData, "code") ?? "").trim();
  if (code.length < 6 || code.length > 32) return { ok: false, message: t("enterCode") };

  const { membership, actor } = await requireTenantContext();
  const verified = await verifyStepUpWithHeaders(code, await headers());
  if (!verified.ok) {
    if (verified.reason === "no_session") redirect("/login");
    if (verified.reason === "not_enrolled") redirect(enrolUrl(path));
    const tStep = await getTranslations("account.stepUp");
    return { ok: false, message: verified.reason === "rate_limited" ? tStep("tooManyAttempts") : tStep("mismatch") };
  }
  const ctx = {
    tenantId: membership.tenantId,
    actor: { ...actor, mfa: { enrolled: true, verifiedAt: verified.verifiedAt } },
  };
  const r = await runForm(path, async () => {
    await approveSealedAsk(ctx, id.data);
    return t("approved");
  });
  if (r.ok) {
    revalidatePath(path);
    revalidatePath("/vault");
  }
  return r;
}

export async function denySealedAskAction(_prev: FormResult | null, formData: FormData): Promise<FormResult> {
  const id = uuid.safeParse(formData.get("requestId"));
  if (!id.success) return invalid();
  const path = pathOf(id.data);
  const t = await getTranslations("vault.requests");
  const reason = formData.get("reason");
  const text = typeof reason === "string" ? reason : "";
  if (text.trim().length > SEALED_REASON_MAX) return { ok: false, message: t("reasonTooLong", { max: SEALED_REASON_MAX }) };
  const { membership, actor } = await requireTenantContext();
  const r = await runForm(path, async () => {
    await denySealedAsk({ tenantId: membership.tenantId, actor }, id.data, text);
    return t("denied");
  });
  if (r.ok) {
    revalidatePath(path);
    revalidatePath("/vault");
  }
  return r;
}

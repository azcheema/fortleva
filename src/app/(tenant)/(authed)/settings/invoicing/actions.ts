"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";

import { verifyStepUpWithHeaders } from "@/auth/step-up";
import type { MemberActor } from "@/authz/authorize";
import { enrolUrl } from "@/authz/redirects";
import { field, messageForError, runForm, type FormResult } from "@/lib/server-actions";
import { requireTenantContext } from "@/members/tenant-context";
import {
  COMPANY_FIELDS,
  normalizeCompanyPatch,
  normalizePaymentPatch,
  PAYMENT_FIELDS,
  isBookkeepingField,
  setFirstInvoiceNumber,
  updateBookkeepingSettings,
  updateCompanyDetails,
  updateDefaultPaymentTerms,
  updatePaymentDetails,
  type CompanyPatch,
  type PaymentPatch,
} from "@/modules/invoicing";

/**
 * Server actions for /settings/invoicing (Phase 4 slice 107). Tenant and
 * actor come from the session; `src/modules/invoicing/seller.ts` checks
 * `settings:edit`, the invoicing module and the factor's age, and audits.
 *
 * THE TWO PROTECTED CARDS carry the member's authenticator code IN THE FORM
 * (founder decisions C75 (h)–(j): "their authenticator code at that moment")
 * — the vault export's pattern: the code is verified here, through the one
 * step-up path that spends the per-member attempt budget, and the service is
 * handed a factor seconds old, which its one-minute window accepts. A member
 * with no authenticator is sent to set one up (the page offers no form to
 * them); a wrong code is a sentence, and the form keeps everything typed.
 */

const PATH = "/settings/invoicing";

type Verified = { readonly ok: true; readonly ctx: { readonly tenantId: string; readonly actor: MemberActor } };

/** Verify the code typed in the form; a refusal the card can show, or the context with a fresh factor. */
async function withCode(rawCode: unknown): Promise<Verified | (FormResult & { codeChecked?: boolean })> {
  const t = await getTranslations("settings.invoicing");
  const code = typeof rawCode === "string" ? rawCode.trim() : "";
  // Too short or too long to be a code: not checked, so the card keeps what was typed.
  if (code.length < 6 || code.length > 32) return { ok: false, message: t("enterCode"), codeChecked: false };
  const { membership, actor } = await requireTenantContext();
  const verified = await verifyStepUpWithHeaders(code, await headers());
  if (!verified.ok) {
    if (verified.reason === "no_session") redirect("/login");
    if (verified.reason === "not_enrolled") redirect(enrolUrl(PATH));
    const tStep = await getTranslations("account.stepUp");
    return { ok: false, message: verified.reason === "rate_limited" ? tStep("tooManyAttempts") : tStep("mismatch") };
  }
  return {
    ok: true,
    ctx: { tenantId: membership.tenantId, actor: { ...actor, mfa: { enrolled: true, verifiedAt: verified.verifiedAt } } },
  };
}

/**
 * A typo in the fields (a check digit, a length) is answered BEFORE the code
 * is checked: a mistyped account number must not spend one of the member's
 * code attempts (six per ten minutes, `auth.step_up`). The service checks the
 * same rules again under its own transaction.
 */
async function refusalOf(check: () => unknown): Promise<(FormResult & { codeChecked: false }) | null> {
  try {
    check();
    return null;
  } catch (e) {
    const message = await messageForError(e);
    if (message) return { ok: false, message, codeChecked: false };
    throw e;
  }
}

/** Copy only the known keys of a posted object, each a string or null. */
function pick(raw: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (typeof raw !== "object" || raw === null) return null;
  const input = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (!(key in input)) continue;
    const v = input[key];
    if (v !== null && typeof v !== "string" && typeof v !== "boolean") return null;
    out[key] = v;
  }
  return out;
}

/** The company card's save: the fields edited since the form opened (blank removes one), with the code. */
export async function updateCompanyAction(raw: unknown, code: unknown): Promise<FormResult & { codeChecked?: boolean }> {
  const tCommon = await getTranslations("common");
  const t = await getTranslations("settings.invoicing");
  const patch = pick(raw, COMPANY_FIELDS);
  if (!patch || ("fSkattApproved" in patch && typeof patch.fSkattApproved !== "boolean")) {
    return { ok: false, message: tCommon("invalidInput") };
  }
  for (const key of COMPANY_FIELDS) {
    if (key !== "fSkattApproved" && key in patch && typeof patch[key] === "boolean") return { ok: false, message: tCommon("invalidInput") };
  }
  const typo = await refusalOf(() => normalizeCompanyPatch(patch as CompanyPatch));
  if (typo) return typo;
  const verified = await withCode(code);
  if (!("ctx" in verified)) return verified;
  const r = await runForm(PATH, async () => {
    const changed = await updateCompanyDetails(verified.ctx, patch as CompanyPatch);
    return changed.length === 0 ? t("unchanged") : t("company.saved");
  });
  if (r.ok) revalidatePath(PATH);
  return r;
}

/** The payment card's save: the fields edited since the form opened (blank removes one), with the code. */
export async function updatePaymentAction(raw: unknown, code: unknown): Promise<FormResult & { codeChecked?: boolean }> {
  const tCommon = await getTranslations("common");
  const t = await getTranslations("settings.invoicing");
  const patch = pick(raw, PAYMENT_FIELDS);
  if (!patch || Object.values(patch).some((v) => typeof v === "boolean")) return { ok: false, message: tCommon("invalidInput") };
  const typo = await refusalOf(() => normalizePaymentPatch(patch as PaymentPatch));
  if (typo) return typo;
  const verified = await withCode(code);
  if (!("ctx" in verified)) return verified;
  const r = await runForm(PATH, async () => {
    const changed = await updatePaymentDetails(verified.ctx, patch as PaymentPatch);
    return changed.length === 0 ? t("unchanged") : t("payment.saved");
  });
  if (r.ok) revalidatePath(PATH);
  return r;
}

/** The default payment terms (an AutoForm with one field). */
export async function updateTermsAction(formData: FormData): Promise<FormResult> {
  const { membership, actor } = await requireTenantContext();
  const tCommon = await getTranslations("common");
  const r = await runForm(PATH, async () => {
    await updateDefaultPaymentTerms({ tenantId: membership.tenantId, actor }, field(formData, "paymentTermsDays"));
    return tCommon("saved");
  });
  if (r.ok) revalidatePath(PATH);
  return r;
}

/**
 * The first invoice number (slice 108, C76 (b)) — `invoice:manage_series` ✦:
 * a stale second factor sends the owner to the step-up page and back here
 * (`runForm`'s MFA_REQUIRED). Fixed once an invoice holds a number.
 */
export async function setFirstNumberAction(formData: FormData): Promise<FormResult> {
  const { membership, actor } = await requireTenantContext();
  const t = await getTranslations("settings.invoicing.numbering");
  const r = await runForm(PATH, async () => {
    await setFirstInvoiceNumber({ tenantId: membership.tenantId, actor }, field(formData, "firstNumber"));
    return t("saved");
  });
  if (r.ok) revalidatePath(PATH);
  return r;
}

/**
 * The Bookkeeping card (slice 111; C82): one field at a time — its name and
 * typed value. `settings:edit` + `invoice:view`; the method refused a change
 * once a file exists; audited with what changed (`bookkeeping.ts`).
 */
export async function updateBookkeepingAction(patch: unknown): Promise<FormResult> {
  const { membership, actor } = await requireTenantContext();
  const tCommon = await getTranslations("common");
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return { ok: false, message: tCommon("invalidInput") };
  const entries = Object.entries(patch as Record<string, unknown>);
  if (entries.length === 0 || entries.some(([k, v]) => !isBookkeepingField(k) || typeof v !== "string")) {
    return { ok: false, message: tCommon("invalidInput") };
  }
  const r = await runForm(PATH, async () => {
    await updateBookkeepingSettings({ tenantId: membership.tenantId, actor }, Object.fromEntries(entries));
    return tCommon("saved");
  });
  if (r.ok) {
    revalidatePath(PATH);
    revalidatePath("/invoices/bookkeeping");
  }
  return r;
}

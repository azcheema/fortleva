"use server";

import { revalidatePath } from "next/cache";
import { getFormatter, getTranslations } from "next-intl/server";
import { z } from "zod";

import { field, has, runAction, runForm, type ActionResult, type FormResult } from "@/lib/server-actions";
import { requireTenantContext } from "@/members/tenant-context";
import { closeRateCard, createRateCard, repriceRateCard, type TimeCtx } from "@/modules/time";
import { CURRENCIES, updatePreferences } from "@/preferences/service";

/**
 * Server actions for /settings/rates (PLAN.md 2T screens; DATA_MODEL.md
 * §6.15 "RateCard"). Thin: parse → service (which authorizes —
 * rate:manage_bill / rate:manage_cost ✦ + fresh factor / time:reprice /
 * settings:edit — and audits in one transaction) → revalidate. Tenant
 * and member come from the session, never from the form. A stale factor
 * on the ✦ half is navigation (step-up → back here), not a denial.
 */

const PATH = "/settings/rates";
const uuid = z.uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const ctxOf = async (): Promise<TimeCtx> => {
  const { membership, actor } = await requireTenantContext();
  return { tenantId: membership.tenantId, actor };
};

/**
 * The form's returnTo: the client's Agreements tab posts the same
 * action, so a step-up redirect must land back on the page that asked.
 */
const returnToOf = (fd: FormData): string => {
  const raw = field(fd, "returnTo");
  return raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : PATH;
};

const revalidate = (returnTo: string) => {
  revalidatePath(PATH);
  if (returnTo !== PATH) revalidatePath(returnTo);
};

const createSchema = z.object({
  kind: z.enum(["BILL", "COST"]),
  scope: z.enum(["TENANT", "MEMBER", "PROJECT", "PROJECT_MEMBER", "SERVICE"]),
  memberId: uuid.nullable(),
  projectId: uuid.nullable(),
  serviceId: uuid.nullable(),
  amount: z.string().trim().min(1).max(20),
  currency: z.enum(CURRENCIES),
  effectiveFrom: isoDate,
  closeOpen: z.boolean(),
});

export type RateFormState = { ok: boolean; message: string } | null;

const idOrNull = (fd: FormData, name: string): string | null => {
  const v = field(fd, name);
  return v && v.trim() !== "" ? v : null;
};

/** useActionState form: add a BILL or COST card (closeOpen = "change the rate" gesture). */
export async function createRateCardAction(_prev: RateFormState, formData: FormData): Promise<RateFormState> {
  const t = await getTranslations("settings.rates");
  const tCommon = await getTranslations("common");
  const format = await getFormatter();
  const parsed = createSchema.safeParse({
    kind: field(formData, "kind"),
    scope: field(formData, "scope"),
    memberId: idOrNull(formData, "memberId"),
    projectId: idOrNull(formData, "projectId"),
    serviceId: idOrNull(formData, "serviceId"),
    amount: field(formData, "amount"),
    currency: field(formData, "currency"),
    effectiveFrom: field(formData, "effectiveFrom"),
    closeOpen: has(formData, "closeOpen"),
  });
  if (!parsed.success) return { ok: false, message: tCommon("invalidInput") };
  const input = parsed.data;
  // Only the axes the scope carries reach the service; a stale hidden
  // value from a previous scope choice must not turn TENANT into MEMBER.
  const axes = {
    memberId: input.scope === "MEMBER" || input.scope === "PROJECT_MEMBER" ? input.memberId : null,
    projectId: input.scope === "PROJECT" || input.scope === "PROJECT_MEMBER" ? input.projectId : null,
    serviceId: input.scope === "SERVICE" ? input.serviceId : null,
  };
  const ctx = await ctxOf();
  const returnTo = returnToOf(formData);
  const r = await runForm(returnTo, async () => {
    await createRateCard(ctx, { ...input, ...axes });
    const date = format.dateTime(new Date(`${input.effectiveFrom}T00:00:00Z`), { dateStyle: "medium", timeZone: "UTC" });
    return t("form.created", { date });
  });
  if (r.ok) revalidate(returnTo);
  return r;
}

const closeSchema = z.object({ id: uuid, effectiveTo: isoDate, returnTo: z.string().optional() });

export async function closeRateCardAction(raw: { id: string; effectiveTo: string; returnTo?: string }): Promise<FormResult> {
  const t = await getTranslations("settings.rates");
  const tCommon = await getTranslations("common");
  const parsed = closeSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: tCommon("invalidInput") };
  const ctx = await ctxOf();
  const returnTo = parsed.data.returnTo && parsed.data.returnTo.startsWith("/") ? parsed.data.returnTo : PATH;
  const r = await runForm(returnTo, async () => {
    await closeRateCard(ctx, parsed.data.id, parsed.data.effectiveTo);
    return t("closeForm.closed");
  });
  if (r.ok) revalidate(returnTo);
  return r;
}

const repriceSchema = z.discriminatedUnion("mode", [
  z.object({ id: uuid, mode: z.literal("FROM_DATE"), fromDate: isoDate, returnTo: z.string().optional() }),
  z.object({ id: uuid, mode: z.literal("ALL_UNBILLED"), returnTo: z.string().optional() }),
]);

export async function repriceRateCardAction(
  raw: { id: string; mode: "FROM_DATE" | "ALL_UNBILLED"; fromDate?: string; returnTo?: string },
): Promise<ActionResult<{ repriced: number; skippedLocked: number }>> {
  const tCommon = await getTranslations("common");
  const parsed = repriceSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: tCommon("invalidInput") };
  const ctx = await ctxOf();
  const input = parsed.data;
  const returnTo = input.returnTo && input.returnTo.startsWith("/") ? input.returnTo : PATH;
  const r = await runAction(returnTo, () =>
    repriceRateCard(ctx, {
      rateCardId: input.id,
      mode: input.mode,
      ...(input.mode === "FROM_DATE" ? { fromDate: input.fromDate } : {}),
    }),
  );
  if (r.ok) {
    revalidate(returnTo);
    revalidatePath("/projects", "layout");
  }
  return r;
}

/** settings:edit — the tenant's encrypted internal-cost layer on/off (finance.costRates.enabled). */
export async function setCostLayerAction(raw: { enabled: boolean }): Promise<FormResult> {
  const tCommon = await getTranslations("common");
  const parsed = z.object({ enabled: z.boolean() }).safeParse(raw);
  if (!parsed.success) return { ok: false, message: tCommon("invalidInput") };
  const ctx = await ctxOf();
  const r = await runForm(PATH, async () => {
    await updatePreferences(ctx, { finance: { costRatesEnabled: parsed.data.enabled } });
    return tCommon("saved");
  });
  if (r.ok) {
    revalidatePath(PATH);
    revalidatePath("/projects", "layout");
  }
  return r;
}

"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { z } from "zod";

import { field, has, runForm, type FormResult } from "@/lib/server-actions";
import { requireTenantContext } from "@/members/tenant-context";
import {
  ASSET_FIELDS,
  createAsset,
  deleteAsset,
  isAssetStatus,
  isAssetType,
  updateAsset,
  type AssetPatch,
  type AssetStatus,
  type AssetType,
} from "@/modules/vault";

/**
 * Server actions for a client's Assets tab (Phase 3V slice 87). Each one
 * only PARSES: tenant and actor come from the session, and the registry's
 * services do everything else — the permission on all four gates, the
 * scope, the audit row. Every id is held to a UUID before the session is
 * read, and the page revalidated is always the client's own Assets tab,
 * built from that UUID — never a path a form names.
 */

const uuid = z.uuid();

const invalid = async (): Promise<FormResult> => ({
  ok: false,
  message: (await getTranslations("common"))("invalidInput"),
});

const ctxOf = async () => {
  const { membership, actor } = await requireTenantContext();
  return { tenantId: membership.tenantId, actor };
};

const pathOf = (clientId: string) => `/clients/${clientId.toLowerCase()}/assets`;

/**
 * The posted `field.<key>` values — only the keys `type` has. A row whose
 * type select just changed still posts its OLD type's inputs; those are the
 * facts the type change drops, so they are not passed on (the service
 * would refuse a key the new type does not have).
 */
function fieldsOf(formData: FormData, type: AssetType): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key } of ASSET_FIELDS[type]) {
    const v = formData.get(`field.${key}`);
    if (typeof v === "string") out[key] = v;
  }
  return out;
}

/**
 * A posted `<input type="date">`: blank is no date; a real `YYYY-MM-DD` is
 * that day at UTC midnight; ANYTHING ELSE is `undefined`, which the actions
 * refuse. `dateField` reads an unparseable value as blank — and a browser's
 * date input takes a five-digit year — so a typo would have CLEARED the
 * stored date and said "Saved" (the code review). The service then holds
 * the year to 2000–2199.
 */
function dayOf(formData: FormData, name: string): Date | null | undefined {
  const v = field(formData, name);
  if (v === null || v === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? undefined : d;
}

/** "Renews by itself": yes, no, or not known. */
const autoRenewOf = (raw: string | null): boolean | null => (raw === "yes" ? true : raw === "no" ? false : null);

export async function createAssetAction(_prev: FormResult | null, formData: FormData): Promise<FormResult> {
  const clientId = uuid.safeParse(formData.get("clientId"));
  const type = field(formData, "type");
  // Where the asset hangs: the client as a whole ("") or one of its projects.
  const where = field(formData, "projectId") ?? "";
  const projectId = where === "" ? null : uuid.safeParse(where);
  const expiresAt = dayOf(formData, "expiresAt");
  if (!clientId.success || !isAssetType(type) || (projectId !== null && !projectId.success) || expiresAt === undefined) {
    return invalid();
  }
  const ctx = await ctxOf();
  const t = await getTranslations("assets");
  const name = field(formData, "name") ?? "";
  const path = pathOf(clientId.data);
  const r = await runForm(path, async () => {
    await createAsset(ctx, {
      clientId: clientId.data,
      projectId: projectId === null ? null : projectId.data,
      type,
      name,
      provider: field(formData, "provider"),
      identifier: field(formData, "identifier"),
      url: field(formData, "url"),
      expiresAt,
      autoRenew: autoRenewOf(field(formData, "autoRenew")),
      renewalCost: field(formData, "renewalCost"),
      currency: field(formData, "currency"),
      fields: fieldsOf(formData, type),
      notes: field(formData, "notes"),
    });
    return t("add.added", { name: name.trim() });
  });
  if (r.ok) revalidatePath(path);
  return r;
}

/** The row's read-first fields (AutoForm): only the fields the form posted are patched. */
export async function updateAssetAction(formData: FormData): Promise<FormResult> {
  const clientId = uuid.safeParse(formData.get("clientId"));
  const assetId = uuid.safeParse(formData.get("assetId"));
  const type = field(formData, "type");
  const expiresAt = dayOf(formData, "expiresAt");
  if (!clientId.success || !assetId.success || !isAssetType(type) || expiresAt === undefined) return invalid();
  const ctx = await ctxOf();
  const tCommon = await getTranslations("common");
  const patch: { -readonly [K in keyof AssetPatch]: AssetPatch[K] } = { type, fields: fieldsOf(formData, type) };
  if (has(formData, "name")) patch.name = field(formData, "name") ?? "";
  if (has(formData, "provider")) patch.provider = field(formData, "provider");
  if (has(formData, "identifier")) patch.identifier = field(formData, "identifier");
  if (has(formData, "url")) patch.url = field(formData, "url");
  if (has(formData, "expiresAt")) patch.expiresAt = expiresAt;
  if (has(formData, "autoRenew")) patch.autoRenew = autoRenewOf(field(formData, "autoRenew"));
  if (has(formData, "renewalCost")) patch.renewalCost = field(formData, "renewalCost");
  if (has(formData, "currency")) patch.currency = field(formData, "currency");
  if (has(formData, "notes")) patch.notes = field(formData, "notes");
  const path = pathOf(clientId.data);
  const r = await runForm(path, async () => {
    await updateAsset(ctx, assetId.data, patch);
    return tCommon("saved");
  });
  if (r.ok) revalidatePath(path);
  return r;
}

/** Retire an asset (kept, off the renewals) or bring it back. */
export async function setAssetStatusAction(clientId: string, assetId: string, status: AssetStatus): Promise<FormResult> {
  if (!uuid.safeParse(clientId).success || !uuid.safeParse(assetId).success || !isAssetStatus(status)) return invalid();
  const ctx = await ctxOf();
  const t = await getTranslations("assets.row");
  const path = pathOf(clientId);
  const r = await runForm(path, async () => {
    await updateAsset(ctx, assetId, { status });
    return status === "RETIRED" ? t("retired") : t("reactivated");
  });
  if (r.ok) revalidatePath(path);
  return r;
}

export async function deleteAssetAction(clientId: string, assetId: string): Promise<FormResult> {
  if (!uuid.safeParse(clientId).success || !uuid.safeParse(assetId).success) return invalid();
  const ctx = await ctxOf();
  const t = await getTranslations("assets.row");
  const path = pathOf(clientId);
  const r = await runForm(path, async () => {
    await deleteAsset(ctx, assetId);
    return t("deleted");
  });
  if (r.ok) revalidatePath(path);
  return r;
}

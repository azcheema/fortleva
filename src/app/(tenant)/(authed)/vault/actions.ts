"use server";

import { revalidatePath } from "next/cache";
import { getTranslations } from "next-intl/server";
import { z } from "zod";

import { field, has, runForm, type FormResult } from "@/lib/server-actions";
import { requireTenantContext } from "@/members/tenant-context";
import {
  createCredential,
  deleteCredential,
  isCredentialType,
  replaceCredentialSecret,
  SECRET_FIELDS,
  updateCredential,
  type CredentialPatch,
} from "@/modules/vault";

import { vaultPathOf, vaultWhereOf } from "./surface";

/**
 * Server actions for every vault page — a client's tab, a project's tab and
 * the tenant's `/vault` (Phase 3V slices 85–86). Each one only PARSES:
 * tenant and actor come from the session, and the vault's services do
 * everything else — the door (a fresh factor, C52), the permission, the
 * scope, the audit row. A secret value is passed through exactly as typed
 * (never trimmed: a trailing space is part of a password) and never
 * appears in a message — every refusal is translated from its code.
 *
 * The page a form came from is its `surface` (`surface.ts`): one of three
 * shapes, revalidated on success and the place a stale factor's step-up
 * returns to, which re-opens the vault; the typed value is not kept, by
 * design. Anything else is refused before the session is read.
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

/** Every secret field name any type has — the only `secret.*` keys a form may post. */
const ALL_SECRET_KEYS = new Set(Object.values(SECRET_FIELDS).flat());

/** The posted `secret.<key>` values, exactly as typed; blanks included (the service reads "" as "unchanged"). */
function secretsOf(formData: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ALL_SECRET_KEYS) {
    const v = formData.get(`secret.${key}`);
    if (typeof v === "string") out[key] = v;
  }
  return out;
}

export async function createCredentialAction(_prev: FormResult | null, formData: FormData): Promise<FormResult> {
  const path = vaultPathOf(formData.get("surface"));
  // Where the login hangs: the agency, a client, or one project — the
  // service checks scope, that the project is live, and C49.
  const where = vaultWhereOf(formData.get("where"));
  const type = field(formData, "type");
  if (path === null || where === null || !isCredentialType(type)) return invalid();
  const ctx = await ctxOf();
  const t = await getTranslations("vault");
  const name = field(formData, "name") ?? "";
  const r = await runForm(path, async () => {
    await createCredential(ctx, {
      clientId: where.clientId,
      projectId: where.projectId,
      type,
      name,
      username: field(formData, "username"),
      url: field(formData, "url"),
      notes: field(formData, "notes"),
      secret: secretsOf(formData),
      totp: field(formData, "totp"),
    });
    return t("add.added", { name: name.trim() });
  });
  if (r.ok) revalidatePath(path);
  return r;
}

/** The row's read-first fields (AutoForm): only the fields the form posted are patched. */
export async function updateCredentialAction(formData: FormData): Promise<FormResult> {
  const path = vaultPathOf(formData.get("surface"));
  const credentialId = uuid.safeParse(formData.get("credentialId"));
  if (path === null || !credentialId.success) return invalid();
  const ctx = await ctxOf();
  const tCommon = await getTranslations("common");
  const patch: { -readonly [K in keyof CredentialPatch]: CredentialPatch[K] } = {};
  if (has(formData, "name")) patch.name = field(formData, "name") ?? "";
  if (has(formData, "username")) patch.username = field(formData, "username");
  if (has(formData, "url")) patch.url = field(formData, "url");
  if (has(formData, "notes")) patch.notes = field(formData, "notes");
  const r = await runForm(path, async () => {
    await updateCredential(ctx, credentialId.data, patch);
    return tCommon("saved");
  });
  if (r.ok) revalidatePath(path);
  return r;
}

/**
 * Change the secret (the rotate gesture): a blank field keeps its value,
 * a typed one replaces it; the authenticator key is replaced when typed
 * and removed when "remove" is ticked. The old values become a version.
 */
export async function replaceCredentialSecretAction(_prev: FormResult | null, formData: FormData): Promise<FormResult> {
  const path = vaultPathOf(formData.get("surface"));
  const credentialId = uuid.safeParse(formData.get("credentialId"));
  if (path === null || !credentialId.success) return invalid();
  const ctx = await ctxOf();
  const t = await getTranslations("vault");
  const totpText = field(formData, "totp") ?? "";
  const totp = has(formData, "removeTotp") ? null : totpText.trim() === "" ? undefined : totpText;
  const r = await runForm(path, async () => {
    await replaceCredentialSecret(ctx, credentialId.data, {
      secret: secretsOf(formData),
      ...(totp === undefined ? {} : { totp }),
    });
    return t("secret.changed");
  });
  if (r.ok) revalidatePath(path);
  return r;
}

export async function deleteCredentialAction(surface: string, credentialId: string): Promise<FormResult> {
  const path = vaultPathOf(surface);
  if (path === null || !uuid.safeParse(credentialId).success) return invalid();
  const ctx = await ctxOf();
  const t = await getTranslations("vault");
  const r = await runForm(path, async () => {
    await deleteCredential(ctx, credentialId);
    return t("row.deleted");
  });
  if (r.ok) revalidatePath(path);
  return r;
}

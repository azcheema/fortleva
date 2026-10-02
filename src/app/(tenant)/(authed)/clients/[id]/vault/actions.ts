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

/**
 * Server actions for /clients/[id]/vault. Each one only PARSES: tenant and
 * actor come from the session, and the vault's services do everything
 * else — the door (a fresh factor, C52), the permission, the scope, the
 * audit row. A secret value is passed through exactly as typed (never
 * trimmed: a trailing space is part of a password) and never appears in a
 * message — every refusal is translated from its code.
 *
 * A stale factor redirects to the step-up page and back here (`runForm`),
 * which re-opens the vault; the typed value is not kept, by design.
 */

const uuid = z.uuid();
const vaultPath = (clientId: string) => `/clients/${clientId}/vault`;

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
  const clientId = uuid.safeParse(formData.get("clientId"));
  if (!clientId.success) return invalid();
  const type = field(formData, "type");
  if (!isCredentialType(type)) return invalid();
  // "Where" is the client itself or one of its projects; the service
  // checks that the project is this client's and in the member's scope.
  const where = field(formData, "where") ?? "client";
  const project = where === "client" ? null : uuid.safeParse(where);
  if (project && !project.success) return invalid();
  const ctx = await ctxOf();
  const t = await getTranslations("clients.vault");
  const name = field(formData, "name") ?? "";
  const r = await runForm(vaultPath(clientId.data), async () => {
    await createCredential(ctx, {
      clientId: clientId.data,
      projectId: project ? project.data : null,
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
  if (r.ok) revalidatePath(vaultPath(clientId.data));
  return r;
}

/** The row's read-first fields (AutoForm): only the fields the form posted are patched. */
export async function updateCredentialAction(formData: FormData): Promise<FormResult> {
  const clientId = uuid.safeParse(formData.get("clientId"));
  const credentialId = uuid.safeParse(formData.get("credentialId"));
  if (!clientId.success || !credentialId.success) return invalid();
  const ctx = await ctxOf();
  const tCommon = await getTranslations("common");
  const patch: { -readonly [K in keyof CredentialPatch]: CredentialPatch[K] } = {};
  if (has(formData, "name")) patch.name = field(formData, "name") ?? "";
  if (has(formData, "username")) patch.username = field(formData, "username");
  if (has(formData, "url")) patch.url = field(formData, "url");
  if (has(formData, "notes")) patch.notes = field(formData, "notes");
  const r = await runForm(vaultPath(clientId.data), async () => {
    await updateCredential(ctx, credentialId.data, patch);
    return tCommon("saved");
  });
  if (r.ok) revalidatePath(vaultPath(clientId.data));
  return r;
}

/**
 * Change the secret (the rotate gesture): a blank field keeps its value,
 * a typed one replaces it; the authenticator key is replaced when typed
 * and removed when "remove" is ticked. The old values become a version.
 */
export async function replaceCredentialSecretAction(_prev: FormResult | null, formData: FormData): Promise<FormResult> {
  const clientId = uuid.safeParse(formData.get("clientId"));
  const credentialId = uuid.safeParse(formData.get("credentialId"));
  if (!clientId.success || !credentialId.success) return invalid();
  const ctx = await ctxOf();
  const t = await getTranslations("clients.vault");
  const totpText = field(formData, "totp") ?? "";
  const totp = has(formData, "removeTotp") ? null : totpText.trim() === "" ? undefined : totpText;
  const r = await runForm(vaultPath(clientId.data), async () => {
    await replaceCredentialSecret(ctx, credentialId.data, {
      secret: secretsOf(formData),
      ...(totp === undefined ? {} : { totp }),
    });
    return t("secret.changed");
  });
  if (r.ok) revalidatePath(vaultPath(clientId.data));
  return r;
}

export async function deleteCredentialAction(clientId: string, credentialId: string): Promise<FormResult> {
  if (!uuid.safeParse(clientId).success || !uuid.safeParse(credentialId).success) return invalid();
  const ctx = await ctxOf();
  const t = await getTranslations("clients.vault");
  const r = await runForm(vaultPath(clientId), async () => {
    await deleteCredential(ctx, credentialId);
    return t("deleted");
  });
  if (r.ok) revalidatePath(vaultPath(clientId));
  return r;
}

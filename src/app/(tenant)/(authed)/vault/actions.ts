"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { z } from "zod";

import { verifyStepUpWithHeaders } from "@/auth/step-up";
import { enrolUrl } from "@/authz/redirects";
import { field, has, runAction, runForm, type ActionResult, type FormResult } from "@/lib/server-actions";
import { requireTenantContext } from "@/members/tenant-context";
import {
  createCredential,
  createShareLink,
  deleteCredential,
  hideLoginFromClient,
  isCredentialType,
  listShareLinks,
  replaceCredentialSecret,
  revokeShareLink,
  SECRET_FIELDS,
  showLoginToClient,
  updateCredential,
  type CredentialPatch,
  type ShareLinkView,
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

const invalid = async (): Promise<{ ok: false; message: string }> => ({
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

/** What the share form gets back: the link to copy — once — or why not. */
export type ShareCreateState =
  | { readonly ok: true; readonly url: string; readonly expiresAt: Date; readonly email: string }
  | { readonly ok: false; readonly message: string };

/**
 * MAKE A SHARE LINK (slice 90). Sharing ALWAYS asks for a fresh factor
 * (AUTHZ.md §7.5, CP4), so the form carries the member's authenticator
 * code, verified HERE — through the product's one step-up door, on the
 * member's step-up budget — immediately before the service runs; the
 * service then wants a factor no older than a minute. The member's
 * session is stamped by the verification, and the actor handed on carries
 * that stamp (`requireTenantContext` read the session before it).
 *
 * The link comes back to this member ONCE: only its hash is kept. Nothing
 * is revalidated — the page shows no links; the dialog re-reads its list.
 */
export async function createShareLinkAction(_prev: ShareCreateState | null, formData: FormData): Promise<ShareCreateState> {
  const path = vaultPathOf(formData.get("surface"));
  const credentialId = uuid.safeParse(formData.get("credentialId"));
  const hours = Number(field(formData, "hours"));
  const shareField = field(formData, "field");
  const email = field(formData, "email");
  if (
    path === null ||
    !credentialId.success ||
    !Number.isInteger(hours) ||
    hours < 1 ||
    hours > 168 ||
    shareField === null ||
    shareField.length === 0 ||
    shareField.length > 64 ||
    email === null
  ) {
    return invalid();
  }
  // THE FREE CHECKS BEFORE THE CODE IS SPENT (the code review): the step-up
  // below costs one of the member's six attempts in ten minutes, so a typo
  // in the address must not reach it. The service checks all of this again.
  if (!z.email().max(320).safeParse(email.trim().toLowerCase()).success) {
    return { ok: false, message: (await getTranslations("domainErrors"))("EMAIL_INVALID") };
  }
  const t = await getTranslations("vault.share");
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
  const r = await runAction(path, () =>
    createShareLink(ctx, credentialId.data, {
      field: shareField,
      recipientEmail: email,
      expiresInHours: hours,
      includeUsername: has(formData, "includeUsername"),
    }),
  );
  if (!r.ok) return r;
  return { ok: true, url: r.value.url, expiresAt: r.value.expiresAt, email: email.trim().toLowerCase() };
}

/** A login's share links, for the share dialog (read on open). */
export async function listShareLinksAction(surface: string, credentialId: string): Promise<ActionResult<readonly ShareLinkView[]>> {
  const path = vaultPathOf(surface);
  if (path === null || !uuid.safeParse(credentialId).success) return invalid();
  const ctx = await ctxOf();
  return runAction(path, () => listShareLinks(ctx, credentialId));
}

/**
 * SHOW A LOGIN TO THE CLIENT (slice 91; C52 (d)). Showing ALWAYS asks for
 * a fresh factor (AUTHZ.md §7.5, CP4: "always step-up for visibility"), so
 * the dialog carries the member's authenticator code, verified HERE through
 * the product's one step-up door just before the service runs — the share
 * form's shape; the service then wants a factor no older than a minute.
 */
export async function showLoginToClientAction(_prev: FormResult | null, formData: FormData): Promise<FormResult> {
  const path = vaultPathOf(formData.get("surface"));
  const credentialId = uuid.safeParse(formData.get("credentialId"));
  if (path === null || !credentialId.success) return invalid();
  const t = await getTranslations("vault.clientView");
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
    await showLoginToClient(ctx, credentialId.data);
    return t("shown");
  });
  if (r.ok) revalidatePath(path);
  return r;
}

/** Hide a shown login from the client again — the vault's window, no code (it takes access away). */
export async function hideLoginFromClientAction(surface: string, credentialId: string): Promise<FormResult> {
  const path = vaultPathOf(surface);
  if (path === null || !uuid.safeParse(credentialId).success) return invalid();
  const ctx = await ctxOf();
  const t = await getTranslations("vault.clientView");
  const r = await runForm(path, async () => {
    await hideLoginFromClient(ctx, credentialId);
    return t("hidden");
  });
  if (r.ok) revalidatePath(path);
  return r;
}

/** End a link nobody has opened yet. */
export async function revokeShareLinkAction(surface: string, linkId: string): Promise<FormResult> {
  const path = vaultPathOf(surface);
  if (path === null || !uuid.safeParse(linkId).success) return invalid();
  const ctx = await ctxOf();
  const t = await getTranslations("vault.share");
  return runForm(path, async () => {
    await revokeShareLink(ctx, linkId);
    return t("revoked");
  });
}

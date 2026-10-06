"use server";

import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

import { field, type FormResult } from "@/lib/server-actions";
import { submitPortalCredential } from "@/modules/vault";
import { runPortalForm } from "@/portal/action";
import { requirePortalContext } from "@/portal/context";

/**
 * HAND A LOGIN OVER (Phase 3V slice 96; founder decision C64) — the
 * "Send us a login" form's action.
 *
 * THE PRINCIPAL COMES FROM `requirePortalContext()` AND FROM NOWHERE ELSE,
 * the portal's standing rule (`requests/new/actions.ts` has the long form):
 * nothing that names a tenant, a client or a contact is read out of the
 * form, and a member inside View-as — who has no contact session — is sent
 * to the client sign-in page. The client the login lands on is the
 * principal's; the PROJECT is the one id the form may carry, and the broker
 * proves it is this contact's to name (`authorizePortal` on the project)
 * and re-reads it as this client's.
 *
 * TWO REFUSALS ARE SAID HERE, BEFORE THE BROKER, because they are about
 * what the reader typed and a plain "check what you typed" would not tell
 * them which: no name, and no secret. Everything else is the broker's —
 * `runPortalForm` turns every refusal about the agency into the plane's one
 * message and says only the reader's own (`INVALID_INPUT`,
 * `SUBMISSION_RATE_LIMITED`).
 *
 * SUCCESS REDIRECTS FROM THE SERVER to the same page with `?sent=1`, which
 * says it went and shows it at the top of their list — a fresh render, so
 * the form is empty again and no secret lingers in the browser's state.
 * Outside the runner, because `redirect()` works by throwing.
 */
export async function sendLoginAction(_prev: FormResult | null, formData: FormData): Promise<FormResult> {
  const { principal } = await requirePortalContext();
  const t = await getTranslations("portal.sendLogin.errors");

  // A null-prototype map: a field named `secret.__proto__` must be a key
  // like any other (the broker refuses it), never the object's prototype.
  const secret = Object.create(null) as Record<string, string>;
  for (const [key, value] of formData.entries()) {
    if (key.startsWith("secret.") && typeof value === "string") secret[key.slice("secret.".length)] = value;
  }
  const name = field(formData, "name") ?? "";
  if (name.trim() === "") return { ok: false, message: t("name") };
  if (!Object.values(secret).some((v) => v.length > 0)) return { ok: false, message: t("secret") };

  const result = await runPortalForm("sendLogin", async () => {
    await submitPortalCredential(principal, {
      type: field(formData, "type"),
      name,
      projectId: field(formData, "projectId"),
      username: field(formData, "username"),
      url: field(formData, "url"),
      notes: field(formData, "notes"),
      secret,
    });
    // Never rendered: the redirect below runs on every success.
    return "";
  });
  if (result.ok) redirect("/portal/send-login?sent=1");
  return result;
}
